// SPDX-License-Identifier: AGPL-3.0-only
// Stage 4 room finder ("signaling"): it only introduces two browsers so they can open a direct WebRTC data channel. It carries
// WebRTC session descriptions and ICE candidates, nothing else: never the passcode, room keys, names, grants or project source
// (the room protocol in lan-room.mjs runs inside the data channel, end to end). Everything a signaling service sends is untrusted.
//
// Adapter contract (one object per service):
//   open({ roomId, role: 'owner' | 'peer', passcodes, onSignal(from, message), onState(up) }) -> Promise<{ send(to, message), close() }>
//   passcodes (current first) key the finder's encryption; the in-process test hub ignores them.
//   A peer addresses the owner as 'owner'; the owner answers the `from` it received. `from` is chosen by the service: untrusted.
//   open rejects when the service is unreachable, when nobody is sharing that room (role 'peer'), or when the room is taken (role 'owner').
//   onState(false) reports an outage after open; connections already made do not depend on the service.
// Message shapes (checkSignal is the only gate, in both directions):
//   {t:'offer'|'answer', sdp}  {t:'ice', c:{candidate, sdpMid, sdpMLineIndex}}  {t:'bye'}
export const MAX_SDP = 16 * 1024, MAX_CANDIDATE = 1024;

export function checkSignal(m) {
  if ((m?.t === 'offer' || m?.t === 'answer') && typeof m.sdp === 'string' && m.sdp.length <= MAX_SDP) return { t: m.t, sdp: m.sdp };
  if (m?.t === 'bye') return { t: 'bye' };
  const c = m?.t === 'ice' ? m.c : null;
  if (c && typeof c.candidate === 'string' && c.candidate.length <= MAX_CANDIDATE && (c.sdpMid == null || (typeof c.sdpMid === 'string' && c.sdpMid.length <= 32)) &&
    (c.sdpMLineIndex == null || (Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex < 16)))
    return { t: 'ice', c: { candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null } };
  throw Error('Malformed signaling message');
}

/**
 * In-process signaling for tests: one hub, any number of rooms. `tap(roomId, from, to, message)` sees every payload (the checks
 * assert no secret or source in them); `outage(true)` makes the service unreachable and tells every open endpoint.
 * The browser check runs this hub in Node and reaches it from each profile through bridgeSignaling below.
 */
export function memorySignaling({ tap = () => {} } = {}) {
  const rooms = new Map(), endpoints = new Set(); let next = 1, down = false;
  const deliver = (target, from, message) => { if (target && !target.closed) setTimeout(() => { if (!target.closed && !down) target.onSignal(from, message); }, 0); };
  return {
    async open({ roomId, role, onSignal, onState = () => {} }) {
      if (down) throw Error('The room finder is unreachable');
      if (typeof roomId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(roomId)) throw Error('Invalid room');
      const room = rooms.get(roomId) ?? { owner: null, peers: new Map() };
      if (role === 'owner' && room.owner) throw Error('This room is already open');
      if (role === 'peer' && !room.owner) throw Error('Nobody is sharing this room right now');
      const id = role === 'owner' ? 'owner' : `p${next++}`, self = { id, onSignal, onState, closed: false };
      if (role === 'owner') room.owner = self; else room.peers.set(id, self);
      rooms.set(roomId, room); endpoints.add(self);
      return {
        send(to, message) {
          if (self.closed) return; if (down) throw Error('The room finder is unreachable');
          const clean = checkSignal(message); tap(roomId, id, to, clean);
          deliver(to === 'owner' ? room.owner : id === 'owner' ? room.peers.get(to) : null, id, clean);
        },
        close() {
          if (self.closed) return; self.closed = true; endpoints.delete(self);
          if (room.owner === self) { room.owner = null; rooms.delete(roomId); } else room.peers.delete(id);
        },
      };
    },
    outage(on) { down = !!on; for (const e of endpoints) e.onState(!down); },
  };
}

/** Test bridge: the page reaches a hub through a binding the browser harness installs (globalThis.__p2pSignal / __p2pDeliver). */
export function bridgeSignaling(call = (...args) => globalThis.__p2pSignal(...args)) {
  const open = new Map();
  globalThis.__p2pDeliver = (handle, kind, from, message) => { const e = open.get(handle); if (!e) return; if (kind === 'state') e.onState(message); else e.onSignal(from, checkSignal(message)); };
  return {
    async open({ roomId, role, onSignal, onState = () => {} }) {
      const handle = crypto.randomUUID(); open.set(handle, { onSignal, onState });
      try { await call('open', { handle, roomId, role }); } catch (error) { open.delete(handle); throw Error(String(error?.message ?? error).replace(/^.*?Error: /, '')); }
      return { send: (to, message) => { call('send', { handle, to, message: checkSignal(message) }).catch(() => {}); }, close: () => { open.delete(handle); call('close', { handle }).catch(() => {}); } };
    },
  };
}

// ---- production room finder: public MQTT brokers (p2p-providers.mjs) ---------------------------------------------------------
// Every envelope {from, to, m} is AES-GCM encrypted with a key derived from the room ID and passcode (HKDF), published QoS 0 on
// topic latex-p2p/v1/<SHA-256 of the room ID>. Brokers see only that hash and ciphertext. Endpoint ids are random per connection.
// The coordinator publishes a beacon every BEACON ms; a peer addresses 'owner' as the beacon's sender. "Room slot" rule: a new
// coordinator listens LISTEN ms first and refuses ('This room is already open') when it hears another beacon; two coordinators that
// start at the same instant are resolved by signed epochs (p2p-room.mjs), not here.
import { BROKERS } from './p2p-providers.mjs';
export const BEACON = 2000, LISTEN = 2600, FIND = 4500, CONNECT = 6000;
const enc = new TextEncoder(), dec = new TextDecoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const b64 = bytes => { let t = ''; for (const x of bytes) t += String.fromCharCode(x); return btoa(t); };
const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
async function finderKey(roomId, passcode) {
  const code = String(passcode).toUpperCase().replace(/[\s-]/g, '');
  const material = await crypto.subtle.importKey('raw', enc.encode(code), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(`latex-p2p-finder-v1\n${roomId}`), info: enc.encode('finder') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const varint = n => { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; out.push(b); } while (n); return out; };
const str = s => { const b = enc.encode(s); return [b.length >> 8, b.length & 255, ...b]; };
const packet = (type, body) => Uint8Array.from([type, ...varint(body.length), ...body]);

/** Minimal MQTT 3.1.1 over WebSocket: connect, one subscription, QoS 0 publish, keep-alive. Incoming bytes are untrusted. */
function mqtt(url, topic, onPayload, onDown, Socket) {
  return new Promise((resolve, reject) => {
    let buffer = new Uint8Array(0), up = false, ping;
    const ws = new Socket(url, 'mqtt'); ws.binaryType = 'arraybuffer';
    const fail = () => { clearInterval(ping); if (!up) reject(Error('unreachable')); else onDown(); up = false; };
    const timer = setTimeout(() => { try { ws.close(); } catch {} fail(); }, CONNECT);
    ws.onopen = () => ws.send(packet(0x10, [...str('MQTT'), 4, 0x02, 0, 60, ...str('lp' + hex(crypto.getRandomValues(new Uint8Array(10))))]));
    ws.onerror = ws.onclose = () => { clearTimeout(timer); fail(); };
    ws.onmessage = event => {
      const add = new Uint8Array(event.data); if (buffer.length + add.length > 256 * 1024) { ws.close(); return; }
      const merged = new Uint8Array(buffer.length + add.length); merged.set(buffer); merged.set(add, buffer.length); buffer = merged;
      for (;;) {
        let len = 0, mul = 1, i = 1;
        for (; i < 5 && i < buffer.length; i++) { len += (buffer[i] & 127) * mul; mul *= 128; if (!(buffer[i] & 128)) break; }
        if (i >= buffer.length || buffer.length < i + 1 + len) return;
        const type = buffer[0] >> 4, body = buffer.subarray(i + 1, i + 1 + len); buffer = buffer.slice(i + 1 + len);
        if (type === 2) { // CONNACK
          if (body[1] !== 0) { ws.close(); return; }
          ws.send(packet(0x82, [0, 1, ...str(topic), 0]));
        } else if (type === 9) { clearTimeout(timer); up = true; ping = setInterval(() => { try { ws.send(Uint8Array.of(0xC0, 0)); } catch {} }, 30_000); resolve({ publish: p => ws.send(packet(0x30, [...str(topic), ...p])), close: () => { up = false; clearInterval(ping); try { ws.close(); } catch {} } }); }
        else if (type === 3 && body.length >= 2) { const n = (body[0] << 8) | body[1]; onPayload(body.subarray(2 + n)); }
      }
    };
  });
}

/** The production adapter (contract above, plus `passcodes`: the current passcode first, then accepted older ones). */
export function mqttSignaling({ brokers = BROKERS, Socket = globalThis.overleafNetworkSocket ?? globalThis.WebSocket } = {}) {
  return {
    async open({ roomId, role, passcodes = [], onSignal, onState = () => {} }) {
      if (!/^[A-Za-z0-9_-]{22}$/.test(roomId) || !passcodes.length) throw Error('Invalid room');
      let keys = await Promise.all(passcodes.slice(0, 9).map(code => finderKey(roomId, code)));
      const topic = `latex-p2p/v1/${hex(await crypto.subtle.digest('SHA-256', enc.encode(`latex-p2p-topic-v1\n${roomId}`)))}`;
      const id = hex(crypto.getRandomValues(new Uint8Array(12))), seen = new Set();
      let owner = null, heard = null, closed = false, beacon;
      const links = new Set();
      const incoming = async payload => {
        if (closed || payload.length > 64 * 1024 || payload.length < 30) return;
        let env = null;
        try { const text = dec.decode(payload), iv = unb64(text.slice(0, 16)), data = unb64(text.slice(16)); const mark = text.slice(0, 16); if (seen.has(mark)) return; seen.add(mark); if (seen.size > 2000) seen.clear();
          for (const key of keys) { try { env = JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data))); break; } catch {} } } catch { return; }
        if (!env || typeof env.from !== 'string' || env.from.length > 32 || env.from === id) return;
        if (env.beacon) { heard ??= env.from; if (role === 'peer' && !owner) owner = env.from; return; }
        if (env.to !== id) return;
        if (role === 'peer' && env.from !== owner) return;
        try { onSignal(role === 'peer' ? 'owner' : env.from, checkSignal(env.m)); } catch {}
      };
      const publish = async env => {
        const iv = crypto.getRandomValues(new Uint8Array(12)), data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keys[0], enc.encode(JSON.stringify(env))));
        const payload = enc.encode(b64(iv) + b64(data));
        for (const link of links) try { link.publish(payload); } catch {}
      };
      const down = link => { links.delete(link); if (!links.size && !closed) onState(false); };
      await Promise.all(brokers.map(async url => { let link; try { link = await mqtt(url, topic, incoming, () => down(link), Socket); links.add(link); } catch {} }));
      if (!links.size) throw Error('The room finder is unreachable');
      const wait = ms => new Promise(r => setTimeout(r, ms));
      if (role === 'owner') {
        await wait(LISTEN);
        if (heard) { for (const l of links) l.close(); throw Error('This room is already open'); }
        const tick = () => publish({ from: id, beacon: true }).catch(() => {});
        tick(); beacon = setInterval(tick, BEACON);
      } else {
        for (let t = 0; t < FIND && !owner; t += 100) await wait(100);
        if (!owner) { for (const l of links) l.close(); throw Error('Nobody is sharing this room right now (or the passcode is not this room’s)'); } // a wrong passcode cannot decrypt the beacons
      }
      return {
        send(to, message) { if (closed) return; publish({ from: id, to: to === 'owner' ? owner : to, m: checkSignal(message) }).catch(() => {}); },
        close() { if (closed) return; closed = true; clearInterval(beacon); for (const l of links) l.close(); },
        /** After a passcode rotation: encrypt with the new one, still read the older ones. */
        async rekey(list) { if (list?.length) keys = await Promise.all(list.slice(0, 9).map(code => finderKey(roomId, code))); },
      };
    },
  };
}

export const providerSignaling = mqttSignaling();

/** The adapter in use: the test bridge when a browser check installs it, otherwise the public brokers. */
export const selectSignaling = () => (globalThis.LATEX_P2P_TEST_SIGNAL && typeof globalThis.__p2pSignal === 'function' ? bridgeSignaling() : providerSignaling);
