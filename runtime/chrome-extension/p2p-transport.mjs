// SPDX-License-Identifier: AGPL-3.0-only
// Stage 4 P2P-ROOM-01 transport: browser WebRTC data channels in place of the LAN relay helper and its WebSocket.
// p2pHelper() has the helper shape lan-host.mjs startHost uses (call/send/subscribe/close with peer/data/gone events) and
// p2pSocket() returns a WebSocket-shaped class for lan-guest.mjs joinSession, so the sealed room protocol (lan-room.mjs),
// snapshot transfer, OT and grants run unchanged and end to end inside the channel. The room finder (p2p-signal.mjs) sees only
// WebRTC session descriptions and ICE candidates. Everything from the finder or a peer is untrusted.
import { MAX_MESSAGE, roomLink } from './lan-room.mjs';
import { selectSignaling } from './p2p-signal.mjs';

export const PIECE = 64 * 1024 - 1;           // payload per data-channel message: 64 KiB is the size every WebRTC stack accepts
export const QUEUE_LIMIT = 96 * 1024 * 1024;  // bytes waiting per peer; a full 64 MB snapshot in base64 frames fits, more drops the peer
export const OPEN_TIMEOUT = 20_000;           // a connection attempt that never opens its channel is closed (strangers cannot pile up)
export const MAX_PEERS = 32, CLOSE_GRACE = 2000, DISCONNECT_GRACE = 3000;
const HIGH = 1024 * 1024, MORE = 0, LAST = 1;
const b64 = bytes => { let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(text); };
const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

/**
 * One reliable ordered channel, framed: every room frame is split into pieces with a 1-byte more/last header and joined again,
 * bounded by MAX_MESSAGE. Sending queues behind the channel's buffer and flushes on `bufferedamountlow`; past QUEUE_LIMIT it fails.
 */
function framed(channel, { onFrame, onFail }) {
  let parts = [], size = 0, queue = [], queued = 0;
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = HIGH / 2;
  const flush = () => {
    while (queue.length && channel.readyState === 'open' && channel.bufferedAmount < HIGH) { const piece = queue.shift(); queued -= piece.length; channel.send(piece); }
  };
  channel.onbufferedamountlow = flush;
  channel.onmessage = event => {
    const piece = new Uint8Array(event.data instanceof ArrayBuffer ? event.data : new ArrayBuffer(0));
    if (!piece.length || piece[0] > LAST || (size += piece.length - 1) > MAX_MESSAGE) { onFail(Error('Malformed message')); return; }
    parts.push(piece.subarray(1));
    if (piece[0] === MORE) return;
    const frame = new Uint8Array(size); let at = 0; for (const p of parts) { frame.set(p, at); at += p.length; }
    parts = []; size = 0; onFrame(frame);
  };
  return bytes => {
    if (bytes.length > MAX_MESSAGE) throw Error('Message too large');
    for (let at = 0; at < bytes.length || at === 0; at += PIECE) {
      const body = bytes.subarray(at, at + PIECE), piece = new Uint8Array(body.length + 1);
      piece[0] = at + PIECE >= bytes.length ? LAST : MORE; piece.set(body, 1);
      queue.push(piece); queued += piece.length;
      if (at + PIECE >= bytes.length) break;
    }
    if (queued > QUEUE_LIMIT) { queue = []; queued = 0; onFail(Error('The peer is not keeping up')); return; }
    flush();
  };
}

// A transient network change may recover; repeated state events must not postpone a persistent loss.
function watchConnection(pc, onLost) {
  let timer = null;
  const clear = () => { clearTimeout(timer); timer = null; };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') clear();
    else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') { clear(); onLost(); }
    else if (pc.connectionState === 'disconnected' && timer === null) timer = setTimeout(() => {
      timer = null; if (pc.connectionState !== 'connected') onLost();
    }, DISCONNECT_GRACE);
  };
  return () => { clear(); pc.onconnectionstatechange = null; };
}

const noFinder = () => Error('Internet rooms are not available: no room finder is configured');
const candidate = c => c && { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex };

/**
 * Owner side: stands in for the LAN helper in startHost({ helper }). 'open' registers the room with the finder and answers
 * offers; each opened channel is one peer. 'addresses' reports none (internet rooms bind nothing), 'admit' is a no-op and 'drop'
 * closes that peer's connection. `state` is 'up' or 'down' (finder outage: open rooms keep working, new joins wait).
 */
export function p2pHelper({ signaling = selectSignaling(), RTC = globalThis.RTCPeerConnection, iceServers = [], passcodes = () => [] } = {}) {
  const listeners = new Set(), peers = new Map(), byFrom = new Map(); let next = 1, finder = null, closed = false;
  const helper = { state: 'down', get peers() { return peers.size; } };
  const emit = event => { for (const listener of listeners) listener(event); };
  const end = (peer, notify = true) => {
    const p = peers.get(peer); if (!p) return;
    peers.delete(peer); byFrom.delete(p.from); clearTimeout(p.timer); p.stopWatching?.();
    // The channel closes first so messages already queued (e.g. 'revoked') still arrive; closing the connection at once discards them.
    if (p.local) { p.local.closedByHelper(); if (p.open && notify) emit({ ev: 'gone', peer }); return; }
    const pc = p.pc, later = setTimeout(() => { try { pc.close(); } catch {} }, CLOSE_GRACE);
    if (p.channel) p.channel.onclose = () => { clearTimeout(later); try { pc.close(); } catch {} };
    try { p.channel?.close(); } catch {} if (!p.channel) { clearTimeout(later); try { pc.close(); } catch {} }
    try { finder?.send(p.from, { t: 'bye' }); } catch {}
    if (p.open && notify) emit({ ev: 'gone', peer });
  };
  const onSignal = (from, message) => {
    if (closed || typeof from !== 'string' || from.length > 64) return;
    const known = byFrom.get(from), p = known && peers.get(known);
    if (message.t === 'offer' && !p) {
      if (peers.size >= MAX_PEERS) { try { finder.send(from, { t: 'bye' }); } catch {} return; }
      const peer = next++, pc = new RTC({ iceServers }), entry = { from, pc, open: false, chain: Promise.resolve(), channel: null, send: null };
      entry.timer = setTimeout(() => end(peer), OPEN_TIMEOUT);
      peers.set(peer, entry); byFrom.set(from, peer);
      pc.onicecandidate = event => { if (event.candidate) try { finder.send(from, { t: 'ice', c: candidate(event.candidate) }); } catch {} };
      entry.stopWatching = watchConnection(pc, () => end(peer));
      pc.ondatachannel = ({ channel }) => {
        if (entry.channel) { channel.close(); return; } // one channel per peer
        entry.channel = channel;
        entry.send = framed(channel, { onFrame: bytes => emit({ ev: 'data', peer, data: b64(bytes) }), onFail: () => end(peer) });
        channel.onopen = () => { clearTimeout(entry.timer); entry.open = true; emit({ ev: 'peer', peer }); };
        channel.onclose = () => end(peer);
      };
      entry.chain = entry.chain.then(async () => {
        await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        finder.send(from, { t: 'answer', sdp: pc.localDescription.sdp });
      }).catch(() => end(peer));
      return;
    }
    if (!p) return;
    if (message.t === 'ice') p.chain = p.chain.then(() => p.pc.addIceCandidate(message.c)).catch(() => {}); // a bad candidate is skipped, not fatal
    else if (message.t === 'bye' && !p.open) end(known); // an open channel ends only on its own close: the finder cannot cut a session
  };
  Object.assign(helper, {
    async call(op, args = {}) {
      if (op === 'addresses') return { addresses: [] };
      if (op === 'admit') return {};
      if (op === 'drop') { end(args.peer); return {}; }
      if (op === 'open') {
        if (!signaling) throw noFinder();
        if (finder) throw Error('This room is already open');
        finder = await signaling.open({ roomId: args.room, role: 'owner', passcodes: passcodes(), onSignal, onState: up => { helper.state = up ? 'up' : 'down'; } });
        helper.state = 'up';
        return { port: 0, link: roomLink(args.room) };
      }
      if (op === 'close') { helper.close(); return {}; }
      throw Error('Unknown request');
    },
    send(message) { if (message?.op === 'send') { const p = peers.get(message.peer); if (p?.open) p.send(unb64(message.data)); } },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    /** The passcodes changed (removal): the finder re-keys; open connections are unaffected. */
    rekey: () => finder?.rekey?.(passcodes()),
    /**
     * In-memory participant connection to this coordinator, WebSocket-shaped like p2pSocket's class: the member whose computer
     * coordinates keeps its own participant session (and editor) and reaches its own room without any network.
     */
    connectLocal(url) {
      const peer = next++, socket = { url, binaryType: 'arraybuffer', readyState: 0 }, entry = { from: `local${peer}`, open: false, local: socket };
      entry.send = bytes => { const copy = bytes.slice(); queueMicrotask(() => { if (socket.readyState === 1) socket.onmessage?.({ data: copy.buffer }); }); };
      socket.send = bytes => { if (socket.readyState !== 1) throw Error('Not connected'); const copy = new Uint8Array(bytes).slice(); queueMicrotask(() => { if (peers.get(peer) === entry) emit({ ev: 'data', peer, data: b64(copy) }); }); };
      socket.close = () => { if (socket.readyState === 3) return; const was = socket.readyState; socket.readyState = 3; if (peers.get(peer) === entry) { peers.delete(peer); if (entry.open) emit({ ev: 'gone', peer }); } if (was === 1) queueMicrotask(() => socket.onclose?.()); };
      socket.closedByHelper = () => { if (socket.readyState === 3) return; socket.readyState = 3; queueMicrotask(() => socket.onclose?.()); };
      if (closed) { queueMicrotask(() => socket.onerror?.(Error('The room is closed'))); socket.readyState = 3; return socket; }
      peers.set(peer, entry);
      queueMicrotask(() => { if (socket.readyState !== 0) return; entry.open = true; socket.readyState = 1; emit({ ev: 'peer', peer }); socket.onopen?.(); });
      return socket;
    },
    close() { if (closed) return; closed = true; for (const peer of [...peers.keys()]) end(peer); finder?.close(); finder = null; helper.state = 'down'; },
  });
  return helper;
}

/**
 * Participant side: a WebSocket-shaped class (`new Socket('p2p:<roomId>')`) for joinSession. It offers one data channel to the
 * room's owner through the finder; once open, the finder is left and the session no longer depends on it.
 */
export function p2pSocket({ signaling = selectSignaling(), RTC = globalThis.RTCPeerConnection, iceServers = [], passcode = () => null } = {}) {
  return class P2PSocket {
    #pc = null; #channel = null; #finder = null; #send = null; #state = 0; #timer; #stopWatching;
    constructor(url) {
      this.url = url; this.binaryType = 'arraybuffer';
      const roomId = /^p2p:([A-Za-z0-9_-]{22})$/.exec(String(url))?.[1];
      queueMicrotask(() => this.#start(roomId).catch(error => this.#fail(error)));
    }
    get readyState() { return this.#state; }
    async #start(roomId) {
      if (!roomId) throw Error('This is not a valid room link');
      if (!signaling) throw noFinder();
      this.#finder = await signaling.open({ roomId, role: 'peer', passcodes: [passcode()].filter(Boolean), onSignal: (from, m) => this.#signal(from, m) });
      if (this.#state !== 0) { this.#finder.close(); return; }
      const pc = this.#pc = new RTC({ iceServers }), channel = this.#channel = pc.createDataChannel('room', { ordered: true });
      this.#send = framed(channel, { onFrame: bytes => this.onmessage?.({ data: bytes.buffer }), onFail: () => this.close() });
      channel.onopen = () => { clearTimeout(this.#timer); this.#state = 1; this.#finder?.close(); this.#finder = null; this.onopen?.(); };
      channel.onclose = () => this.#end();
      this.#stopWatching = watchConnection(pc, () => this.#fail(Error('No direct connection path to the room was found. This network may require relay fallback, which is not available yet')));
      pc.onicecandidate = event => { if (event.candidate) try { this.#finder?.send('owner', { t: 'ice', c: candidate(event.candidate) }); } catch {} };
      this.#timer = setTimeout(() => this.#fail(Error('The room did not open a direct connection. Keep the owner’s shared project open. This network may require relay fallback, which is not available yet')), OPEN_TIMEOUT);
      await pc.setLocalDescription(await pc.createOffer());
      this.#finder.send('owner', { t: 'offer', sdp: pc.localDescription.sdp });
    }
    #signal(from, m) {
      if (from !== 'owner' || !this.#pc || this.#state !== 0) return;
      if (m.t === 'answer') this.#pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch(error => this.#fail(error));
      else if (m.t === 'ice') this.#pc.addIceCandidate(m.c).catch(() => {});
      else if (m.t === 'bye') this.#fail(Error('The room refused the connection'));
    }
    #fail(error) { if (this.#state === 0) { this.#state = 3; this.#teardown(); this.onerror?.(error); } else this.close(); }
    #teardown() { clearTimeout(this.#timer); this.#stopWatching?.(); this.#stopWatching = null; try { this.#channel?.close(); } catch {} try { this.#pc?.close(); } catch {} this.#finder?.close(); this.#finder = null; }
    #end() { if (this.#state === 3) return; const was = this.#state; this.#state = 3; this.#teardown(); if (was === 1) this.onclose?.(); }
    send(bytes) { if (this.#state !== 1) throw Error('Not connected'); this.#send(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); }
    close() { if (this.#state === 0) { this.#state = 3; this.#teardown(); return; } this.#end(); }
  };
}
