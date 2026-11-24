// SPDX-License-Identifier: AGPL-3.0-only
// Stage 4 room finder ("signaling"): it only introduces two browsers so they can open a direct WebRTC data channel. It carries
// WebRTC session descriptions and ICE candidates, nothing else: never the passcode, room keys, names, grants or project source
// (the room protocol in lan-room.mjs runs inside the data channel, end to end). Everything a signaling service sends is untrusted.
//
// Adapter contract (one object per service):
//   open({ roomId, role: 'owner' | 'peer', onSignal(from, message), onState(up) }) -> Promise<{ send(to, message), close() }>
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

/**
 * Adapter slot for the signaling service the user will choose (not chosen yet; nothing here contacts any service).
 * It must implement the contract above over e.g. a small WebSocket relay; the manifest CSP must then name its wss:// host.
 */
export const providerSignaling = null;

/** The adapter in use, or null when internet rooms are unavailable (no provider chosen and no test bridge). */
export const selectSignaling = () => (globalThis.LATEX_P2P_TEST_SIGNAL && typeof globalThis.__p2pSignal === 'function' ? bridgeSignaling() : providerSignaling);
