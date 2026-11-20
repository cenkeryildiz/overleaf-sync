// SPDX-License-Identifier: AGPL-3.0-only
// Run: node --test test/lan-grants.integration.test.mjs
// Real OwnerRoom (owner-side transport authorization) + connectStore (memory-only participant) + lan-grants, joined in memory.
// Needs lan-room.mjs, lan-session-store.mjs, lan-transfer.mjs and test/lan-transfer-harness.mjs from the LAN transport work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connectStore } from '../runtime/chrome-extension/lan-session-store.mjs';
import { handleSnapshotRequest } from '../runtime/chrome-extension/lan-transfer.mjs';
import { GrantAuthority, GrantGate, LIMITS, saveStandaloneCopy, exportCopy, copyResources } from '../runtime/chrome-extension/lan-grants.mjs';
import { harness, until, settle } from './lan-transfer-harness.mjs';

const text = value => new TextEncoder().encode(value);
const source = () => ({ main: 'main.tex', files: [{ path: 'main.tex', bytes: text('\\input{ch/one} Türkçe 😀') }, { path: 'ch/one.tex', bytes: text('one') }, { path: 'a.bin', bytes: Uint8Array.of(255, 254, 0) }] });

async function lan() {
  const seen = [], messages = []; let authority, gate, connection;
  const h = harness({
    join: args => { connection = connectStore({ ...args, onMessage: m => { messages.push(m); gate.receive(m); }, onGrant: g => gate.observeGrant(g), onEnd: () => gate.end() }); return connection.session; },
    onJoin: peer => authority.onJoin(h.room, peer),
    onMessage: (peer, m, name) => { seen.push(m.t); return authority.onMessage(h.room, peer, m, name) || handleSnapshotRequest(h.room, peer, m, () => source()); },
  });
  authority = await GrantAuthority.create(h.room.roomId); gate = new GrantGate({ roomId: h.room.roomId, name: 'Ada' });
  const link = h.connect(); const { grant } = await link.session.joined; gate.observeGrant(grant);
  const { store, requestSnapshot } = connection; await requestSnapshot(); await until(() => { try { return store.paths().length === 3; } catch { return false; } });
  await settle(); gate.installStorageGuard();
  return { ...h, link, store, gate, seen, messages, send: m => link.session.send(m) };
}
const denied = promise => assert.rejects(promise, { code: 'denied' });

test('restricted peer: no ticket, no copy, nothing persisted; the owner transport refuses raw copy/export/download requests', async () => {
  const hits = [], saved = new Map(); for (const name of ['indexedDB', 'localStorage', 'sessionStorage', 'caches']) { saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, get() { hits.push(name); throw Error(name); } }); }
  try {
    const { store, gate, send, seen, messages } = await lan();
    assert.equal(store.grant, 'online'); assert.equal(gate.locked, true);
    await denied(gate.authorize(send, 'persist')); await denied(saveStandaloneCopy({ gate, store, send, save: () => assert.fail('must not save') })); await denied(exportCopy({ gate, store, send }));
    for (const request of [{ t: 'copy', kind: 'persist', ref: 'a'.repeat(16), ts: Date.now() }, { t: 'export' }, { t: 'download' }]) await send(request);   // a hand-written client
    await until(() => messages.filter(m => m.t === 'denied').length === 3); assert.deepEqual(seen.filter(t => t !== 'snapshot'), []);   // the room denied them before any grant logic ran
    assert.throws(() => store.release('persist'), { code: 'denied' });
    assert.equal(globalThis.overleafLanGate.consume(), false);
    gate.end();
  } finally { for (const [name, d] of saved) d ? Object.defineProperty(globalThis, name, d) : delete globalThis[name]; }
  assert.deepEqual(hits, []);
});

test('permitted peer saves a standalone copy explicitly; a downgrade stops new copies without recalling the old one', async () => {
  const { room, link, store, gate, send, messages } = await lan();
  await room.setGrant(link.peer, 'copy'); await until(() => !gate.locked && store.grant === 'copy');
  const saves = [];
  const save = copy => { assert.equal(globalThis.overleafLanGate.consume(), true); saves.push(copy); return copyResources(copy); };   // stands in for overleafLocalProjects.local
  const first = await saveStandaloneCopy({ gate, store, send, save });
  assert.equal(first.main, 'main.tex'); assert.deepEqual(first.resources.map(r => r.path).sort(), ['a.bin', 'ch/one.tex', 'main.tex']);
  assert.match(first.resources.find(r => r.path === 'main.tex').content, /Türkçe 😀/); assert.equal(first.resources.find(r => r.path === 'a.bin').data, '//4A');
  const exported = await exportCopy({ gate, store, send, kind: 'download' }); assert.notEqual(exported.id, saves[0].id);
  await room.setGrant(link.peer, 'online'); await until(() => gate.locked && store.grant === 'online');
  await denied(saveStandaloneCopy({ gate, store, send, save })); await denied(exportCopy({ gate, store, send })); assert.throws(() => store.release('persist'), { code: 'denied' });
  assert.equal(saves.length, 1); assert.match(new TextDecoder().decode(saves[0].files.find(f => f.path === 'main.tex').bytes), /Türkçe/);   // the earlier copy is not recalled
  await room.setGrant(link.peer, 'copy'); await until(() => !gate.locked); assert.ok((await exportCopy({ gate, store, send })).id);
  assert.equal(messages.some(m => m.t === 'ticket'), true);
});

test('oversized, malformed and replayed requests over the wire are denied by the owner', async () => {
  const { room, link, store, gate, send, messages } = await lan();
  await room.setGrant(link.peer, 'copy'); await until(() => !gate.locked);
  const deny = async (request, reason) => { const n = messages.filter(m => m.t === 'denied').length; await send(request); await until(() => messages.filter(m => m.t === 'denied').length === n + 1); assert.equal(messages.at(-1).reason, reason); };
  const ref = 'b'.repeat(20);
  await deny({ t: 'copy', kind: 'persist', ref, ts: Date.now(), pad: 'x'.repeat(LIMITS.request) }, 'oversized');
  await deny({ t: 'copy', kind: 'rm -rf', ref, ts: Date.now() }, 'malformed');
  await deny({ t: 'copy', kind: 'persist', ref, ts: Date.now() - LIMITS.window - 5 }, 'stale');
  await send({ t: 'copy', kind: 'persist', ref, ts: Date.now() }); await until(() => messages.some(m => m.t === 'ticket' && m.ref === ref));
  await deny({ t: 'copy', kind: 'persist', ref, ts: Date.now() }, 'replayed');                                       // same request id again
  assert.equal(store.grant, 'copy');
});

test('revoke and stop end the gate and the storage guard; reload would find no project and no permit', async () => {
  for (const how of ['revoke', 'stop']) {
    const { room, link, store, gate, send } = await lan();
    await room.setGrant(link.peer, 'copy'); await until(() => !gate.locked); await gate.authorize(send, 'persist');   // a permit is pending
    if (how === 'revoke') await room.revoke(link.peer); else await room.stop();
    await until(() => store.ended); assert.equal(globalThis.overleafLanGate, undefined, how);
    await denied(gate.authorize(send, 'persist')); assert.equal(gate.locked, true); assert.throws(() => store.paths(), /ended/);
  }
});
