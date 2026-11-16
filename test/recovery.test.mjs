import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { patchEditor, patchLanUuid } from '../runtime/browser-recovery/apply.mjs';
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
