// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end check of the LAN relay helper on loopback only. Build it first, then run:
//   cargo build --offline --release --manifest-path runtime/chrome-extension/lan/Cargo.toml
//   LATEX_LAN_HELPER=runtime/chrome-extension/lan/target/release/latex-local-lan node --test test/lan-helper.integration.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { OwnerRoom, joinRoom } from '../runtime/chrome-extension/lan-room.mjs';

const HELPER = process.env.LATEX_LAN_HELPER;
if (!HELPER) throw Error('Set LATEX_LAN_HELPER to the built latex-local-lan binary');
const ORIGIN = 'chrome-extension://oekjjadnainlmdbgbdjokegaikafafke';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, ms = 3000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw Error('Timed out'); await wait(10); } };

function startHelper() {
  const child = spawn(HELPER, [`${ORIGIN}/`], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buffer = Buffer.alloc(0), next = 1;
  const pending = new Map(), events = [], listeners = new Set();
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const message = JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE(0)));
      buffer = buffer.subarray(4 + buffer.readUInt32LE(0));
      if (message.id) { const { resolve, reject } = pending.get(message.id); pending.delete(message.id); message.error ? reject(Error(message.error)) : resolve(message.result); }
      else { events.push(message); for (const listener of listeners) listener(message); }
    }
  });
  const write = value => { const body = Buffer.from(JSON.stringify(value)), head = Buffer.alloc(4); head.writeUInt32LE(body.length); child.stdin.write(Buffer.concat([head, body])); };
  const call = (op, args = {}) => new Promise((resolve, reject) => { const id = next++; pending.set(id, { resolve, reject }); write({ id, op, ...args }); });
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  return { child, call, write, events, listeners, exited };
}
/** Wires an OwnerRoom to the helper exactly as the extension page will. */
async function shareOnLoopback(helper, hooks = {}) {
  const room = new OwnerRoom({
    send: (peer, bytes) => helper.write({ op: 'send', peer, data: Buffer.from(bytes).toString('base64') }),
    admit: peer => helper.call('admit', { peer }).catch(() => {}),
    drop: peer => helper.call('drop', { peer }).catch(() => {}),
    ...hooks,
  });
  helper.listeners.add(event => {
    if (event.ev === 'peer') room.connected(event.peer);
    if (event.ev === 'data') room.receive(event.peer, new Uint8Array(Buffer.from(event.data, 'base64')));
    if (event.ev === 'gone') room.disconnected(event.peer);
  });
  const { port } = await helper.call('open', { bind: '127.0.0.1', port: 0, room: room.roomId });
  return { room, port, url: `ws://127.0.0.1:${port}/r/${room.roomId}` };
}
function participant(url, roomId, passcode, username, headers = { Origin: ORIGIN }) {
  const socket = new WebSocket(url, { headers }); socket.binaryType = 'arraybuffer';
  const link = { socket, received: [], ended: [] };
  link.opened = new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(Error('Connection refused')); });
  link.opened.then(() => {
    link.session = joinRoom({ roomId, passcode, username, send: bytes => socket.send(bytes), close: () => socket.close(),
      onMessage: m => link.received.push(m), onEnd: reason => link.ended.push(reason) });
    socket.onmessage = event => link.session.receive(new Uint8Array(event.data));
    socket.onclose = () => link.session.closed();
  }, () => {});
  return link;
}
/** Raw TCP WebSocket client for frames a browser would never send. */
function rawSocket(port, path, origin = ORIGIN) {
  const socket = net.connect(port, '127.0.0.1');
  const state = { socket, data: Buffer.alloc(0), closed: false };
  socket.on('data', chunk => { state.data = Buffer.concat([state.data, chunk]); });
  socket.on('close', () => { state.closed = true; }); socket.on('error', () => {});
  socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`);
  return state;
}

test('helper refuses public and wildcard binds and only one room at a time', async () => {
  const helper = startHelper();
  for (const bind of ['0.0.0.0', '8.8.8.8', '::']) await assert.rejects(helper.call('open', { bind, port: 0, room: 'A'.repeat(22) }), /private local network/);
  await assert.rejects(helper.call('open', { bind: '127.0.0.1', port: 80, room: 'A'.repeat(22) }), /Invalid port/);
  await assert.rejects(helper.call('open', { bind: '127.0.0.1', port: 0, room: 'short' }), /Invalid room/);
  const { addresses } = await helper.call('addresses');
  assert.equal(addresses[0], '127.0.0.1');
  for (const address of addresses) assert.match(address, /^(127|10|192\.168|172\.(1[6-9]|2\d|3[01])|169\.254)\./);
  await helper.call('open', { bind: '127.0.0.1', port: 0, room: 'A'.repeat(22) });
  await assert.rejects(helper.call('open', { bind: '127.0.0.1', port: 0, room: 'B'.repeat(22) }), /already on/);
  helper.child.stdin.end();
  assert.equal(await helper.exited, 0);
});

test('real helper: join, Unicode edit, large frames, grant enforcement, wrong origin/room/passcode and stop', async () => {
  const helper = startHelper(), messages = [];
  const { room, port, url } = await shareOnLoopback(helper, { onMessage: (peer, message) => messages.push(message) });

  const wrongOrigin = participant(url, room.roomId, room.passcode, 'Eve', { Origin: 'http://192.168.1.9' });
  await assert.rejects(wrongOrigin.opened, /refused/);
  const wrongRoom = participant(`ws://127.0.0.1:${port}/r/${'Z'.repeat(22)}`, room.roomId, room.passcode, 'Eve');
  await assert.rejects(wrongRoom.opened, /refused/);
  const wrongCode = participant(url, room.roomId, 'AAAA-AAAA-AAAA-AAAA', 'Eve');
  await wrongCode.opened; await assert.rejects(wrongCode.session.joined, /passcode incorrect/);

  const ada = participant(url, room.roomId, room.passcode, 'Ada');
  await ada.opened;
  assert.equal((await ada.session.joined).grant, 'online');
  const text = 'Türkçe ğüşiöç — 数学 — 😀'.repeat(9000); // ≈ 300 KB sealed: exercises 64-bit frame lengths
  await ada.session.send({ t: 'update', text });
  await until(() => messages.length === 1);
  assert.equal(messages[0].text, text);
  await room.sendTo(room.participants[0].peer, { t: 'file', bytes: Buffer.from(randomBytes(200_000)).toString('base64') });
  await until(() => ada.received.length === 1);
  assert.equal(ada.received[0].bytes.length, 266_668);

  await ada.session.send({ t: 'export', ref: 7 });
  await until(() => ada.received.length === 2);
  assert.deepEqual(ada.received[1], { t: 'denied', request: 'export', ref: 7 });
  assert.equal(messages.length, 1);

  await room.stop();
  await until(() => ada.ended.length === 1);
  assert.match(ada.ended[0], /stopped sharing/);
  await helper.call('close');
  await assert.rejects(participant(url, room.roomId, room.passcode, 'Late').opened, /refused/);
  helper.child.stdin.end();
  assert.equal(await helper.exited, 0);
});

test('helper closes unmasked frames at once and silent unauthenticated connections after the admission window', async () => {
  const helper = startHelper();
  const { port, room } = await shareOnLoopback(helper);
  const unmasked = rawSocket(port, `/r/${room.roomId}`);
  await until(() => unmasked.data.includes('101 Switching'));
  unmasked.socket.write(Buffer.from([0x82, 0x01, 0x41])); // binary frame without client mask
  await until(() => unmasked.closed);

  const silent = rawSocket(port, `/r/${room.roomId}`);
  await until(() => silent.data.includes('101 Switching'));
  await wait(8000);
  assert.equal(silent.closed, false);
  await until(() => silent.closed, 4000);
  await until(() => helper.events.filter(e => e.ev === 'gone').length === 2);
  helper.child.stdin.end(); // closing the extension page stops sharing
  assert.equal(await helper.exited, 0);
  const refused = rawSocket(port, `/r/${room.roomId}`);
  await until(() => refused.closed);
  assert.equal(refused.data.length, 0);
});
