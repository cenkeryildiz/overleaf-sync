import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { patchOutputAuthorization } from '../runtime/participant-compile/hosting/output-auth.mjs';
import { configuration } from '../runtime/participant-compile/hosting/configure.mjs';
import { safePath, prepareSnapshot, prepareResult } from '../runtime/participant-compile/artifacts.mjs';
import { patchPasses } from '../runtime/participant-compile/sdk-patch.mjs';
const fixture = () => ({ main: 'main.tex', active: 'chapters/one.tex', text: 'exact candidate', resources: [
  { path: 'main.tex', content: 'root' }, { path: 'chapters/one.tex', content: 'old' }, { path: 'figure.png', data: 'AA==' },
] });
async function claimWaitClient() {
  const timers = new Map(), listeners = new Map(); let serial = 0;
  const context = vm.createContext({ location: { pathname: '/' },
    document: { createElement: () => ({ style: {}, setAttribute() {} }), querySelector: () => null },
    addEventListener: (name, callback) => listeners.set(name, callback),
    setTimeout: (callback, delay) => { const id = ++serial; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id), clearInterval() {},
  });
  const source = readFileSync(new URL('../runtime/participant-compile/client.mjs', import.meta.url), 'utf8');
  const subject = new vm.SourceTextModule(source + '\nexport { notifyWork, waitForWork };', { context });
  await subject.link(name => {
    assert(name.startsWith('./busytex-sdk.mjs'));
    return new vm.SyntheticModule(['BusyTexRunner', 'PdfLatex', 'XeLatex', 'LuaLatex'], function () {
      for (const key of ['BusyTexRunner', 'PdfLatex', 'XeLatex', 'LuaLatex']) this.setExport(key, class { constructor() { assert.fail('Non-project claim wait must not initialize the compiler'); } });
    }, { context });
  });
  await subject.evaluate();
  return { ...subject.namespace, timers, pagehide: () => listeners.get('pagehide')() };
}
test('independent instances use their own Google callback and fresh persistent secrets', () => {
  const client = site => ({ web: { client_id: 'own-client.apps.googleusercontent.com', client_secret: 'synthetic-only',
    redirect_uris: [site + '/oidc/login/callback'] } });
  const a = configuration('https://one.example.test', client('https://one.example.test'));
  const b = configuration('https://two.example.test', client('https://two.example.test'), '8082');
  assert(a.includes('OVERLEAF_SITE_URL=https://one.example.test\n'));
  assert(b.includes('OVERLEAF_SITE_URL=https://two.example.test\n') && b.includes('LATEX_PORT=8082\n'));
  const secrets = text => [...text.matchAll(/^OVERLEAF_(?:INVITE_TOKEN|SESSION)_SECRET=([a-f0-9]{64})$/gm)].map(m => m[1]);
  assert.equal(new Set([...secrets(a), ...secrets(b)]).size, 4);
  for (const site of ['http://one.example.test', 'https://one.example.test/path', 'https://user:pass@one.example.test'])
    assert.throws(() => configuration(site, client('https://one.example.test')));
  assert.throws(() => configuration('https://two.example.test', client('https://one.example.test')), /exact site callback/);
  assert.throws(() => configuration('https://one.example.test', { installed: client('https://one.example.test').web }), /web client/);
  const missingSecret = client('https://one.example.test'); delete missingSecret.web.client_secret;
  assert.throws(() => configuration('https://one.example.test', missingSecret), /web client/);
  const malformedCallbacks = client('https://one.example.test'); malformedCallbacks.web.redirect_uris = malformedCallbacks.web.redirect_uris[0];
  assert.throws(() => configuration('https://one.example.test', malformedCallbacks), /exact site callback/);
  assert.throws(() => configuration('https://one.example.test', client('https://one.example.test'), '0'));
});
test('setup writes private configuration once and never prints or overwrites secrets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'latex-config-'));
  try {
    const input = join(directory, 'client.json'), output = join(directory, 'private.env');
    writeFileSync(input, JSON.stringify({ web: { client_id: 'synthetic.apps.googleusercontent.com',
      client_secret: 'private-fixture-secret', redirect_uris: ['https://own.example.test/oidc/login/callback'] } }));
    const args = [fileURLToPath(new URL('../runtime/participant-compile/hosting/configure.mjs', import.meta.url)),
      'https://own.example.test', input, output];
    const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
    if (process.platform === 'win32') {
      assert.equal(first.status, 1); assert.match(first.stderr, /Windows file ACL setup is not implemented/);
      assert(!existsSync(output)); assert(!(first.stdout + first.stderr).includes('private-fixture-secret')); return;
    }
    assert.equal(first.status, 0, first.stderr);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    const original = readFileSync(output, 'utf8'); assert(original.includes('private-fixture-secret'));
    const second = spawnSync(process.execPath, args, { encoding: 'utf8' }); assert.equal(second.status, 1);
    assert.equal(readFileSync(output, 'utf8'), original);
    assert(!(first.stdout + first.stderr + second.stdout + second.stderr).includes('private-fixture-secret'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('all fast PDF and cached-content paths check native project authorization first', () => {
  const backend = '\t\tproxy_pass http://127.0.0.1:8080; # clsi-nginx.conf';
  const source = '  # handle output files for specific users\n' + Array.from({ length: 4 }, (_, n) => `location /fixture${n} {\n${backend}\n}`).join('\n');
  const result = patchOutputAuthorization(source);
  assert.equal(result.split('auth_request /_participant_output_auth;').length - 1, 4);
  assert.equal(result.split(backend).length - 1, 4, 'Keep the fast file/range backend');
  assert.equal(result.split('add_header Cache-Control "private, no-store" always;').length - 1, 4);
  assert.equal(result.split('proxy_hide_header Expires;').length - 1, 4, 'Do not inherit the public one-day content cache');
  assert(result.includes('internal;') && result.includes('proxy_pass_request_body off;'));
  assert(result.includes('proxy_set_header Accept "application/json";'), 'Native global login must return 401 rather than redirect the auth subrequest');
  assert(result.includes('/project/$participant_output_project/participant-output-auth'));
  assert(result.includes('location ~ ^/(?:recovery|participant|js|fonts|images)/'));
  assert(result.includes('try_files $uri =404;') && result.includes('application/javascript js mjs;'));
  for (const invalid of ['', source + backend, result]) assert.throws(() => patchOutputAuthorization(invalid));
});
test('snapshots preserve exact source, binary inputs and selected compiler in the digest', () => {
  const a = prepareSnapshot(fixture()); assert.equal(a.resources[1].content, 'exact candidate');
  assert.equal(a.resources[2].data, 'AA=='); assert.equal(a.digest.length, 64);
  const changed = fixture(); changed.resources[2].data = 'AQ=='; assert.notEqual(a.digest, prepareSnapshot(changed).digest);
  assert.notEqual(a.digest, prepareSnapshot({ ...fixture(), compiler: 'xelatex' }).digest);
  assert.throws(() => prepareSnapshot({ ...fixture(), compiler: 'custom' }));
});
test('unsafe or ambiguous snapshot paths are refused', () => {
  for (const path of ['../secret', '/Users/macc/secret', 'a/../b', 'a//b', 'a\\b', 'https:x', 'a\ninput', '']) assert(!safePath(path), path);
  const duplicate = fixture(); duplicate.resources.push({ path: 'main.tex', content: 'other' }); assert.throws(() => prepareSnapshot(duplicate));
});
test('navigation is restricted to exact snapshot files and decompression is bounded', () => {
  const pdf = Buffer.from('%PDF-1.7\nsynthetic fixture\n');
  const sync = 'SyncTeX Version:1\nInput:1:/home/web_user/project_dir/main.tex\nInput:2:/etc/private\nInput:3:chapters/one.tex\nContent:\n';
  const result = prepareResult(Buffer.concat([pdf, gzipSync(sync)]), pdf.length, prepareSnapshot(fixture()), '/compile/fixture');
  const text = gunzipSync(result.synctex).toString(); assert(text.includes('Input:1:/compile/fixture/main.tex'));
  assert(text.includes('Input:3:/compile/fixture/chapters/one.tex')); assert(!text.includes('/etc/private')); assert.deepEqual(result.pdf, pdf);
  assert.throws(() => prepareResult(Buffer.concat([pdf, gzipSync('not navigation')]), pdf.length, prepareSnapshot(fixture()), '/compile/fixture'));
  assert.throws(() => prepareResult(Buffer.concat([pdf, gzipSync('x'.repeat(32 * 1024 * 1024 + 1))]), pdf.length, prepareSnapshot(fixture()), '/compile/fixture'));
});

test('browser compiler can request only fixed public assets with no private credentials', async () => {
  const requests = [];
  class XHR { open(method, url) { requests.push([method, url]); } }
  const load = path => {
    const context = { URL, location: new URL('https://fixture.test' + path), XMLHttpRequest: XHR, indexedDB: {}, postMessage() {},
      performance: { mark() {} }, WebAssembly: { instantiate: async () => {} },
      fetch: (url, options) => { requests.push([url, options]); return Promise.resolve(); }, importScripts: (...urls) => requests.push(urls) };
    context.self = context; vm.createContext(context);
    vm.runInContext(readFileSync(new URL('../runtime/participant-compile/worker.js', import.meta.url), 'utf8'), context);
    return context;
  };
  // Offline workers read packages from the verified Cache Storage copy; only connected workers keep Emscripten's IDB cache.
  assert.equal(load('/recovery/busytex/busytex_worker.js').indexedDB, undefined);
  const context = load('/participant/busytex/busytex_worker.js');
  assert.deepEqual(context.indexedDB, {});
  await context.fetch('texlive-basic.data', { credentials: 'include' });
  assert.equal(requests.at(-1)[1].credentials, 'omit');
  for (const path of ['https://outside.test/source', '/project/private/file', 'texlive-basic.data?source=private', '../secret', 'invented.sty']) {
    assert.throws(() => context.fetch(path)); assert.throws(() => context.importScripts(path));
    assert.throws(() => new context.XMLHttpRequest().open('GET', path));
  }
  assert.throws(() => new context.XMLHttpRequest().open('POST', 'texlive-basic.data'));
  assert.throws(() => new context.WebSocket('wss://outside.test'));
});

test('hosted settings require persistent secrets and public HTTPS with secure cookies', () => {
  const source = readFileSync(new URL('../runtime/participant-compile/hosting/settings.cjs', import.meta.url), 'utf8');
  function settings(siteUrl, env = { OVERLEAF_INVITE_TOKEN_SECRET: 'a'.repeat(64), OVERLEAF_SESSION_SECRET: 'b'.repeat(64) }) {
    const context = { URL, module: { exports: {} }, require: () => ({ siteUrl }), process: { env } };
    vm.runInNewContext(source, context); return context.module.exports;
  }
  assert(settings('https://latex.example.test').secureCookie);
  assert.equal(settings('http://127.0.0.1:8080').secureCookie, false);
  assert.equal(settings('https://latex.example.test').participantCompilationOnly, true);
  assert.throws(() => settings('http://latex.example.test'), /requires HTTPS/);
  for (const url of ['https://user:secret@latex.example.test', 'https://latex.example.test/path', 'file:///tmp'])
    assert.throws(() => settings(url), /plain HTTP/);
  assert.throws(() => settings('https://latex.example.test', {}), /persistent random secret/);
  assert.throws(() => settings('https://latex.example.test', { OVERLEAF_INVITE_TOKEN_SECRET: 'weak' }), /persistent random secret/);
  assert.throws(() => settings('https://latex.example.test', { OVERLEAF_INVITE_TOKEN_SECRET: 'a'.repeat(64),
    OVERLEAF_SESSION_SECRET: 'REPLACE_WITH_DIFFERENT_RANDOM_HEX_64' }), /persistent random secret/);
  const google = { OVERLEAF_INVITE_TOKEN_SECRET: 'a'.repeat(64), OVERLEAF_SESSION_SECRET: 'b'.repeat(64),
    EXTERNAL_AUTH: 'oidc', OVERLEAF_OIDC_PROVIDER_ID: 'google' };
  assert.throws(() => settings('https://latex.example.test', google), /private Google web-client credentials/);
  assert.throws(() => settings('https://latex.example.test', { ...google, OVERLEAF_OIDC_CLIENT_ID: 'REPLACE_WITH_ID', OVERLEAF_OIDC_CLIENT_SECRET: 'REPLACE_SECRET' }), /private Google web-client credentials/);
  const complete = { ...google, OVERLEAF_OIDC_CLIENT_ID: 'synthetic-123.apps.googleusercontent.com', OVERLEAF_OIDC_CLIENT_SECRET: 'synthetic-fixture-only' };
  assert(settings('https://latex.example.test', complete).secureCookie);
  assert.throws(() => settings('https://latex.example.test', { ...complete, OVERLEAF_OIDC_CLIENT_ID: 'wrong-client' }), /web OAuth client ID/);
});

test('offline preparation is bounded through response/abort, and native shutdown settles work without restart', async () => {
  const context = vm.createContext({ Buffer, setTimeout, clearTimeout, setInterval: () => ({ unref() {} }) });
  let cleanup, spawns = 0, kills = 0, respond = true, snapshotReader;
  const child = new EventEmitter(); child.stdout = new PassThrough();
  child.stdin = { write(line, done) {
    done?.(); const request = JSON.parse(line);
    if (respond) child.stdout.write(JSON.stringify({ id: request.id, ok: true, value: {} }) + '\n');
  } };
  child.kill = () => { kills++; child.emit('exit', null, 'SIGTERM'); return true; };
  const subject = new vm.SourceTextModule(readFileSync(new URL('../runtime/participant-compile/host.mjs', import.meta.url), 'utf8'), { context });
  await subject.link(async name => {
    let exports;
    if (name === 'node:child_process') exports = { spawn: () => { spawns++; return child; } };
    else if (name.endsWith('/SessionManager.mjs')) exports = { default: { getLoggedInUserId: session => session.user || 'a'.repeat(24) } };
    else if (name.endsWith('/GracefulShutdown.mjs')) exports = { addOptionalCleanupHandlerBeforeStoppingTraffic: (_, handler) => { cleanup = handler; } };
    else if (name.endsWith('/LivePreview.mjs')) exports = { snapshot: (...args) => { assert(args[3] && args[4]); return snapshotReader(); } };
    else if (name.endsWith('/ParticipantArtifacts.mjs')) exports = { prepareSnapshot, prepareResult() {} };
    else if (name.endsWith('/SessionCheckpoint.mjs')) exports = { checkpoint() { throw Error('Unexpected checkpoint'); } };
    else exports = await import(name);
    return new vm.SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value); }, { context });
  });
  await subject.evaluate();
  const request = { session: {}, params: { Project_id: 'b'.repeat(24) }, body: { op: 'join' } };
  const response = () => Object.assign(new EventEmitter(), { code: 200, set() {}, json(body) { this.body = body; return this; }, status(code) { this.code = code; return this; }, sendStatus(code) { this.code = code; return this; } });
  await subject.namespace.participantCompile(request, response()); assert.equal(spawns, 1);
  const reads = []; snapshotReader = () => new Promise(resolve => reads.push(resolve));
  const prepare = user => ({ ...request, session: { user }, body: { op: 'prepare-offline' } });
  const a = response(), b = response();
  const first = subject.namespace.participantCompile(prepare('a'.repeat(24)), a);
  const duplicate = response(); await subject.namespace.participantCompile(prepare('a'.repeat(24)), duplicate); assert.equal(duplicate.code, 429);
  const second = subject.namespace.participantCompile(prepare('b'.repeat(24)), b);
  const crowded = response(); await subject.namespace.participantCompile(prepare('c'.repeat(24)), crowded); assert.equal(crowded.code, 429);
  a.emit('close'); const aborted = response(); await subject.namespace.participantCompile(prepare('c'.repeat(24)), aborted);
  assert.equal(aborted.code, 429, 'Abort cannot release a slot while its snapshot is still being read');
  reads[0](fixture()); await first; assert.equal(a.body, undefined);
  reads[1](fixture()); await second;
  const held = response(); await subject.namespace.participantCompile(prepare('b'.repeat(24)), held); assert.equal(held.code, 429, 'Hold slot until response finishes');
  b.emit('finish'); snapshotReader = () => Promise.resolve(fixture());
  const released = response(); await subject.namespace.participantCompile(prepare('b'.repeat(24)), released);
  assert.equal(released.code, 200); assert(released.body.source.digest); released.emit('finish');
  respond = false; const pendingResponse = response(), pending = subject.namespace.participantCompile(request, pendingResponse);
  cleanup(); await pending; assert.equal(kills, 1); assert.equal(pendingResponse.code, 409);
  const after = response(); await subject.namespace.participantCompile(request, after); assert.equal(after.code, 409); assert.equal(spawns, 1);
});

// Drain the controlled promise chain without coupling assertions to its microtask depth.
const claimTurn = () => new Promise(resolve => setImmediate(resolve));
test('claim wake retains one early signal, coalesces duplicates, then resumes the750ms idle fallback', async () => {
  const client = await claimWaitClient();
  client.notifyWork(); client.notifyWork();
  let awake = false;
  client.waitForWork().then(() => { awake = true; });
  await claimTurn();
  assert(awake, 'A queued job must wake the next claim without waiting for a timer');
  assert.equal(client.timers.size, 0);
  let fallback = false;
  client.waitForWork().then(() => { fallback = true; });
  await claimTurn();
  assert.equal(fallback, false, 'Duplicate signals must not create a second immediate claim');
  assert.equal(client.timers.size, 1);
  const pending = [...client.timers.values()][0]; assert.equal(pending.delay, 750);
  pending.callback(); await claimTurn();
  assert(fallback); assert.equal(client.timers.size, 0);
  client.pagehide();
});

test('queued work interrupts an idle claim timer and pagehide settles the next wait without leaking a timer', async () => {
  const client = await claimWaitClient();
  let awake = false;
  client.waitForWork().then(() => { awake = true; });
  assert.equal(client.timers.size, 1);
  client.notifyWork(); client.notifyWork();
  await claimTurn();
  assert(awake); assert.equal(client.timers.size, 0);
  let closed = false;
  client.waitForWork().then(() => { closed = true; });
  assert.equal(client.timers.size, 1, 'Waking a sleeper consumes the signal rather than causing a busy loop');
  client.pagehide(); await claimTurn();
  assert(closed); assert.equal(client.timers.size, 0);
});

test('pagehide cancels only this page\'s queued job with keepalive so no device compiles an abandoned job', async () => {
  for (const queued of ['job-1', null]) {
    const listeners = new Map(), calls = [];
    const context = vm.createContext({ location: { pathname: '/project/' + 'a'.repeat(24) },
      document: { createElement: () => ({ style: {}, setAttribute() {} }), querySelector: () => null },
      addEventListener: (name, callback) => listeners.set(name, callback), setTimeout, clearTimeout, clearInterval, performance,
      overleafParticipantFetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body), keepalive: init.keepalive }); return { ok: true, json: async () => ({}) }; } });
    const source = readFileSync(new URL('../runtime/participant-compile/client.mjs', import.meta.url), 'utf8');
    const subject = new vm.SourceTextModule(source + '\nexport function queue(job) { lastJob = job; }', { context });
    await subject.link(() => new vm.SyntheticModule(['BusyTexRunner', 'PdfLatex', 'XeLatex', 'LuaLatex'], function () {
      this.setExport('BusyTexRunner', class { initialize() { return new Promise(() => {}); } terminate() {} });
      for (const key of ['PdfLatex', 'XeLatex', 'LuaLatex']) this.setExport(key, class {});
    }, { context }));
    await subject.evaluate();
    subject.namespace.queue(queued); listeners.get('pagehide')(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.map(call => [call.body.op, call.body.job, call.keepalive]), queued ? [['cancel', 'job-1', true]] : []);
    assert(calls.every(call => call.url === '/project/' + 'a'.repeat(24) + '/participant-compile'));
  }
});

test('a page\'s first claim waits for its own in-flight queue so an older job of the same user is superseded first', async () => {
  const listeners = new Map(), events = [];
  const reply = value => ({ ok: true, json: async () => value });
  const context = vm.createContext({ location: { pathname: '/project/' + 'b'.repeat(24) },
    document: { createElement: () => ({ style: {}, setAttribute() {} }), querySelector: () => null, dispatchEvent() {} }, CustomEvent: class {},
    Response, addEventListener: (name, callback) => listeners.set(name, callback), setTimeout, clearTimeout, setInterval, clearInterval, performance,
    overleafParticipantEditor: { facade: { getValue: () => 'text' }, docId: 'd'.repeat(24) },
    overleafParticipantFetch: async (url, init) => {
      const { op } = JSON.parse(init.body); events.push(op);
      if (op === 'join') return reply({ worker: 'w' });
      if (op === 'queue') { await new Promise(resolve => setTimeout(resolve, 30)); events.push('queued'); return reply({ job: 'j2', digest: 'x' }); }
      if (op === 'status') return reply({ state: 'complete', result: {} });
      return reply({ job: null });
    } });
  const source = readFileSync(new URL('../runtime/participant-compile/client.mjs', import.meta.url), 'utf8');
  const subject = new vm.SourceTextModule(source, { context });
  await subject.link(() => new vm.SyntheticModule(['BusyTexRunner', 'PdfLatex', 'XeLatex', 'LuaLatex'], function () {
    this.setExport('BusyTexRunner', class { async initialize() {} terminate() {} });
    for (const key of ['PdfLatex', 'XeLatex', 'LuaLatex']) this.setExport(key, class {});
  }, { context }));
  await subject.evaluate();
  const compiled = subject.namespace.compile(); // the editor asks for its open-time compile while the compiler is still starting
  await compiled;
  listeners.get('pagehide')();
  assert(events.indexOf('claim') > events.indexOf('queued'), JSON.stringify(events));
});

test('pdflatex pass fixed point compares every file TeX reads back and refuses a changed pinned anchor', () => {
  const loop = `                    ({ exit_code, log: last_log } = run(cmd, error_messages));

                    if (exit_code != 0)
                        break;

                    if (!this._needs_rerun(last_log)) {
                        if (cmd !== final_cmd) {`;
  const pinned = `class BusytexPipeline {\n    _needs_rerun(log_text) {\n        return false;\n    }\n    loop() {\n        for (;;) {\n${loop}\n        }}}\n    }\n}\nself.BusytexPipeline = BusytexPipeline;`;
  assert.throws(() => patchPasses(pinned.replace('_needs_rerun(log_text) {', '_needs_rerun(text) {')), /anchor changed/);
  const context = vm.createContext({ self: {} }); vm.runInContext(patchPasses(pinned), context);
  const { prototype } = context.self.BusytexPipeline, root = '/home/web_user/project_dir', files = new Map([
    [root + '/main.tex', 'a'], [root + '/main.aux', 'x'], [root + '/main.pdf', 'p'], [root + '/main.log', 'l'], [root + '/main.synctex.gz', 's'], [root + '/sub/c.toc', 't']]);
  const isDir = path => [...files.keys()].some(key => key.startsWith(path + '/'));
  const FS = { readdir: dir => ['.', '..', ...new Set([...files.keys()].filter(key => key.startsWith(dir + '/')).map(key => key.slice(dir.length + 1).split('/')[0]))],
    stat: path => ({ mode: isDir(path) ? 1 : 0, size: files.get(path)?.length ?? 0, mtime: new Date(1) }), isDir: mode => mode === 1, readFile: path => new TextEncoder().encode(files.get(path)) };
  const PATH = { join: (...parts) => parts.join('/').replace(/\/+/g, '/') }, self = { project_dir: root }, skip = new Set([root + '/main.pdf', root + '/main.log']);
  const snapshot = () => prototype._reread_snapshot.call(self, FS, PATH, skip), before = snapshot();
  assert.deepEqual([...before.keys()].sort(), [root + '/main.aux', root + '/main.tex', root + '/sub/c.toc']);
  files.set(root + '/main.pdf', 'new pdf'); files.set(root + '/main.log', 'new log'); files.set(root + '/main.synctex.gz', 'new');
  assert.equal(prototype._reread_unchanged(before, snapshot()), true, 'Outputs TeX does not read back must not force another pass');
  files.set(root + '/sub/c.toc', 'T'); assert.equal(prototype._reread_unchanged(before, snapshot()), false, 'A changed TOC needs the final pass');
  files.set(root + '/sub/c.toc', 't'); files.set(root + '/main.out', 'o'); assert.equal(prototype._reread_unchanged(before, snapshot()), false, 'A new auxiliary file needs the final pass');
  files.delete(root + '/main.out'); files.delete(root + '/main.aux'); assert.equal(prototype._reread_unchanged(before, snapshot()), false);
});
