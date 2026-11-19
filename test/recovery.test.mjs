import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { patchEditor, patchLanUuid, patchEditorUnicode } from '../runtime/browser-recovery/apply.mjs';
const source = readFileSync(new URL('../runtime/browser-recovery/recovery-core.js', import.meta.url), 'utf8');
const account = 'a'.repeat(24), project = 'b'.repeat(24), docId = 'c'.repeat(24);
class Storage {
  values = new Map(); full = false;
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { if (this.full) throw Error('QuotaExceededError'); this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
function client(storage = new Storage(), user = account, crypto = webcrypto) {
  const node = () => ({ append() {}, setAttribute() {}, addEventListener() {}, style: {}, isConnected: true });
  const context = vm.createContext({ crypto, localStorage: storage, location: { pathname: '/project/' + project }, document: {
    createElement: node, body: node(), querySelector: selector => ({ content: selector.includes('ol-user_id') ? user : project, dataset: {} }) } });
  vm.runInContext(source, context); return { api: context.overleafRecovery, storage, context };
}
function filter(api, raw = 'base') {
  const container = { doc_id: docId, docName: 'main.tex', doc: { getVersion: () => 7, type: 'sharejs-text-ot', _doc: { snapshot: raw } } };
  return api.extension({ transactionFilter: { of: fn => fn } }, { remote: true }, container);
}
const change = (before = 'base', after = 'base+edit', remote = false) => ({ docChanged: true, annotation: () => remote, startState: { doc: { toString: () => before } }, newDoc: { toString: () => after } });
test('native raw-string account IDs scope the exact pre-send recovery intent', () => {
  const { api } = client(), capture = filter(api), tr = change(); assert.equal(capture(tr), tr);
  const [{record}] = api.list(account, project); assert.equal(record.candidate, 'base+edit'); assert.equal(record.base.text, 'base'); assert.equal(record.base.version, 7); assert.equal(record.name, 'main.tex'); assert.equal(record.base.snapshot, undefined);
});
test('remote hydration writes nothing and quota failure refuses local transaction', () => {
  const {api,storage} = client(), capture = filter(api); const remote = change('base','remote',true);assert.equal(capture(remote),remote);assert.equal(storage.length,0);
  storage.full=true;assert.equal(capture(change()).length,0);assert.equal(storage.length,0);
});
test('missing or changed account identity cannot capture or transmit edits', () => {
  const {api,storage}=client(new Storage(),'invalid');assert.equal(filter(api)(change()).length,0);assert.equal(storage.length,0);
  const live=client();const capture=filter(live.api);capture(change());live.context.document.querySelector=selector=>({content:selector.includes('ol-user_id')?'d'.repeat(24):project,dataset:{}});assert.equal(capture(change('base+edit','wrong account')).length,0);assert.equal(live.api.list(account,project)[0].record.candidate,'base+edit');
});
test('tabs and offline forks retain separate candidates and immutable review baseline', () => {
  const storage=new Storage(), a=client(storage).api,b=client(storage).api, raw={content:'base',comments:[{id:'comment',pos:1}]};
  const capture=filter(a,{toRaw:()=>raw});capture(change());raw.comments[0].pos=999;capture(change('base+edit','base+edit2'));filter(b)(change('base','peer'));
  const copies=a.list(account,project);assert.equal(copies.length,2);const first=copies.find(x=>x.record.candidate==='base+edit2').record;assert.equal(first.base.snapshot.comments[0].pos,1);assert.equal(first.base.snapshot.content,undefined);assert.equal(first.base.snapshot.contentInBaseText,true);
  const fork1=a.fork(first),fork2=a.fork(first);assert.notEqual(fork1.writer,fork2.writer);a.save(fork1);a.save(fork2);assert.equal(a.list(account,project).length,4);assert.equal(a.list('d'.repeat(24),project).length,0);
});
test('malformed stored records are retained but never offered as valid copies', () => {
  const {api,storage}=client();filter(api)(change());const [{key}]=api.list(account,project);storage.setItem(key,'{"schema":1}');assert.throws(()=>api.read(key),/malformed/);assert.equal(api.list(account,project).length,0);assert.equal(storage.length,1);assert.throws(()=>api.read('unrelated-key'),/Invalid/);
});
test('review applies minimal native changes only against the exact connected document and preserves both sides', () => {
  const { api, context } = client(); filter(api)(change('base\n', 'local\n'));
  const record = api.list(account, project)[0].record;
  vm.runInContext(readFileSync(new URL('../runtime/browser-recovery/diff.min.js', import.meta.url), 'utf8'), context);
  let text = 'shared\nkeep\n', version = 10, buffered = false, writes = 0;
  const socket = { socket: { connected: true }, on() {} };
  const facade = { getValue: () => text, view: { state: { readOnly: false } }, cmChange(changes) {
    writes++; for (const change of [...changes].reverse()) text = text.slice(0, change.from) + change.insert + text.slice(change.to);
  } };
  const container = { doc_id: docId, socket, doc: { getVersion: () => version, hasBufferedOps: () => buffered } };
  api.attach(facade, container, 'main.tex'); const reviewed = api.reviewSnapshot(record);
  version++; assert.throws(() => api.applyReviewed(record, reviewed, 'local\nkeep\n'), /shared document changed/); assert.equal(writes, 0);
  assert(api.list(account, project).some(v => v.record.candidate === 'local\nkeep\n'));
  const current = api.reviewSnapshot(record); text = 'new remote\nkeep\n';
  assert.throws(() => api.applyReviewed(record, current, 'local\nkeep\n'), /shared document changed/); assert.equal(writes, 0);
  const fresh = api.reviewSnapshot(record); api.applyReviewed(record, fresh, 'new remote\nkeep\nlocal\n'); assert.equal(writes, 1);
  assert.equal(text, 'new remote\nkeep\nlocal\n'); assert(api.list(account, project).some(v => v.record.candidate === fresh.text));
  for (const mode of ['disconnected', 'buffered', 'readonly', 'identity']) {
    socket.socket.connected = mode !== 'disconnected'; buffered = mode === 'buffered'; facade.view.state.readOnly = mode === 'readonly';
    container.doc_id = mode === 'identity' ? 'd'.repeat(24) : docId;
    assert.throws(() => api.applyReviewed(record, fresh, 'refused')); assert.equal(writes, 1);
  }
});
test('offline project storage refuses wrong identity, unsafe paths and malformed files before opening storage', async () => {
  let opens = 0;
  const context = vm.createContext({ TextEncoder, Blob, crypto: webcrypto, atob,
    indexedDB: { open() { opens++; throw Error('Unexpected storage access'); } } });
  vm.runInContext(readFileSync(new URL('../runtime/browser-recovery/project-store.js', import.meta.url), 'utf8'), context);
  const payload = { user: account, project, source: { main: 'main.tex', compiler: 'pdflatex', resources: [{ path: 'main.tex', content: 'source' }] }, documents: [{ path: 'main.tex', id: docId, version: 7 }] };
  await assert.rejects(context.overleafLocalProjects.create(payload, 'd'.repeat(24), project), /identity changed/);
  for (const path of ['../private', '/absolute', 'a//b', 'a\\b']) {
    const value = structuredClone(payload); value.source.resources[0].path = path;
    await assert.rejects(context.overleafLocalProjects.create(value, account, project), /Invalid project file/);
  }
  const duplicate = structuredClone(payload); duplicate.source.resources.push(duplicate.source.resources[0]);
  await assert.rejects(context.overleafLocalProjects.create(duplicate, account, project), /Invalid project file/);
  const malformed = structuredClone(payload); malformed.documents[0].version = -1;
  await assert.rejects(context.overleafLocalProjects.create(malformed, account, project), /document identity/);
  const changed = structuredClone(payload); changed.source.digest = '0'.repeat(64);
  await assert.rejects(context.overleafLocalProjects.create(changed, account, project), /integrity mismatch/);
  assert.equal(opens, 0);
  for (const name of ['', '../outside', '/absolute', 'a//b', 'a\\b']) {
    await assert.rejects(context.overleafLocalProjects.add({ id: 'unused' }, 'doc', name), /Invalid local/);
  }
  await assert.rejects(context.overleafLocalProjects.add({}, 'linked_file', 'a.tex'), /Invalid local/);
  for (const name of ['', ' ', 'a'.repeat(201), 'bad\0name']) await assert.rejects(context.overleafLocalProjects.blank('unused', name), /project name/);
  assert.equal(opens, 0);
});
test('editor hook refuses duplicate/unknown/already-patched input', () => {
  const fixture='let{currentDoc:o}=e;const s=r.Z9.define;(0,y.WU)(e.currentDoc,e.handleError);return o.attachToCM6(t),{update(e){x}};return n.Nb.highest([s,i])};class u extends s.EventEmitter';
  const patched=patchEditor(fixture,'CORE','CONFIG');assert(patched.includes('overleafRecovery.extension(n.$t,n.ZX,o,recoveryName)'));assert(patched.startsWith('CONFIG\nCORE\n'));
  for(const text of ['',fixture+fixture,patched])assert.throws(()=>patchEditor(text,'CORE','CONFIG'),/Unexpected/);
});
test('offline worker never falls through to network for unknown/private requests', async () => {
  const handlers={},responses=[],manifest={version:'test',nativePaths:[],assets:[{path:'/recovery/local-workspace.html'}]};let networks=0;
  const context=vm.createContext({self:{addEventListener:(name,fn)=>handlers[name]=fn,location:{origin:'http://127.0.0.1:8080'}},URL,Response,caches:{open:async()=>({match:async()=>new Response('public static cached page')})},fetch:()=>{networks++;throw Error('Unexpected network')}});
  vm.runInContext(readFileSync(new URL('../runtime/browser-recovery/recovery-sw.template.js',import.meta.url),'utf8').replace('__RECOVERY_MANIFEST__',JSON.stringify(manifest)),context);
  for(const [url,method,status]of [['http://127.0.0.1:8080/recovery/local-workspace.html','GET',200],['http://127.0.0.1:8080/project/'+project,'GET',503],['https://example.org/','GET',503],['http://127.0.0.1:8080/recovery/local-workspace.html','POST',503]]){handlers.fetch({request:{url,method},respondWith:p=>responses.push(p)});assert.equal((await responses.pop()).status,status)}assert.equal(networks,0);
});

test('LAN HTTP editing retains independent cryptographic writer identities without randomUUID', () => {
  const crypto = { getRandomValues: bytes => webcrypto.getRandomValues(bytes) };
  const a = client(new Storage(), account, crypto), b = client(new Storage(), account, crypto);
  filter(a.api)(change()); filter(b.api)(change());
  const first = a.api.list(account,project)[0].record, second = b.api.list(account,project)[0].record;
  assert.match(first.writer, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.notEqual(first.writer, second.writer); assert.notEqual(a.api.fork(first).writer, first.writer);
});

test('LAN UUID editor patch refuses ambiguous or already-patched recovery source', () => {
  const fixture = '  const writer = globalThis.crypto.randomUUID();\nreturn { writer: globalThis.crypto.randomUUID(), revision: 0 };';
  const output = patchLanUuid(fixture, source); assert(output.includes('function randomUUID()'));
  assert.throws(() => patchLanUuid(output, source)); assert.throws(() => patchLanUuid(fixture + fixture, source)); assert.throws(() => patchLanUuid(fixture, 'unknown'));
});

test('offline navigation uses exact project paths and refuses malformed or oversized output', async () => {
  const context = vm.createContext({ TextEncoder, Blob, DecompressionStream, Uint8Array, crypto: webcrypto, atob });
  const parser = new vm.SourceTextModule(readFileSync(new URL('../runtime/browser-recovery/synctex-parser.mjs', import.meta.url), 'utf8'), { context });
  const sdk = new vm.SyntheticModule(['BusyTexRunner', 'PdfLatex', 'XeLatex', 'LuaLatex'], function () {
    for (const name of ['BusyTexRunner', 'PdfLatex', 'XeLatex', 'LuaLatex']) this.setExport(name, class {});
  }, { context });
  const module = new vm.SourceTextModule(readFileSync(new URL('../runtime/browser-recovery/project-compile.mjs', import.meta.url), 'utf8'), { context });
  await module.link(name => name.includes('synctex') ? parser : sdk); await module.evaluate();
  const { fingerprint, forward, backward, navigation } = module.namespace;
  const nodes = [{ path: 'one/child.tex', line: 5, page: 1, x: 10, y: 20, width: 30, height: 10 }, { path: 'two/child.tex', line: 7, page: 2, x: 5, y: 6, width: 10, height: 10 }];
  assert.equal(forward(nodes, 'one/child.tex', 5), nodes[0]); assert.equal(forward(nodes, 'child.tex', 5), undefined);
  assert.equal(backward(nodes, 2, 7, 8), nodes[1]); assert.equal(backward(nodes, 3, 7, 8), undefined);
  const project = { main: 'main.tex', compiler: 'pdflatex' }, files = [{ path: 'main.tex', content: 'base' }, { path: 'figure.png', data: 'AA==' }];
  assert.equal(await fingerprint(project, files), await fingerprint(project, files.toReversed()));
  assert.notEqual(await fingerprint(project, files), await fingerprint(project, [{ ...files[0], content: 'changed' }, files[1]]));
  await assert.rejects(navigation(new Uint8Array(8 * 1024 * 1024 + 1), project, files), /Invalid navigation/);
  const { gzipSync } = await import('node:zlib');
  await assert.rejects(navigation(new Uint8Array(gzipSync('not SyncTeX')), project, files), /Unsupported navigation/);
});

test('large public cache entries stream exact verified parts and do not publish failed writes', async () => {
  const bytes = new Uint8Array(16 * 1024 * 1024 + 3); bytes[0] = 7; bytes[bytes.length - 1] = 93;
  const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
  const values = new Map(); let fail = true;
  const cache = { async put(url, response) { if (fail && String(url).endsWith('?part=1')) throw Error('injected write failure'); values.set(String(url), response); }, async match(url) { return values.get(String(url))?.clone(); } };
  const manifest = { version: 'test', nativePaths: [], assets: [] };
  const context = vm.createContext({ self: { addEventListener() {}, location: { origin: 'https://fixture.test' } }, URL, Response, ReadableStream, Uint8Array,
    crypto: webcrypto, fetch: async (_, options) => {
      const range = options.headers?.Range?.match(/^bytes=(\d+)-(\d+)$/);
      return range ? new Response(bytes.slice(Number(range[1]), Number(range[2]) + 1), { status: 206 }) : new Response(bytes);
    } });
  vm.runInContext(readFileSync(new URL('../runtime/browser-recovery/recovery-sw.template.js', import.meta.url), 'utf8').replace('__RECOVERY_MANIFEST__', JSON.stringify(manifest)), context);
  const partHash = async value => Buffer.from(await webcrypto.subtle.digest('SHA-256', value)).toString('hex');
  const url = new URL('https://fixture.test/recovery/package.data'), asset = { path: url.pathname, sha256: digest, size: bytes.length,
    parts: [await partHash(bytes.slice(0, 16 * 1024 * 1024)), await partHash(bytes.slice(16 * 1024 * 1024))], type: 'application/octet-stream' };
  await assert.rejects(context.store(cache, asset), /injected write/); assert.equal(values.has(url.href), false);
  fail = false; await context.store(cache, asset);
  const response = await context.cached(cache, url); assert.equal(Number(response.headers.get('Content-Length')), bytes.length);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  values.clear(); await assert.rejects(context.store(cache, { ...asset, parts: ['0'.repeat(64), asset.parts[1]] }), /integrity mismatch/); assert.equal(values.size, 0);
});

test('native offline recovery retains the original shared baseline and enforces account/project identity', () => {
  const { api, context } = client();
  context.location.pathname = '/recovery/native-workspace.html';
  context.overleafOfflineNative = { account, project, clientProject: project, file: () => ({ base: { version: 42, text: 'original shared text' } }) };
  filter(api, 'local already changed')(change('local already changed', 'next edit'));
  const record = api.list(account, project)[0].record; assert.equal(record.base.version, 42); assert.equal(record.base.text, 'original shared text');
  context.overleafOfflineNative.account = 'd'.repeat(24);
  assert.equal(filter(api)(change()).length, 0);
});

test('offline ZIP export refuses unsafe/duplicate/ambiguous paths and retains exact binary inputs', async () => {
  const { projectZip } = await import('../runtime/browser-recovery/project-zip.mjs');
  const files = [{ path: 'nested/chapter.tex', content: 'Exact source\n' }, { path: 'figure.png', data: 'AAEC/w==' }];
  const zip = await projectZip(files); assert.equal((await zip.slice(0, 2).text()), 'PK'); assert(zip.size > 4);
  for (const path of ['../secret', '/absolute', 'a/../b', 'a\\b', 'x:y']) await assert.rejects(projectZip([{ path, content: 'x' }]), /Invalid project file/);
  await assert.rejects(projectZip([files[0], files[0]]), /Invalid project file/);
  await assert.rejects(projectZip([{ path: 'x', content: 'x', data: 'AA==' }]), /Invalid project file/);
  assert.equal(files[1].data, 'AAEC/w==');
});

test('held local saving refuses further edits while keeping the existing recovery copy', () => {
  const { api, context } = client(); const capture = filter(api); capture(change());
  const retained = api.list(account, project)[0].record.candidate;
  context.overleafOfflineNative = { savingHeld: true };
  assert.equal(capture(change('base+edit', 'must not apply')).length, 0);
  assert.equal(api.list(account, project)[0].record.candidate, retained);
  const remote = change('base+edit', 'remote', true); assert.equal(capture(remote), remote);
});

test('offline updates wait for existing editing windows and retain reusable compiler caches', async () => {
  const handlers = {}, removed = []; let forced = 0, claimed = 0;
  const context = vm.createContext({ URL, Response, TextEncoder,
    self: { location: { origin: 'https://local.example' }, addEventListener(name, fn) { handlers[name] = fn; },
      skipWaiting() { forced++; }, clients: { claim() { claimed++; } } },
    caches: { async open() { return {}; }, async keys() { return ['overleaf-local-old', 'overleaf-local-current', 'overleaf-compiler-pinned', 'unrelated']; }, async delete(name) { removed.push(name); } } });
  const sw = readFileSync(new URL('../runtime/browser-recovery/recovery-sw.template.js', import.meta.url), 'utf8')
    .replace('__RECOVERY_MANIFEST__', JSON.stringify({ version: 'current', assets: [], nativePaths: [] }));
  vm.runInContext(sw, context);
  let task; handlers.install({ waitUntil(value) { task = value; } }); await task;
  assert.equal(forced, 0, 'A new runtime must not take over unfinished editing windows');
  handlers.activate({ waitUntil(value) { task = value; } }); await task;
  assert.equal(claimed, 0, 'Existing pages must keep their own runtime until navigation');
  assert.deepEqual(removed, ['overleaf-local-old'], 'Only obsolete UI cache is recycled; compiler and unrelated storage stay available');
});

test('offline compiler warm-up shares one initialize with the first compile and retries a failed start', async () => {
  const runners = []; let failNext = true;
  const context = vm.createContext({ TextEncoder, Blob, Uint8Array, crypto: webcrypto, atob, performance, setTimeout, clearTimeout });
  const parser = new vm.SyntheticModule(['parseSyncTex'], function () { this.setExport('parseSyncTex', () => undefined); }, { context });
  const sdk = new vm.SyntheticModule(['BusyTexRunner', 'PdfLatex', 'XeLatex', 'LuaLatex'], function () {
    this.setExport('BusyTexRunner', class { constructor() { this.inits = 0; this.terminated = false; runners.push(this); }
      async initialize() { this.inits++; await new Promise(resolve => setTimeout(resolve, 5)); if (failNext) { failNext = false; throw Error('injected start failure'); } }
      terminate() { this.terminated = true; } });
    this.setExport('PdfLatex', class { constructor(runner) { this.runner = runner; } async compile() { return { success: true, pdf: new Uint8Array([1]), synctex: new Uint8Array([2]), runner: this.runner }; } });
    for (const name of ['XeLatex', 'LuaLatex']) this.setExport(name, class {});
  }, { context });
  const module = new vm.SourceTextModule(readFileSync(new URL('../runtime/browser-recovery/project-compile.mjs', import.meta.url), 'utf8'), { context });
  await module.link(name => name.includes('synctex') ? parser : sdk); await module.evaluate();
  const compiler = new module.namespace.LocalCompiler(), project = { main: 'main.tex', compiler: 'pdflatex' }, files = [{ path: 'main.tex', content: 'x' }];
  await assert.rejects(compiler.warm(), /injected start failure/);
  assert.equal(runners[0].terminated, true); assert.equal(compiler.runner, undefined);
  const warm = compiler.warm(), result = await compiler.compile(project, files, () => {}, new AbortController().signal); await warm;
  assert.equal(runners.length, 2); assert.equal(runners[1].inits, 1); assert.equal(result.runner, runners[1]);
  await compiler.compile(project, files, () => {}, new AbortController().signal); assert.equal(runners[1].inits, 1);
  compiler.stop(); assert.equal(runners[1].terminated, true);
  await compiler.compile(project, files, () => {}, new AbortController().signal); assert.equal(runners.length, 3);
});


test('offline editor sanitation preserves valid Unicode pairs and replaces only NUL or lone surrogates', () => {
  const source = String.raw`text.replaceAll(/[\0\uD800-\uDFFF]/g, "�")`;
  const patched = patchEditorUnicode(source);
  const sanitize = text => vm.runInNewContext(patched, { text });
  assert.equal(sanitize('Türkçe 😀 𝑥'), 'Türkçe 😀 𝑥');
  assert.equal(sanitize('a\0b\uD800c\uDC00d'), 'a�b�c�d');
  assert.throws(() => patchEditorUnicode('unknown'));
  assert.throws(() => patchEditorUnicode(source + source));
  assert.throws(() => patchEditorUnicode(patched));
});
