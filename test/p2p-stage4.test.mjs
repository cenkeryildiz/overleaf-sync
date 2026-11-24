// SPDX-License-Identifier: AGPL-3.0-only
// Stage 4 P2P-OWNER-01 / P2P-HANDOVER-01 in memory: signed member list rules, explicit merge plans, and whole rooms
// (p2p-room.mjs) over fake WebRTC and the in-process room finder: join, coordinator crash and takeover without lost or repeated
// edits, removal with passcode rotation, and reopening from a saved copy with nobody online. Loopback only; no network.
// Run: node --test test/p2p-stage4.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Membership } from '../runtime/chrome-extension/p2p-membership.mjs';
import { newIdentity, identityStore } from '../runtime/chrome-extension/p2p-identity.mjs';
import { planMerge, keepName } from '../runtime/chrome-extension/p2p-reconcile.mjs';
import { createInternetRoom, joinInternetRoom, reopenInternetRoom, STEP } from '../runtime/chrome-extension/p2p-room.mjs';
import { memorySignaling } from '../runtime/chrome-extension/p2p-signal.mjs';
import { apply, transformX } from '../runtime/chrome-extension/lan-ot.mjs';
import { RTC } from './p2p-fake-rtc.mjs';

const ROOM = 'R'.repeat(22), enc = s => new TextEncoder().encode(s);
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const until = async (check, what = 'condition', ms = 20000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) throw Error('Timed out: ' + what); await tick(); } };

test('member list: owner changes verify everywhere; forged, superseded, replayed and competing documents are refused or freeze', async () => {
  const [{ identity: owner }, { identity: bo }, { identity: cy }] = await Promise.all([newIdentity(), newIdentity(), newIdentity()]);
  const m = await Membership.create(ROOM, owner, 'Ada');
  const peer = await Membership.load(ROOM, m.chain());
  const step = async doc => { assert.equal(await m.accept(doc), 'applied'); assert.equal(await peer.accept(doc), 'applied'); return doc; };
  await step(await m.setMember(owner, bo.key, 'Bo', 'online'));
  await step(await m.setMember(owner, cy.key, 'Cy', 'online'));
  await assert.rejects(m.setMember(owner, owner.key, 'Ada', 'online'), /owner keeps/);
  await assert.rejects(m.setMember(bo, bo.key, 'Bo', 'copy'), /Only the owner/);           // a coordinator cannot promote itself
  // A document signed by a member instead of the owner is forged, even with a correct chain position.
  const forged = await m.setMember(owner, bo.key, 'Bo', 'copy'); forged.s = await bo.sign(enc('x'));
  await assert.rejects(peer.accept(forged), /Forged/);
  const promoted = await step(await m.setMember(owner, bo.key, 'Bo', 'copy'));
  assert.equal(await peer.accept(promoted), 'known');                                         // replay of a held document
  await step(await m.setBackup(owner, bo.key));
  // Transfer needs the recipient's acceptance; the offer alone is not valid.
  const offer = await m.offerTransfer(owner, cy.key);
  await assert.rejects(peer.accept(offer), /Forged/);
  await step(await m.acceptTransfer(cy, offer));
  assert.equal(m.owner, cy.key); assert.equal(m.member(cy.key).role, 'copy');
  await assert.rejects(m.setMember(owner, bo.key, 'Bo', 'online'), /Only the owner/);         // the superseded owner
  // Backup claim (bo is still backup): only the backup may claim.
  await assert.rejects(m.claim(owner), /Only the backup/);
  const claim = await m.claim(bo);
  // Competing: the current owner (cy) signs a different document for the same number; whichever arrives second freezes.
  const rival = await m.setMember(cy, owner.key, 'Ada', 'online');
  await step(claim);
  assert.equal(m.owner, bo.key);
  assert.equal(await peer.accept(rival), 'conflict'); assert.equal(peer.frozen, true);
  await assert.rejects(peer.setMember(bo, cy.key, 'Cy', 'online'), /frozen/);
  // Removal: the removed member is no longer listed on any verifier.
  const fresh = await Membership.load(ROOM, m.chain()); await fresh.accept(await m.remove(bo, cy.key).then(async d => { await m.accept(d); return d; }));
  assert.equal(fresh.member(cy.key), null);
  await assert.rejects(Membership.load('S'.repeat(22), m.chain()), /another room/);
});

test('merge plan keeps both versions when both sides changed, takes one-sided changes and never drops a changed file', async () => {
  const hash = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
  const base = { 'main.tex': await hash('m0'), 'a.tex': await hash('a0'), 'b.tex': await hash('b0'), 'c.tex': await hash('c0'), 'gone.tex': await hash('g0') };
  const mine = new Map([['main.tex', enc('m-mine')], ['a.tex', enc('a0')], ['b.tex', enc('b-mine')], ['new.tex', enc('n')], ['gone.tex', enc('g-mine')]]);
  const theirs = new Map([['main.tex', enc('m-room')], ['a.tex', enc('a-room')], ['b.tex', enc('b0')], ['c.tex', enc('c0')]]);
  const plan = await planMerge(base, mine, theirs);
  assert.deepEqual(plan.conflicts.map(c => [c.path, c.kind]), [['gone.tex', 'changed-deleted'], ['main.tex', 'both-changed']]);
  assert.equal(plan.conflicts[1].mine, 'main (my version).tex');
  assert.deepEqual(plan.take, [{ path: 'a.tex', from: 'theirs' }, { path: 'b.tex', from: 'mine' }, { path: 'new.tex', from: 'mine' }]);
  assert.deepEqual(plan.remove, ['c.tex']); // deleted here, unchanged in the room
  assert.deepEqual(plan.ops.map(o => [o.kind, o.path ?? o.from]), [['remove', 'b.tex'], ['put', 'b.tex'], ['remove', 'c.tex'], ['put', 'gone.tex'], ['put', 'main (my version).tex'], ['put', 'new.tex']]);
  assert.equal(keepName('fig/plot', new Set(['fig/plot (my version)'])), 'fig/plot (my version 2)');
});

// ---- whole rooms ------------------------------------------------------------------------------------------------------------
/** The native editor's client: one op in flight, local ops transform against remote ones (as test/lan-native.test.mjs). */
class Editor {
  constructor(room, path, state) { Object.assign(this, { room, path, text: state.text, version: state.v, inflight: null, pending: [] }); }
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
    this.room.edit(this.path, { op: this.inflight, v: this.version }).then(applied => { assert.equal(applied, this.version); this.version++; this.inflight = null; this.#pump(); }, error => { this.error = error; });
  }
  get idle() { return !this.inflight && !this.pending.length; }
}
/** One computer: its own RTC connections and room-finder endpoints, so a crash can cut exactly this computer. */
function computer(hub) {
  const pcs = new Set(), endpoints = new Set();
  const Rtc = class extends RTC { constructor(c) { super(c); pcs.add(this); } };
  const signaling = { async open(o) { const e = await hub.open(o); endpoints.add(e); return e; } };
  return { RTC: Rtc, signaling, identities: identityStore({ memory: true }), crash() { for (const e of endpoints) e.close(); for (const p of pcs) p.close(); } };
}
function project(text) {
  const files = new Map([['main.tex', enc(text)], ['fig.bin', Uint8Array.of(0, 255, 7)]]);
  return { tree: () => ({ main: 'main.tex', docs: ['main.tex'], folders: [], files: [...files].map(([path, bytes]) => ({ path, bytes })) }), text: path => path === 'main.tex' ? { text, version: 0 } : null, persist: () => {}, apply: () => {} };
}
async function member(link, passcode, name, pc, events = {}) {
  const editors = {}, room = await joinInternetRoom({ link, passcode, username: name, ...pc, events: { onRemote: (path, e) => editors[path]?.remote(e.op, e.v), ...events } });
  room.open = async path => (editors[path] = new Editor(room, path, await room.join(path)));
  room.editors = editors; return room;
}

test('coordinator crash: the next member takes over and every acknowledged and pending edit lands exactly once', async () => {
  const hub = memorySignaling(), A = computer(hub), B = computer(hub), C = computer(hub);
  const ownerEditors = {};
  const owner = await createInternetRoom({ source: project('start\n'), username: 'Ada', ...A, events: { onRemote: (path, e) => ownerEditors[path]?.remote(e.op, e.v) } });
  ownerEditors['main.tex'] = new Editor(owner, 'main.tex', await owner.join('main.tex'));
  const bo = await member(owner.link, owner.passcode, 'Bo', B), cy = await member(owner.link, owner.passcode, 'Cy', C);
  await until(() => owner.members.length === 3, 'members added');
  await owner.setRole(owner.members.find(m => m.name === 'Bo').key, 'copy'); // Bo ranks first in the succession list
  const [eb, ec, ea] = [await bo.open('main.tex'), await cy.open('main.tex'), ownerEditors['main.tex']];
  eb.submit([{ p: 0, i: 'B1 ' }]); ec.submit([{ p: 0, i: 'C1 ' }]); ea.submit([{ p: 0, i: 'A1 ' }]);
  await until(() => eb.idle && ec.idle && ea.idle && eb.text === ec.text && ec.text === ea.text, 'first round converges');
  await until(() => bo.role === 'participant' && cy.role === 'participant');
  // Crash the coordinator; Cy keeps typing while nobody coordinates (held, then resent under its original id).
  A.crash();
  ec.submit([{ p: 0, i: 'C2 ' }]);
  await until(() => bo.role === 'coordinator', 'Bo takes over', STEP * 4 + 15000);
  await until(() => ec.idle && cy.session?.state === 'live', 'Cy resumes on Bo', 40000);
  eb.submit([{ p: eb.text.length, i: ' B2' }]);
  await until(() => eb.idle && ec.idle && eb.text === ec.text && eb.text.includes('B2'), 'second round converges');
  for (const piece of ['A1 ', 'B1 ', 'C1 ', 'C2 ', ' B2']) assert.equal(eb.text.split(piece).length - 1, 1, `${piece} exactly once`);
  assert.ok(bo.epoch > 1 && cy.epoch === bo.epoch);
  await cy.leave(); await bo.leave();
});

test('removing a member rotates the passcode; the removed identity cannot rejoin even with the new passcode', async () => {
  const hub = memorySignaling(), A = computer(hub), B = computer(hub);
  const ended = [], owner = await createInternetRoom({ source: project('x'), username: 'Ada', ...A });
  const first = owner.passcode, bo = await member(owner.link, first, 'Bo', B, { onEnd: reason => ended.push(reason) });
  await until(() => owner.members.length === 2);
  await owner.remove(owner.members.find(m => m.name === 'Bo').key);
  await until(() => ended.length === 1, 'removed member is disconnected');
  assert.notEqual(owner.passcode, first);
  await assert.rejects(member(owner.link, owner.passcode, 'Bo', B), /removed you/);
  await assert.rejects(member(owner.link, first, 'Bo2', computer(hub)), /passcode|refused|answer/i); // the old passcode no longer admits anyone new
  assert.equal(owner.members.length, 1);
  void bo; await owner.leave();
});

test('nobody online: a copy member reopens the room from a saved copy; offline edits are not replayed onto the room history', async () => {
  const hub = memorySignaling(), A = computer(hub), B = computer(hub);
  const owner = await createInternetRoom({ source: project('shared\n'), username: 'Ada', ...A });
  const bo = await member(owner.link, owner.passcode, 'Bo', B);
  await until(() => owner.members.length === 2);
  await owner.setRole(owner.members.find(m => m.name === 'Bo').key, 'copy');
  await until(() => bo.members.find(m => m.name === 'Bo')?.role === 'copy');
  const saved = await owner.saveForReopen(async (project, room) => ({ project, room }));
  await bo.leave(); await owner.leave();
  await assert.rejects(joinInternetRoom({ link: owner.link, passcode: owner.passcode, username: 'Bo', ...B }), e => e.code === 'nobody');
  const reopened = await reopenInternetRoom({ saved, passcode: owner.passcode, username: 'Ada', ...A });
  assert.equal(reopened.role, 'coordinator'); assert.equal(reopened.epoch, saved.room.epoch + 1);
  assert.deepEqual(await reopened.join('main.tex'), { text: 'shared\n', v: saved.room.heads['main.tex'].v, at: saved.room.heads['main.tex'].at });
  // An offline edit since the save: the room starts a new version, so members holding the old history reconcile explicitly.
  await reopened.leave();
  const edited = { ...saved, project: { ...saved.project, files: saved.project.files.map(f => f.path === 'main.tex' ? { ...f, bytes: enc('shared + offline\n') } : f) } };
  const again = await reopenInternetRoom({ saved: edited, passcode: owner.passcode, username: 'Ada', ...A });
  assert.equal((await again.join('main.tex')).v, saved.room.heads['main.tex'].v + 1);
  await again.leave();
  await assert.rejects(reopenInternetRoom({ saved, passcode: owner.passcode, username: 'Bo', ...computer(hub) }), /copy permission/);
});
