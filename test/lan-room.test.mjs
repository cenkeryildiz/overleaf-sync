// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { OwnerRoom, joinRoom, joinLink, parseJoinLink, normalizePasscode, validUsername, newRoomSecrets, MAX_MESSAGE } from '../runtime/chrome-extension/lan-room.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };

/** In-memory stand-in for the helper: records every frame so tests can replay or tamper with them. */
function harness(events = {}) {
  const links = new Map(), dropped = new Set(), admitted = new Set(), log = { joins: [], messages: [], leaves: [] };
  let next = 1;
  const room = new OwnerRoom({
    send: (peer, bytes) => { const link = links.get(peer); if (link && !dropped.has(peer)) { link.toParticipant.push(bytes); setImmediate(() => link.session.receive(bytes)); } },
    admit: peer => admitted.add(peer),
    drop: peer => { dropped.add(peer); const link = links.get(peer); if (link) setImmediate(() => link.session.closed()); },
    onJoin: (peer, name) => log.joins.push([peer, name]),
    onMessage: (peer, message, name) => log.messages.push([peer, message, name]),
    onLeave: (peer, name) => log.leaves.push([peer, name]),
    ...events,
  });
  const connect = ({ passcode = room.passcode, username = 'Ada', ...rest } = {}) => {
    const peer = next++, link = { peer, toOwner: [], toParticipant: [], ended: [], received: [], grants: [] };
    links.set(peer, link);
    room.connected(peer);
    link.session = joinRoom({
      roomId: room.roomId, passcode, username,
      send: bytes => { link.toOwner.push(bytes); if (!dropped.has(peer)) setImmediate(() => room.receive(peer, bytes)); },
      close: () => { if (!dropped.has(peer)) { dropped.add(peer); room.disconnected(peer); } },
      onMessage: message => link.received.push(message), onGrant: grant => link.grants.push(grant), onEnd: reason => link.ended.push(reason),
      ...rest,
    });
    return link;
  };
  return { room, connect, dropped, admitted, log };
}

test('participant joins with the passcode and gets the default host-online grant', async () => {
  const { room, connect, admitted, log } = harness();
  const ada = connect({ passcode: room.passcode.toLowerCase().replaceAll('-', ' ') });
  const welcome = await ada.session.joined;
  assert.equal(welcome.grant, 'online');
  assert.deepEqual(log.joins, [[ada.peer, 'Ada']]);
  assert.ok(admitted.has(ada.peer));
  assert.equal(ada.session.can('edit'), true);
  assert.equal(ada.session.can('copy'), false);
  await ada.session.send({ t: 'update', op: [{ p: 0, i: 'é😀' }] });
  await settle();
  assert.deepEqual(log.messages.map(([, message, name]) => [message.op[0].i, name]), [['é😀', 'Ada']]);
});

test('a wrong passcode is dropped before admission and never reaches the owner application', async () => {
  const { room, connect, dropped, admitted, log } = harness();
  const other = normalizePasscode(newRoomSecrets().passcode);
  const mallory = connect({ passcode: other === normalizePasscode(room.passcode) ? 'AAAA-AAAA-AAAA-AAAA' : other, username: 'Mallory' });
  await assert.rejects(mallory.session.joined, /passcode incorrect/);
  assert.ok(dropped.has(mallory.peer));
  assert.ok(!admitted.has(mallory.peer));
  assert.deepEqual(log.joins, []);
  assert.deepEqual(room.participants, []);
});

test('replayed, tampered, oversized and unknown messages end the connection', async () => {
  for (const attack of ['replay', 'tamper', 'oversize', 'unknown', 'rawHello']) {
    const { room, connect, dropped, log } = harness();
    const ada = connect();
    await ada.session.joined;
    await ada.session.send({ t: 'update', n: 1 });
    await settle();
    const last = ada.toOwner.at(-1);
    if (attack === 'replay') await room.receive(ada.peer, last);
    if (attack === 'tamper') { const forged = last.slice(); forged[forged.length - 1] ^= 1; forged[1 + 7] += 1; await room.receive(ada.peer, forged); }
    if (attack === 'oversize') await room.receive(ada.peer, new Uint8Array(MAX_MESSAGE + 1).fill(3));
    if (attack === 'unknown') {
      await assert.rejects(ada.session.send({ t: 'shell', cmd: 'ls' }), /Not connected/); // unlisted types are refused locally
      await room.receive(ada.peer, new Uint8Array([3, 0, 0, 0, 0, 0, 0, 0, 2, ...new Uint8Array(40)])); // correct counter, forged ciphertext
    }
    if (attack === 'rawHello') await room.receive(ada.peer, new Uint8Array([1, ...new Uint8Array(65)]));
    await settle();
    assert.ok(dropped.has(ada.peer), attack);
    assert.equal(log.messages.length, 1, attack);
    assert.deepEqual(log.leaves, [[ada.peer, 'Ada']], attack);
    assert.equal(room.authorize(ada.peer, 'edit'), false, attack);
  }
});

test('copy, export and download need the owner grant, and a downgrade stops new copies', async () => {
  const { room, connect, log } = harness();
  const ada = connect();
  await ada.session.joined;
  await ada.session.send({ t: 'export', ref: 1 });
  await settle();
  assert.deepEqual(ada.received, [{ t: 'denied', request: 'export', ref: 1 }]);
  assert.equal(log.messages.length, 0);

  await room.setGrant(ada.peer, 'copy');
  await settle();
  assert.deepEqual(ada.grants, ['copy']);
  assert.equal(ada.session.can('copy'), true);
  await ada.session.send({ t: 'copy', ref: 2 });
  await settle();
  assert.deepEqual(log.messages.map(([, m]) => m.ref), [2]);

  await room.setGrant(ada.peer, 'online');
  await ada.session.send({ t: 'download', ref: 3 });
  await settle();
  assert.equal(ada.session.can('copy'), false);
  assert.deepEqual(ada.received.at(-1), { t: 'denied', request: 'download', ref: 3 });
  assert.equal(log.messages.length, 1);
  await assert.rejects(room.setGrant(ada.peer, 'owner'), /permission/);
});

test('names are validated and unique; revoke and stop end access for everyone', async () => {
  const { room, connect, dropped } = harness();
  const ada = connect({ username: '  Ada  ' });
  const grace = connect({ username: 'Grace' });
  await Promise.all([ada.session.joined, grace.session.joined]);
  const twin = connect({ username: 'Ada' });
  await assert.rejects(twin.session.joined, /already in use/);
  assert.throws(() => joinRoom({ roomId: room.roomId, passcode: room.passcode, username: 'a‮b', send() {}, close() {} }), /name/);
  assert.throws(() => joinRoom({ roomId: room.roomId, passcode: room.passcode, username: 'x'.repeat(33), send() {}, close() {} }), /name/);

  await room.revoke(grace.peer);
  await settle();
  assert.ok(dropped.has(grace.peer));
  assert.match(grace.ended[0], /removed you/);
  assert.equal(grace.session.can('edit'), false);
  await assert.rejects(grace.session.send({ t: 'update' }), /Not connected/);

  await room.stop();
  await settle();
  assert.match(ada.ended[0], /stopped sharing/);
  assert.deepEqual(room.participants, []);
  const late = connect({ username: 'Late' });
  await settle();
  assert.ok(dropped.has(late.peer));
  await assert.rejects(late.session.joined);
});

test('host loss locks the participant and keeps the session in memory only', async () => {
  const { room, connect } = harness();
  const ada = connect();
  await ada.session.joined;
  room.disconnected(ada.peer);
  ada.session.closed();
  await settle();
  assert.match(ada.ended[0], /locked until you rejoin/);
  assert.equal(ada.session.state, 'ended');
  assert.equal(ada.session.can('edit'), false);
});

test('join links carry routing only, never the passcode', () => {
  const { roomId, passcode } = newRoomSecrets();
  assert.match(passcode, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  const link = joinLink('192.168.1.20', 41234, roomId);
  assert.ok(!link.includes(normalizePasscode(passcode)) && !link.includes(passcode));
  assert.deepEqual(parseJoinLink(link), { host: '192.168.1.20', port: 41234, roomId, url: `ws://192.168.1.20:41234/r/${roomId}` });
  for (const bad of ['8.8.8.8', '0.0.0.0', 'evil.example', '172.32.0.1']) assert.throws(() => joinLink(bad, 41234, roomId));
  assert.throws(() => joinLink('10.0.0.2', 80, roomId));
  assert.throws(() => parseJoinLink(link.replace('oekjj', 'aaaaa')));
  assert.throws(() => parseJoinLink(`${link}&code=${passcode}`));
  assert.equal(validUsername('  Zoë 😀 '), 'Zoë 😀');
  assert.equal(normalizePasscode('ABCD-EFGH-JKLM-NPQ0'), null);
});

test('S2-05 resume: a forged, replayed or revoked resume token is refused; a valid one replaces the stale connection', async () => {
  const { room, connect } = harness();
  const ada = connect(), { resume } = await ada.session.joined; assert.match(resume, /^[A-Za-z0-9_-]{22}$/);
  const forged = connect({ resume: 'A'.repeat(22) }); await assert.rejects(forged.session.joined, error => error.code === 'resume');
  const again = connect({ resume }), next = await again.session.joined; await settle();
  assert.notEqual(next.resume, resume); assert.deepEqual(room.participants.map(p => p.name), ['Ada']); assert.equal(ada.session.state, 'ended');
  const replayed = connect({ resume }); await assert.rejects(replayed.session.joined, error => error.code === 'resume'); // single use
  await room.revoke(again.peer); await settle();
  const revoked = connect({ resume: next.resume }); await assert.rejects(revoked.session.joined, error => error.code === 'resume');
  const wrong = connect({ resume: next.resume, passcode: 'AAAA-AAAA-AAAA-AAAA' }); await assert.rejects(wrong.session.joined, /passcode incorrect/);
});
