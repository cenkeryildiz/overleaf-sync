// SPDX-License-Identifier: AGPL-3.0-only
// CE+ ae07e781; bounded FIFO admission over the installed async queue.
import logger from '@overleaf/logger'
import Errors from './Errors.js'
import RequestParser from './RequestParser.js'
import Metrics from '@overleaf/metrics'
import Settings from '@overleaf/settings'
import async from 'async'
import Path from 'node:path'

// The lock timeout should be higher than the maximum end-to-end compile time.
// Here, we use the maximum compile timeout plus 2 minutes.
const LOCK_TIMEOUT_MS = RequestParser.MAX_TIMEOUT * 1000 + 120000

const LOCKS = new Map()
const queue = async.queue(async lock => {
  if (lock.released) return
  await new Promise(done => { lock.finish = done; lock.queued = false; clearTimeout(lock.timer); lock.admit() })
}, Settings.compileConcurrencyLimit)

/**
 * @param key
 * @return {Lock | undefined}
 */
function getExistingLock(key) {
  return LOCKS.get(key)
}

async function acquire(key) {
  if (LOCKS.has(key)) throw new Errors.AlreadyCompilingError('compile in progress')
  const owner = Path.basename(key).match(/-([a-f0-9]{24})$/)?.[1] || key
  if (LOCKS.size >= 36 || [...LOCKS.values()].filter(lock => lock.owner === owner).length >= 2) {
    throw new Errors.TooManyCompileRequestsError('compile queue is busy')
  }
  const lock = new Lock(key); lock.owner = owner; lock.queued = true
  LOCKS.set(key, lock)
  Metrics.gauge('concurrent_compile_requests', LOCKS.size)
  await new Promise((resolve, reject) => {
    lock.admit = resolve; lock.reject = reject
    lock.timer = setTimeout(() => lock.release(new Errors.TooManyCompileRequestsError('compile queue wait expired')), 60000)
    queue.push(lock)
  })
  return lock
}

class Lock {
  constructor(key) {
    this.key = key
    this.expiresAt = Date.now() + LOCK_TIMEOUT_MS
  }

  isExpired() {
    return Date.now() >= this.expiresAt
  }

  waitForRelease() {
    if (this.waitingForRelease) return this.waitingForRelease
    this.waitingForRelease = new Promise(resolve => {
      this.onRelease = resolve
    })
    return this.waitingForRelease
  }

  release(error) {
    if (this.released) return
    this.released = true; clearTimeout(this.timer)
    if (this.queued) { queue.remove(({data}) => data === this); this.reject(error || new Error('compile admission canceled')) }
    if (LOCKS.get(this.key) === this) LOCKS.delete(this.key)
    this.finish?.(); this.onRelease?.()
  }
}

export default { acquire, getExistingLock }
