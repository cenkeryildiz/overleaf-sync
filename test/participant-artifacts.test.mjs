import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
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
