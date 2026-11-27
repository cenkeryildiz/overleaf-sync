// SPDX-License-Identifier: AGPL-3.0-only
// CEX-LAN-01 in memory: lan-host.mjs + lan-guest.mjs over the real sealed room (lan-room.mjs), with a fake relay helper and a
// small native-style OT client (inflight + pending, transforms the way the editor's own client does). No sockets, no storage.
// Run: node --test test/lan-native.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHost, nativeHelper, helperAvailable } from '../runtime/chrome-extension/lan-host.mjs';
import { joinSession, reconcile, treeChanges } from '../runtime/chrome-extension/lan-guest.mjs';
import { apply, transformX } from '../runtime/chrome-extension/lan-ot.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const until = async (check, ms = 5000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw Error('Timed out'); await tick(); } };
const text = value => new TextEncoder().encode(value);
const b64 = bytes => Buffer.from(bytes).toString('base64');
const FILES = { 'main.tex': 'Hello Türkçe 😀 world\nline two\n', 'sec/a.tex': 'alpha' };

/** A relay that behaves like latex-local-lan: peers connect, frames are forwarded, admit/drop/close are recorded. */
function relay() {
  const listeners = new Set(), sockets = new Map(), calls = []; let next = 1;
  const emit = event => setImmediate(() => { for (const listener of listeners) listener(event); });
  const helper = {
    calls,
    call: async (op, args) => { calls.push(op); if (op === 'open') { assert.equal(args.bind, '127.0.0.1'); return { port: 4242 }; } if (op === 'drop') { const s = sockets.get(args.peer); if (s) s.deliverClose(); } return {}; },
    send: message => { if (message.op === 'send') { const s = sockets.get(message.peer); if (s && !s.dead && !s.mute) setImmediate(() => s.onmessage?.({ data: Uint8Array.from(Buffer.from(message.data, 'base64')).buffer })); } },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    close: () => {},
    lose: () => emit({ ev: 'helper-lost' }),
    raw: (peer, bytes) => emit({ ev: 'data', peer, data: b64(bytes) }),
    peerEvent: peer => emit({ ev: 'peer', peer }),
  };
  class Socket {
    constructor(url) { this.url = url; this.peer = next++; sockets.set(this.peer, this); this.dead = false; setImmediate(() => { emit({ ev: 'peer', peer: this.peer }); this.onopen?.(); }); }
    send(bytes) { if (!this.dead) emit({ ev: 'data', peer: this.peer, data: b64(bytes) }); }
    close() { if (!this.dead) { this.dead = true; emit({ ev: 'gone', peer: this.peer }); } }
    deliverClose() { if (!this.dead) { this.dead = true; setImmediate(() => this.onclose?.()); } }
    cut() { if (!this.dead) { this.dead = true; emit({ ev: 'gone', peer: this.peer }); setImmediate(() => this.onclose?.()); } } // the network drops: both ends notice
  }
  return { helper, Socket, sockets };
}

/** The native editor's client: local ops transform against remote ones (client = left), one op in flight. */
class Editor {
  constructor(ctl, path, state) { Object.assign(this, { ctl, path, text: state.text, version: state.v, inflight: null, pending: [], acks: 0 }); }
  submit(op) { this.text = apply(this.text, op); this.pending.push(op); this.#pump(); }
  remote(op, v) {
    assert.equal(v, this.version, 'remote update out of order');
    if (op === null) { this.inflight = null; this.version++; this.acks++; this.#pump(); return; } // an acknowledgement (reconcile: the owner had applied it)
    if (this.inflight) [this.inflight, op] = transformX(this.inflight, op);
    this.pending = this.pending.map(p => { let q; [q, op] = transformX(p, op); return q; });
    this.text = apply(this.text, op); this.version++;
  }
  #pump() {
    if (this.inflight || !this.pending.length) return;
    this.inflight = this.pending.shift();
    this.ctl.edit(this.path, { op: this.inflight, v: this.version }).then(applied => {
      if (applied === null) return; // reconciliation dropped it (clearInflightAndPendingOps already ran)
      assert.equal(applied, this.version, 'acknowledgement version');
      this.version++; this.inflight = null; this.acks++; this.#pump();
    });
  }
  get idle() { return !this.inflight && !this.pending.length; }
  // the ShareJS document surface reconcile() uses
  getSnapshot() { return this.text; } getVersion() { return this.version; } getInflightOp() { return this.inflight; }
  getPendingOp() { return this.pending.length ? this.pending.flat() : null; } clearInflightAndPendingOps() { this.inflight = null; this.pending = []; }
}

async function room({ permission } = {}) {
  const r = relay(), store = new Map(Object.entries(FILES).map(([path, content]) => [path, { content, revision: 3 }])), persisted = [], remotes = [];
  const source = {
    tree: () => ({ main: 'main.tex', docs: [...store.keys()], files: [...store].map(([path, f]) => ({ path, bytes: text(f.content) })) }),
    text: path => store.has(path) ? { text: store.get(path).content, version: store.get(path).revision } : null,
    persist: (path, value) => persisted.push([path, value]),
  };
  let owner;
  const host = await startHost({ helper: r.helper, source, permission, onRemote: (path, e) => owner?.[path]?.remote(e.op, e.v), onPeers: () => {} });
  owner = {};
  const own = async path => (owner[path] = new Editor(host, path, host.join(path)));
  const guests = [];
  const join = async (username = 'Ada', passcode = host.passcode, link = host.link, options = {}) => {
    const editors = {}, ctl = await joinSession({ ...options, link, passcode, username, WebSocketImpl: r.Socket, onRemote: (path, e) => editors[path]?.remote(e.op, e.v), onEnd: reason => (ctl.ended = reason) });
    ctl.editors = editors; ctl.open = async path => (editors[path] = new Editor(ctl, path, await ctl.join(path))); guests.push(ctl); return ctl;
  };
  return { r, host, own, join, store, persisted, guests, source };
}
const rnd = seed => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const PIECES = ['a', 'Türkçe', '😀', 'ß', '\n', '𝔛y', 'ж'];
function randomOp(random, current) {
  const chars = [...current]; // code-point boundaries: editors never split a surrogate pair
  const index = Math.floor(random() * (chars.length + 1)), position = chars.slice(0, index).join('').length;
  if (random() < 0.6 || !chars.length) return [{ p: position, i: PIECES[Math.floor(random() * PIECES.length)] }];
  const at = Math.min(index, chars.length - 1), span = chars.slice(at, at + 1 + Math.floor(random() * 3)).join('');
  return [{ p: chars.slice(0, at).join('').length, d: span }];
}

test('join, tree, live edits: owner and two participants converge on Unicode text including supplementary characters', async () => {
  const { host, own, join, guests, r } = await room();
  const ada = await join('Ada'), bob = await join('Bob');
  assert.deepEqual([...ada.docs].sort(), ['main.tex', 'sec/a.tex']); assert.equal(ada.store.readText('main.tex'), FILES['main.tex']);
  const random = rnd(7), editors = [await own('main.tex'), await ada.open('main.tex'), await bob.open('main.tex')];
  for (let round = 0; round < 60; round++) {
    const e = editors[Math.floor(random() * 3)]; e.submit(randomOp(random, e.text));
    if (random() < 0.5) await tick(); // some rounds overlap in flight, some settle first
  }
  await until(() => editors.every(e => e.idle) && editors.every(e => e.version === editors[0].version));
  assert.equal(editors[1].text, editors[0].text); assert.equal(editors[2].text, editors[0].text); assert.equal(editors[0].text, host.text('main.tex'));
  assert.ok(editors[0].version > 3 + 20); assert.equal(editors[0].text.isWellFormed(), true);
  assert.ok(editors[1].acks + editors[2].acks > 5);
});

test('equal-position inserts converge in the owner\'s log order with the native tie rule', async () => {
  const { own, join } = await room();
  const a = await (await join('Ada')).open('sec/a.tex'), b = await (await join('Bob')).open('sec/a.tex'), o = await own('sec/a.tex');
  a.submit([{ p: 2, i: 'AA' }]); b.submit([{ p: 2, i: 'BB' }]); o.submit([{ p: 2, i: '😀' }]);
  await until(() => [a, b, o].every(e => e.idle && e.version === 6)); assert.equal(a.text, b.text); assert.equal(a.text, o.text); assert.equal(a.text.length, 'alpha'.length + 6);
});

test('wrong passcode, wrong room, forged, replayed, oversized, stale and malformed requests are denied; the owner text survives', async () => {
  const { r, host, own, join, store, guests } = await room();
  await assert.rejects(join('Mallory', 'AAAA-AAAA-AAAA-AAAA'), /Room unavailable|passcode/i);
  await assert.rejects(join('Mallory', host.passcode, host.link.replace(/\/[A-Za-z0-9_-]{22}$/, '/' + 'A'.repeat(22))), /./); // another room id: keys differ
  const o = await own('main.tex'), before = host.text('main.tex');
  // forged bytes from an unadmitted peer are dropped by the room (and the helper told to drop it)
  r.helper.peerEvent(900); await tick(); const drops = r.helper.calls.filter(c => c === 'drop').length;
  r.helper.raw(900, crypto.getRandomValues(new Uint8Array(200))); await until(() => r.helper.calls.filter(c => c === 'drop').length > drops);
  const ada = await join('Ada'), edit = await ada.open('main.tex');
  // stale base in the future / malformed ops: the owner refuses, nothing changes
  await assert.rejects(ada.edit('main.tex', { op: [{ p: 0, i: 'x' }], v: 999 }), /unknown_base/);
  await assert.rejects(ada.edit('main.tex', { op: [{ p: 0, d: 'nope' }], v: edit.version }), /invalid_op/);
  assert.equal(host.text('main.tex'), before);
  // replay of a sealed frame: capture Ada's next frame and resend it
  const frames = []; const send = ada.session.send; const raw = r.helper;
  const socket = [...r.sockets.values()].find(s => !s.dead && s.peer === [...r.sockets.keys()].at(-1));
  const original = socket.send.bind(socket); socket.send = bytes => { frames.push(bytes); original(bytes); };
  await ada.cursor({ path: 'main.tex', row: 0, column: 1 }); await until(() => frames.length === 1);
  original(frames[0]); await until(() => ada.ended || !ada.session.can('edit')); // replayed counter: the room drops the connection
  assert.equal(ada.session.state, 'ended'); assert.equal(host.text('main.tex'), before); void raw; void send;
  // oversized: a participant frame above the limit never reaches the room
  const bob = await join('Bob'); const peer = [...r.sockets.keys()].at(-1), calls = r.helper.calls.length;
  r.helper.raw(peer, new Uint8Array(600 * 1024)); await tick(); assert.equal(bob.session.state, 'joined');
  // unknown file / unsupported request types end the connection
  await bob.session.send({ t: 'update', k: 'op', path: '../../etc/passwd', cid: '0'.repeat(32), n: 1, base: 0, ops: [] }); await until(() => bob.session.state === 'ended');
  assert.equal(store.get('main.tex').content, FILES['main.tex']); void guests; void calls; void o;
});

test('permission hook: a denied action gets "denied" and changes nothing; raw copy requests need the owner grant', async () => {
  const seen = []; let allow = true;
  const { host, join, own } = await room({ permission: info => { seen.push(info.action); return allow; } });
  const ada = await join('Ada'), e = await ada.open('main.tex'); await own('main.tex');
  allow = false; const before = host.text('main.tex');
  await assert.rejects(ada.edit('main.tex', { op: [{ p: 0, i: 'x' }], v: e.version }), /not allowed/);
  assert.equal(host.text('main.tex'), before); assert.ok(seen.includes('view') && seen.includes('edit'));
  allow = true;
  await assert.rejects(ada.exportCopy('export'), { code: 'denied' }); // grant is 'online': no ticket, no copy
  await host.setGrant(host.participants()[0].peer, 'copy'); await until(() => !ada.gate.locked);
  const copy = await ada.exportCopy('export'); assert.equal(new TextDecoder().decode(copy.files.find(f => f.path === 'sec/a.tex').bytes), 'alpha');
});

test('host loss ends the session and keeps owner data; stop sharing revokes; rejoin gets the current shared text', async () => {
  const { r, host, own, join, store, persisted } = await room();
  const o = await own('main.tex'), ada = await join('Ada'), a = await ada.open('main.tex');
  a.submit([{ p: 0, i: 'A:' }]); o.submit([{ p: 0, i: 'O:' }]);
  await until(() => a.idle && o.idle && a.version === o.version);
  assert.equal(a.text, o.text); assert.ok(persisted.length >= 1); assert.equal(persisted.at(-1)[1], host.text(persisted.at(-1)[0]) ?? persisted.at(-1)[1]);
  await host.stop(); await until(() => ada.ended); assert.match(ada.ended, /stopped/);
  await assert.rejects(ada.edit('main.tex', { op: [{ p: 0, i: 'z' }], v: 9 }), /./);
  assert.equal(store.get('main.tex').content, FILES['main.tex']); // the owner's saved file is only changed through persist(); the shim does that
  // a new room (new passcode) after stop: the old passcode no longer joins, the new one does and starts from the owner's text
  const next = await room(); const guest = await next.join('Ada'); assert.equal((await guest.join('main.tex')).text, FILES['main.tex']);
  await assert.rejects(next.join('Eve', host.passcode), /./);
  void r;
});

test('helper loss stops the owner side and rejects pending edits', async () => {
  const { r, host, own, join } = await room(); const o = await own('main.tex'); let lost = false;
  const pending = host.edit('main.tex', { op: [{ p: 0, i: 'x' }], v: o.version }); await pending; // acknowledged before loss
  r.helper.lose(); await until(() => host.stopped);
  void lost;
});

const live = r => [...r.sockets.values()].filter(s => !s.dead).at(-1);
const count = (text, part) => text.split(part).length - 1;

test('S2-05 a dropped connection locks, keeps unsent edits in memory and resumes through the owner log: nothing applies twice or is lost', async () => {
  const { r, host, own, join } = await room(); const lost = [], resumed = [];
  const o = await own('main.tex'), ada = await join('Ada', undefined, undefined, { retries: [5, 5, 5], onLost: (_, x) => lost.push(x.retrying), onResumed: c => resumed.push(c) });
  const a = await ada.open('main.tex');
  const s = live(r); s.mute = true; a.submit([{ p: 0, i: 'A1:' }]); // the owner applies it, the acknowledgement is lost with the connection
  await until(() => host.text('main.tex').startsWith('A1:')); s.cut();
  await until(() => ada.state !== 'live'); assert.throws(() => ada.store.paths(), /ended/, 'the session copy is wiped on loss');
  a.submit([{ p: 0, i: 'A2:' }]); o.submit([{ p: o.text.length, i: '|O' }]); // edits on both sides while apart
  await until(() => ada.state === 'live' && a.idle && o.idle && a.version === o.version);
  assert.equal(a.text, o.text); assert.equal(a.text, host.text('main.tex'));
  assert.equal(count(a.text, 'A1:'), 1); assert.equal(count(a.text, 'A2:'), 1); assert.equal(count(a.text, '|O'), 1);
  assert.deepEqual(lost, [true]); assert.deepEqual(resumed, [[]]); assert.equal(ada.store.readText('sec/a.tex'), 'alpha');
  // revoked: the session ends and cannot be resumed
  await host.revoke(host.participants()[0].peer); await until(() => ada.ended);
  await assert.rejects(ada.rejoin(), /ended/); await assert.rejects(ada.edit('main.tex', { op: [{ p: 0, i: 'z' }], v: a.version }), /./);
});

test('S2-05 rejoin into a new room: unsafe files wait for an explicit choice; keep rebases onto the owner text, discard drops only the unsent edit', async () => {
  const { r, host, join, source, store } = await room(); const resumed = [];
  const ada = await join('Ada', undefined, undefined, { retries: [], onResumed: c => resumed.push(c) });
  const a = await ada.open('main.tex'), b = await ada.open('sec/a.tex');
  live(r).cut(); await until(() => ada.state === 'lost');
  a.submit([{ p: 0, i: 'MINE:' }]); b.submit([{ p: 0, i: 'X' }]); // unsent, held in memory
  await host.stop(); // the owner's page went away; sharing again opens a new room with a new passcode
  store.get('main.tex').content = 'OWNER ' + FILES['main.tex']; store.get('sec/a.tex').content = 'ALPHA';
  const host2 = await startHost({ helper: r.helper, source, onPeers: () => {} });
  await assert.rejects(ada.rejoin({ link: host2.link, passcode: host.passcode }), /./); // the old passcode does not open the new room
  assert.equal(ada.state, 'lost');
  await ada.rejoin({ link: host2.link, passcode: host2.passcode });
  assert.deepEqual(resumed, [['main.tex', 'sec/a.tex']]);
  const deliver = editor => (op, v) => editor.remote(op, v);
  assert.equal(await reconcile(ada, 'main.tex', a, deliver(a)), false, 'auto never picks a side when both changed');
  assert.equal(host2.text('main.tex') ?? store.get('main.tex').content, 'OWNER ' + FILES['main.tex']);
  assert.equal(await reconcile(ada, 'main.tex', a, deliver(a), 'keep'), true);
  await until(() => a.idle && host2.text('main.tex').includes('MINE:'));
  assert.equal(a.text, host2.text('main.tex')); assert.equal(count(a.text, 'MINE:'), 1); assert.ok(a.text.includes('OWNER '));
  assert.equal(await reconcile(ada, 'sec/a.tex', b, deliver(b), 'discard'), true);
  assert.equal(b.text, 'ALPHA'); assert.equal(host2.text('sec/a.tex'), 'ALPHA');
  b.submit([{ p: 5, i: '!' }]); await until(() => b.idle && host2.text('sec/a.tex') === 'ALPHA!'); // versions line up after the choice
  await host2.stop();
});

test('S2-05 a resumed participant keeps the owner grant (owner-signed copies still work); a downgrade made while it was away applies on resume', async () => {
  const { r, host, join } = await room();
  const ada = await join('Ada', undefined, undefined, { retries: [] }), a = await ada.open('main.tex');
  await host.setGrant(host.participants()[0].peer, 'copy'); await until(() => ada.grant === 'copy');
  live(r).cut(); await until(() => ada.state === 'lost');
  await ada.rejoin(); assert.equal(ada.grant, 'copy'); assert.equal(host.participants()[0].grant, 'copy');
  assert.ok(await ada.exportCopy('export'), 'a ticket signed by the owner still releases a copy after resume');
  const stale = host.participants()[0].peer; live(r).deliverClose(); await until(() => ada.state === 'lost'); // only Ada notices the loss
  await host.setGrant(stale, 'online'); // the owner downgrades the connection it still sees
  await ada.rejoin(); assert.equal(ada.grant, 'online'); assert.equal(ada.gate.locked, true);
  await assert.rejects(ada.exportCopy('export'), { code: 'denied' });
  assert.equal(ada.session.can('edit'), true); a.submit([{ p: 0, i: 'EDIT:' }]); await until(() => a.idle && host.text('main.tex').startsWith('EDIT:')); // "online" still edits
  await host.stop();
});

/** Owner edits that push the participant's base out of the owner log (LIMITS.logBytes), leaving the text unchanged. */
const churn = async (host, path) => {
  const big = 'x'.repeat(100_000); let { v } = host.join(path);
  for (let i = 0; i < 24; i++) { v = await host.edit(path, { op: [{ p: 0, i: big }], v }) + 1; v = await host.edit(path, { op: [{ p: 0, d: big }], v }) + 1; }
  return v;
};
test('S2-05 log truncation: an edit the owner applied but never acknowledged is not duplicated by keep or auto; the unsent one is kept once', async () => {
  const { r, host, join } = await room(); const resumed = [];
  const ada = await join('Ada', undefined, undefined, { retries: [], onResumed: c => resumed.push(c) });
  const a = await ada.open('main.tex'), b = await ada.open('sec/a.tex');
  live(r).mute = true; a.submit([{ p: 0, i: 'A1:' }]); b.submit([{ p: 0, i: 'B1:' }]); // applied by the owner, acknowledgements lost
  await until(() => host.text('main.tex').startsWith('A1:') && host.text('sec/a.tex').startsWith('B1:')); live(r).cut();
  await until(() => ada.state === 'lost');
  a.submit([{ p: 0, i: 'A2:' }]); // unsent, waits behind the applied one
  for (const path of ['main.tex', 'sec/a.tex']) { const v = await churn(host, path); await host.edit(path, { op: [{ p: host.text(path).length, i: '|OWNER' }], v }); }
  await ada.rejoin(); await until(() => resumed.length); assert.deepEqual(resumed, [['main.tex', 'sec/a.tex']], 'the log no longer covers either file');
  const deliver = editor => (op, v) => editor.remote(op, v);
  assert.equal(await reconcile(ada, 'sec/a.tex', b, deliver(b)), true, 'auto: the only in-flight edit was already applied, nothing is unsent');
  assert.equal(await reconcile(ada, 'main.tex', a, deliver(a)), false, 'auto still asks when an unsent edit and owner changes meet');
  assert.equal(await reconcile(ada, 'main.tex', a, deliver(a), 'keep'), true);
  await until(() => a.idle && b.idle && host.text('main.tex').includes('A2:'));
  assert.equal(a.text, host.text('main.tex')); assert.equal(b.text, host.text('sec/a.tex'));
  assert.equal(count(a.text, 'A1:'), 1); assert.equal(count(a.text, 'A2:'), 1); assert.equal(count(a.text, '|OWNER'), 1);
  assert.equal(b.text, 'B1:alpha|OWNER');
  a.submit([{ p: a.text.length, i: '!' }]); b.submit([{ p: 0, i: '>' }]); // ids and versions line up after the choice: the owner accepts the next edits
  await until(() => a.idle && b.idle && host.text('main.tex').endsWith('!') && host.text('sec/a.tex') === '>B1:alpha|OWNER');
  assert.equal(ada.state, 'live'); await host.stop();
});

// ---- S2-03: exact project transfer and file-tree changes during a session ------------------------------------------------------
import { CHUNK, MAX_FILE, streamFiles, ProjectTree } from '../runtime/chrome-extension/lan-transfer.mjs';
import { settle } from './lan-transfer-harness.mjs';
const noise = (length, seed = 1) => { const out = new Uint8Array(length); let s = seed >>> 0; for (let i = 0; i < length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; out[i] = s >>> 24; } return out; };
const hex = bytes => Buffer.from(bytes).toString('hex');
/** Owner project like native-workspace: text docs (bytes = UTF-8 of the saved text), binary files, folders; apply() mutates it. */
async function fsRoom() {
  const r = relay(), files = new Map(), folders = new Set(['figures', 'empty/nested']), applied = [], open = [], project = { main: 'main.tex' };
  // like native-workspace: an open editor follows a rename and closes on delete
  const follow = (ctl, op) => { for (const x of open) if (x.ctl === ctl && x.path && op.from && (x.path === op.from || x.path.startsWith(op.from + '/'))) x.path = op.kind === 'relocate' ? op.to + x.path.slice(op.from.length) : null; };
  const put = (path, bytes, doc) => files.set(path, { bytes, doc, revision: 0 });
  put('main.tex', text('\\documentclass{article}\r\n\\begin{document}\r\nTürkçe 😀 𝔛\r\n\\end{document}\r\n'), true);
  put('sec/a.tex', text('alpha\nbeta\r\n'), true);
  put('figures/plot.png', noise(CHUNK + 1234, 3), false);
  const pdf = noise(2 * CHUNK + 7, 9); pdf.set(text('%PDF-1.7\n'), 0); put('out/paper.pdf', pdf, false);
  put('fonts/Ünï.otf', noise(5000, 4), false); put('empty.txt', new Uint8Array(0), false);
  const inside = (path, root) => path === root || path.startsWith(root + '/');
  let host;
  const source = {
    tree: () => ({ main: project.main, folders: [...folders], docs: [...files].filter(([, f]) => f.doc).map(([p]) => p), files: [...files].map(([path, f]) => ({ path, bytes: f.bytes })) }),
    text: path => files.get(path)?.doc ? { text: new TextDecoder().decode(files.get(path).bytes), version: files.get(path).revision } : null,
    persist: (path, value) => { const f = files.get(path); if (f) f.bytes = text(value); },
    apply: async op => {
      applied.push(op.kind); follow(host, op);
      if (op.kind === 'main') { if (!files.get(op.path)?.doc) throw Error('Choose an existing text main document'); project.main = op.path; }
      else if (op.kind === 'folder') folders.add(op.path);
      else if (op.kind === 'doc') put(op.path, new Uint8Array(0), true);
      else if (op.kind === 'put') { if (op.doc && !new TextDecoder().decode(op.bytes).isWellFormed()) throw Error('Unsupported text file'); put(op.path, op.bytes.slice(), op.doc); }
      else for (const [path, f] of [...files]) if (inside(path, op.from)) { files.delete(path); if (op.kind === 'relocate') files.set(op.to + path.slice(op.from.length), f); }
      if (op.kind === 'relocate' && inside(project.main, op.from)) project.main = op.to + project.main.slice(op.from.length); // as project-store.js
      if (op.from) for (const path of [...folders]) if (inside(path, op.from)) { folders.delete(path); if (op.kind === 'relocate') folders.add(op.to + path.slice(op.from.length)); }
      return { applied: op.kind };
    },
  };
  const route = ctl => (path, e) => open.find(x => x.ctl === ctl && x.path === path)?.remote(e.op, e.v);
  host = await startHost({ helper: r.helper, source, onPeers: () => {}, onRemote: (...a) => route(host)(...a) });
  const join = async (username, options = {}) => {
    const seen = [], ctl = await joinSession({ ...options, link: host.link, passcode: host.passcode, username, WebSocketImpl: r.Socket, onEnd: reason => (ctl.ended = reason),
      onRemote: (...a) => route(ctl)(...a), onFs: op => { seen.push(op); follow(ctl, op); options.onFs?.(op); return { seenBy: username, kind: op.kind }; } });
    ctl.seen = seen; return ctl;
  };
  const edit = async (ctl, path) => { const e = new Editor(ctl, path, ctl === host ? host.join(path) : await ctl.join(path)); open.push(e); return e; };
  /** Every file of the owner equals the participant's bytes, and nothing else exists there. */
  const same = ctl => { assert.deepEqual(ctl.store.paths(), [...files.keys()].sort()); for (const [path, f] of files) if (!open.some(x => x.path === path)) assert.equal(hex(ctl.store.read(path)), hex(f.bytes), path); return true; }; // live-edited text is the native persist's job
  return { r, host, join, files, folders, same, applied, edit, project, source };
}

/** What a native file tree would show after replaying onFs ops in order; each op must fit the tree it lands on. */
function view(ctl) {
  const files = new Map(ctl.store.paths().map(path => [path, ctl.docs.has(path)])), folders = new Set(ctl.folders), v = { files, folders, main: ctl.main };
  const parent = path => path.slice(0, Math.max(0, path.lastIndexOf('/'))), inside = (path, root) => path === root || path.startsWith(root + '/');
  v.apply = op => {
    if (op.kind === 'main') { assert.ok(files.get(op.path), 'main is a shown text file'); v.main = op.path; return; }
    if (op.kind === 'folder' || op.kind === 'put' || op.kind === 'doc') {
      assert.ok(!files.has(op.path) && !folders.has(op.path), 'not shown yet: ' + op.path);
      if (op.kind === 'folder') { assert.ok(!parent(op.path) || folders.has(parent(op.path)), 'parent shown first'); folders.add(op.path); return; }
      if (op.kind === 'put') assert.equal(op.bytes.length, op.size);
      files.set(op.path, op.kind === 'doc' || op.doc); for (let p = parent(op.path); p; p = parent(p)) folders.add(p); return;
    }
    assert.ok(files.has(op.from) || folders.has(op.from), 'shown before ' + op.kind + ': ' + op.from);
    const to = path => op.kind === 'relocate' ? op.to + path.slice(op.from.length) : null;
    for (const [path, doc] of [...files]) if (inside(path, op.from)) { files.delete(path); if (to(path)) files.set(to(path), doc); }
    for (const path of [...folders]) if (inside(path, op.from)) { folders.delete(path); if (to(path)) folders.add(to(path)); }
  };
  v.matches = () => { assert.deepEqual([...files.keys()].sort(), ctl.store.paths()); assert.deepEqual([...folders].sort(), [...ctl.folders].sort());
    for (const [path, doc] of files) assert.equal(doc, ctl.docs.has(path), path); assert.equal(v.main, ctl.main); return true; };
  return v;
}

test('S2-03 tree changes made while a participant was away reach its native tree on resume, emoji paths included, then live changes follow', async () => {
  const { r, host, join, same } = await fsRoom(); let shown = null;
  const ada = await join('Ada', { retries: [], onFs: op => shown?.apply(op) }); shown = view(ada);
  live(r).cut(); await until(() => ada.state === 'lost');
  await host.fs({ kind: 'relocate', from: 'sec', to: 'chapters 😀' }); await host.fs({ kind: 'remove', from: 'out' });
  const pic = noise(CHUNK + 17, 61); await host.fs({ kind: 'put', path: 'figs 🎉/pic 😀.png', doc: false, bytes: pic });
  await host.fs({ kind: 'remove', from: 'figures/plot.png' }); await host.fs({ kind: 'put', path: 'figures/plot.png', doc: false, bytes: noise(99, 5) }); // replaced, other size
  await host.fs({ kind: 'remove', from: 'empty.txt' }); await host.fs({ kind: 'put', path: 'empty.txt', doc: true, bytes: text('now text 😀') }); // binary became text
  await host.fs({ kind: 'folder', path: 'new 🚀' }); await host.fs({ kind: 'folder', path: 'new 🚀/deep' }); await host.fs({ kind: 'main', path: 'chapters 😀/a.tex' });
  await ada.rejoin(); await until(() => ada.state === 'live'); await settle();
  assert.ok(same(ada) && shown.matches()); assert.equal(hex(ada.store.read('figs 🎉/pic 😀.png')), hex(pic));
  await host.fs({ kind: 'relocate', from: 'figs 🎉/pic 😀.png', to: 'pic 🚀.png' }); await ada.fs({ kind: 'remove', from: 'figs 🎉' });
  await ada.fs({ kind: 'relocate', from: 'pic 🚀.png', to: 'new 🚀/deep/pic 🚀.png' }); await settle();
  assert.ok(same(ada) && shown.matches()); assert.equal(hex(ada.store.read('new 🚀/deep/pic 🚀.png')), hex(pic));
});

test('S2-03 rejoin into a new room: the native tree shows the new room\'s project', async () => {
  const { r, host, join, files, source } = await fsRoom(); let shown = null;
  const ada = await join('Ada', { retries: [], onFs: op => shown?.apply(op) }); shown = view(ada);
  live(r).cut(); await until(() => ada.state === 'lost'); await host.stop();
  files.delete('out/paper.pdf'); files.set('notes 😀/n.tex', { bytes: text('n'), doc: true, revision: 0 }); // the owner's project changed before sharing again
  const host2 = await startHost({ helper: r.helper, source, onPeers: () => {} });
  await ada.rejoin({ link: host2.link, passcode: host2.passcode }); await until(() => ada.state === 'live');
  assert.ok(shown.matches()); assert.ok(ada.docs.has('notes 😀/n.tex') && !ada.store.has('out/paper.pdf'));
  await host2.stop();
});

test('treeChanges: outermost removals first, kind or size changes re-put, folders parents-first, then the main file', () => {
  const before = { tree: new ProjectTree({ files: [['a/b/c.tex', 3], ['a/x.bin', 4], ['k.bin', 2], ['d.tex', 0], ['f', 1]], folders: ['a/b/e'], main: 'd.tex' }), docs: new Set(['a/b/c.tex', 'd.tex']) };
  assert.deepEqual(treeChanges(before, before), []);
  const after = { tree: new ProjectTree({ files: [['k.bin', 5], ['d.tex', 1], ['f/g 😀.tex', 2], ['m.tex', 1]], folders: ['n 🎉/o/p'], main: 'm.tex' }), docs: new Set(['d.tex', 'f/g 😀.tex', 'm.tex']) };
  assert.deepEqual(treeChanges(before, after), [
    { kind: 'remove', from: 'k.bin' }, { kind: 'remove', from: 'f' }, { kind: 'remove', from: 'a' },
    { kind: 'folder', path: 'f' }, { kind: 'folder', path: 'n 🎉' }, { kind: 'folder', path: 'n 🎉/o' }, { kind: 'folder', path: 'n 🎉/o/p' },
    { kind: 'put', path: 'k.bin', size: 5, doc: false }, { kind: 'put', path: 'f/g 😀.tex', size: 2, doc: true }, { kind: 'put', path: 'm.tex', size: 1, doc: true },
    { kind: 'main', path: 'm.tex' },
  ]);
});

test('S2-03 join transfers the whole project exactly: CRLF/supplementary text, multi-chunk binaries, empty file and empty folders', async () => {
  const { join, same, folders } = await fsRoom(), ada = await join('Ada');
  assert.ok(same(ada));
  assert.deepEqual(new Set(ada.folders), new Set([...folders, 'empty', 'sec', 'out', 'fonts']));
  assert.deepEqual([...ada.docs].sort(), ['main.tex', 'sec/a.tex']);
  assert.equal(ada.store.readText('main.tex').includes('\r\nTürkçe 😀 𝔛\r\n'), true);
});

test('S2-03 owner and participant file-tree changes reach every peer through the owner, in order, with exact bytes', async () => {
  const { host, join, files, same, folders, edit } = await fsRoom(), ada = await join('Ada'), bob = await join('Bob');
  let count = 0; const settled = () => until(() => ada.seen.length === count && bob.seen.length === count);
  // owner: folder, doc, multi-chunk binary upload, rename and move
  await host.fs({ kind: 'folder', path: 'chapters' }); count++;
  await host.fs({ kind: 'doc', path: 'chapters/one.tex' }); count++;
  const big = noise(3 * CHUNK + 99, 21); await host.fs({ kind: 'put', path: 'figures/big.bin', doc: false, bytes: big }); count++;
  await settled(); assert.ok(same(ada) && same(bob)); assert.ok(ada.docs.has('chapters/one.tex'));
  assert.equal(hex(ada.seen.find(op => op.kind === 'put').bytes), hex(big));
  // participant: upload a binary and a text file, create a folder; the answer is this peer's own onFs result
  const png = noise(CHUNK * 2 + 5, 33);
  assert.deepEqual(await ada.fs({ kind: 'put', path: 'figures/ada.png', doc: false, bytes: png }), { seenBy: 'Ada', kind: 'put' }); count++;
  await ada.fs({ kind: 'put', path: 'chapters/two.tex', doc: true, bytes: text('Zwei 😀\r\n') }); count++;
  await bob.fs({ kind: 'folder', path: 'chapters/drafts' }); count++;
  const deep = noise(777, 8); await bob.fs({ kind: 'put', path: 'new/deep/Ünï 😀.bin', doc: false, bytes: deep }); count++; // an upload creates its folders
  await settled(); assert.equal(hex(files.get('figures/ada.png').bytes), hex(png)); assert.ok(same(ada) && same(bob)); assert.ok(bob.docs.has('chapters/two.tex'));
  assert.ok(folders.has('chapters/drafts') && bob.folders.includes('chapters/drafts'));
  // rename a document both sides are editing, then keep editing under the new name: the shared log carries on
  const o = await edit(host, 'sec/a.tex'), a = await edit(ada, 'sec/a.tex');
  a.submit([{ p: 0, i: 'A1 ' }]); o.submit([{ p: 0, i: 'O1 ' }]); await until(() => a.idle && o.idle && a.version === o.version);
  await ada.fs({ kind: 'relocate', from: 'sec', to: 'chapters/sec' }); count++;
  await settled(); assert.equal(a.path, 'chapters/sec/a.tex'); await until(() => o.path === 'chapters/sec/a.tex');
  a.submit([{ p: 0, i: 'A2 ' }]); o.submit([{ p: 0, i: 'O2 ' }]); await until(() => a.idle && o.idle && a.version === o.version);
  assert.equal(a.text, o.text); assert.equal(a.text, host.text('chapters/sec/a.tex')); assert.ok(a.text.includes('A2') && a.text.includes('O1'));
  assert.equal(new TextDecoder().decode(files.get('chapters/sec/a.tex').bytes), o.text); // persisted under the new name
  assert.ok(!files.has('sec/a.tex') && ada.docs.has('chapters/sec/a.tex') && !ada.docs.has('sec/a.tex'));
  await host.fs({ kind: 'relocate', from: 'figures/ada.png', to: 'ada.png' }); count++;
  await host.fs({ kind: 'remove', from: 'out' }); count++;
  await settled(); assert.ok(same(ada) && same(bob)); assert.ok(!ada.folders.includes('out'));
  assert.deepEqual(ada.seen.map(op => op.kind), ['folder', 'doc', 'put', 'put', 'put', 'folder', 'put', 'relocate', 'relocate', 'remove']);
  assert.ok(ada.folders.includes('new/deep') && hex(ada.store.read('new/deep/Ünï 😀.bin')) === hex(deep));
  // a late joiner gets the current tree exactly
  const eve = await join('Eve'); assert.ok(same(eve)); assert.deepEqual(new Set(eve.folders), new Set(ada.folders));
});

test('S2-03 refused changes: collisions, path escape, missing parent, main file, oversized, damaged or truncated uploads change nothing', async () => {
  const { host, join, files, same } = await fsRoom(), ada = await join('Ada'), snapshot = () => [...files.keys()].sort().join('|');
  const before = snapshot();
  for (const [op, reason] of [
    [{ kind: 'relocate', from: 'sec/a.tex', to: 'main.tex' }, /already exists/],
    [{ kind: 'relocate', from: 'sec/a.tex', to: 'MAIN.TEX' }, /already exists/],      // case-insensitive file systems
    [{ kind: 'relocate', from: 'sec', to: 'sec/inner' }, /outside/],
    [{ kind: 'doc', path: '../escape.tex' }, /Invalid project path/],
    [{ kind: 'folder', path: 'figures/../../x' }, /Invalid project path/],
    [{ kind: 'relocate', from: 'main.tex', to: '/abs.tex' }, /valid destination/],
    [{ kind: 'doc', path: 'missing/x.tex' }, /folder is missing/],
    [{ kind: 'put', path: 'main.tex/x.bin', doc: false, bytes: new Uint8Array(1) }, /already exists/],   // a file cannot become an upload's folder
    [{ kind: 'put', path: 'FIGURES/x.bin', doc: false, bytes: new Uint8Array(1) }, /already exists/],
    [{ kind: 'remove', from: 'main.tex' }, /main document/],
    [{ kind: 'remove', from: 'nope.tex' }, /missing/],
    [{ kind: 'chmod', path: 'main.tex' }, /Unknown/],
  ]) await assert.rejects(ada.fs(op), reason, JSON.stringify(op));
  await assert.rejects(host.fs({ kind: 'doc', path: 'a\\b' }), /Invalid project path/);
  await assert.rejects(ada.fs({ kind: 'put', path: 'huge.bin', doc: false, bytes: new Uint8Array(MAX_FILE + 1) }), /size/); // refused before sending
  // hand-made uploads: oversized manifest, flipped byte (hash mismatch), truncated (end before the last chunk), op without upload
  const send = m => ada.session.send({ t: 'fs', k: 'blob', m });
  const raw = async (bytes, tamper) => { const msgs = []; const { xfer } = await streamFiles(async m => msgs.push(m), { files: [{ path: 'evil.bin', bytes }] }); for (const m of tamper(msgs)) await send(m); return xfer; };
  const bytes = noise(CHUNK + 10, 5);
  const cases = {
    oversized: msgs => [{ ...msgs[0], total: MAX_FILE + 1, files: [{ ...msgs[0].files[0], size: MAX_FILE + 1, chunks: Math.ceil((MAX_FILE + 1) / CHUNK) }] }, ...msgs.slice(1)],
    'hash mismatch': msgs => msgs.map(m => m.t === 'file' && m.seq === 1 ? { ...m, data: Buffer.from(Buffer.from(m.data, 'base64').map((b, i) => i === 3 ? b ^ 1 : b)).toString('base64') } : m),
    truncated: msgs => [...msgs.slice(0, -2), msgs.at(-1)],
    'short chunk': msgs => msgs.map(m => m.t === 'file' && m.seq === 1 ? { ...m, data: m.data.slice(0, 8) } : m),
  };
  for (const [name, tamper] of Object.entries(cases)) {
    const xfer = await raw(bytes, tamper), ref = name.length.toString(16).padStart(4, '0');
    await ada.session.send({ t: 'fs', k: 'op', ref, op: { kind: 'put', path: 'evil.bin', doc: false, xfer } });
    await settle(); assert.equal(files.has('evil.bin'), false, name); assert.equal(ada.session.state, 'joined', name);
  }
  await assert.rejects(ada.fs({ kind: 'put', path: 'evil.bin', doc: false }), /Invalid project/);   // no bytes at all: refused locally
  assert.equal(snapshot(), before); assert.ok(same(ada)); assert.equal(ada.seen.length, 0);
});

test('S2-03 deleting a file someone has open: late edits are refused without ending the session; the path can be created again', async () => {
  const { host, join, files, edit } = await fsRoom(), ada = await join('Ada');
  const a = await edit(ada, 'sec/a.tex'), o = await edit(host, 'sec/a.tex');
  a.submit([{ p: 0, i: 'x' }]); await until(() => a.idle);
  await host.fs({ kind: 'remove', from: 'sec' }); await until(() => ada.seen.length === 1);
  assert.equal(files.has('sec/a.tex'), false); assert.equal(ada.store.has('sec/a.tex'), false); assert.equal(ada.docs.has('sec/a.tex'), false);
  await assert.rejects(ada.edit('sec/a.tex', { op: [{ p: 0, i: 'late' }], v: a.version }), /no_such_file|deleted/);
  await assert.rejects(host.edit('sec/a.tex', { op: [{ p: 0, i: 'late' }], v: o.version }), /deleted|Unknown/);
  assert.equal(ada.session.state, 'joined'); assert.equal(files.has('sec/a.tex'), false);
  await ada.fs({ kind: 'folder', path: 'sec' }); await ada.fs({ kind: 'doc', path: 'sec/a.tex' });
  const fresh = await edit(ada, 'sec/a.tex'); assert.equal(fresh.text, '');
  fresh.submit([{ p: 0, i: 'new' }]); await until(() => fresh.idle); assert.equal(host.text('sec/a.tex'), 'new');
});

test('S2-03 changes made while a participant is still receiving the project are applied once, after it', async () => {
  const { host, join, same } = await fsRoom();
  const joining = join('Ada'), changes = (async () => { for (let i = 0; i < 6; i++) await host.fs({ kind: 'put', path: `late${i}.bin`, doc: false, bytes: noise(CHUNK + i, 50 + i) }); })();
  const ada = await joining; await changes; await until(() => ada.store.has('late5.bin'));
  await settle(); assert.ok(same(ada)); assert.equal(ada.session.state, 'joined'); assert.ok(ada.seen.length < 6 || ada.seen.length === 6);
});

test('S2-03 set-main goes through the owner: a binary main is refused, a text main moves on every peer and frees the old main', async () => {
  const { host, join, project, same } = await fsRoom(), ada = await join('Ada'), bob = await join('Bob');
  await assert.rejects(ada.fs({ kind: 'main', path: 'figures/plot.png' }), /text main/);
  await assert.rejects(ada.fs({ kind: 'main', path: 'nope.tex' }), /existing/);
  await assert.rejects(bob.fs({ kind: 'remove', from: 'main.tex' }), /main document/);
  await ada.fs({ kind: 'main', path: 'sec/a.tex' }); await until(() => bob.seen.length === 1);
  assert.equal(project.main, 'sec/a.tex'); assert.equal(ada.store.main, 'sec/a.tex'); assert.equal(bob.store.main, 'sec/a.tex');
  await bob.fs({ kind: 'remove', from: 'main.tex' }); await until(() => ada.seen.length === 2);   // the old main is an ordinary file now
  await host.fs({ kind: 'relocate', from: 'sec', to: 'body' }); await until(() => ada.seen.length === 3 && bob.seen.length === 3);
assert.equal(ada.store.main, 'body/a.tex'); assert.equal(bob.store.main, 'body/a.tex'); assert.ok(same(ada) && same(bob));
  const eve = await join('Eve'); assert.equal(eve.main, 'body/a.tex');
});


test('missing sharing host acknowledges Chrome errors and rejects pending calls', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'chrome'); let reads = 0, disconnected;
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime: { get lastError() { reads++; return { message: 'Specified native messaging host not found.' }; } } } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'chrome', original); else delete globalThis.chrome; });
  const port = { onMessage: { addListener() {} }, onDisconnect: { addListener(fn) { disconnected = fn; } }, postMessage() {}, disconnect() {} };
  const helper = nativeHelper(() => port), events = []; helper.subscribe(event => events.push(event));
  const pending = [helper.call('addresses'), helper.call('open')]; disconnected();
  assert.equal(reads, 1); for (const call of pending) await assert.rejects(call, /sharing helper is not available/);
  await assert.rejects(helper.call('addresses'), /sharing helper is not available/); assert.deepEqual(events, [{ ev: 'helper-lost' }]);
  assert.equal(await helperAvailable(() => { queueMicrotask(() => disconnected()); return port; }), false); assert.equal(reads, 2);
});
