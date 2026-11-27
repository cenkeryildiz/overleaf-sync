// SPDX-License-Identifier: AGPL-3.0-only
// RESEARCH-RUNTIME-01 / DOCEXEC-01: the research host in native-messaging mode (as Chrome starts it) with the user's REAL
// installed kernels (python3 in the selected conda env, ir) on synthetic code only. Selection goes through the same ops the
// "This computer" rows use; settings live in a temporary file. Nothing reads or prints a real user file: home-directory
// checks only test that listing/opening is refused.
//   cargo build --offline --release --manifest-path runtime/chrome-extension/research-host/Cargo.toml
//   LATEX_RESEARCH_HELPER=<binary> node --test test/research_session.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, statSync, readFileSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = process.env.LATEX_RESEARCH_HELPER ?? join(ROOT, 'runtime/chrome-extension/research-host/target/release/latex-local-research');
const ENV_PYTHON = process.env.RESEARCH_PYTHON ?? '/Users/macc/miniforge3/envs/myproject/bin/python';
const work = mkdtempSync(join(realpathSync(tmpdir()), 'lr-session-')), settings = join(work, 'research.json');
const jobs = join(work, 'jobs'); mkdirSync(jobs);
const SECRET = 'SECRET-' + randomBytes(8).toString('hex'), HOME = homedir();
const PROJECT = 'synthetic-project-1';
after(() => rmSync(work, { recursive: true, force: true }));

/** One Chrome-style connection: 4-byte little-endian length + JSON, both ways. */
function connect(extraEnv = {}) {
  const child = spawn(HELPER, ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/'], { env: { HOME, PATH: '/usr/bin:/bin', LATEX_LOCAL_RESEARCH_SETTINGS: settings, TMPDIR: jobs, OPENAI_API_KEY: SECRET, FAKE_TOKEN: SECRET, ...extraEnv }, stdio: ['pipe', 'pipe', 'ignore'] });
  let buffer = Buffer.alloc(0), next = 1; const waiting = new Map(), events = [], raw = [];
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const size = buffer.readUInt32LE(0), text = buffer.subarray(4, 4 + size).toString(); buffer = buffer.subarray(4 + size); raw.push(text);
      assert.ok(size <= 1_000_000, 'a host message exceeds Chrome\'s 1 MB limit');
      const message = JSON.parse(text);
      if (message.id && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); } else events.push(message);
    }
  });
  const exited = new Promise(resolve => child.on('exit', resolve));
  const call = (op, args = {}) => new Promise(resolve => { const id = next++; waiting.set(id, resolve); const body = Buffer.from(JSON.stringify({ id, op, ...args })), head = Buffer.alloc(4); head.writeUInt32LE(body.length); child.stdin.write(Buffer.concat([head, body])); });
  const ok = async (op, args) => { const reply = await call(op, args); assert.equal(reply.error, undefined, `${op}: ${reply.error}`); return reply.result; };
  const run = async (code, options = {}) => { const reply = await call('run', { project: PROJECT, cell: 'cells/a.py', code, timeout: 20, ...options }); assert.equal(reply.error, undefined, reply.error); return reply.result; };
  const close = async () => { child.stdin.end(); await exited; };
  return { child, call, ok, run, close, events, raw, exited };
}
const text = result => result.items.map(item => typeof item.data === 'string' ? item.data : JSON.stringify(item.data)).join('') + result.items.filter(i => i.kind === 'error').map(i => i.ename + ': ' + i.evalue).join('');
const until = async (check, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
/** Processes of a host connection: everything descended from its pid (kernel.py and the kernel), with resident memory. */
function tree(root) {
  const rows = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const found = new Set([root]); for (let grew = true; grew;) { grew = false; for (const [pid, ppid] of rows) if (found.has(ppid) && !found.has(pid)) { found.add(pid); grew = true; } }
  found.delete(root); return { pids: [...found], rssKb: rows.filter(([pid]) => found.has(pid)).reduce((n, [, , rss]) => n + rss, 0) };
}
const leftovers = () => spawnSync('/usr/bin/pgrep', ['-f', `${jobs}/latex-local-research-[0-9a-f]+/job/kernel.py`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
const measurements = {};

async function prepare(host, kernelName) {
  const status = await host.ok('status', { project: PROJECT });
  const python = status.python.find(p => p.path === ENV_PYTHON); assert.ok(python, 'the selected conda environment is discovered: ' + status.python.map(p => p.label).join(', '));
  await host.ok('select', { kind: 'python', path: ENV_PYTHON });
  await host.ok('kernel', { name: kernelName });
  await host.ok('feature', { name: 'jupyter', on: true });
  await host.ok('consent', { project: PROJECT, granted: true });
  return status;
}

test('selection gates: nothing runs without toggle, consent and a discovered interpreter; wrong executables and kernels are refused', async () => {
  rmSync(settings, { force: true });
  const host = connect();
  try {
    const status = await host.ok('status', { project: PROJECT });
    assert.equal(status.sandbox, true); assert.equal(status.consent, false); assert.equal(status.features.jupyter.on, false);
    assert.ok(status.kernels.some(k => k.name === 'python3' && k.usable) && status.kernels.some(k => k.name === 'ir' && k.language === 'r'));
    assert.doesNotMatch(JSON.stringify(status), new RegExp(SECRET));
    for (const path of ['/bin/sh', join(work, 'python'), '/usr/bin/env', ENV_PYTHON + '/../python3-config', 'relative/python']) assert.match((await host.call('select', { kind: 'python', path })).error, /not a discovered/i, path);
    writeFileSync(join(work, 'python'), '#!/bin/sh\necho Python 3.99\n'); chmodSync(join(work, 'python'), 0o755);
    assert.match((await host.call('select', { kind: 'python', path: join(work, 'python') })).error, /not a discovered/i);
    assert.match((await host.call('kernel', { name: 'no-such-kernel' })).error, /not a discovered kernel/i);
    assert.match((await host.call('feature', { name: 'jupyter', on: true })).error, /No Python environment/i);
    assert.match((await host.call('start', { project: PROJECT })).error, /turned off/i);
    await host.ok('select', { kind: 'python', path: ENV_PYTHON }); await host.ok('kernel', { name: 'python3' }); await host.ok('feature', { name: 'jupyter', on: true });
    assert.match((await host.call('start', { project: PROJECT })).error, /not been approved/i, 'no consent, no kernel');
    assert.match((await host.call('run', { project: PROJECT, cell: 'a.py', code: '1' })).error, /No kernel is running/);
    assert.match((await host.call('nonsense')).error, /Unknown operation/);
    const mode = statSync(settings).mode & 0o777; assert.equal(mode, 0o600); assert.doesNotMatch(readFileSync(settings, 'utf8'), new RegExp(SECRET));
  } finally { await host.close(); }
});

test('python kernel: confined run, hostile output, timeout, interrupt, restart, denials, secrets; measured', async () => {
  const listener = net.createServer(socket => socket.destroy()); await new Promise(r => listener.listen(0, '127.0.0.1', r)); let hits = 0; listener.on('connection', () => hits++);
  const host = connect();
  try {
    await prepare(host, 'python3');
    let t = performance.now(); const started = await host.ok('start', { project: PROJECT }); measurements.pythonStartMs = Math.round(performance.now() - t);
    assert.equal(started.status, 'ok', JSON.stringify(started)); assert.equal(started.language, 'python');
    assert.match((await host.call('start', { project: PROJECT })).error, /already running/);
    const trips = []; for (let i = 0; i < 9; i++) { t = performance.now(); assert.equal(text(await host.run(`print(${i}+1)`)).trim(), String(i + 1)); trips.push(performance.now() - t); }
    measurements.pythonRoundTripMedianMs = Math.round(trips.sort((a, b) => a - b)[4]);
    const r1 = await host.run('import sys; x = 41; print(sys.executable.endswith("myproject/bin/python"), sys.prefix.endswith("myproject"))');
    assert.equal(text(r1).trim(), 'True True', 'the kernel is the selected environment\'s, not another python3 kernelspec'); assert.equal(r1.provenance.kernel, 'python3');
    assert.match(r1.provenance.code, /^[0-9a-f]{64}$/); assert.equal(r1.provenance.cell, 'cells/a.py');
    // secrets: no inherited keys, the connection key is redacted even when the code prints it
    const env = await host.run('import os, json, glob\nprint(sorted(k for k in os.environ if "KEY" in k or "TOKEN" in k or "SECRET" in k))\nf = glob.glob(os.environ["TMPDIR"] + "/kernel-*/k.json")[0]\nprint(json.load(open(f))["key"])');
    assert.match(text(env), /^\[\]\n<REDACTED>\n$/, text(env));
    // home, files outside the job, network and processes are refused
    const deny = await host.run(`import os, socket, subprocess
def tryit(name, f):
    try: f(); print(name, "ALLOWED")
    except Exception as e: print(name, "denied", type(e).__name__)
tryit("list-home", lambda: os.listdir(${JSON.stringify(HOME)}))
tryit("open-home-file", lambda: open(${JSON.stringify(join(HOME, '.zshrc'))}).close())
tryit("list-users", lambda: os.listdir("/Users"))
tryit("write-outside", lambda: open("/private/tmp/lr-escape-${randomBytes(3).toString('hex')}", "w").close())
tryit("etc-passwd", lambda: open("/etc/passwd").read())
tryit("connect-loopback", lambda: socket.create_connection(("127.0.0.1", ${listener.address().port}), timeout=2))
tryit("connect-external", lambda: socket.create_connection(("192.0.2.1", 80), timeout=2))
tryit("dns", lambda: socket.getaddrinfo("example.com", 80))
tryit("spawn-shell", lambda: subprocess.run(["/bin/sh", "-c", "echo hi"], check=True))
tryit("spawn-curl", lambda: subprocess.run(["/usr/bin/curl", "-s", "http://192.0.2.1"], check=True))
tryit("write-job", lambda: open("ok.txt", "w").write("ok"))`);
    const lines = Object.fromEntries(text(deny).trim().split('\n').map(line => line.split(' ').slice(0, 2)));
    for (const name of ['list-home', 'open-home-file', 'list-users', 'write-outside', 'etc-passwd', 'connect-loopback', 'connect-external', 'dns', 'spawn-shell', 'spawn-curl']) assert.equal(lines[name], 'denied', `${name}: ${text(deny)}`);
    assert.equal(lines['write-job'], 'ALLOWED'); assert.equal(hits, 0, 'the loopback listener was never reached');
    // hostile rich output stays inert data
    const rich = await host.run(`from IPython.display import display
display({'text/html': '<img src=x onerror=alert(1)>', 'application/javascript': 'alert(1)', 'text/plain': 'plain'}, raw=True)
display({'image/svg+xml': '<svg onload=alert(1)/>'}, raw=True)
print("\\x1b[31mred\\x1b[0m")
print("y" * 400000)`);
    assert.deepEqual(rich.blocked, ['application/javascript', 'image/svg+xml', 'text/html']); assert.doesNotMatch(JSON.stringify(rich.items), /alert|\x1b/);
    assert.ok(rich.truncated && JSON.stringify(rich).length < 400000, 'output is bounded');
    // wall-clock timeout interrupts; the kernel keeps its state
    t = performance.now(); const slow = await host.run('while True: pass', { timeout: 2 }); assert.equal(slow.status, 'timeout'); assert.ok(performance.now() - t < 9000);
    assert.equal(text(await host.run('print(x)')).trim(), '41');
    // Stop (interrupt) during a run
    const sleeping = host.run('import time; time.sleep(30)'); await new Promise(r => setTimeout(r, 700)); t = performance.now(); await host.ok('interrupt');
    const stopped = await sleeping; assert.equal(stopped.status, 'canceled'); measurements.interruptMs = Math.round(performance.now() - t);
    // memory of the confined tree while idle
    measurements.pythonPeakRssMb = Math.round(tree(host.child.pid).rssKb / 1024);
    // restart clears state; fresh order
    assert.equal((await host.ok('restart')).status, 'ok'); const gone = await host.run('print(x)'); assert.equal(gone.status, 'error'); assert.equal(gone.provenance.order, 0);
    assert.doesNotMatch(host.raw.join('\n'), new RegExp(SECRET));
  } finally { await host.close(); listener.close(); }
  assert.ok(await until(() => leftovers().length === 0), 'no kernel process survives the closed connection: ' + leftovers());
});

test('limits: a memory hog is stopped, the whole tree is killed and reported; the connection then starts a fresh kernel', async () => {
  const host = connect();
  try {
    await prepare(host, 'python3'); assert.equal((await host.ok('start', { project: PROJECT })).status, 'ok');
    const root = tree(host.child.pid).pids;
    const hog = host.call('run', { project: PROJECT, cell: 'hog.py', code: 'b = []\nwhile True: b.append(b"\\1" * (64 << 20))', timeout: 60 });
    assert.ok(await until(() => host.events.some(e => e.ev === 'ended'), 60000), 'session ended');
    assert.equal(host.events.find(e => e.ev === 'ended').reason, 'memory_limit'); assert.match((await hog).error, /memory limit/, 'the in-flight run is answered');
    assert.ok(await until(() => root.every(pid => spawnSync('/bin/kill', ['-0', String(pid)]).status !== 0)), 'every process of the session is gone');
    assert.match((await host.call('run', { project: PROJECT, cell: 'a.py', code: '1' })).error, /No kernel is running/);
    assert.equal((await host.ok('start', { project: PROJECT })).status, 'ok'); assert.equal(text(await host.run('print(2)')).trim(), '2');
    await host.ok('consent', { project: PROJECT, granted: false }); // withdrawing consent stops the kernel and further runs
    assert.ok(await until(() => host.events.filter(e => e.ev === 'ended').length === 2));
    assert.match((await host.call('start', { project: PROJECT })).error, /not been approved/);
  } finally { await host.close(); }
  assert.ok(await until(() => leftovers().length === 0), 'no survivors');
});

test('editor tools (research-ui transport): probe without consent, analysis only with toggle and consent, Stop cancels', async () => {
  rmSync(settings, { force: true });
  const host = connect();
  const script = (request, extra = {}) => host.call('script', { tool: 'python', project: PROJECT, request, timeout: 30, ...extra });
  try {
    const describe = { op: 'describe', data: { a: [1, 2, 3, 4] }, columns: ['a'] };
    assert.match((await script({ op: 'version' })).error, /No Python environment/i, 'nothing runs before a selection');
    await host.ok('select', { kind: 'python', path: ENV_PYTHON });
    const status = await host.ok('status', { project: PROJECT });
    // the environment decides: math check is ready exactly when SymPy imports there (it was absent from myproject before 2026-11-23)
    const hasSympy = spawnSync(ENV_PYTHON, ['-I', '-c', 'import sympy']).status === 0;
    assert.equal(status.features['python-analysis'].ready, true);
    if (hasSympy) assert.equal(status.features['math-check'].ready, true); else assert.match(String(status.features['math-check'].ready), /^sympy is not installed in the selected Python environment$/, 'math check reports the missing package');
    assert.equal(typeof (await script({ op: 'version' })).result, 'object', 'the readiness probe needs no consent');
    assert.match((await script(describe)).error, /turned off/);
    await host.ok('feature', { name: 'python-analysis', on: true });
    assert.match((await script(describe)).error, /not been approved/);
    await host.ok('consent', { project: PROJECT, granted: true });
    const done = await script(describe); assert.equal(done.result?.status, 'computed', JSON.stringify(done));
    assert.match((await host.call('script', { tool: 'shell', project: PROJECT, request: {} })).error, /Unknown tool/);
    // Stop: a large analysis is canceled through cancel-script and the next request still runs
    const big = script({ op: 'optimize', objective: 'lad', y: 'y', x: ['x'], data: { y: Array.from({ length: 2000 }, (_, i) => i % 7), x: Array.from({ length: 2000 }, (_, i) => i) } });
    await new Promise(r => setTimeout(r, 300)); await host.ok('cancel-script');
    const stopped = await big; assert.ok(stopped.result && ['canceled', 'computed'].includes(stopped.result.status), JSON.stringify(stopped));
    assert.equal((await script(describe)).result?.status, 'computed');
  } finally { await host.close(); }
});

test('R kernel (ir): confined run, denials, timeout', async () => {
  const host = connect();
  try {
    await prepare(host, 'ir');
    let t = performance.now(); const started = await host.ok('start', { project: PROJECT }); measurements.rStartMs = Math.round(performance.now() - t);
    assert.equal(started.status, 'ok', JSON.stringify(started)); assert.equal(started.language, 'R');
    t = performance.now(); assert.equal(text(await host.run('cat(mean(c(1, 2, 3)))', { cell: 'cells/a.R' })).trim(), '2'); measurements.rRoundTripMs = Math.round(performance.now() - t);
    const deny = await host.run(`tryit <- function(name, expr) cat(name, tryCatch({ force(expr); "ALLOWED" }, error = function(e) "denied", warning = function(w) "denied"), "\\n")
tryit("list-home", { x <- list.files(${JSON.stringify(HOME)}); if (!length(x)) stop("none") })
tryit("read-home", readLines(${JSON.stringify(join(HOME, '.zshrc'))}, n = 1))
# finding (as in research_confinement): R's launcher needs /bin/sh, so system() reaches a confined shell; other programs and the home stay denied
tryit("system-home", { x <- system(paste("ls", ${JSON.stringify(HOME)}), intern = TRUE, ignore.stderr = TRUE); if (!length(x)) stop("none") })
tryit("url", readLines(url("http://192.0.2.1/"), n = 1))
tryit("env", if (nzchar(Sys.getenv("OPENAI_API_KEY"))) "leak" else stop("absent"))`, { cell: 'cells/a.R' });
    for (const line of text(deny).trim().split('\n')) assert.match(line.trim(), / denied$/, text(deny));
    assert.equal((await host.run('Sys.sleep(60)', { cell: 'cells/a.R', timeout: 2 })).status, 'timeout');
    measurements.rPeakRssMb = Math.round(tree(host.child.pid).rssKb / 1024);
  } finally { await host.close(); }
  assert.ok(await until(() => leftovers().length === 0), 'no survivors');
  console.log('measurements', JSON.stringify(measurements));
});
