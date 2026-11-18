import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
const helper = readFileSync(new URL('../runtime/browser-recovery/session-checkpoint.js', import.meta.url), 'utf8');
const recovery = readFileSync(new URL('../runtime/browser-recovery/recovery-core.js', import.meta.url), 'utf8');
const toolbar = readFileSync(new URL('../runtime/browser-recovery/offline-toolbar.js', import.meta.url), 'utf8');
class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } }
const account = 'a'.repeat(24), project = 'b'.repeat(24), doc = 'c'.repeat(24);
class Storage {
  values = new Map();
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
function lockManager() {
  const held = new Map();
  return {
    forOwner(owner) { return { request(name, options, callback) {
      if (held.has(name)) return Promise.resolve(callback(null));
      const token = { owner }; held.set(name, token);
      return Promise.resolve(callback({ name })).finally(() => { if (held.get(name) === token) held.delete(name); });
    } }; },
    close(owner) { for (const [key, value] of held) if (value.owner === owner) held.delete(key); },
  };
}
function client({ storage = new Storage(), manager = lockManager(), owner = Symbol(), locks = true, respond, digest, abortController = globalThis.AbortController, user = account, path = '/project/' + project } = {}) {
  const listeners = new Map(), timers = new Map(), requests = [], events = [];
  const identity = { user }, location = { pathname: path, href: 'https://latex.example' + path };
  let serial = 0;
  const crypto = digest ? { randomUUID: () => webcrypto.randomUUID(), subtle: { digest } } : webcrypto;
  const context = vm.createContext({ crypto, TextEncoder, URL, AbortController: abortController, location, localStorage: storage,
    navigator: locks ? { locks: manager.forOwner(owner) } : {},
    document: {
      querySelector(selector) { return { content: selector.includes('ol-user_id') ? identity.user : selector.includes('csrfToken') ? 'csrf-fixture' : project, dataset: {} }; },
      addEventListener(name, callback) { listeners.set('document:' + name, callback); },
    },
    addEventListener(name, callback) { listeners.set(name, callback); },
    CustomEvent, dispatchEvent: event => events.push(event.detail.state),
    setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options) => {
      const request = { url, ...options, data: JSON.parse(options.body) }; requests.push(request);
      if (respond) return respond(request);
      return { ok: true, json: async () => ({ checkpoint: { user, project, durable: true, version: 9,
        documents: request.data.docs.map(d => ({ ...d, version: 12 })) } }) };
    },
  });
  vm.runInContext(helper, context); vm.runInContext(recovery, context);
  const api = context.overleafSessionCheckpoint;
  const make = (candidate = 'Exact source', fields = {}) => ({ schema: 1, account, project, doc, writer: webcrypto.randomUUID(), revision: 1,
    name: 'main.tex', base: { version: 0, text: '' }, candidate, updatedAt: Date.now(), ...fields });
  const save = record => { const key = context.overleafRecovery.save(record); api.track(key, record); return key; };
  api.start({ account: user, project });
  return { api, context, storage, requests, events, identity, location, listeners, timers, make, save, manager, close: () => manager.close(owner) };
}
const markers = storage => [...storage.values.keys()].filter(key => key.startsWith('overleaf.checkpoint.v1.'));
const tick = () => new Promise(resolve => setImmediate(resolve));

test('exact durable receipt removes only owned unchanged recovery and leaves caches/workspaces alone', async () => {
  const c = client(), own = c.make(), key = c.save(own);
  const other = c.make('Other writer'); const otherKey = c.context.overleafRecovery.save(other);
  c.storage.setItem('unrelated', 'retain');
  await c.api.flush();
  assert.equal(c.requests.length, 1); assert.equal(c.storage.getItem(key), null);
  assert.notEqual(c.storage.getItem(otherKey), null); assert.equal(c.storage.getItem('unrelated'), 'retain');
  assert.deepEqual(markers(c.storage), []);
  assert.equal(c.requests[0].data.op, 'checkpoint'); assert.equal(c.requests[0].data.docs.length, 1);
  assert(!c.requests[0].body.includes(own.candidate)); assert(c.requests[0].body.length < 8192);
  assert.equal(c.requests[0].credentials, 'same-origin');
  await c.api.flush(); assert.equal(c.requests.length, 1, 'No redundant request after verified cleanup');
});

test('network, nondurable, wrong-account, stale hash and invalid-version receipts retain recovery and marker', async () => {
  for (const kind of ['network', 'refused', 'nondurable', 'account', 'project', 'hash', 'version', 'duplicates']) {
    const c = client({ respond: async request => {
      if (kind === 'network') throw Error('Disconnected');
      const proof = { user: account, project, durable: kind !== 'nondurable', version: 9, documents: request.data.docs.map(d => ({ ...d, version: 12 })) };
      if (kind === 'account') proof.user = 'd'.repeat(24);
      if (kind === 'project') proof.project = 'e'.repeat(24);
      if (kind === 'hash') proof.documents[0].hash = 'f'.repeat(64);
      if (kind === 'version') proof.version = -1;
      if (kind === 'duplicates') proof.documents.push(proof.documents[0]);
      return { ok: kind !== 'refused', json: async () => ({ checkpoint: proof }) };
    } });
    const key = c.save(c.make()); await c.api.flush();
    assert.notEqual(c.storage.getItem(key), null, kind); assert.equal(markers(c.storage).length, 1, kind); c.close();
  }
});

test('edit or account change during proof cannot delete the newer candidate', async () => {
  for (const kind of ['edit', 'account']) {
    let release;
    const c = client({ respond: request => new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ checkpoint: { user: account, project, durable: true, version: 9, documents: request.data.docs.map(d => ({ ...d, version: 12 })) } }) }); }) });
    const original = c.make(), key = c.save(original), running = c.api.flush();
    while (!release) await tick();
    if (kind === 'edit') c.save({ ...original, revision: 2, candidate: 'New unsaved source' });
    else c.identity.user = 'd'.repeat(24);
    release(); await running; assert.notEqual(c.storage.getItem(key), null, kind); c.close();
  }
});

test('pending marker retries on authenticated visit but never steals another active tab record', async () => {
  const storage = new Storage(), manager = lockManager();
  const first = client({ storage, manager, respond: async () => { throw Error('Close interrupted request'); } });
  const key = first.save(first.make()); await first.api.flush();
  assert.equal(markers(storage).length, 1); assert(!storage.getItem(markers(storage)[0]).includes('Exact source'));
  const second = client({ storage, manager }); await second.api.flush();
  assert.equal(second.requests.length, 0); assert.notEqual(storage.getItem(key), null);
  first.close();
  const reopened = client({ storage, manager }); await reopened.api.flush();
  assert.equal(reopened.requests.length, 1); assert.equal(storage.getItem(key), null); assert.equal(markers(storage).length, 0);
});

test('without Web Locks fresh owned edits can checkpoint but pending markers are retained on revisit', async () => {
  const storage = new Storage();
  const first = client({ storage, locks: false, respond: async () => ({ ok: false }) });
  const key = first.save(first.make()); await first.api.flush();
  const reopened = client({ storage, locks: false }); await reopened.api.flush();
  assert.equal(reopened.requests.length, 0); assert.notEqual(storage.getItem(key), null);
  const own = reopened.save(reopened.make('Fresh own source', { doc: 'd'.repeat(24) })); await reopened.api.flush();
  assert.equal(storage.getItem(own), null); assert.notEqual(storage.getItem(key), null);
});

test('native/offline documents are retained and never sent for server finalization', async () => {
  for (const native of [false, true]) {
    const c = client({ path: native ? '/project/' + project : '/recovery/native-workspace.html' });
    if (native) c.context.overleafOfflineNative = {};
    const key = c.save(c.make()); await c.api.flush();
    assert.equal(c.requests.length, 0); assert.notEqual(c.storage.getItem(key), null);
  }
  const c = client(), key = c.save(c.make('Offline-linked copy', { workspace: webcrypto.randomUUID() })); await c.api.flush();
  assert.equal(c.requests.length, 0); assert.notEqual(c.storage.getItem(key), null);
});

test('idle checkpoints use a 30-second debounce and close uses only prepared keepalive proofs', async () => {
  const c = client(), record = c.make(), key = c.save(record);
  await tick(); await tick();
  assert([...c.timers.values()].every(timer => timer.delay === 30000));
  c.listeners.get('pagehide')();
  await c.api.flush(); assert.equal(c.requests[0].keepalive, true); assert.equal(c.storage.getItem(key), null);
});

test('request is bounded to32 unique hashes and only one proof can be in flight', async () => {
  let release;
  const c = client({ respond: request => new Promise(resolve => { release = () => resolve({ ok: false }); }) });
  for (let n = 0; n < 35; n++) c.save(c.make('Source' + n, { doc: n.toString(16).padStart(24, '0') }));
  const a = c.api.flush(), b = c.api.flush(); assert.equal(a, b);
  while (!release) await tick();
  assert.equal(c.requests.length, 1); assert.equal(c.requests[0].data.docs.length, 32); assert(new TextEncoder().encode(c.requests[0].body).length <= 8192);
  release(); await a; c.close();
});

test('close before hashing retains source and marker for a later authenticated retry', async () => {
  let release;
  const storage = new Storage(), manager = lockManager();
  const c = client({ storage, manager, digest: (...args) => new Promise(resolve => { release = () => webcrypto.subtle.digest(...args).then(resolve); }) });
  const key = c.save(c.make()); while (!release) await tick();
  c.listeners.get('pagehide')(); await c.api.flush();
  assert.equal(c.requests.length, 0); assert.notEqual(storage.getItem(key), null); assert.equal(markers(storage).length, 1);
  c.close(); release();
  const reopened = client({ storage, manager }); await reopened.api.flush();
  assert.equal(reopened.requests.length, 1); assert.equal(storage.getItem(key), null);
});

test('an orphaned ownership marker is removed without a request or any other source deletion', async () => {
  const storage = new Storage(), manager = lockManager();
  const first = client({ storage, manager, respond: async () => ({ ok: false }) });
  const key = first.save(first.make()); await first.api.flush(); first.close();
  storage.removeItem(key); storage.setItem('unrelated', 'keep');
  const next = client({ storage, manager }); await next.api.flush();
  assert.equal(markers(storage).length, 0); assert.equal(next.requests.length, 0); assert.equal(storage.getItem('unrelated'), 'keep');
});

test('remaining documents checkpoint in a later bounded idle batch', async () => {
  const c = client();
  for (let n = 0; n < 35; n++) c.save(c.make('Source' + n, { doc: n.toString(16).padStart(24, '0') }));
  await c.api.flush();
  assert.equal(c.requests.length, 1); assert.equal(c.requests[0].data.docs.length, 32);
  assert.equal(markers(c.storage).length, 3);
  assert.equal(c.timers.size, 1); assert.equal([...c.timers.values()][0].delay, 30000);
  [...c.timers.values()][0].callback(); await c.api.flush();
  assert.equal(c.requests.length, 2); assert.equal(c.requests[1].data.docs.length, 3);
  assert.equal(markers(c.storage).length, 0);
});

test('ownership-marker write failure never deletes or sends the existing recovery source', async () => {
  const storage = new Storage(), set = storage.setItem.bind(storage);
  storage.setItem = (key, value) => { if (key.startsWith('overleaf.checkpoint.v1.')) throw Error('Marker quota'); set(key, value); };
  const c = client({ storage }), key = c.save(c.make()); await c.api.flush();
  assert.notEqual(storage.getItem(key), null); assert.equal(markers(storage).length, 0); assert.equal(c.requests.length, 0);
});

test('hung normal and keepalive requests abort after15s, retain recovery and permit retry', async () => {
  for (const keepalive of [false, true]) {
    let attempts = 0;
    const c = client({ respond: request => {
      if (++attempts === 1) return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
      return { ok: true, json: async () => ({ checkpoint: { user: account, project, durable: true, version: 9,
        documents: request.data.docs.map(d => ({ ...d, version: 12 })) } }) };
    } });
    const key = c.save(c.make()); await tick(); await tick();
    const running = c.api.flush({ keepalive });
    while (!c.requests.length) await tick();
    const timeout = [...c.timers.values()].find(timer => timer.delay === 15000); assert(timeout);
    timeout.callback(); await running;
    assert.equal(c.requests[0].signal.aborted, true); assert.equal(c.requests[0].keepalive, keepalive);
    assert.notEqual(c.storage.getItem(key), null); assert.equal(markers(c.storage).length, 1);
    assert([...c.timers.values()].every(timer => timer.delay === 30000));
    await c.api.flush(); assert.equal(c.requests.length, 2); assert.equal(c.storage.getItem(key), null);
  }
});

test('without AbortController no unbounded checkpoint request is sent', async () => {
  const c = client({ abortController: null }), key = c.save(c.make());
  await c.api.flush(); assert.equal(c.requests.length, 0); assert.notEqual(c.storage.getItem(key), null);
  assert.equal(markers(c.storage).length, 1); c.close();
});

// Minimal DOM for the toolbar durability label.
function element() {
  const node = { children: [], dataset: {}, attributes: {}, hidden: false, textContent: '', append(...nodes) { this.children.push(...nodes); },
    setAttribute(name, value) { this.attributes[name] = value; }, get firstChild() { return this.children[0]; } };
  return node;
}
function label() {
  const listeners = new Map();
  const context = vm.createContext({ localStorage: new Storage(), document: { createElement: element, documentElement: { dataset: {} } },
    addEventListener(name, callback) { listeners.set(name, callback); } });
  vm.runInContext(toolbar, context);
  const node = context.overleafOfflineToolbar.durability();
  const send = state => listeners.get('overleaf-durability')(new CustomEvent('overleaf-durability', { detail: { state } }));
  return { node, send, text: () => node.children[1].textContent };
}

test('durability label is accessible text, starts hidden and never claims an off-host backup', () => {
  const l = label();
  assert.equal(l.node.attributes.role, 'status'); assert.equal(l.node.attributes['aria-live'], 'polite'); assert.equal(l.node.hidden, true);
  for (const state of ['visible', 'local', 'acknowledged', 'device', 'server']) {
    const fresh = label(); if (state === 'acknowledged' || state === 'server') fresh.send('local');
    fresh.send(state); assert.equal(fresh.node.dataset.state, state); assert.equal(fresh.node.hidden, false);
    assert(fresh.text().length > 10 && fresh.node.title === fresh.text(), state);
    assert(!/backed up off-host/.test(fresh.text()) || /not backed up off-host/.test(fresh.text()), state);
  }
});

test('durability label orders edit, acknowledgement, receipt and refuses late upgrades', () => {
  const l = label();
  l.send('local'); assert.equal(l.text(), 'Not yet saved to server — kept on this device');
  l.send('acknowledged'); assert.match(l.text(), /not yet saved to server/);
  l.send('server'); assert.equal(l.text(), 'Saved to server — not backed up off-host');
  l.send('acknowledged'); assert.equal(l.node.dataset.state, 'server', 'late acknowledgement cannot downgrade a receipt');
  l.send('local'); l.send('server'); assert.equal(l.node.dataset.state, 'server');
  l.send('visible'); l.send('server'); l.send('acknowledged'); assert.equal(l.node.dataset.state, 'visible', 'failure stays visible');
  l.send('bogus'); assert.equal(l.node.dataset.state, 'visible');
  const offline = label(); offline.send('local'); offline.send('device'); offline.send('server');
  assert.equal(offline.node.dataset.state, 'device', 'a receipt cannot follow an offline-only save');
});

test('receipt reports server-durable only after every tracked edit is proven; 409 and timeout keep saved locally', async () => {
  const ok = client(); ok.save(ok.make()); await ok.api.flush(); assert.deepEqual(ok.events, ['server']);
  const refused = client({ respond: async () => ({ ok: false, status: 409 }) }), key = refused.save(refused.make()); await refused.api.flush();
  assert.deepEqual(refused.events, []); assert.notEqual(refused.storage.getItem(key), null);
  const hung = client({ respond: request => new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })) });
  const hungKey = hung.save(hung.make()); await tick(); await tick();
  const running = hung.api.flush(); while (!hung.requests.length) await tick();
  [...hung.timers.values()].find(timer => timer.delay === 15000).callback(); await running;
  assert.deepEqual(hung.events, []); assert.notEqual(hung.storage.getItem(hungKey), null);
  let release;
  const racing = client({ respond: request => new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ checkpoint: { user: account, project, durable: true, version: 9, documents: request.data.docs.map(d => ({ ...d, version: 12 })) } }) }); }) });
  const original = racing.make(); racing.save(original); const flushing = racing.api.flush(); while (!release) await tick();
  racing.save({ ...original, revision: 2, candidate: 'Newer unsaved source' }); release(); await flushing;
  assert.deepEqual(racing.events, [], 'a newer edit during proof is not server-durable');
  const partial = client(); partial.save(partial.make());
  const otherDoc = partial.make('Second doc', { doc: 'd'.repeat(24) });
  partial.storage.setItem(partial.context.overleafRecovery.key(otherDoc), JSON.stringify(otherDoc));
  partial.context.navigator.locks.request = async (name, options, hold) => hold(null); partial.api.track(partial.context.overleafRecovery.key(otherDoc), otherDoc);
  await partial.api.flush(); assert.deepEqual(partial.events, [], 'an unclaimed tracked edit blocks the server state');
});

test('offline/native editing never reports server-durable', async () => {
  const c = client({ path: '/recovery/native-workspace.html' }); c.context.overleafOfflineNative = {};
  c.save(c.make()); await c.api.flush(); assert.deepEqual(c.events, []); assert.equal(c.requests.length, 0);
});

test('own OT acknowledgement after a local edit reports acknowledged; buffered or remote ops do not', async () => {
  const c = client(), socketListeners = new Map();
  let buffered = false;
  const node = () => ({ append() {}, after() {}, setAttribute() {}, addEventListener() {}, querySelector: () => node(), dataset: {}, isConnected: true });
  c.context.document.createElement = node; c.context.document.head = node();
  c.context.overleafOfflineToolbar = { stylesheet() {}, theme() {}, mount() {}, durability: node, button: node, menu: () => ({ list: node() }) };
  const container = { doc_id: doc, docName: 'main.tex', socket: { socket: { connected: true }, on(name, callback) { socketListeners.set(name, callback); } },
    doc: { getVersion: () => 7, type: 'sharejs-text-ot', _doc: { snapshot: 'base' }, hasBufferedOps: () => buffered } };
  const idle = c.context.setTimeout; c.context.setTimeout = (callback, delay) => delay === 0 ? (callback(), 0) : idle(callback, delay);
  c.context.overleafRecovery.attach({}, container, 'main.tex');
  const capture = c.context.overleafRecovery.extension({ transactionFilter: { of: fn => fn } }, { remote: true }, container);
  capture({ docChanged: true, annotation: () => false, startState: { doc: { toString: () => 'base' } }, newDoc: { toString: () => 'base+edit' } });
  assert.deepEqual(c.events, ['local']);
  const ack = socketListeners.get('otUpdateApplied');
  buffered = true; ack({ doc, v: 7 }); ack({ doc, v: 8, op: [{ i: 'x', p: 0 }] }); ack({ doc: 'e'.repeat(24), v: 7 });
  buffered = false; ack({ doc, v: 8, op: [{ i: 'x', p: 0 }] }); assert.deepEqual(c.events, ['local']);
  ack({ doc, v: 7 }); assert.deepEqual(c.events, ['local', 'acknowledged']);
});
