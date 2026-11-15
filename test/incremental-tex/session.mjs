// Isolated engine comparison. Use disposable inputs; never mount an original project.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const [engine, directory, main, frameDirectory] = process.argv.slice(2);
assert(['rtex', 'texpresso'].includes(engine), 'Choose rtex or texpresso');
assert(directory && main && path.basename(main) === main, 'Supply copied project directory and main basename');
const project = fs.realpathSync(directory), source = fs.readFileSync(path.join(project, main), 'utf8');
assert(!fs.lstatSync(path.join(project, main)).isSymbolicLink(), 'Main must be a regular copied source');
const environments = [...source.matchAll(/\\begin\{questions\}/g)];
assert(environments.length, 'Fixture needs a questions environment');
const start = environments.at(-1).index;
const questions = [...source.slice(start).matchAll(/\\question(?:\[[^\]]*\])?/g)];
assert(questions.length >= 3, 'Fixture needs at least three questions');
const position = start + questions[1].index + questions[1][0].length;
const byte = Buffer.byteLength(source.slice(0, position)), line = source.slice(0, position).split('\n').length;
const marker = ' IncrementalTrialMarker ';
const name = `overleaf-${engine}-trial-${process.pid}`;
const args = ['run', '-i', '--rm', '--name', name, '--network', 'none', '--memory', '1g', '--pids-limit', '128', '-v', `${project}:/project`, '-w', '/project'];
let frames;
if (engine === 'texpresso') {
  assert(frameDirectory, 'TeXpresso needs a private, empty frame directory');
  fs.mkdirSync(frameDirectory, { mode: 0o700, recursive: true }); frames = fs.realpathSync(frameDirectory);
  assert.equal(fs.readdirSync(frames).length, 0, 'Frame directory must be empty');
  args.push('-v', `${frames}:/frames`, '-e', 'SDL_VIDEODRIVER=dummy', '-e', 'SDL_RENDER_DRIVER=software', '-e', 'TEXPRESSO_FRAME_DIR=/frames', '--entrypoint', '/opt/texpresso/bin/texpresso', 'overleafcep-local/texpresso-trial:20261115', '-texlive', '-json', `/project/${main}`);
} else args.push('--entrypoint', '/opt/rtex/bin/rtex', 'overleafcep-local/rtex-trial:20261115', 'serve', '--project', '/project', '--main', main);
const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '', phase = 0, sent = performance.now(), stopping = false, stderrTail = '';
let missingBbm = false, unsupportedCharacter = false, success = false;
const send = command => child.stdin.write(JSON.stringify(command) + '\n');
const stop = () => {
  if (stopping) return; stopping = true; clearTimeout(timer);
  spawnSync('docker', ['stop', '-t', '2', name], { stdio: 'ignore', timeout: 5000 });
};
const timer = setTimeout(() => { console.log(JSON.stringify({ timeout: true, phase })); stop(); }, 60000);
child.stderr.on('data', chunk => {
  const text = stderrTail + chunk;
  missingBbm ||= text.includes('No fz nor vf font for bbm10');
  unsupportedCharacter ||= text.includes('could not represent character');
  stderrTail = text.slice(-200); // Do not log source/protocol payloads.
});
child.stdout.on('data', chunk => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\n')) >= 0) {
    const record = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    let message; try { message = JSON.parse(record); } catch { continue; }
    if (engine === 'rtex') {
      if (message.reply === 'edit') console.log(JSON.stringify({ edit: message.result?.routed, reasons: message.result?.reasons, ms: performance.now() - sent }));
      if (message.event === 'ParagraphUpdate' && phase === 1) console.log(JSON.stringify({ paragraphMs: performance.now() - sent }));
      if (message.event !== 'LayoutUpdate' || message.convergence?.state !== 'Converged') continue;
      console.log(JSON.stringify({ event: 'layout', phase, engineMs: message.wall_ms, elapsedMs: performance.now() - sent, pages: message.pages_total, compile: message.compile?.state }));
      if (phase === 0) { phase = 1; sent = performance.now(); send({ cmd: 'edit', path: main, start: byte, end: byte, text: marker }); }
      else { success = message.compile?.state === 'Ok'; stop(); }
    } else {
      if (!Array.isArray(message) || message[0] !== 'frame') continue;
      const [, serial, page, width, height, pages] = message;
      assert(Number.isSafeInteger(serial) && serial > 0, 'Invalid frame id');
      const hasMarker = fs.readFileSync(path.join(frames, serial + '.json'), 'utf8').includes(marker.trim());
      console.log(JSON.stringify({ event: 'frame', phase, page, width, height, pages, elapsedMs: performance.now() - sent, hasMarker }));
      if (phase === 0) { phase = 1; send(['open', `/project/${main}`, source]); send(['synctex-forward', `/project/${main}`, line]); }
      else if (phase === 1 && page > 0) { phase = 2; sent = performance.now(); send(['change', `/project/${main}`, byte, 0, marker]); }
      else if (phase === 2 && hasMarker) { success = true; stop(); }
    }
  }
});
child.on('error', error => { console.error(error.message); stop(); process.exitCode = 1; });
child.on('exit', () => {
  clearTimeout(timer);
  console.log(JSON.stringify({ completed: success, missingBbm, unsupportedCharacter, browserVisibilityChecked: false }));
  if (!success || missingBbm || unsupportedCharacter) process.exitCode = 1;
});
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
