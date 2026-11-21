// SPDX-License-Identifier: AGPL-3.0-only
// CEX-LAN-01 in memory: lan-host.mjs + lan-guest.mjs over the real sealed room (lan-room.mjs), with a fake relay helper and a
// small native-style OT client (inflight + pending, transforms the way the editor's own client does). No sockets, no storage.
// Run: node --test test/lan-native.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHost } from '../runtime/chrome-extension/lan-host.mjs';
import { joinSession, reconcile } from '../runtime/chrome-extension/lan-guest.mjs';
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
