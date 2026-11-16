// SPDX-License-Identifier: AGPL-3.0-only
// CE+ ae07e781; native local runner with per-job confinement and bounded lifetime.
/* eslint-disable
    no-return-assign,
    no-unused-vars,
*/
// TODO: This file was created by bulk-decaffeinate.
// Fix any style issues and re-enable lint.
/*
 * decaffeinate suggestions:
 * DS101: Remove unnecessary use of Array.from
 * DS102: Remove unnecessary code created because of implicit returns
 * DS207: Consider shorter variations of null checks
 * Full docs: https://github.com/decaffeinate/decaffeinate/blob/master/docs/suggestions.md
 */
import { spawn } from 'node:child_process'
import { promisify } from 'node:util'
import Path from 'node:path'
import _ from 'lodash'
import logger from '@overleaf/logger'
let CommandRunner

logger.debug('using standard command runner')

// Track PIDs that have been intentionally killed so that the close handler
// can detect termination even when the child exits with a numeric code instead
// of being reported as killed by a signal (e.g. exit code 4 from latexmk).
const killedPids = new Set()

export default CommandRunner = {
  run(
    projectId,
    command,
    directory,
    image,
    timeout,
    environment,
    compileGroup,
    cwd,
    callback
  ) {
    let key, value
    callback = _.once(callback)
    const spawnCwd = cwd ? Path.join(directory, cwd) : directory
    command = Array.from(command).map(arg =>
      arg.toString().replace('$COMPILE_DIR', directory)
    )
    logger.debug(
      { projectId, command, directory, cwd: spawnCwd },
      'running command'
    )
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600000) return callback(new Error('invalid compile timeout'))

    // merge environment settings
    const env = {}
    for (key in process.env) {
      value = process.env[key]
      env[key] = value
    }
    for (key in environment) {
      value = environment[key]
      env[key] = value
    }

    // run command as detached process so it has its own process group (which can be killed if needed)
    const proc = spawn('/opt/overleaf-native-tex/bin/overleaf-compile-sandbox', [directory, spawnCwd, ...command], {
      cwd: spawnCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })

    let stdout = '', stderr = '', bytes = 0, exceeded = false, expired = false
    const terminate = () => { try { process.kill(-proc.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') logger.warn({ error }, 'Unable to stop compiler') } }
    const deadline = setTimeout(() => { expired = true; terminate() }, timeout)
    proc.once('exit', () => { clearTimeout(deadline); terminate() })
    proc.stdout.setEncoding('utf8').on('data', data => { bytes += Buffer.byteLength(data); if (bytes > 8 * 1024 * 1024) { exceeded = true; terminate() } else stdout += data })

    proc.stderr.setEncoding('utf8').on('data', data => { bytes += Buffer.byteLength(data); if (bytes > 8 * 1024 * 1024) { exceeded = true; terminate() } else stderr += data })

    proc.on('error', function (err) {
      clearTimeout(deadline)
      killedPids.delete(proc.pid)
      logger.err(
        { err, projectId, command, directory },
        'error running command'
      )
      return callback(err)
    })

    proc.on('close', function (code, signal) {
      let err
      logger.debug({ code, signal, projectId }, 'command exited')
      const wasKilled = killedPids.delete(proc.pid)
      if (signal || wasKilled || expired || exceeded) {
        err = new Error(expired ? 'compile timed out' : exceeded ? 'compile output limit exceeded' : 'terminated')
        err.terminated = true
        err.timedout = expired
        return callback(err)
      } else if (code === 1 || code === 126) {
        // exit status from chktex
        err = new Error('exited')
        err.code = code
        return callback(err)
      } else {
        return callback(null, { stdout, stderr, exitCode: code })
      }
    })

    return proc.pid
  }, // return process id to allow job to be killed if necessary

  kill(pid, callback) {
    if (callback == null) {
      callback = function () {}
    }
    try {
      killedPids.add(pid)
      process.kill(-pid, 'SIGKILL') // reap even workers ignoring graceful termination
    } catch (err) {
      killedPids.delete(pid)
      return callback(err)
    }
    return callback()
  },

  canRunSyncTeXInOutputDir() {
    return true
  },
}

CommandRunner.promises = {
  run: promisify(CommandRunner.run),
  kill: promisify(CommandRunner.kill),
}
