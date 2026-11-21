// SPDX-License-Identifier: AGPL-3.0-only
// Qualification of runtime/chrome-extension/research-host (latex-local-research) with hostile, synthetic scripts run by the
// user's real interpreters. Build first, then run:
//   cargo build --offline --release --manifest-path runtime/chrome-extension/research-host/Cargo.toml
//   node --test test/research_confinement.test.mjs
// Canaries live in a fake home under the temp directory; nothing here reads or writes a real user file. Each attack is
// recorded as BLOCKED or NOT BLOCKED in the final table; NOT BLOCKED rows that are by design are asserted as findings so a change is noticed.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = process.env.LATEX_RESEARCH_HELPER ?? join(ROOT, 'runtime/chrome-extension/research-host/target/release/latex-local-research');
const PY = process.env.RESEARCH_PYTHON ?? '/Users/macc/miniforge3/envs/myproject/bin/python', RS = process.env.RESEARCH_RSCRIPT ?? '/usr/local/bin/Rscript';
const IMAGE_ENV_PYTHON = '/Users/macc/miniforge3/envs/image_resizer/bin/python';
const TEMP = realpathSync(tmpdir()), work = mkdtempSync(join(TEMP, 'lr-test-'));
const home = join(work, 'home'), outside = join(work, 'outside'), scripts = join(work, 'scripts');
const MARK = `CANARY-${randomBytes(6).toString('hex')}`, SECRET = `SECRET-${randomBytes(6).toString('hex')}`;
const canary = { ssh: join(home, '.ssh', 'id_canary'), dot: join(home, `.latex-local-canary-${randomBytes(4).toString('hex')}`), data: join(outside, 'data.csv'), sibling: join(outside, 'sibling.txt') };
const table = [];
const record = (area, attack, blocked, note = '') => table.push({ area, attack, result: blocked === 'info' ? 'INFO' : blocked ? 'BLOCKED' : 'NOT BLOCKED', note });
const hostEnv = { PATH: process.env.PATH, HOME: home, TMPDIR: TEMP, FAKE_API_KEY: SECRET, AWS_SECRET_ACCESS_KEY: SECRET, OPENAI_API_KEY: SECRET };

for (const d of [join(home, '.ssh'), outside, scripts]) mkdirSync(d, { recursive: true });
for (const f of [canary.ssh, canary.dot, canary.sibling]) writeFileSync(f, `${MARK}\n`);
writeFileSync(canary.data, `a,b\n1,2\n${MARK}\n`);
const script = (name, text) => { const p = join(scripts, name); writeFileSync(p, text); return p; };

// ---- helper driver ------------------------------------------------------------------------------------------------
function start(request, { env = hostEnv } = {}) {
  const child = spawn(HELPER, [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', resolveStarted, resolveResult; const events = [];
  const started = new Promise(r => { resolveStarted = r; }), result = new Promise(r => { resolveResult = r; });
  child.stdout.on('data', chunk => { buffer += chunk; let i; while ((i = buffer.indexOf('\n')) >= 0) { const e = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); events.push(e); if (e.ev === 'started') resolveStarted(e.pid); else resolveResult(e); } });
  child.on('exit', () => { resolveStarted(null); resolveResult({ ev: 'result', status: 'helper_exited' }); });
  child.stdin.write(`${JSON.stringify({ op: 'run', ...request })}\n`);
  return { child, started, result, cancel: () => child.stdin.write('{"op":"cancel"}\n'), closeStdin: () => child.stdin.end(), events };
}
async function run(request, options) {
  const job = start(request, options);
  const timer = setTimeout(() => job.child.kill('SIGKILL'), ((request.timeout_s ?? 30) + 25) * 1000);
  const result = await job.result; clearTimeout(timer); job.child.stdin.end();
  if (job.child.exitCode === null) await new Promise(r => job.child.once('exit', r));
  return result;
}
const json = result => { try { return JSON.parse(result.stdout.trim().split('\n').at(-1)); } catch { assert.fail(`no probe JSON: ${JSON.stringify(result).slice(0, 600)}`); } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pgrep = pattern => spawnSync('/usr/bin/pgrep', ['-f', pattern], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).length;
const leftovers = () => readdirSync(TEMP).filter(n => n.startsWith('latex-local-research-'));

// Disposable same-user processes a hostile script might signal or attach to, and listeners it might connect to.
let victim, tcp, tcpHits = 0, unix, unixHits = 0, tcpPort, unixPath = join(outside, 'sock');
before(async () => {
  assert.ok(existsSync(HELPER), `Build the helper first: ${HELPER}`);
  victim = spawn('/bin/sleep', ['997']);
  tcp = net.createServer(s => { tcpHits++; s.destroy(); }); await new Promise(r => tcp.listen(0, '127.0.0.1', r)); tcpPort = tcp.address().port;
  unix = net.createServer(s => { unixHits++; s.destroy(); }); await new Promise(r => unix.listen(unixPath, r));
});
after(() => {
  victim?.kill('SIGKILL'); tcp?.close(); unix?.close();
  for (const n of leftovers()) rmSync(join(TEMP, n), { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  console.log(`\nConfinement attempts (${table.length}):`); console.table(table);
});

const params = () => ({ ssh: canary.ssh, dot: canary.dot, home, outside, repo: join(ROOT, 'package.json'), sibling_env: IMAGE_ENV_PYTHON, port: tcpPort, unix: unixPath, victim: victim.pid, outside_file: join(outside, 'written-by-script'), data: canary.data, sibling: canary.sibling });

// ---- Python probes ----------------------------------------------------------------------------------------------------
const PYTHON_PROBE = `
import json, os, sys, socket, subprocess, ctypes, signal
P = json.loads(sys.stdin.read()); R = {}
def t(name, fn):
    try: R[name] = {"allowed": True, "detail": str(fn())[:100]}
    except BaseException as e: R[name] = {"allowed": False, "err": type(e).__name__ + ":" + str(getattr(e, "errno", ""))}
rd = lambda p: open(p, "rb").read(50)
t("read_fake_ssh_canary", lambda: rd(P["ssh"])); t("read_fake_home_dotfile", lambda: rd(P["dot"])); t("read_etc_passwd", lambda: rd("/etc/passwd")); t("read_etc_hosts", lambda: rd("/etc/hosts"))
t("read_repo_file", lambda: rd(P["repo"])); t("read_sibling_conda_env", lambda: rd(P["sibling_env"])); t("read_unlisted_sibling_file", lambda: rd(P["sibling"]))
t("read_helper_profile", lambda: rd(os.path.join(os.getcwd(), "..", "ctl", "profile.sb"))); t("read_helper_captured_stdout", lambda: rd(os.path.join(os.getcwd(), "..", "ctl", "stdout")))
t("listdir_fake_home", lambda: os.listdir(P["home"])); t("listdir_users", lambda: os.listdir("/Users")); t("listdir_job_root", lambda: os.listdir(os.path.join(os.getcwd(), "..")))
t("listdir_temp_parent", lambda: os.listdir(os.path.dirname(os.path.dirname(os.getcwd()))))
t("stat_canary_metadata", lambda: os.stat(P["ssh"]).st_size); t("stat_home_dir_metadata", lambda: os.stat(P["home"]).st_mode)
t("write_outside_dir", lambda: open(P["outside_file"], "w").write("x")); t("write_fake_home", lambda: open(os.path.join(P["home"], "new"), "w").write("x"))
t("write_etc", lambda: open("/etc/latex-local-test", "w").write("x")); t("write_tmp_sibling", lambda: open("/tmp/latex-local-test", "w").write("x"))
t("rename_out_of_job", lambda: (open("move.txt", "w").write("x"), os.rename("move.txt", os.path.join(P["outside"], "moved.txt"))))
t("write_in_job_CONTROL", lambda: open("out/ok.txt", "w").write("ok")); t("read_job_script_CONTROL", lambda: rd("script.py"))
def tcp(h, p): s = socket.socket(); s.settimeout(3); s.connect((h, p)); return "connected"
t("net_tcp_loopback_listener", lambda: tcp("127.0.0.1", P["port"])); t("net_tcp_external", lambda: tcp("1.1.1.1", 53))
t("net_udp_external", lambda: socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(b"x", ("1.1.1.1", 53)))
t("net_dns_lookup", lambda: socket.getaddrinfo("example.com", 80)); t("net_listen_loopback", lambda: (lambda s: (s.bind(("127.0.0.1", 0)), s.listen(1)))(socket.socket()))
def unix():
    s = socket.socket(socket.AF_UNIX); s.settimeout(3); s.connect(P["unix"]); return "connected"
t("net_unix_socket_outside", unix)
t("spawn_subprocess_echo", lambda: subprocess.run(["/bin/echo", "x"], capture_output=True))
def system():
    rc = os.system("echo SPAWNED > out/spawned.txt")
    if rc != 0 or os.path.exists("out/spawned.txt"): raise PermissionError("os.system rc=%d (shell not executed)" % rc)
    return "ran"
t("spawn_os_system", system)
def forkit():
    pid = os.fork()
    if pid == 0: os._exit(0)
    return pid
t("spawn_os_fork", forkit); t("spawn_posix_spawn", lambda: os.posix_spawn("/bin/echo", ["echo"], {}))
def bomb():
    n = 0
    for _ in range(300):
        pid = os.fork()
        if pid == 0: os._exit(0)
        n += 1; os.waitpid(pid, 0)
    return n
t("fork_bomb_forks_succeeded", bomb)
secrets = [k for k, v in os.environ.items() if any(w in (k + v).upper() for w in ("FAKE_API", "SECRET", "AWS", "OPENAI"))]
R["env_secrets_visible"] = {"allowed": bool(secrets), "detail": ",".join(secrets), "env_names": sorted(os.environ)}
t("signal_victim_probe0", lambda: os.kill(P["victim"], 0)); t("signal_parent_probe0", lambda: os.kill(os.getppid(), 0)); t("signal_victim_sigterm", lambda: os.kill(P["victim"], signal.SIGTERM))
libc = ctypes.CDLL(None)
t("ptrace_attach_victim", lambda: libc.ptrace(10, P["victim"], 0, 0) == 0 or (_ for _ in ()).throw(PermissionError("ptrace refused")))
def tfp():
    port = ctypes.c_uint(0); rc = libc.task_for_pid(libc.mach_task_self(), P["victim"], ctypes.byref(port))
    if rc != 0: raise PermissionError("task_for_pid rc=%d" % rc)
t("task_for_pid_victim", tfp)
t("proc_list_visible", lambda: libc.proc_listallpids(None, 0) > 1 or (_ for _ in ()).throw(PermissionError("empty")))
def pidpath():
    b = ctypes.create_string_buffer(1024); n = libc.proc_pidpath(P["victim"], b, 1024)
    if n <= 0: raise PermissionError("proc_pidpath refused")
    return b.value.decode()
t("proc_pidpath_other_process", pidpath)
import pwd
t("identity_pwd_home_dir", lambda: pwd.getpwuid(os.getuid()).pw_dir); t("identity_hostname_uname", lambda: os.uname().nodename)
def shm():
    from multiprocessing import shared_memory; m = shared_memory.SharedMemory(create=True, size=16); m.close(); m.unlink(); return "created"
t("posix_shared_memory", shm)
for name, tgt in (("ssh", P["ssh"]), ("etc_passwd", "/etc/passwd")):
    t("symlink_create_to_" + name, lambda tgt=tgt, name=name: os.symlink(tgt, "out/link_" + name)); t("symlink_read_through_" + name, lambda name=name: rd("out/link_" + name))
    t("hardlink_to_" + name, lambda tgt=tgt, name=name: os.link(tgt, "out/hard_" + name))
os.symlink(P["home"], "out/dirlink")
sys.stdout.write("\\n" + json.dumps(R))
`;
const pyRun = (name = 'probe.py') => run({ interpreter: PY, script: script(name, PYTHON_PROBE), stdin: JSON.stringify(params()), timeout_s: 30 });
let pyProbe, pyResult;
const BLOCKED_PY = ['read_fake_ssh_canary', 'read_fake_home_dotfile', 'read_etc_passwd', 'read_etc_hosts', 'read_repo_file', 'read_sibling_conda_env', 'read_unlisted_sibling_file', 'read_helper_profile', 'read_helper_captured_stdout',
  'listdir_fake_home', 'listdir_users', 'listdir_job_root', 'listdir_temp_parent', 'stat_canary_metadata', 'stat_home_dir_metadata', 'write_outside_dir', 'write_fake_home', 'write_etc', 'write_tmp_sibling', 'rename_out_of_job',
  'net_tcp_loopback_listener', 'net_tcp_external', 'net_udp_external', 'net_dns_lookup', 'net_listen_loopback', 'net_unix_socket_outside',
  'spawn_subprocess_echo', 'spawn_os_system', 'spawn_os_fork', 'spawn_posix_spawn', 'signal_victim_probe0', 'signal_parent_probe0', 'signal_victim_sigterm', 'ptrace_attach_victim', 'task_for_pid_victim',
  'posix_shared_memory', 'symlink_read_through_ssh', 'symlink_read_through_etc_passwd', 'hardlink_to_ssh', 'hardlink_to_etc_passwd'];

test('python: every file, network, process, signal and IPC attack is refused; the job itself still works', async () => {
  pyResult = await pyRun(); assert.equal(pyResult.status, 'ok', JSON.stringify(pyResult).slice(0, 500)); pyProbe = json(pyResult);
  for (const name of BLOCKED_PY) { record('python', name, pyProbe[name] && !pyProbe[name].allowed, pyProbe[name]?.err ?? pyProbe[name]?.detail ?? 'missing'); assert.equal(pyProbe[name]?.allowed, false, `${name}: ${JSON.stringify(pyProbe[name])}`); }
  record('python', 'job-local write and read (control)', pyProbe.write_in_job_CONTROL.allowed && pyProbe.read_job_script_CONTROL.allowed, 'must be allowed');
  assert.ok(pyProbe.write_in_job_CONTROL.allowed && pyProbe.read_job_script_CONTROL.allowed);
  assert.equal(pyProbe.fork_bomb_forks_succeeded.allowed, false); record('python', 'fork bomb (300 forks)', true, pyProbe.fork_bomb_forks_succeeded.err);
  assert.equal(tcpHits, 0, 'a loopback listener received a connection'); assert.equal(unixHits, 0, 'the unix-socket listener received a connection'); assert.ok(alive(victim.pid), 'victim was signalled');
  assert.equal(pyProbe.env_secrets_visible.allowed, false, JSON.stringify(pyProbe.env_secrets_visible)); record('python', 'inherited API-key environment variables', !pyProbe.env_secrets_visible.allowed, pyProbe.env_secrets_visible.env_names.join(','));
  for (const key of ['err', 'stderr', 'stdout']) assert.ok(!(pyResult[key] ?? '').replace(/"detail"[^}]*/g, '').includes(MARK) && !(pyResult[key] ?? '').includes(SECRET));
});

test('python: results never carry canary or system-file content through symlinks or hard links', () => {
  assert.deepEqual(pyResult.files.map(f => f.path), ['ok.txt']);
  const dump = JSON.stringify(pyResult.files) + JSON.stringify(pyResult.skipped);
  assert.ok(!Buffer.from(pyResult.files[0].data, 'base64').toString().includes(MARK) && !dump.includes('root:'));
  assert.ok(pyResult.skipped.some(s => s.path.startsWith('link_')) || !pyProbe.symlink_create_to_ssh.allowed, 'symlinks are skipped, not followed');
  record('python', 'symlink in out/ to canary/etc/passwd returned by the helper', true, `created=${pyProbe.symlink_create_to_ssh.allowed}; skipped=${pyResult.skipped.length}`);
  record('python', 'hard link in out/ to canary/etc/passwd', !pyProbe.hardlink_to_ssh.allowed && !pyProbe.hardlink_to_etc_passwd.allowed);
});

test('findings that are NOT blocked and by design (documented, asserted so a change is noticed)', () => {
  const allowed = name => pyProbe[name].allowed;
  const findings = { proc_list_visible: 'other processes can be listed', proc_pidpath_other_process: 'executable path of other processes visible', identity_pwd_home_dir: 'real username/home path visible', identity_hostname_uname: 'hostname and OS version visible' };
  for (const [name, why] of Object.entries(findings)) record('python', `${name} (finding)`, !allowed(name), `${why}: ${pyProbe[name].detail ?? pyProbe[name].err}`);
  assert.equal(allowed('proc_list_visible'), true, 'finding changed: process listing is now blocked, update the report');
  // sysctl-read is required by the interpreters; user-name lookups go through the allowed libinfo mach service.
});

// ---- processes, exec, limits, cancellation ---------------------------------------------------------------------------
test('python: exec() of another binary replaces nothing', async () => {
  const r = await run({ interpreter: PY, script: script('exec.py', 'import os\ntry:\n    os.execv("/bin/echo", ["echo", "EXEC-ESCAPED"])\nexcept OSError as e:\n    print("exec blocked", e.errno)\n'), timeout_s: 20 });
  record('python', 'os.execv of /bin/echo', r.status === 'ok' && !r.stdout.includes('EXEC-ESCAPED'), r.stdout.trim()); assert.ok(r.stdout.includes('exec blocked') && !r.stdout.includes('EXEC-ESCAPED'));
});
test('python: ctypes cannot dlopen a library outside the allowed trees', async () => {
  const lib = join(outside, 'lib.dylib'); writeFileSync(lib, 'not a library');
  const r = await run({ interpreter: PY, script: script('dl.py', `import ctypes\ntry:\n    ctypes.CDLL(${JSON.stringify(lib)})\n    print("loaded")\nexcept OSError as e:\n    print("refused", str(e)[-170:])\n`), timeout_s: 20 });
  record('python', 'dlopen of file outside allowed trees', r.stdout.includes('refused') && /not permitted|denied|Permission|sandbox/i.test(r.stdout), r.stdout.trim().slice(-110)); assert.match(r.stdout, /refused/);
});
test('limits: infinite loop, memory hog, huge output and job growth end the job, leave no process and no scratch directory', async () => {
  const cases = [
    ['cpu/wall loop', 'while True: pass', { timeout_s: 2 }, 'timeout'],
    ['memory hog (256 MiB cap)', 'a = []\nwhile True: a.append(b"x" * 50_000_000)', { timeout_s: 20, max_memory_mb: 256 }, 'memory_limit'],
    ['huge stdout (100 kB cap)', 'import sys\nwhile True: sys.stdout.write("x" * 65536)', { timeout_s: 20, max_output: 100_000 }, 'output_limit'],
    ['job disk growth (8 MiB cap)', 'i = 0\nwhile True:\n    open("out/f%d" % i, "wb").write(b"x" * 1_000_000); i += 1', { timeout_s: 20, max_job_bytes: 8 << 20 }, 'job_limit'],
    ['sleeping job', 'import time\ntime.sleep(300)', { timeout_s: 2 }, 'timeout'],
  ];
  for (const [name, code, limits, expected] of cases) {
    const started = Date.now(), r = await run({ interpreter: PY, script: script('limit.py', code), ...limits });
    record('python', `limit: ${name}`, r.status === expected && r.orphans === 0, `${r.status} in ${Date.now() - started} ms`);
    assert.equal(r.status, expected, name); assert.equal(r.orphans, 0, name); assert.ok(r.stdout.length <= (limits.max_output ?? 1 << 20) + 1, name);
  }
  assert.deepEqual(leftovers(), [], 'job directories are removed');
});
test('cancel and stdin EOF stop the job; a SIGKILLed helper does not leave the job running forever', async () => {
  const sleeper = script('sleeper.py', 'import time\ntime.sleep(300)');
  for (const how of ['cancel', 'eof']) {
    const job = start({ interpreter: PY, script: sleeper, timeout_s: 60 }), pid = await job.started; assert.ok(alive(pid));
    how === 'cancel' ? job.cancel() : job.closeStdin(); const r = await job.result;
    record('python', `${how} stops the job`, r.status === 'canceled' && !alive(pid), r.status); assert.equal(r.status, 'canceled'); assert.ok(!alive(pid)); assert.equal(r.orphans, 0);
  }
  const job = start({ interpreter: PY, script: sleeper, timeout_s: 2 }), pid = await job.started; job.child.kill('SIGKILL');
  const killedAt = Date.now(); while (alive(pid) && Date.now() - killedAt < 15000) await new Promise(r => setTimeout(r, 200));
  record('python', 'helper SIGKILLed mid-job: job reaped by alarm', !alive(pid), `${Date.now() - killedAt} ms (alarm = timeout+5 s)`); assert.ok(!alive(pid), 'job survived its helper');
  for (const n of leftovers()) rmSync(join(TEMP, n), { recursive: true, force: true }); // a SIGKILLed helper cannot clean its scratch directory: finding
});

// ---- R ----------------------------------------------------------------------------------------------------------------
const R_PROBE = `
P <- jsonlite::fromJSON(file("stdin")); res <- list()
t <- function(name, expr) res[[name]] <<- tryCatch({ force(expr); list(allowed = TRUE) }, error = function(e) list(allowed = FALSE, err = conditionMessage(e)), warning = function(w) list(allowed = FALSE, err = conditionMessage(w)))
sys <- function(name, cmd, marker) res[[name]] <<- { out <- suppressWarnings(tryCatch(system(cmd, intern = TRUE, ignore.stderr = TRUE), error = function(e) character())); list(allowed = any(grepl(marker, out, fixed = TRUE)), detail = paste(head(out, 1), collapse = "")) }
t("read_fake_ssh_canary", readLines(P$ssh, n = 1)); t("read_etc_passwd", readLines("/etc/passwd", n = 1)); t("read_repo_file", readLines(P$repo, n = 1)); t("read_unlisted_sibling_file", readLines(P$sibling, n = 1))
t("write_outside_dir", writeLines("x", P$outside_file)); t("write_fake_home", writeLines("x", file.path(P$home, "new")))
t("net_socketConnection_loopback", socketConnection("127.0.0.1", P$port, open = "r+", timeout = 2))
sys("spawn_cat_canary", paste("/bin/cat", shQuote(P$ssh)), P$marker); sys("spawn_sh_cat_canary", paste("sh -c", shQuote(paste("cat", shQuote(P$ssh)))), P$marker)
sys("spawn_sh_builtin_read_canary", paste("sh -c", shQuote(paste("while IFS= read -r l; do echo $l; done <", shQuote(P$ssh)))), P$marker)
sys("spawn_curl_loopback", paste("/usr/bin/curl -s -o /dev/null -w CURLED http://127.0.0.1:", P$port, sep = ""), "CURLED")
sys("spawn_bash_devtcp_loopback", paste("/bin/bash -c", shQuote(sprintf("exec 3<>/dev/tcp/127.0.0.1/%d && echo SENT", P$port))), "SENT")
sys("spawn_python_binary", paste(shQuote(P$py), "-c 'print(\\"PYRAN\\")'"), "PYRAN")
sys("spawn_sh_kill_victim", paste("kill -9", P$victim, "&& echo KILLED"), "KILLED")
res[["env_secrets_visible"]] <- list(allowed = any(grepl("FAKE_API|SECRET|AWS|OPENAI", paste(names(Sys.getenv()), Sys.getenv()))), env_names = names(Sys.getenv()))
res[["shell_available_FINDING"]] <- { out <- suppressWarnings(tryCatch(system("echo SPAWNED", intern = TRUE, ignore.stderr = TRUE), error = function(e) character())); list(allowed = any(out == "SPAWNED")) }
t("read_job_script_CONTROL", readLines("script.R", n = 1)); t("write_in_job_CONTROL", writeLines("ok", "out/ok.txt"))
cat("\\n", jsonlite::toJSON(res, auto_unbox = TRUE), sep = "")
`;
test('R: file, network, signal and spawn attacks are refused; the shell R needs is the one permitted finding', async () => {
  const r = await run({ interpreter: RS, script: script('probe.R', R_PROBE), stdin: JSON.stringify({ ...params(), marker: MARK, py: PY }), timeout_s: 60 });
  assert.equal(r.status, 'ok', JSON.stringify(r).slice(0, 500)); const p = json(r);
  const blocked = ['read_fake_ssh_canary', 'read_etc_passwd', 'read_repo_file', 'read_unlisted_sibling_file', 'write_outside_dir', 'write_fake_home', 'net_socketConnection_loopback',
    'spawn_cat_canary', 'spawn_sh_cat_canary', 'spawn_sh_builtin_read_canary', 'spawn_curl_loopback', 'spawn_bash_devtcp_loopback', 'spawn_python_binary', 'spawn_sh_kill_victim'];
  for (const name of blocked) { record('R', name, !p[name].allowed, p[name].err ?? p[name].detail ?? ''); assert.equal(p[name].allowed, false, `${name}: ${JSON.stringify(p[name])}`); }
  assert.ok(p.read_job_script_CONTROL.allowed && p.write_in_job_CONTROL.allowed); record('R', 'job-local read/write (control)', true, 'must be allowed');
  assert.equal(p.env_secrets_visible.allowed, false); record('R', 'inherited API-key environment variables', true, p.env_secrets_visible.env_names.join(','));
  assert.equal(tcpHits, 0); assert.ok(alive(victim.pid));
  record('R', 'system("echo") runs /bin/sh (finding: R\'s own launcher needs it)', !p.shell_available_FINDING.allowed); assert.equal(p.shell_available_FINDING.allowed, true, 'finding changed');
});
test('R: libcurl network functions (url, download.file) cannot reach loopback or external hosts', async () => {
  for (const [name, code] of [['url() external', 'readLines(url("http://1.1.1.1/"), n = 1, warn = FALSE); cat("REACHED")'], ['url() loopback listener', `readLines(url("http://127.0.0.1:${tcpPort}/"), n = 1, warn = FALSE); cat("REACHED")`], ['download.file external', 'download.file("http://example.com/", tempfile(), quiet = TRUE); cat("REACHED")']]) {
    const r = await run({ interpreter: RS, script: script('net.R', code), timeout_s: 30 });
    record('R', `net: ${name}`, !r.stdout.includes('REACHED') && r.status !== 'ok', `${r.status}; ${r.stderr.replace(/\s+/g, ' ').slice(0, 90)}`); assert.ok(!r.stdout.includes('REACHED') && r.status !== 'ok', name);
  }
  await new Promise(r => setTimeout(r, 200)); assert.equal(tcpHits, 0, 'loopback listener was contacted');
});
test('R: process storm, job-control escape and runaway CPU leave no process behind', async () => {
  const storm = 'for (i in 1:200) system("sh -c \': STORM-MARK; while :; do :; done\' &", wait = FALSE, ignore.stderr = TRUE)\nSys.sleep(1)';
  const escape = 'system("sh -c \'set -m; : ESCAPE-MARK; (while :; do :; done) & sleep 0\'", wait = FALSE, ignore.stderr = TRUE)\nSys.sleep(1)';
  for (const [name, code, marker] of [['fork storm (200 busy shells)', storm, 'STORM-MARK'], ['job-control (set -m) process-group escape', escape, 'ESCAPE-MARK']]) {
    const r = await run({ interpreter: RS, script: script('storm.R', code), timeout_s: 15 });
    await new Promise(res => setTimeout(res, 300)); const left = pgrep(marker);
    record('R', name, left === 0 && r.orphans === 0, `status=${r.status}, orphans=${r.orphans}, marker processes after=${left}`); assert.equal(left, 0, `${name}: processes survived`); assert.equal(r.orphans, 0, name);
  }
  const r = await run({ interpreter: RS, script: script('loop.R', 'repeat {}'), timeout_s: 2 }); record('R', 'infinite loop', r.status === 'timeout' && r.orphans === 0, r.status); assert.equal(r.status, 'timeout');
  assert.deepEqual(leftovers(), []);
});

// ---- legitimate work under the sandbox ---------------------------------------------------------------------------------
const OLS = { op: 'ols', data: { y: [3.1, 4.9, 8.2, 8.8, 13.4, 13.1, 18.9, 17.6], x1: [1, 2, 3, 4, 5, 6, 7, 8], x2: [2.5, 1, 4.5, 3, 6.5, 4, 8.5, 5] }, y: 'y', x: ['x1', 'x2'] };
test('the real analysis scripts give identical results sandboxed and unsandboxed (numpy/pandas/statsmodels, R + jsonlite)', async () => {
  const direct = (cmd, args) => spawnSync(cmd, args, { input: JSON.stringify(OLS), encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } }).stdout;
  const py = await run({ interpreter: PY, script: join(ROOT, 'runtime/research/analysis.py'), stdin: JSON.stringify(OLS) });
  assert.equal(py.status, 'ok', py.stderr); assert.deepEqual(JSON.parse(py.stdout), JSON.parse(direct(PY, ['-B', '-I', join(ROOT, 'runtime/research/analysis.py')])));
  const r = await run({ interpreter: RS, script: join(ROOT, 'runtime/research/analysis.R'), stdin: JSON.stringify(OLS) });
  assert.equal(r.status, 'ok', r.stderr); assert.deepEqual(JSON.parse(r.stdout), JSON.parse(direct(RS, ['--vanilla', join(ROOT, 'runtime/research/analysis.R')])));
  record('both', 'analysis.py / analysis.R OLS under the sandbox = unsandboxed result', true, `python ${py.elapsed_ms} ms, R ${r.elapsed_ms} ms`);
});
test('matplotlib renders a PNG with its font cache inside the job and the helper returns it', async () => {
  const code = `import matplotlib; matplotlib.use("Agg")\nfrom matplotlib.figure import Figure\nimport os\nf = Figure(figsize=(4, 3)); ax = f.subplots(); ax.plot([1, 2, 3], [1, 4, 9]); ax.set_title("t")\nf.savefig("out/p.png", dpi=80)\nprint(matplotlib.get_configdir(), os.listdir(os.environ["MPLCONFIGDIR"]))`;
  const r = await run({ interpreter: PY, script: script('mpl.py', code), timeout_s: 60 });
  assert.equal(r.status, 'ok', r.stderr + r.stdout); assert.ok(r.stdout.includes(join('latex-local-research-')) && /fontlist/.test(r.stdout), r.stdout);
  const png = Buffer.from(r.files.find(f => f.path === 'p.png').data, 'base64'); assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  record('python', 'matplotlib PNG with font cache under MPLCONFIGDIR in the job', true, `${png.length} bytes, ${r.elapsed_ms} ms`);
});
test('explicit extra read grants are exact: a named file, never its siblings, never broad paths', async () => {
  const code = `import json\nr = {}\nfor name, p in json.loads(input()).items():\n    try: r[name] = open(p).read()[:12]\n    except OSError as e: r[name] = "denied"\nprint(json.dumps(r))`;
  const stdin = JSON.stringify({ data: canary.data, sibling: canary.sibling });
  let r = await run({ interpreter: PY, script: script('extra.py', code), stdin, extra_read: [canary.data] }); const got = json(r);
  assert.ok(got.data.startsWith('a,b')); assert.equal(got.sibling, 'denied'); record('python', 'extra_read of one file does not expose its siblings', got.sibling === 'denied');
  r = await run({ interpreter: PY, script: script('extra.py', code), stdin: JSON.stringify({ data: canary.data, sibling: canary.sibling }), extra_read: [outside] }); assert.equal(json(r).sibling.slice(0, 6), MARK.slice(0, 6));
  const evil = join(outside, 'evil") (allow file-read* (subpath "/'); mkdirSync(evil, { recursive: true });
  for (const bad of ['/', '/Users', home, dirname(home), '/etc', '/private/etc/hosts', '/System', '/nonexistent/zzz/data', evil]) {
    r = await run({ interpreter: PY, script: script('extra.py', code), extra_read: [bad] }); record('helper', `extra_read ${bad === evil ? 'policy-injection path' : bad}`, r.status === 'error', r.reason ?? r.status); assert.equal(r.status, 'error', bad);
    if (bad === evil) assert.match(r.reason, /Unsupported character/);
  }
});
test('request validation: only python/Rscript by absolute path, bounded numbers, malformed input refused', async () => {
  const ok = script('ok.py', 'print(1)'); mkdirSync(join(work, 'fake'), { recursive: true });
  const bad = [['/bin/sh', ok], ['python', ok], ['/usr/bin/perl', ok], ['/nonexistent/bin/python', ok], [PY, 'relative.py'], [PY, join(scripts, 'missing.py')]];
  for (const [interpreter, scriptPath] of bad) { const r = await run({ interpreter, script: scriptPath }); record('helper', `request: interpreter=${interpreter} script=${scriptPath.slice(-12)}`, r.status === 'error', r.reason); assert.equal(r.status, 'error', `${interpreter} ${scriptPath}`); }
  for (const limits of [{ timeout_s: 0 }, { timeout_s: 9999 }, { max_memory_mb: 99999 }, { max_output: -1 }]) { const r = await run({ interpreter: PY, script: ok, ...limits }); assert.equal(r.status, 'error', JSON.stringify(limits)); }
  const garbage = spawn(HELPER, [], { env: hostEnv }); let out = ''; garbage.stdout.on('data', c => { out += c; }); garbage.stdin.write('not json\n'); await new Promise(r => garbage.on('exit', r));
  assert.equal(JSON.parse(out).status, 'error'); assert.deepEqual(leftovers(), []);
});

// ---- cost ---------------------------------------------------------------------------------------------------------------
test('startup overhead: sandboxed versus direct, median of 9 trivial runs', async () => {
  const py = script('trivial.py', 'print(1)'), rs = script('trivial.R', 'cat(1)');
  const median = xs => xs.sort((a, b) => a - b)[xs.length >> 1];
  for (const [name, bin, file, args] of [['python', PY, py, ['-I', '-B']], ['R', RS, rs, ['--vanilla']]]) {
    const direct = [], boxed = [];
    for (let i = 0; i < 9; i++) {
      let t = performance.now(); spawnSync(bin, [...args, file], { env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } }); direct.push(performance.now() - t);
      t = performance.now(); const r = await run({ interpreter: bin, script: file }); boxed.push(performance.now() - t); assert.equal(r.status, 'ok');
    }
    const note = `direct ${median(direct).toFixed(0)} ms, sandboxed ${median(boxed).toFixed(0)} ms`; record(name, 'startup cost', 'info', note); console.log(`${name} startup: ${note}`);
  }
});
