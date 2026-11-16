// Synthetic cold-backup drill. Never mounts or stops an existing instance.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, createReadStream, createWriteStream, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
// Colima shares the home directory, not macOS /var/folders temporary paths.
const root = mkdtempSync(join(homedir(), '.latex-backup-'));
const prefix = 'latex-backup-' + randomBytes(6).toString('hex');
const label = 'latex.backup.fixture=' + prefix;
const appImage = process.env.HOSTING_APP_IMAGE || 'sha256:74cfc2b291106a146a3945a2db1c5f354cda841531d1a2a69107d74098a2c50a';
assert.match(appImage, /^sha256:[a-f0-9]{64}$/);
const mongoImage = 'sha256:d97fea17ccb8d004cd137be8dab54d70d0df11be69c9f422aefe4484c8414ab7';
const redisImage = 'sha256:2e3eb11462c4e3759e6972678dd051d150ff54b1e60714b3c33b701260172a90';
const resticImage = 'restic/restic@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510';
const owned = { container: [], volume: [], network: [] };
const users = ['Alice', 'Bob', 'Carol'].map(first_name => ({ first_name, last_name: 'Backup Fixture',
  email: `qualification-${randomBytes(10).toString('hex')}@example.test`, password: randomBytes(24).toString('hex'), analyticsId: randomUUID() }));
const source = '\\documentclass{article}\n\\begin{document}\nCold restore fixture.\n\\input{chapter}\n\\end{document}\n';
const editedSource = source.replace('Cold restore fixture.', 'Saved edit survives cold restore.');
const files = { 'main.tex': Buffer.from(editedSource), 'chapter.tex': Buffer.from('Exact child source: café.\n'),
  'figure.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64') };
let browser, projectId, success = false;
const metrics = {};
function docker(args, input) {
  return execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 180000, maxBuffer: 8 * 1024 * 1024 }).trim();
}
function privateFile(path, content) { writeFileSync(path, content, { mode: 0o600 }); }
function createVolume(suffix) {
  const name = prefix + '-' + suffix; docker(['volume', 'create', '--label', label, name]); owned.volume.push(name); return name;
}
function mount(source, target, ro = true) { return ['--mount', `type=volume,src=${source},dst=${target}${ro ? ',readonly' : ''}`]; }
function bind(source, target) { return ['--mount', `type=bind,src=${source},dst=${target},readonly`]; }
function run(name, args) {
  assert(name.startsWith(prefix + '-')); owned.container.push(name); docker(['run', '-d', '--name', name, '--label', label, ...args]);
}
async function waitFor(check, description, timeout = 120000) {
  const start = performance.now(); let last;
  while (performance.now() - start < timeout) {
    try { if (await check()) return; } catch (error) { last = error; }
    await delay(1000);
  }
  throw Error('Timed out: ' + description, { cause: last });
}
function network(suffix, internal = true) {
  const name = prefix + '-' + suffix; docker(['network', 'create', ...(internal ? ['--internal'] : []), '--label', label, name]); owned.network.push(name); return name;
}
function makeStack(suffix) {
  return { suffix, network: network(suffix), app: prefix + '-' + suffix + '-app', mongo: prefix + '-' + suffix + '-mongo', redis: prefix + '-' + suffix + '-redis',
    appVolume: createVolume(suffix + '-app'), mongoVolume: createVolume(suffix + '-mongo'), redisVolume: createVolume(suffix + '-redis') };
}
async function startStores(stack, initialize) {
  run(stack.mongo, ['--network', stack.network, '--network-alias', 'mongo', '--memory=1g', ...mount(stack.mongoVolume, '/data/db', false), mongoImage,
    'mongod', '--replSet', 'rs0', '--bind_ip_all', '--wiredTigerCacheSizeGB', '0.25']);
  run(stack.redis, ['--network', stack.network, '--network-alias', 'redis', '--memory=256m', ...mount(stack.redisVolume, '/data', false), redisImage,
    'redis-server', '--appendonly', 'yes']);
  await waitFor(() => docker(['exec', stack.mongo, 'mongosh', '--quiet', '--eval', 'db.runCommand({ping:1}).ok']) === '1', 'Mongo ready');
  if (initialize) docker(['exec', stack.mongo, 'mongosh', '--quiet', '--eval', 'rs.initiate({_id:"rs0",members:[{_id:0,host:"mongo:27017"}]})']);
  await waitFor(() => docker(['exec', stack.mongo, 'mongosh', '--quiet', '--eval', 'db.hello().isWritablePrimary']) === 'true', 'Mongo primary');
}
async function startApp(stack, config) {
  // Docker suppresses published ports on internal-only networks. Only the app joins ingress.
  const ingress = network(stack.suffix + '-ingress', false); owned.container.push(stack.app);
  docker(['create', '--name', stack.app, '--label', label, '--network', stack.network, '--network-alias', 'sharelatex', '--publish', '127.0.0.1::80', '--memory=4g', '--cpus=2', '--pids-limit=512',
    '--env-file', join(config, 'private.env'), '--env', 'OVERLEAF_MONGO_URL=mongodb://mongo/sharelatex?replicaSet=rs0',
    '--env', 'OVERLEAF_REDIS_HOST=redis', '--env', 'REDIS_HOST=redis', '--env', 'REDIS_PORT=6379', '--env', 'V1_HISTORY_URL=http://sharelatex:3100/api',
    ...mount(stack.appVolume, '/var/lib/overleaf', false), ...(process.env.HOSTING_APP_IMAGE ? [] : [
      ...bind(join(config, 'settings.cjs'), '/etc/overleaf/settings.js'), ...bind(join(config, 'base.cjs'), '/etc/overleaf/fixture-base.cjs'),
      ...bind(join(config, 'CompileManager.mjs'), '/overleaf/services/web/app/src/Features/Compile/CompileManager.mjs')]), appImage]);
  docker(['network', 'connect', ingress, stack.app]); docker(['start', stack.app]);
  await waitFor(() => {
    const address = docker(['port', stack.app, '80/tcp']);
    if (!address) return false; stack.base = 'http://' + address; return true;
  }, 'published loopback port', 20000);
  await waitFor(async () => (await fetch(stack.base + '/login', { signal: AbortSignal.timeout(3000) })).status === 200, 'app login', 180000);
}
async function login(stack, user) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: process.env.HOSTING_APP_IMAGE ? 'allow' : 'block' });
  await context.addInitScript(() => { globalThis.participantResults = []; document.addEventListener('overleaf:participant-result', e => participantResults.push(e.detail)); });
  await context.route('**/*', route => new URL(route.request().url()).origin === stack.base ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(25000);
  await page.goto(stack.base + '/login'); await page.locator('input[name=email]').fill(user.email);
  await page.locator('input[name=password]').fill(user.password); await page.getByRole('button', { name: /^Login/ }).click();
  await page.waitForURL(stack.base + '/project'); return page;
}
async function checkZip(page, stack, suffix) {
  const response = await page.request.get(stack.base + '/Project/' + projectId + '/download/zip'); assert(response.ok(), 'Authorized source ZIP');
  const path = join(root, suffix + '.zip'); privateFile(path, await response.body());
  const names = execFileSync('/usr/bin/unzip', ['-Z1', path], { encoding: 'utf8' }).trim().split('\n').filter(n => !n.endsWith('/'));
  assert.deepEqual(names.sort(), Object.keys(files).sort(), 'Exact exported file roster');
  for (const [name, expected] of Object.entries(files)) assert.deepEqual(execFileSync('/usr/bin/unzip', ['-p', path, name]), expected, name);
}
async function compileRefused(page) {
  const csrf = await page.evaluate(() => {
    const raw = document.querySelector('meta[name="ol-csrfToken"]').content;
    try { return JSON.parse(raw); } catch { return raw; }
  });
  // APIRequestContext bypasses the browser's participant fetch interception.
  const response = await page.request.post(page.url() + '/compile', { headers: { 'X-CSRF-Token': csrf }, data: {} });
  assert.equal(response.status(), 200); assert.equal((await response.json()).status, 'error', 'Server TeX must refuse compilation');
}
async function checkParticipant(page) {
  if (!process.env.HOSTING_APP_IMAGE) return;
  // Plain project URL must compile locally without the opt-in query parameter.
  assert(!new URL(page.url()).searchParams.has('participant-compile'));
  const target = page.locator('.textLayer span').filter({ hasText: /^Saved edit survives cold restore\./ }).first();
  await target.waitFor({ timeout: 180000 });
  const navigation = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/sync/pdf'));
  await target.dblclick(); const response = await navigation; assert(response.ok());
  assert((await response.json()).code?.some(p => p.file === 'main.tex' && p.line === 3), 'Restored PDF maps to exact source');
  const forward = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/sync/code'));
  await page.getByRole('button', { name: /go to code location in pdf/i }).click();
  const forwardResponse = await forward; assert(forwardResponse.ok());
  assert((await forwardResponse.json()).pdf?.some(p => p.page === 1), 'Source maps to actual PDF page');
  const pdf = await page.evaluate(async () => {
    const resource = performance.getEntriesByType('resource').filter(e => /\/output\/output.pdf/.test(e.name)).at(-1);
    if (!resource) throw Error('No participant PDF'); return Array.from(new Uint8Array(await (await fetch(resource.name)).arrayBuffer()));
  });
  assert(Buffer.from(pdf).subarray(0, 5).equals(Buffer.from('%PDF-')));
  await page.evaluate(() => globalThis.overleafRecovery.offlineReady());
}
function stop(stack) {
  metrics[stack.suffix + 'Stop'] = [];
  for (const name of [stack.app, stack.mongo, stack.redis]) {
    const started = performance.now(); docker(['stop', '--time', '60', name]);
    const state = JSON.parse(docker(['inspect', '--format', '{{json .State}}', name]));
    metrics[stack.suffix + 'Stop'].push({ role: name.split('-').at(-1), ms: performance.now() - started, exitCode: state.ExitCode });
    // Pinned Phusion PID1 handles SIGTERM with full cleanup then exits2 (KeyboardInterrupt).
    let appStopped = false;
    if (name === stack.app && state.ExitCode === 2) {
      const log = spawnSync('docker', ['logs', '--tail', '30', name], { encoding: 'utf8', timeout: 10000 });
      appStopped = log.status === 0 && (log.stdout + log.stderr).includes('*** Running /etc/my_init.post_shutdown.d/10_syslog-ng.shutdown...');
    }
    assert(!state.OOMKilled && ([0, 143].includes(state.ExitCode) || appStopped), 'Cold backup requires clean store/app shutdown');
  }
}
function restic(repo, args, extras = [], password = 'password') {
  return docker(['run', '--rm', '--label', label, '--network', 'none', '--read-only', '--tmpfs', '/tmp', ...mount(repo, '/repo', false),
    ...bind(join(root, password), '/key'), '--env', 'RESTIC_REPOSITORY=/repo', '--env', 'RESTIC_PASSWORD_FILE=/key', '--env', 'RESTIC_CACHE_DIR=/tmp/cache',
    ...extras, resticImage, ...args]);
}
async function transfer(repo, transported) {
  const path = join(root, 'encrypted-repository.tar');
  // Only ciphertext crosses the host; no plaintext volume is exported.
  const out = spawn('docker', ['run', '--rm', '--label', label, '--network', 'none', '--entrypoint', '/bin/tar', ...mount(repo, '/repo'), redisImage, '-C', '/repo', '-cf', '-', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const outDone = new Promise((resolve, reject) => out.on('error', reject).on('close', code => code === 0 ? resolve() : reject(Error('Repository export failed'))));
  await Promise.all([outDone, pipeline(out.stdout, createWriteStream(path, { mode: 0o600 }))]);
  const into = spawn('docker', ['run', '--rm', '-i', '--label', label, '--network', 'none', '--entrypoint', '/bin/tar', ...mount(transported, '/repo', false), redisImage, '-C', '/repo', '-xf', '-'], { stdio: ['pipe', 'ignore', 'pipe'] });
  const inDone = new Promise((resolve, reject) => into.on('error', reject).on('close', code => code === 0 ? resolve() : reject(Error('Repository import failed'))));
  await Promise.all([inDone, pipeline(createReadStream(path), into.stdin)]); metrics.encryptedTransferBytes = statSync(path).size;
}
try {
  console.log('Fixture ' + prefix + ': building isolated source instance');
  const config = join(root, 'config'); mkdirSync(config, { mode: 0o700 });
  writeFileSync(join(config, 'base.cjs'), docker(['run', '--rm', '--network', 'none', '--entrypoint', 'cat', appImage, '/etc/overleaf/settings.js']), { mode: 0o644 });
  writeFileSync(join(config, 'settings.cjs'), `const s=require('/etc/overleaf/fixture-base.cjs');\ns.security={...s.security,sessionSecret:process.env.FIXTURE_SESSION_SECRET};\ns.participantCompilationOnly=true;\nmodule.exports=s;\n`, { mode: 0o644 });
  writeFileSync(join(config, 'CompileManager.mjs'), readFileSync(resolve('runtime/fast-preview/CompileManager.mjs')), { mode: 0o644 });
  const sessionSecret = randomBytes(48).toString('hex');
  privateFile(join(config, 'private.env'), 'FIXTURE_SESSION_SECRET=' + sessionSecret + '\nOVERLEAF_SESSION_SECRET=' + sessionSecret + '\nOVERLEAF_INVITE_TOKEN_SECRET=' + randomBytes(48).toString('hex') + '\n');
  privateFile(join(root, 'password'), randomBytes(48).toString('hex')); privateFile(join(root, 'wrong-password'), randomBytes(48).toString('hex'));
  for (const [name, bytes] of Object.entries(files)) privateFile(join(root, name), name === 'main.tex' ? source : bytes);
  execFileSync('/usr/bin/zip', ['-q', join(root, 'input.zip'), ...Object.keys(files)], { cwd: root });
  const sourceStack = makeStack('source'); let started = performance.now();
  await startStores(sourceStack, true); await startApp(sourceStack, config); metrics.sourceBootMs = performance.now() - started;
  const register = `import R from './app/src/Features/User/UserRegistrationHandler.mjs';let raw='';for await(const c of process.stdin)raw+=c;for(const u of JSON.parse(raw)){const v=await R.promises.registerNewUser(u);console.log('TEST_USER:'+v._id)}process.exit(0);`;
  const registered = docker(['exec', '-i', '-w', '/overleaf/services/web', sourceStack.app, 'node', '--input-type=module', '-e', register], JSON.stringify(users));
  assert.equal(registered.match(/TEST_USER:[a-f0-9]{24}/g)?.length, 3);
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  const alice = await login(sourceStack, users[0]);
  await alice.getByRole('button', { name: /^(New project|Create a new project)$/ }).click();
  await alice.getByText('Existing project (.zip)', { exact: true }).click(); await alice.locator('input[type=file]').first().setInputFiles(join(root, 'input.zip'));
  await alice.waitForURL(/\/project\/[a-f0-9]+/); projectId = alice.url().split('/').at(-1); assert.match(projectId, /^[a-f0-9]{24}$/);
  const editor = alice.getByRole('textbox', { name: /^Source Editor/ }); await editor.waitFor();
  await editor.evaluate((e, text) => { const view = e.cmView.view; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }); }, editedSource);
  const bob = await login(sourceStack, users[1]);
  await alice.getByRole('button', { name: /Share/ }).click(); const dialog = alice.getByRole('dialog');
  await dialog.locator('input[type=email]').fill(users[1].email); await dialog.getByRole('button', { name: 'Invite', exact: true }).click();
  await dialog.getByText(users[1].email, { exact: true }).waitFor(); await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
  await bob.reload(); const invite = bob.getByRole('alert').filter({ hasText: 'input' });
  await invite.getByRole('button', { name: 'Join Project', exact: true }).click(); await invite.getByText('Open Project', { exact: true }).waitFor();
  await bob.goto(sourceStack.base + '/project/' + projectId); await bob.getByRole('textbox', { name: /^Source Editor/ }).waitFor();
  await checkZip(alice, sourceStack, 'before'); await checkParticipant(alice); await compileRefused(alice);
  metrics.appMemoryPeakBytes = Number(docker(['exec', sourceStack.app, 'cat', '/sys/fs/cgroup/memory.peak']));
  await browser.close(); browser = null;
  console.log('Source edits, binary export, invitation and server-compile refusal verified; cold-stopping fixture only');
  started = performance.now(); stop(sourceStack);
  const repository = createVolume('encrypted');
  restic(repository, ['init']);
  const backup = restic(repository, ['backup', '/source', '--json', '--exclude', '/source/app/tmp', '--exclude', '/source/app/data/cache',
    '--exclude', '/source/app/data/compiles', '--exclude', '/source/app/data/output', '--exclude', '/source/app/data/clsi-uploads'],
    [...mount(sourceStack.appVolume, '/source/app'), ...mount(sourceStack.mongoVolume, '/source/mongo'), ...mount(sourceStack.redisVolume, '/source/redis'), ...bind(config, '/source/config')]);
  const summary = backup.split('\n').map(line => JSON.parse(line)).find(item => item.message_type === 'summary'); assert(summary?.snapshot_id);
  const snapshot = summary.snapshot_id; assert.match(snapshot, /^[a-f0-9]+$/);
  restic(repository, ['check', '--read-data']); metrics.coldBackupMs = performance.now() - started; metrics.processedBytes = summary.total_bytes_processed;
  assert.throws(() => restic(repository, ['snapshots', '--json'], [], 'wrong-password'), 'Wrong encryption key must be rejected');
  const transported = createVolume('transported'); await transfer(repository, transported);
  const restore = createVolume('restore'); started = performance.now();
  restic(transported, ['check', '--read-data']);
  restic(transported, ['restore', snapshot, '--target', '/restore', '--verify'], mount(restore, '/restore', false));
  const restored = makeStack('restored');
  for (const [dir, volume] of [['app', restored.appVolume], ['mongo', restored.mongoVolume], ['redis', restored.redisVolume]])
    docker(['run', '--rm', '--network', 'none', '--label', label, '--entrypoint', '/bin/cp', ...mount(restore, '/restore'), ...mount(volume, '/target', false), redisImage, '-a', '/restore/source/' + dir + '/.', '/target/']);
  const restoredConfig = join(root, 'restored-config'); mkdirSync(restoredConfig, { mode: 0o700 });
  const helper = prefix + '-extract'; run(helper, ['--network', 'none', ...mount(restore, '/restore'), '--entrypoint', 'sleep', redisImage, '300']);
  docker(['cp', helper + ':/restore/source/config/.', restoredConfig]); docker(['stop', helper]);
  await startStores(restored, false); await startApp(restored, restoredConfig);
  metrics.restoreBootMs = performance.now() - started;
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  for (const user of users.slice(0, 2)) {
    const page = await login(restored, user); await page.goto(restored.base + '/project/' + projectId);
    const text = page.getByRole('textbox', { name: /^Source Editor/ }); await text.waitFor();
    assert.equal(await text.evaluate(e => e.cmView.view.state.doc.toString()), editedSource);
    await checkZip(page, restored, user.first_name); await checkParticipant(page); await compileRefused(page);
  }
  const carol = await login(restored, users[2]);
  const denied = await carol.request.get(restored.base + '/Project/' + projectId + '/download/zip');
  assert([403, 404].includes(denied.status()), 'Non-member may not export restored files');
  await browser.close(); browser = null; stop(restored); success = true;
  console.log(JSON.stringify({ passed: true, ...metrics }));
} catch (error) {
  // Do not print child command buffers or synthetic credentials. Keep recoverable data on failure.
  console.error(JSON.stringify({ passed: false, stageError: error.message?.slice(0, 200), fixture: prefix, privateScratch: root }));
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const name of owned.container.reverse()) {
    try { if (docker(['inspect', '--format', '{{index .Config.Labels "latex.backup.fixture"}}', name]) === prefix) docker(['stop', '--time', '60', name]); } catch {}
  }
  if (success) {
    for (const [type, names] of Object.entries(owned)) for (const name of names) {
      const format = type === 'container' ? '{{index .Config.Labels "latex.backup.fixture"}}' : '{{index .Labels "latex.backup.fixture"}}';
      assert.equal(docker([type, 'inspect', '--format', format, name]), prefix);
      docker([type, 'rm', ...(type === 'container' ? ['-v'] : []), name]); assert.throws(() => docker([type, 'inspect', name]));
    }
    rmSync(root, { recursive: true, force: true });
    console.log('Owned fixture containers, networks, volumes and private scratch removed.');
  } else console.error('Owned fixture services stopped; data retained for repair. Original instance untouched.');
}
