import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { safePath, prepareSnapshot, prepareResult } from '../runtime/participant-compile/artifacts.mjs';
const fixture = () => ({ main: 'main.tex', active: 'chapters/one.tex', text: 'exact candidate', resources: [
  { path: 'main.tex', content: 'root' }, { path: 'chapters/one.tex', content: 'old' }, { path: 'figure.png', data: 'AA==' },
] });
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
  const context = { URL, location: new URL('https://fixture.test/participant/busytex/busytex_worker.js'), XMLHttpRequest: XHR,
    fetch: (url, options) => { requests.push([url, options]); return Promise.resolve(); }, importScripts: (...urls) => requests.push(urls) };
  context.self = context; vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../runtime/participant-compile/worker.js', import.meta.url), 'utf8'), context);
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

test('native graceful shutdown stops the metadata child, settles pending work and refuses restart', async () => {
  const context = vm.createContext({ Buffer, setTimeout, clearTimeout, setInterval: () => ({ unref() {} }) });
  let cleanup, spawns = 0, kills = 0, respond = true;
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
    else if (name.endsWith('/SessionManager.mjs')) exports = { default: { getLoggedInUserId: () => 'a'.repeat(24) } };
    else if (name.endsWith('/GracefulShutdown.mjs')) exports = { addOptionalCleanupHandlerBeforeStoppingTraffic: (_, handler) => { cleanup = handler; } };
    else if (name.endsWith('/LivePreview.mjs')) exports = { snapshot: () => { throw Error('Unexpected snapshot'); } };
    else if (name.endsWith('/ParticipantArtifacts.mjs')) exports = { prepareSnapshot() {}, prepareResult() {} };
    else exports = await import(name);
    return new vm.SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value); }, { context });
  });
  await subject.evaluate();
  const request = { session: {}, params: { Project_id: 'b'.repeat(24) }, body: { op: 'join' } };
  const response = () => ({ code: 200, set() {}, json() { return this; }, status(code) { this.code = code; return this; }, sendStatus(code) { this.code = code; return this; } });
  await subject.namespace.participantCompile(request, response()); assert.equal(spawns, 1);
  respond = false; const pendingResponse = response(), pending = subject.namespace.participantCompile(request, pendingResponse);
  cleanup(); await pending; assert.equal(kills, 1); assert.equal(pendingResponse.code, 409);
  const after = response(); await subject.namespace.participantCompile(request, after); assert.equal(after.code, 409); assert.equal(spawns, 1);
});
