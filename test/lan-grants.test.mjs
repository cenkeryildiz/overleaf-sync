// SPDX-License-Identifier: AGPL-3.0-only
// Run: node --test test/lan-grants.test.mjs   (self-contained: a fake room implements the hook, no lan-room.mjs needed)
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { GrantAuthority, GrantGate, LIMITS, copyResources } from '../runtime/chrome-extension/lan-grants.mjs';

const ROOM = 'r'.repeat(22), tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Waits until the room has sent something (signing runs on the crypto thread pool, so a fixed number of ticks is a race). */
const settle = async (room, count = 1) => { for (let i = 0; i < 3000 && room.sent.length < count; i++) await sleep(1); await tick(); };
const ref = () => Buffer.from(webcrypto.getRandomValues(new Uint8Array(12))).toString('base64url');
const fakeRoom = (grant = 'copy') => { const sent = []; return { roomId: ROOM, sent, participants: [{ peer: 1, name: 'Ada', grant }], sendTo: async (peer, m) => { sent.push([peer, m]); } }; };

async function setup({ grant = 'copy', clock = { t: 1_000_000 } } = {}) {
  const now = () => clock.t, room = fakeRoom(grant), authority = await GrantAuthority.create(ROOM, now), gate = new GrantGate({ roomId: ROOM, name: 'Ada', now });
  await authority.onJoin(room, 1); gate.receive(room.sent.shift()[1]); gate.observeGrant(grant);
  /** Participant asks; the owner answers; the answer reaches the gate. Resolves with the gate's verdict. */
  const ask = async (kind = 'persist', mutate = m => m) => {
    let request; const verdict = gate.authorize(async m => { request = m; }, kind);
    verdict.catch(() => {}); await tick(); request = mutate(request);
    const handled = authority.onMessage(room, 1, request, 'Ada'); await settle(room);
    const [, reply] = room.sent.pop() ?? []; if (reply) gate.receive(reply);
    return { verdict, handled, reply, request };
  };
  return { now, clock, room, authority, gate, ask };
}
const refused = verdict => assert.rejects(verdict, { code: 'denied' });

test('a copy-granted participant gets a signed ticket, bound to room, name and kind, and the gate accepts it once', async () => {
  const { ask, gate, room } = await setup(), { verdict, reply } = await ask('persist');
  assert.deepEqual(await verdict, { kind: 'persist', epoch: 1 });
  assert.equal(reply.t, 'ticket'); assert.equal(reply.ticket.room, ROOM); assert.equal(reply.ticket.sub, 'Ada'); assert.equal(reply.ticket.kind, 'persist');
  assert.equal(room.sent.length, 0);
  gate.receive(reply);                                  // replaying the same answer (ref no longer pending) changes nothing
  const next = await ask('export'); assert.equal((await next.verdict).epoch, 2);
});

test('online-only, downgraded, removed or ended participants are denied by the owner and the gate', async () => {
  const online = await setup({ grant: 'online' }); await refused(online.gate.authorize(async () => {}, 'copy'));   // locked: nothing is even sent
  const { ask, room, gate, authority } = await setup();
  room.participants[0].grant = 'online'; const denied = await ask('copy'); await refused(denied.verdict); assert.equal(denied.reply.reason, 'not allowed');
  room.participants[0].grant = 'copy'; assert.equal((await (await ask('copy')).verdict).epoch, 1);
  room.participants.length = 0; await refused((await ask('copy')).verdict);                                          // revoke / stop: no longer a participant
  const second = await setup(); second.gate.observeGrant('online'); await refused(second.gate.authorize(async () => {}, 'persist'));
  const third = await setup(); third.gate.end(); await refused(third.gate.authorize(async () => {}, 'persist'));
  assert.equal(authority.publicKey.length, 87); void gate;
});

test('a downgrade between the request and the signature is denied, and one between verification and use cancels the permit', async () => {
  const { room, authority, gate } = await setup();
  let request; const verdict = gate.authorize(async m => { request = m; }, 'persist'); verdict.catch(() => {}); await tick();
  authority.onMessage(room, 1, request, 'Ada'); room.participants[0].grant = 'online'; await settle(room);           // owner downgrades while the ticket is being signed
  assert.equal(room.sent.at(-1)[1].t, 'denied'); gate.receive(room.sent.pop()[1]); await refused(verdict);
  const later = await setup(); const { verdict: ok } = await later.ask('persist'); await ok;
  later.gate.observeGrant('online'); later.gate.installStorageGuard(); assert.equal(globalThis.overleafLanGate.consume(), false); later.gate.end();
});

test('stale, future, replayed, oversized and malformed requests are denied and never signed', async () => {
  const s = await setup();
  const cases = { stale: m => ({ ...m, ts: m.ts - LIMITS.window - 1 }), future: m => ({ ...m, ts: m.ts + LIMITS.window + 1 }), oversized: m => ({ ...m, pad: 'x'.repeat(LIMITS.request) }),
    'bad kind': m => ({ ...m, kind: 'upload' }), 'bad ref': m => ({ ...m, ref: 'short' }), 'no ts': m => ({ ...m, ts: undefined }), 'text ts': m => ({ ...m, ts: '5' }) };
  for (const [name, mutate] of Object.entries(cases)) {
    const { reply } = await s.ask('persist', mutate); assert.equal(reply.t, 'denied', name); assert.match(reply.reason, /stale|oversized|malformed/, name);
  }
  const first = await s.ask('persist'); await first.verdict;                                                           // exact replay of an accepted request
  s.authority.onMessage(s.room, 1, first.request, 'Ada'); await settle(s.room); assert.equal(s.room.sent.pop()[1].reason, 'replayed');
  assert.equal(s.authority.onMessage(s.room, 1, { t: 'update' }, 'Ada'), false); assert.equal(s.authority.onMessage(s.room, 1, null, 'Ada'), false);
  s.authority.onMessage(s.room, 1, { t: 'copy', kind: 'persist', ref: ref(), ts: s.now(), x: 1 }, 'Eve'); await settle(s.room);   // right peer, wrong name
  assert.equal(s.room.sent.pop()[1].reason, 'not allowed');
  for (let i = 0; i < LIMITS.seen; i++) s.authority.onMessage(s.room, 1, { t: 'copy', kind: 'persist', ref: ref(), ts: s.now() }, 'Ada');
  await settle(s.room, LIMITS.seen); s.room.sent.length = 0;
  s.authority.onMessage(s.room, 1, { t: 'copy', kind: 'persist', ref: ref(), ts: s.now() }, 'Ada'); await settle(s.room);
  assert.equal(s.room.sent.pop()[1].reason, 'busy'); s.clock.t += LIMITS.window + 1;                                  // expired entries are forgotten
  s.authority.onMessage(s.room, 1, { t: 'copy', kind: 'persist', ref: ref(), ts: s.now() }, 'Ada'); await settle(s.room); assert.equal(s.room.sent.pop()[1].t, 'ticket');
});

test('forged, foreign-room, wrong-peer, wrong-kind, tampered, expired, reused and older tickets never pass the gate', async () => {
  const s = await setup(), used = (await s.ask('persist')).reply.ticket;                                              // epoch 1, already consumed
  const other = await GrantAuthority.create(ROOM, s.now), otherRoom = fakeRoom();                                    // same room id, different signing key
  await other.onMessage(otherRoom, 1, { t: 'copy', kind: 'persist', ref: ref(), ts: s.now() }, 'Ada'); await settle(otherRoom);
  const forged = otherRoom.sent.pop()[1].ticket; assert.equal(forged.sub, 'Ada');
  const direct = ref(); s.authority.onMessage(s.room, 1, { t: 'copy', kind: 'copy', ref: direct, ts: s.now() }, 'Ada'); await settle(s.room);
  const latest = s.room.sent.pop()[1].ticket;                                                                        // issued but never shown to the gate: epoch 2
  const attempt = async (name, ticket, kind = 'persist') => {
    let request; const verdict = s.gate.authorize(async m => { request = m; }, kind); verdict.catch(() => {}); await tick();
    s.gate.receive({ t: 'ticket', ref: request.ref, ticket }); await assert.rejects(verdict, { code: 'denied' }, name);
  };
  await attempt('signed by another key', { ...forged, kind: 'persist', epoch: 99 });
  await attempt('forged for the right fields', forged);
  await attempt('reused ticket', used);
  await attempt('older epoch', { ...latest, epoch: 1 });
  await attempt('tampered epoch', { ...latest, epoch: 7 });
  await attempt('other participant', { ...latest, sub: 'Eve' }, 'copy');
  await attempt('other room', { ...latest, room: 'q'.repeat(22) }, 'copy');
  await attempt('other kind', latest, 'persist');
  await attempt('missing signature', { ...latest, sig: undefined }, 'copy');
  await attempt('garbage signature', { ...latest, sig: 'AAAA' }, 'copy');
  await attempt('not an object', 'ticket', 'copy');
  await attempt('expired', { ...latest, iat: s.now() - 2 * LIMITS.ttl, exp: s.now() - LIMITS.ttl - 2 * LIMITS.skew }, 'copy');
  await attempt('issued in the future', { ...latest, iat: s.now() + 2 * LIMITS.skew, exp: s.now() + 2 * LIMITS.skew + 10 }, 'copy');
  await attempt('lifetime beyond the limit', { ...latest, exp: latest.iat + 5 * LIMITS.ttl }, 'copy');
  for (const [label, name, room] of [['a ticket issued to another participant', 'Eve', ROOM], ['a ticket from another room (same key)', 'Ada', 'q'.repeat(22)]]) {   // valid signature, wrong binding
    const gate = new GrantGate({ roomId: room, name, now: s.now }); gate.observeGrant('copy'); gate.receive({ t: 'grantkey', room, key: s.authority.publicKey });
    let request; const verdict = gate.authorize(async m => { request = m; }, 'copy'); verdict.catch(() => {}); await tick();
    gate.receive({ t: 'ticket', ref: request.ref, ticket: latest }); await assert.rejects(verdict, { code: 'denied' }, label);
  }
  let request; const last = s.gate.authorize(async m => { request = m; }, 'copy'); await tick();                      // the genuine ticket still works afterwards
  s.gate.receive({ t: 'ticket', ref: request.ref, ticket: latest }); assert.equal((await last).epoch, 2);
});

test('a key from a stranger or for another room is not pinned; the first valid key stays; with no key nothing verifies', async () => {
  const s = await setup(), strange = await GrantAuthority.create(ROOM, s.now), gate = new GrantGate({ roomId: ROOM, name: 'Ada', now: s.now });
  gate.observeGrant('copy');
  const ticketFrom = async authority => {
    let request; const verdict = gate.authorize(async m => { request = m; }, 'persist'); verdict.catch(() => {}); await tick();
    authority.onMessage(s.room, 1, request, 'Ada'); await settle(s.room); gate.receive(s.room.sent.pop()[1]); return verdict;
  };
  gate.receive({ t: 'grantkey', room: 'q'.repeat(22), key: s.authority.publicKey }); gate.receive({ t: 'grantkey', room: ROOM, key: 'AAAA' });
  await refused(ticketFrom(s.authority));                                                                            // nothing pinned yet
  gate.receive({ t: 'grantkey', room: ROOM, key: s.authority.publicKey }); gate.receive({ t: 'grantkey', room: ROOM, key: strange.publicKey });
  await refused(ticketFrom(strange)); assert.equal((await ticketFrom(s.authority)).kind, 'persist');
});

test('the storage guard lets exactly one verified persist permit through and nothing else', async () => {
  let opens = 0; const s = await setup();
  const context = vm.createContext({ TextEncoder, Blob, crypto: webcrypto, atob, indexedDB: { open() { opens++; throw Error('storage reached'); } } });
  Object.defineProperty(context, 'overleafLanGate', { get: () => globalThis.overleafLanGate });
  vm.runInContext(readFileSync(new URL('../runtime/browser-recovery/project-store.js', import.meta.url), 'utf8'), context);
  const id = 'a'.repeat(24), payload = { user: id, project: id, source: { main: 'main.tex', compiler: 'pdflatex', resources: [{ path: 'main.tex', content: 'x' }] }, documents: [{ path: 'main.tex', id, version: 0 }] };
  const create = () => context.overleafLocalProjects.create(payload, id, id);
  await assert.rejects(create(), /storage reached|integrity/); opens = 0;                                              // no guard installed: unchanged behaviour
  s.gate.installStorageGuard();
  await assert.rejects(create(), /not allowed saving a copy/); assert.equal(opens, 0);                                // restricted: refused before storage
  await (await s.ask('export')).verdict; await assert.rejects(create(), /not allowed saving/); assert.equal(opens, 0);   // an export permit is not a persist permit
  await (await s.ask('persist')).verdict;
  await assert.rejects(create(), /integrity|storage reached/); await assert.rejects(create(), /not allowed saving a copy/);   // permit is one-shot
  await (await s.ask('persist')).verdict; s.gate.observeGrant('online'); await assert.rejects(create(), /not allowed saving/);    // downgrade clears it
  s.gate.end(); assert.equal(globalThis.overleafLanGate, undefined);
});

test('copyResources keeps text as UTF-8 and other files as base64', () => {
  const copy = { main: 'main.tex', files: [{ path: 'main.tex', bytes: new TextEncoder().encode('Türkçe 😀') }, { path: 'a.bin', bytes: Uint8Array.of(0xff, 0xfe, 0) }] };
  assert.deepEqual(copyResources(copy), { main: 'main.tex', resources: [{ path: 'main.tex', content: 'Türkçe 😀' }, { path: 'a.bin', data: '//4A' }] });
});

test('the module uses no storage, cache, network or logging API', () => {
  const code = readFileSync(new URL('../runtime/chrome-extension/lan-grants.mjs', import.meta.url), 'utf8').split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /\b(indexedDB|localStorage|sessionStorage|caches|cookieStore|console|fetch|XMLHttpRequest|WebSocket|BroadcastChannel|postMessage|eval)\b|new Function/);
});
