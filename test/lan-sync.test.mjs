// SPDX-License-Identifier: AGPL-3.0-only
// S2-05 checks: lan-sync.mjs over the real lan-room.mjs crypto channel, in memory (no sockets).
// The repo has no importable text transform (the native editor's sharejs-text-ot lives in the compiled Overleaf frontend), so the
// `ot` below is a TEST DOUBLE with ShareJS text semantics ({p,i}/{p,d} components, server wins ties). It is validated against an
// independent string-apply reference (the TP1 diamond) before anything relies on it. Production must inject the editor's own OT.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { OwnerRoom, joinRoom } from '../runtime/chrome-extension/lan-room.mjs';
import { OwnerSync, ParticipantSync, LIMITS } from '../runtime/chrome-extension/lan-sync.mjs';

// ---- OT test double -------------------------------------------------------------------------------------------------------------
const isInt = n => Number.isSafeInteger(n) && n >= 0;
function apply(text, ops) {
  for (const c of ops) {
    if (!isInt(c.p) || c.p > text.length) throw Error('Position out of range');
    if (c.i !== undefined) text = text.slice(0, c.p) + c.i + text.slice(c.p);
    else { if (text.slice(c.p, c.p + c.d.length) !== c.d) throw Error('Delete does not match the text'); text = text.slice(0, c.p) + text.slice(c.p + c.d.length); }
  }
  return text;
}
const T = (c, o, side) => { // component c, already-concurrent with o, rewritten to apply after o
  if (c.i !== undefined) {
    if (o.i !== undefined) return [c.p < o.p || (c.p === o.p && side === 'left') ? c : { i: c.i, p: c.p + o.i.length }];
    if (c.p <= o.p) return [c];
    if (c.p >= o.p + o.d.length) return [{ i: c.i, p: c.p - o.d.length }];
    return [{ i: c.i, p: o.p }];
  }
  if (o.i !== undefined) {
    if (c.p >= o.p) return [{ d: c.d, p: c.p + o.i.length }];
    if (c.p + c.d.length > o.p) { const k = o.p - c.p; return [{ d: c.d.slice(0, k), p: c.p }, { d: c.d.slice(k), p: c.p + o.i.length }]; }
    return [c];
  }
  if (c.p >= o.p + o.d.length) return [{ d: c.d, p: c.p - o.d.length }];
  if (c.p + c.d.length <= o.p) return [c];
  let d = ''; if (c.p < o.p) d = c.d.slice(0, o.p - c.p); if (c.p + c.d.length > o.p + o.d.length) d += c.d.slice(o.p + o.d.length - c.p);
  return d ? [{ d, p: Math.min(c.p, o.p) }] : [];
};
const xList = (A, B) => {
  if (!A.length || !B.length) return [A, B];
  if (A.length > 1) { const [a0, B1] = xList([A[0]], B), [rest, B2] = xList(A.slice(1), B1); return [[...a0, ...rest], B2]; }
  if (B.length > 1) { const [A1, b0] = xList(A, [B[0]]), [A2, rest] = xList(A1, B.slice(1)); return [A2, [...b0, ...rest]]; }
  return [T(A[0], B[0], 'right'), T(B[0], A[0], 'left')];
};
const ot = { apply, transformX: xList };

const mulberry = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const offsets = text => { const o = [0]; let i = 0; for (const ch of text) { i += ch.length; o.push(i); } return o; }; // code-point boundaries: never split an emoji
const TOKEN = /⟨[^⟩]*⟩/g;
const insideToken = (text, p) => [...text.matchAll(TOKEN)].some(m => p > m.index && p < m.index + m[0].length);
const ins = (p, i) => [{ p, i }], del = (p, d) => [{ p, d }];

// ---- in-memory world: real OwnerRoom/joinRoom crypto, controllable delivery ---------------------------------------------------
const tick = () => new Promise(resolve => setImmediate(resolve));
const until = async (check, ms = 15000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw Error('Timed out waiting for convergence'); await tick(); } };

function world({ text = 'Hello', version = 0, limits = {} } = {}) {
  const links = new Map(), sent = []; let next = 1, owner;
  const deliver = (peer, dir, bytes) => {
    const link = links.get(peer); if (!link || link.cut) return;
    if ((dir === 'down' && link.holdDown) || (dir === 'up' && link.holdUp)) { return; } // deterministic loss: held frames die with the connection
    setImmediate(() => { if (link.cut) return; dir === 'down' ? link.session.receive(bytes) : room.receive(peer, bytes); });
  };
  const cut = peer => { const link = links.get(peer); if (!link || link.cut) return; link.cut = true; room.disconnected(peer); setImmediate(() => link.session.closed()); };
  const room = new OwnerRoom({ send: (peer, bytes) => deliver(peer, 'down', bytes), admit() {}, drop: cut, onMessage: (peer, message, name) => owner.handle(peer, message, name) });
  owner = new OwnerSync({ room, ot, text, version, limits });
  const realSendTo = room.sendTo.bind(room); room.sendTo = (peer, message) => { sent.push([peer, message]); return realSendTo(peer, message); };
  const connect = async (name, existing) => {
    const peer = next++, link = { cut: false, holdDown: false, holdUp: false }; links.set(peer, link);
    room.connected(peer);
    const sync = existing ?? new ParticipantSync({ ot });
    link.session = joinRoom({ roomId: room.roomId, passcode: room.passcode, username: name, send: bytes => deliver(peer, 'up', bytes),
      close: () => { if (!link.cut) { link.cut = true; room.disconnected(peer); } }, onMessage: m => sync.receive(m), onEnd: () => sync.hostLost() });
    await link.session.joined; sync.attach(message => link.session.send(message));
    return { name, peer, link, sync, session: link.session, cut: () => cut(peer) };
  };
  return { room, owner, connect, sent, cut };
}
const live = (...replicas) => until(() => replicas.every(r => r.sync.state === 'live'));
const settled = (w, ...replicas) => until(() => replicas.every(r => r.sync.state === 'live' && !r.sync.pending.length && r.sync.version === w.owner.version && r.sync.text === w.owner.text));

// ---- tests ---------------------------------------------------------------------------------------------------------------------
test('OT test double satisfies the TP1 diamond against an independent string-apply reference', () => {
  const rng = mulberry(99), tokens = ['a', 'é', '😀', 'xyz', '\n'];
  const randomOps = (text, k) => { const ops = []; for (let i = 0; i < k; i++) {
    const o = offsets(text), a = o[Math.floor(rng() * o.length)];
    if (rng() < .6 || text.length < 2) ops.push({ p: a, i: tokens[Math.floor(rng() * tokens.length)] });
    else { const b = o[Math.min(o.length - 1, o.indexOf(a) + 1 + Math.floor(rng() * 3))]; if (b === a) continue; ops.push({ p: a, d: text.slice(a, b) }); }
    text = apply(text, [ops.at(-1)]); } return ops; };
  for (let trial = 0; trial < 500; trial++) {
    const base = 'Merhaba dünya 😀 çalışıyor\nsecond ✓ line', a = randomOps(base, 1 + Math.floor(rng() * 3)), b = randomOps(base, 1 + Math.floor(rng() * 3));
    const [a2, b2] = xList(a, b);
    assert.equal(apply(apply(base, b), a2), apply(apply(base, a), b2), JSON.stringify({ a, b }));
  }
});

test('first join takes a snapshot, then concurrent edits from two participants and the owner converge', async () => {
  const w = world({ text: 'Hello' }), a = await w.connect('Ada'), b = await w.connect('Grace');
  await live(a, b); assert.equal(a.sync.text, 'Hello');
  a.sync.edit(ins(5, ' A')); b.sync.edit(ins(5, ' B')); w.owner.localEdit(ins(0, '>')); b.sync.edit(ins(0, '😀'));
  await settled(w, a, b);
  assert.equal(w.owner.version, 4); assert.equal(a.sync.text, b.sync.text);
  for (const piece of ['>', ' A', ' B', '😀', 'Hello']) assert.equal(a.sync.text.split(piece).length, 2, piece); // each insertion present exactly once
  assert.equal(w.owner.log.at(-1).len, w.owner.text.length);
});

test('rejoin after the owner applied an in-flight op whose ack was lost: no duplicate, buffered op sent once, concurrent edits merged', async () => {
  const w = world({ text: 'abc' }), a = await w.connect('Ada'), b = await w.connect('Grace'); await live(a, b);
  a.link.holdDown = true;                                   // the owner's acknowledgement and remote edits never reach Ada
  a.sync.edit(ins(3, 'X')); a.sync.edit(ins(0, 'Y'));       // first in flight, second buffered
  await until(() => w.owner.version === 1);
  b.sync.edit(ins(0, 'b1')); await until(() => w.owner.version === 2); b.sync.edit(ins(5, 'b2')); await until(() => w.owner.version === 3);
  a.cut(); assert.equal(a.sync.pending.length, 2);
  await until(() => a.sync.state === 'locked'); assert.throws(() => a.sync.edit(ins(0, 'z')), /paused \(locked\)/);
  assert.equal(a.sync.pending.length, 2); assert.equal(a.sync.text, 'YabcX');                                  // pending kept in memory, text intact
  const a2 = await w.connect('Ada', a.sync);
  await settled(w, a2, b);
  assert.equal(w.owner.text, a.sync.text); assert.equal(w.owner.version, 4);                                    // 3 earlier + Y exactly once
  assert.equal((w.owner.text.match(/X/g) ?? []).length, 1); assert.equal((w.owner.text.match(/Y/g) ?? []).length, 1);
  assert.equal(w.owner.log.filter(e => e.id.startsWith(a.sync.cid)).length, 2);
});

test('rejoin when an in-flight op never reached the owner: resent once with a fresh base', async () => {
  const w = world({ text: 'abc' }), a = await w.connect('Ada'), b = await w.connect('Grace'); await live(a, b);
  a.link.holdUp = true; a.sync.edit(ins(3, 'X'));
  b.sync.edit(ins(0, 'Y')); await until(() => w.owner.version === 1);
  a.cut(); await until(() => a.sync.state === 'locked');
  const a2 = await w.connect('Ada', a.sync); await settled(w, a2, b);
  assert.equal(w.owner.text, 'YabcX'); assert.equal(w.owner.version, 2);
});

test('refusals: log too short keeps pending edits, snapshot adoption is explicit, stale snapshots are refused', async () => {
  const w = world({ text: 'one', limits: { logEntries: 3 } }), a = await w.connect('Ada'), b = await w.connect('Grace'); await live(a, b);
  a.cut(); await until(() => a.sync.state === 'locked');
  for (let i = 0; i < 10; i++) { b.sync.edit(ins(0, `${i}`)); await settled(w, b); }
  const a2 = await w.connect('Ada', a.sync);
  await until(() => a.sync.state === 'needs_snapshot'); assert.equal(a.sync.reason, 'base_too_old');
  assert.throws(() => a.sync.edit(ins(0, 'q')), /paused \(needs_snapshot\)/);
  a.sync.requestSnapshot(); await until(() => a.sync.offered);
  assert.equal(a.sync.offered.v, w.owner.version); assert.notEqual(a.sync.text, w.owner.text);               // not adopted automatically
  const staleText = a.sync.text; assert.equal(a.sync.version, 0);
  const { discarded } = a.sync.acceptSnapshot({ discardPending: true });
  assert.deepEqual(discarded, []); assert.equal(a.sync.text, w.owner.text); assert.notEqual(staleText, w.owner.text);
  await live(a2); a.sync.edit(ins(0, '!')); await settled(w, a2, b); assert.equal(w.owner.text.startsWith('!'), true);
  // an up-to-date copy must refuse an equal/older snapshot
  a.sync.requestSnapshot(); await until(() => a.sync.offered);
  assert.throws(() => a.sync.acceptSnapshot(), /Stale snapshot/);
});

test('unsent edits are handed back, never silently dropped, when a snapshot replaces the copy', async () => {
  const w = world({ text: 'one', limits: { logEntries: 2 } }), a = await w.connect('Ada'), b = await w.connect('Grace'); await live(a, b);
  a.link.holdUp = true; const id = a.sync.edit(ins(3, 'Z')); a.cut(); await until(() => a.sync.state === 'locked');
  for (let i = 0; i < 6; i++) { b.sync.edit(ins(0, `${i}`)); await settled(w, b); }
  await w.connect('Ada', a.sync); await until(() => a.sync.state === 'needs_snapshot');
  a.sync.requestSnapshot(); await until(() => a.sync.offered);
  assert.throws(() => a.sync.acceptSnapshot(), /Unsent edits would be lost/);
  assert.equal(a.sync.pending[0].id, id);
  const { discarded } = a.sync.acceptSnapshot({ discardPending: true });
  assert.deepEqual(discarded.map(d => d.id), [id]); assert.deepEqual(discarded[0].ops, ins(3, 'Z')); assert.equal(a.sync.text, w.owner.text);
});

test('unknown base: a participant ahead of a restored owner is told to take a snapshot', async () => {
  const w1 = world({ text: 'abc' }), a = await w1.connect('Ada'); await live(a);
  for (let i = 0; i < 5; i++) { a.sync.edit(ins(0, `${i}`)); await settled(w1, a); }
  a.cut(); await until(() => a.sync.state === 'locked'); assert.equal(a.sync.version, 5);
  const before = a.sync.text, w2 = world({ text: 'abc', version: 2 }); await w2.connect('Ada', a.sync);
  await until(() => a.sync.state === 'needs_snapshot'); assert.equal(a.sync.reason, 'unknown_base'); assert.equal(a.sync.text, before); // local copy untouched
});

test('owner rejects replayed, tampered, hijacked, skipped, oversized and out-of-range ops', async () => {
  const w = world({ text: 'abc', limits: { logEntries: 2 } }), a = await w.connect('Ada'), b = await w.connect('Grace'); await live(a, b);
  const cid = a.sync.cid, msg = (n, base, ops) => ({ t: 'update', k: 'op', cid, n, base, ops });
  const first = msg(1, 0, ins(0, 'X'));
  w.owner.handle(a.peer, first, 'Ada'); assert.equal(w.owner.version, 1);
  w.owner.handle(a.peer, first, 'Ada'); assert.equal(w.owner.version, 1);                                                     // duplicate: acknowledged, not applied twice
  assert.deepEqual(w.sent.filter(([, m]) => m.t === 'ack').map(([, m]) => [m.id, m.v]), [[`${cid}.1`, 1], [`${cid}.1`, 1]]);
  assert.throws(() => w.owner.handle(a.peer, msg(1, 0, ins(0, 'EVIL')), 'Ada'), /different content/);
  assert.throws(() => w.owner.handle(b.peer, msg(2, 1, ins(0, 'H')), 'Grace'), /another participant/);                        // Grace claims Ada's client id
  assert.throws(() => w.owner.handle(a.peer, msg(5, 1, ins(0, 'S')), 'Ada'), /Replayed or skipped/);
  assert.throws(() => w.owner.handle(a.peer, msg(2, 1, [{ p: 0, i: 'x'.repeat(LIMITS.opBytes) }]), 'Ada'), /Malformed op/);
  for (const bad of [{ n: 0 }, { n: '2' }, { base: -1 }, { base: 1.5 }, { ops: 'x' }, { cid: 'nothex' }]) assert.throws(() => w.owner.handle(a.peer, { ...msg(2, 1, ins(0, 'k')), ...bad }, 'Ada'));
  w.owner.handle(a.peer, msg(2, 99, ins(0, 'F')), 'Ada'); assert.equal(w.sent.at(-1)[1].reason, 'unknown_base'); assert.equal(w.owner.version, 1);
  w.owner.handle(a.peer, msg(2, 1, [{ p: 999, i: 'F' }]), 'Ada'); assert.equal(w.sent.at(-1)[1].reason, 'invalid_op'); assert.equal(w.owner.version, 1);
  w.owner.handle(a.peer, msg(2, 1, [{ p: 0, d: 'zzz' }]), 'Ada'); assert.equal(w.sent.at(-1)[1].reason, 'invalid_op');          // delete that does not match the text
  for (let n = 2; n <= 4; n++) w.owner.handle(a.peer, msg(n, w.owner.version, ins(0, `${n}`)), 'Ada');                          // log keeps 2 entries, so id 1 is beyond retention
  assert.throws(() => w.owner.handle(a.peer, first, 'Ada'), /Replayed or skipped/);
  assert.throws(() => w.owner.handle(a.peer, { t: 'update', k: 'zap' }, 'Ada'), /Unknown update kind/);
  assert.throws(() => w.owner.handle(a.peer, { t: 'update', k: 'sync', cid, base: 'x' }, 'Ada'), /Malformed sync/);
});

test('through the real channel a tampering participant is dropped while others keep editing', async () => {
  const w = world({ text: 'abc' }), a = await w.connect('Ada'), b = await w.connect('Grace'); await live(a, b);
  await a.session.send({ t: 'update', k: 'op', cid: 'f'.repeat(32), n: 1, base: 0, ops: ins(0, 'X') }); await a.session.send({ t: 'update', k: 'op', cid: 'f'.repeat(32), n: 1, base: 0, ops: ins(0, 'Y') });
  await until(() => a.sync.state === 'locked' || w.room.participants.length === 1);
  b.sync.edit(ins(3, '!')); await until(() => w.owner.text.includes('!')); assert.equal(w.room.participants.length, 1);
});

test('host loss locks editing and keeps pending edits in memory; the module never touches browser storage', async () => {
  const src = await readFile(new URL('../runtime/chrome-extension/lan-sync.mjs', import.meta.url), 'utf8');
  assert.ok(!/indexedDB|localStorage|sessionStorage|caches\.|navigator\.storage|document\.cookie/.test(src));
  const sync = new ParticipantSync({ ot }), sent = []; sync.attach(m => { sent.push(m); return Promise.resolve(); });
  sync.receive({ t: 'snapshot', v: 0, text: 'abc' }); assert.equal(sync.state, 'live');
  sync.edit(ins(3, 'x')); sync.edit(ins(0, 'y')); await tick(); sync.hostLost();
  assert.equal(sync.state, 'locked'); assert.equal(sync.pending.length, 2); assert.equal(sync.text, 'yabcx');
  assert.throws(() => sync.edit(ins(0, 'z')), /paused/);
  sync.receive({ t: 'remote', v: 1, id: 'owner.1', by: 'Owner', ops: ins(0, 'o'), len: 4 });                                   // the next entry in order is still consumed consistently
  assert.equal(sync.version, 1); assert.equal(sync.text, 'oyabcx'); assert.equal(sync.state, 'locked'); assert.equal(sync.pending.length, 2);
});

test('pending queue is bounded by count and bytes, and an invalid local edit queues nothing', () => {
  const mk = limits => { const s = new ParticipantSync({ ot, limits }); s.attach(() => Promise.resolve()); s.receive({ t: 'snapshot', v: 0, text: 'abc' }); return s; };
  const s = mk({ pendingOps: 3 }); for (let i = 0; i < 3; i++) s.edit(ins(0, 'a')); assert.throws(() => s.edit(ins(0, 'a')), /Too many unsent/); assert.equal(s.pending.length, 3);
  const big = mk({ pendingBytes: 300 }); big.edit(ins(0, 'x'.repeat(100))); assert.throws(() => big.edit(ins(0, 'x'.repeat(250))), /Too many unsent/);
  assert.throws(() => mk({}).edit(ins(0, 'x'.repeat(LIMITS.opBytes))), /too large/);
  const bad = mk({}); assert.throws(() => bad.edit([{ p: 99, i: 'x' }]), /out of range/); assert.equal(bad.pending.length, 0); assert.equal(bad.text, 'abc');
  assert.throws(() => bad.edit('nope'));
});

test('participant invariants: wrong ack, length mismatch and version gaps are handled explicitly', async () => {
  const mk = () => { const sent = [], s = new ParticipantSync({ ot, onState: () => {} }); s.attach(m => { sent.push(m); return Promise.resolve(); }); s.receive({ t: 'snapshot', v: 0, text: 'abc' }); return { s, sent }; };
  let { s } = mk(); s.receive({ t: 'ack', id: `${s.cid}.9`, v: 1, len: 3 }); assert.equal(s.state, 'diverged');
  s = mk().s; s.receive({ t: 'remote', v: 1, id: 'owner.1', by: 'Owner', ops: ins(0, 'o'), len: 99 }); assert.equal(s.state, 'diverged');
  s = mk().s; s.receive({ t: 'remote', v: 1, id: 'owner.1', by: 'Owner', ops: [{ p: 50, i: 'o' }], len: 4 }); assert.equal(s.state, 'diverged');
  const g = mk(); g.s.receive({ t: 'remote', v: 5, id: 'owner.5', by: 'Owner', ops: ins(0, 'o'), len: 4 }); await tick();
  assert.equal(g.s.state, 'syncing'); assert.deepEqual(g.sent.at(-1), { t: 'update', k: 'sync', cid: g.s.cid, base: 0 }); assert.equal(g.s.text, 'abc');
  g.s.receive({ t: 'remote', v: 1, id: 'owner.1', by: 'Owner', ops: ins(0, 'o'), len: 4 }); assert.equal(g.s.version, 1);                  // a live frame that is next in order is still consumed
  g.s.receive({ t: 'sync', entries: [{ v: 1, id: 'owner.1', by: 'Owner', ops: ins(0, 'o'), len: 4 }], done: true }); assert.equal(g.s.text, 'oabc'); assert.equal(g.s.state, 'live'); // already-seen entries are skipped
  const dup = mk(), frame = { t: 'remote', v: 1, id: 'owner.1', by: 'Owner', ops: ins(0, 'o'), len: 4 };
  dup.s.receive(frame); dup.s.receive(frame); await tick();                                                                                 // a duplicated or old frame is ignored: no state change, no resync traffic
  assert.equal(dup.s.state, 'live'); assert.equal(dup.s.text, 'oabc'); assert.equal(dup.sent.filter(m => m.k === 'sync').length, 0);
  s = mk().s; s.receive({ t: 'refused', reason: 'invalid_op' }); assert.equal(s.state, 'diverged');
});

// ---- randomized convergence ---------------------------------------------------------------------------------------------------
async function run(seed, { mixed, logEntries = 5000, steps = 70 }) {
  const rng = mulberry(seed), BASE = 'Merhaba dünya 😀 çalışıyor\nsecond line ✓ ğüşİ\n', w = world({ text: BASE, limits: { logEntries } });
  const names = ['Ada', 'Grace', 'Linus'], reps = [], stats = { cuts: 0, rejoins: 0, snapshots: 0 };
  for (const name of names) reps.push(await w.connect(name)); await live(...reps);
  const counters = Object.fromEntries([...names, 'Owner'].map(n => [n, 0])), alive = Object.fromEntries([...names, 'Owner'].map(n => [n, []])), undone = new Set();
  const randomOp = (text, name) => {
    const o = offsets(text);
    if (alive[name].length && rng() < .15) { // undo-style: remove an own insertion (in mixed runs another author's delete may already have cut it)
      const token = alive[name].splice(Math.floor(rng() * alive[name].length), 1)[0], at = text.indexOf(token);
      if (at >= 0) { undone.add(token); return del(at, token); }
    }
    if (mixed && rng() < .3 && o.length > 3) { const i = Math.floor(rng() * (o.length - 1)), j = Math.min(o.length - 1, i + 1 + Math.floor(rng() * 3)); return del(o[i], text.slice(o[i], o[j])); }
    let p; do p = o[Math.floor(rng() * o.length)]; while (!mixed && insideToken(text, p));
    if (mixed && rng() < .4) return ins(p, ['é', '😀', 'ab', '\n'][Math.floor(rng() * 4)]);
    const token = `⟨${name[0]}${++counters[name]}⟩`; alive[name].push(token); return ins(p, token);
  };
  const reconnect = async rep => { // the participant learns of a cut one tick later; wait for that before rejoining
    await until(() => rep.sync.state !== 'live' && rep.sync.state !== 'syncing');
    assert.notEqual(rep.sync.state, 'diverged', `${seed} ${rep.name} diverged: ${rep.sync.reason}`);
    Object.assign(rep, await w.connect(rep.name, rep.sync)); stats.rejoins++;
  };
  let edits = 0;
  for (let step = 0; step < steps; step++) {
    const r = rng(), rep = reps[Math.floor(rng() * reps.length)];
    if (r < .55) { if (rep.sync.state === 'live' && rep.sync.pending.length < 40) { try { rep.sync.edit(randomOp(rep.sync.text, rep.name)); edits++; } catch (e) { assert.match(e.message, /Too many/); } } }
    else if (r < .63) { w.owner.localEdit(randomOp(w.owner.text, 'Owner')); edits++; }
    else if (r < .71) { if (!rep.link.cut) { rep.cut(); stats.cuts++; } }
    else if (r < .83) { if (rep.link.cut) await reconnect(rep); }
    else await tick();
  }
  for (const rep of reps) if (rep.link.cut) await reconnect(rep);
  if (logEntries < 100) { // small-log variant: copies that fell off the log take explicit snapshots
    const deadline = Date.now() + 15000;
    while (!reps.every(r => r.sync.state === 'live' && !r.sync.pending.length && r.sync.version === w.owner.version && r.sync.text === w.owner.text)) {
      if (Date.now() > deadline) throw Error(`seed ${seed} timed out: owner v${w.owner.version} ${JSON.stringify(reps.map(r => ({ n: r.name, s: r.sync.state, why: r.sync.reason, v: r.sync.version, p: r.sync.pending.length, cut: r.link.cut, off: r.sync.offered })))}`);
      for (const rep of reps) {
        assert.notEqual(rep.sync.state, 'diverged', `${seed} ${rep.name}: ${rep.sync.reason}`);
        if (rep.link.cut && rep.sync.state !== 'live' && rep.sync.state !== 'syncing') await reconnect(rep);
        else if (rep.sync.state === 'needs_snapshot' && !rep.sync.offered) rep.sync.requestSnapshot();
        else if (rep.sync.state === 'needs_snapshot' && rep.sync.offered) { rep.sync.acceptSnapshot({ discardPending: true }); stats.snapshots++; }
      }
      await tick();
    }
  } else await settled(w, ...reps).catch(() => { throw Error(`seed ${seed} did not converge: owner v${w.owner.version} ${JSON.stringify(w.owner.text)} ${JSON.stringify(reps.map(r => ({ n: r.name, s: r.sync.state, why: r.sync.reason, v: r.sync.version, p: r.sync.pending.length, cut: r.link.cut, t: r.sync.text })))}`); });
  const final = w.owner.text;
  for (const rep of reps) assert.equal(rep.sync.text, final, `${seed} ${rep.name}`);
  if (logEntries >= 100) assert.equal(w.owner.log.reduce((t, e) => apply(t, e.ops), BASE), final, `${seed} replay`);            // independent replay of the owner's committed log
  if (!mixed) {
    const tokens = [...final.matchAll(TOKEN)].map(m => m[0]);
    assert.equal(final.replace(TOKEN, ''), BASE, `${seed} base text intact`);
    assert.equal(new Set(tokens).size, tokens.length, `${seed} no token twice`);
    if (logEntries >= 100) for (const [name, count] of Object.entries(counters)) for (let n = 1; n <= count; n++) { const t = `⟨${name[0]}${n}⟩`; assert.equal(tokens.includes(t), !undone.has(t), `${seed} ${t} present exactly when not undone`); }
  }
  return { edits, version: w.owner.version, ...stats };
}

test('seeded randomized convergence: insert-only with undo, mixed insert/delete, and a tiny owner log', async () => {
  const totals = { runs: 0, edits: 0, ops: 0, cuts: 0, rejoins: 0, snapshots: 0 }, started = performance.now();
  const add = r => { totals.runs++; totals.edits += r.edits; totals.ops += r.version; totals.cuts += r.cuts; totals.rejoins += r.rejoins; totals.snapshots += r.snapshots; };
  for (let seed = 1; seed <= 25; seed++) add(await run(seed, { mixed: false }));
  for (let seed = 101; seed <= 115; seed++) add(await run(seed, { mixed: true }));
  for (let seed = 201; seed <= 210; seed++) add(await run(seed, { mixed: false, logEntries: 6 }));
  assert.ok(totals.rejoins >= 40 && totals.cuts >= 40, JSON.stringify(totals));
  console.log(`convergence ${JSON.stringify(totals)} in ${Math.round(performance.now() - started)} ms`);
});

test('measured: sequential edit-to-acknowledgement latency through the encrypted channel', async () => {
  const w = world({ text: '' }), a = await w.connect('Ada'); await live(a); const times = [];
  for (let i = 0; i < 200; i++) { const t = performance.now(); a.sync.edit(ins(i, 'x')); await until(() => !a.sync.pending.length); times.push(performance.now() - t); }
  times.sort((x, y) => x - y); assert.equal(w.owner.text.length, 200);
  console.log(`edit->ack median ${times[100].toFixed(2)} ms, p95 ${times[190].toFixed(2)} ms (in-memory, real AES-GCM)`);
});
