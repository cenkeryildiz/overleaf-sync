// SPDX-License-Identifier: AGPL-3.0-only
// LAN room protocol. The relay helper (lan/src/main.rs) only forwards bytes; every participant proves the
// passcode and gets its own keys: P-256 ECDH, HKDF salted with the passcode, AES-GCM with strict counters.
// The owner authorizes every participant request here, in its own browser; hidden buttons are not the check.
const subtle = globalThis.crypto.subtle, encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
export const EXTENSION_ID = 'oekjjadnainlmdbgbdjokegaikafafke';
export const MAX_MESSAGE = 512 * 1024; // the helper's frame limit
export const GRANTS = Object.freeze(['online', 'copy']);
const HELLO = 1, CHALLENGE = 2, SEALED = 3, POINT = 65, NONCE = 16, VERSION = 'latex-lan-v1';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 unambiguous symbols: 16 of them carry 80 bits
const ROOM = /^[A-Za-z0-9_-]{22}$/, IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
// Participant message type -> the action the owner must allow. Unknown types end the connection.
const ACTIONS = Object.freeze({ update: 'edit', cursor: 'edit', fs: 'edit', snapshot: 'view', file: 'view', copy: 'copy', export: 'copy', download: 'copy', leave: 'view',
  work: 'copy', compile: 'view' }); // stage 3: helping compile writes temporary files on that computer, so it needs the copy grant
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

const random = length => globalThis.crypto.getRandomValues(new Uint8Array(length));
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };

export function newRoomSecrets() {
  return { roomId: base64url(random(16)), passcode: Array.from(random(16), byte => ALPHABET[byte & 31]).join('').match(/.{4}/g).join('-') };
}
export function normalizePasscode(value) {
  const code = String(value ?? '').toUpperCase().replace(/[\s-]/g, '');
  return code.length === 16 && [...code].every(c => ALPHABET.includes(c)) ? code : null;
}
export function validUsername(value) {
  const name = String(value ?? '').normalize('NFC').trim();
  return [...name].length >= 1 && [...name].length <= 32 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name) ? name : null;
}
const validHost = host => IPV4.test(host) && (/^(10|127)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host));
const validPort = port => Number.isInteger(port) && port >= 1024 && port <= 65535;
/** The link carries routing only; the passcode is shared separately and never enters a URL. */
export function joinLink(host, port, roomId) {
  if (!validHost(host) || !validPort(port) || !ROOM.test(roomId)) throw Error('Invalid sharing address');
  return `chrome-extension://${EXTENSION_ID}/extension/index.html#join=${host}:${port}/${roomId}`;
}
export function parseJoinLink(link) {
  const match = String(link).match(/^chrome-extension:\/\/([a-p]{32})\/extension\/index\.html#join=([\d.]+):(\d{4,5})\/([A-Za-z0-9_-]{22})$/);
  if (!match || match[1] !== EXTENSION_ID || !validHost(match[2]) || !validPort(Number(match[3]))) throw Error('This is not a valid join link');
  const [, , host, port, roomId] = match;
  return { host, port: Number(port), roomId, url: `ws://${host}:${port}/r/${roomId}` };
}

async function deriveKeys(privateKey, otherPoint, roomId, passcode, participantPoint, ownerPoint, nonce) {
  const other = await subtle.importKey('raw', otherPoint, ECDH, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: other }, privateKey, 256);
  const salt = await subtle.digest('SHA-256', encoder.encode(`${VERSION}\n${roomId}\n${passcode}`));
  const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const bits = new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: concat(encoder.encode(VERSION), participantPoint, ownerPoint, nonce) }, material, 512));
  const key = raw => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { toOwner: await key(bits.slice(0, 32)), toParticipant: await key(bits.slice(32)) };
}
/** One direction pair. Counters are the AES-GCM nonces and must arrive in order: replays, drops and reordering fail. */
class Channel {
  #sent = 0n; #received = 0n; #sealing = Promise.resolve();
  constructor(sendKey, receiveKey, roomId, sendLabel, receiveLabel) {
    Object.assign(this, { sendKey, receiveKey, sendData: encoder.encode(`${roomId}|${sendLabel}`), receiveData: encoder.encode(`${roomId}|${receiveLabel}`) });
  }
  seal(message) {
    const plain = encoder.encode(JSON.stringify(message));
    if (plain.length > MAX_MESSAGE - 9 - 16) throw Error('Message too large');
    const counter = this.#sent++, head = new Uint8Array(9); head[0] = SEALED; new DataView(head.buffer).setBigUint64(1, counter);
    const iv = new Uint8Array(12); iv.set(head.subarray(1), 4);
    const sealed = this.#sealing.then(() => subtle.encrypt({ name: 'AES-GCM', iv, additionalData: this.sendData }, this.sendKey, plain)).then(cipher => concat(head, new Uint8Array(cipher)));
    this.#sealing = sealed.catch(() => {});
    return sealed;
  }
  async open(bytes) {
    if (bytes.length < 9 + 16 || bytes.length > MAX_MESSAGE || bytes[0] !== SEALED) throw Error('Malformed message');
    const counter = new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(1);
    if (counter !== this.#received) throw Error('Replayed or missing message');
    const iv = new Uint8Array(12); iv.set(bytes.subarray(1, 9), 4);
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: this.receiveData }, this.receiveKey, bytes.subarray(9));
    this.#received++;
    const message = JSON.parse(decoder.decode(plain));
    if (!message || typeof message !== 'object' || typeof message.t !== 'string') throw Error('Malformed message');
    return message;
  }
}
/** Serializes async handling so each connection's state machine sees frames one at a time. */
const serial = () => { let tail = Promise.resolve(); return task => { const run = tail.then(task); tail = run.catch(() => {}); return run; }; }; // a failed task must not poison the later ones (e.g. the close handler)

/**
 * Owner side. Wire `connected/receive/disconnected` to the helper's peer/data/gone events and pass
 * `send(peer, bytes)`, `admit(peer)` and `drop(peer)` that call the helper. `onMessage` only ever
 * receives requests that passed `authorize`.
 */
export class OwnerRoom {
  #peers = new Map(); #stopped = false; #resume = new Map(); // name -> { token, grant }: an authenticated rejoin keeps the owner's latest grant (memory only)
  #retired = []; // passcodes replaced by rotatePasscode(): they still open a resume, never a new join
  constructor({ send, admit, drop, onJoin = () => {}, onMessage = () => {}, onLeave = () => {} }, secrets = newRoomSecrets()) {
    Object.assign(this, { roomId: secrets.roomId, passcode: secrets.passcode, transport: { send, admit, drop }, onJoin, onMessage, onLeave });
  }
  get participants() { return [...this.#peers].filter(([, p]) => p.state === 'joined').map(([peer, p]) => ({ peer, name: p.name, grant: p.grant })); }
  connected(peer) {
    if (this.#stopped || this.#peers.has(peer)) { this.transport.drop(peer); return; }
    this.#peers.set(peer, { state: 'hello', queue: serial() });
  }
  receive(peer, bytes) {
    const entry = this.#peers.get(peer);
    if (!entry) return Promise.resolve();
    return entry.queue(() => this.#peers.get(peer) === entry && this.#handle(peer, entry, bytes)).catch(() => this.#remove(peer, true));
  }
  disconnected(peer) { this.#remove(peer, false); }
  authorize(peer, action) {
    const entry = this.#peers.get(peer);
    if (this.#stopped || entry?.state !== 'joined') return false;
    return action === 'view' || action === 'edit' || (action === 'copy' && entry.grant === 'copy');
  }
  async setGrant(peer, grant) {
    const entry = this.#peers.get(peer);
    if (!GRANTS.includes(grant) || entry?.state !== 'joined') throw Error('Unknown participant or permission');
    entry.grant = grant; const kept = this.#resume.get(entry.name); if (kept) kept.grant = grant; // also binds a resume of a connection that is already gone on the participant's side
    await this.#send(peer, entry, { t: 'grant', grant });
  }
  async sendTo(peer, message) { const entry = this.#peers.get(peer); if (entry?.state === 'joined') await this.#send(peer, entry, message); }
  async broadcast(message, except) { await Promise.all(this.participants.filter(p => p.peer !== except).map(p => this.sendTo(p.peer, message))); }
  async revoke(peer) {
    const entry = this.#peers.get(peer);
    if (entry?.state === 'joined') { this.#resume.delete(entry.name); await this.#send(peer, entry, { t: 'revoked' }).catch(() => {}); }
    this.#remove(peer, true);
  }
  /**
   * After removing someone: new joins need a new passcode. Participants already in the session keep reconnecting with the
   * old one, because a rejoin under a retired passcode must also prove its resume token (a removed participant has none).
   */
  rotatePasscode() { if (this.#stopped) return this.passcode; this.#retired = [this.passcode, ...this.#retired].slice(0, 8); this.passcode = newRoomSecrets().passcode; return this.passcode; }
  /** Stop sharing: every participant loses access; a new room has a new passcode. */
  async stop() {
    if (this.#stopped) return;
    await this.broadcast({ t: 'stopped' }).catch(() => {});
    this.#stopped = true;
    for (const peer of [...this.#peers.keys()]) this.#remove(peer, true);
  }
  /** The first sealed message decides which passcode the participant used: the current one, or a retired one (resume only). */
  async #openJoin(entry, bytes) {
    try { return await entry.channel.open(bytes); } catch (error) {
      for (const channel of entry.older) { const message = await channel.open(bytes).catch(() => null); if (message) { Object.assign(entry, { channel, retired: true }); return message; } }
      throw error;
    } finally { entry.older = []; }
  }
  async #send(peer, entry, message) { this.transport.send(peer, await entry.channel.seal(message)); }
  #remove(peer, drop) {
    const entry = this.#peers.get(peer);
    if (!entry) return;
    this.#peers.delete(peer);
    if (drop) this.transport.drop(peer);
    if (entry.state === 'joined') this.onLeave(peer, entry.name);
  }
  async #handle(peer, entry, bytes) {
    if (entry.state === 'hello') {
      if (bytes.length !== 1 + POINT || bytes[0] !== HELLO) throw Error('Malformed hello');
      const pair = await subtle.generateKey(ECDH, false, ['deriveBits']), own = new Uint8Array(await subtle.exportKey('raw', pair.publicKey)), nonce = random(NONCE);
      const theirs = bytes.slice(1), channels = await Promise.all([this.passcode, ...this.#retired].map(async code => {
        const keys = await deriveKeys(pair.privateKey, theirs, this.roomId, normalizePasscode(code), theirs, own, nonce);
        return new Channel(keys.toParticipant, keys.toOwner, this.roomId, 'to-participant', 'to-owner');
      }));
      Object.assign(entry, { state: 'joining', channel: channels[0], older: channels.slice(1), retired: false });
      this.transport.send(peer, concat([CHALLENGE], own, nonce));
      return;
    }
    const message = entry.state === 'joining' ? await this.#openJoin(entry, bytes) : await entry.channel.open(bytes); // a wrong passcode fails here and drops the connection
    if (entry.state === 'joining') {
      const name = message.t === 'join' && validUsername(message.name);
      if (!name) throw Error('Invalid join');
      // A rejoin proves the token from its last welcome; revoke and leave delete it, so a removed participant cannot resume.
      const resuming = 'resume' in message, valid = resuming && typeof message.resume === 'string' && message.resume === this.#resume.get(name)?.token;
      if (resuming && !valid) { await this.#send(peer, entry, { t: 'refused', code: 'resume', reason: 'This session can no longer be resumed' }); throw Error('Stale resume'); }
      if (entry.retired && !valid) { await this.#send(peer, entry, { t: 'refused', reason: 'This passcode was replaced. Ask the owner for the current one' }); throw Error('Retired passcode'); }
      const held = this.participants.find(p => p.name === name);
      if (held && valid) this.#remove(held.peer, true); // the same participant on a new connection: the old one is stale
      else if (held) { await this.#send(peer, entry, { t: 'refused', reason: 'That name is already in use in this session' }); throw Error('Name in use'); }
      const resume = base64url(random(16)), grant = valid ? this.#resume.get(name).grant : 'online'; this.#resume.set(name, { token: resume, grant });
      Object.assign(entry, { state: 'joined', name, grant });
      this.transport.admit(peer);
      await this.#send(peer, entry, { t: 'welcome', grant: entry.grant, participants: this.participants.map(p => p.name), resume });
      this.onJoin(peer, name);
      return;
    }
    const action = Object.hasOwn(ACTIONS, message.t) ? ACTIONS[message.t] : null;
    if (!action) throw Error('Unknown request');
    if (message.t === 'leave') { this.#resume.delete(entry.name); this.#remove(peer, true); return; }
    if (!this.authorize(peer, action)) { await this.#send(peer, entry, { t: 'denied', request: message.t, ref: message.ref ?? null }); return; }
    this.onMessage(peer, message, entry.name);
  }
}

/**
 * Participant side. `send(bytes)` writes to the WebSocket, `close()` closes it; feed every binary
 * message to `receive` and the socket's close to `closed`. `joined` settles once the owner admits or refuses.
 * Session state stays in memory: this module never persists anything.
 */
export function joinRoom({ roomId, passcode, username, resume, send, close, onMessage = () => {}, onGrant = () => {}, onEnd = () => {} }) {
  const code = normalizePasscode(passcode), name = validUsername(username);
  if (!ROOM.test(String(roomId))) throw Error('This is not a valid join link');
  if (!code) throw Error('Enter the passcode exactly as shown by the owner');
  if (!name) throw Error('Choose a name of 1 to 32 visible characters');
  let state = 'connecting', grant = null, channel = null, pair = null, own = null, settle;
  const joined = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  joined.catch(() => {});
  const queue = serial();
  const end = (reason, error, final = false) => { // final: revoked, stopped or left; otherwise the connection was lost and may be resumed
    if (state === 'ended') return;
    const wasJoined = state === 'joined'; state = 'ended'; grant = null; channel = null;
    close();
    if (wasJoined) onEnd(reason, final); else settle.reject(error ?? Error(reason));
  };
  const handle = async bytes => {
    if (state === 'challenge') {
      if (bytes.length !== 1 + POINT + NONCE || bytes[0] !== CHALLENGE) throw Error('Malformed challenge');
      const keys = await deriveKeys(pair.privateKey, bytes.slice(1, 1 + POINT), roomId, code, own, bytes.slice(1, 1 + POINT), bytes.slice(1 + POINT));
      channel = new Channel(keys.toOwner, keys.toParticipant, roomId, 'to-owner', 'to-participant');
      state = 'welcome';
      send(await channel.seal({ t: 'join', name, ...(resume ? { resume } : {}) }));
      return;
    }
    if (state !== 'welcome' && state !== 'joined') return;
    const message = await channel.open(bytes); // the owner's reply also proves it knows the passcode
    if (state === 'welcome') {
      if (message.t === 'refused') { const reason = String(message.reason ?? 'The owner refused this join'); end(reason, Object.assign(Error(reason), { code: message.code === 'resume' ? 'resume' : 'refused' })); return; }
      if (message.t !== 'welcome' || !GRANTS.includes(message.grant)) throw Error('Malformed welcome');
      state = 'joined'; grant = message.grant;
      settle.resolve({ grant, participants: Array.isArray(message.participants) ? message.participants.map(String) : [], resume: ROOM.test(message.resume) ? message.resume : null });
      return;
    }
    if (message.t === 'grant' && GRANTS.includes(message.grant)) { grant = message.grant; onGrant(grant); return; }
    if (message.t === 'revoked' || message.t === 'stopped') { end(message.t === 'revoked' ? 'The owner removed you from this session' : 'The owner stopped sharing', null, true); return; }
    onMessage(message);
  };
  const session = {
    joined,
    get grant() { return grant; },
    get state() { return state; },
    /** Mirrors the owner's grant for the UI only; the owner enforces every request. */
    can(action) { return state === 'joined' && (action === 'view' || action === 'edit' || (action === 'copy' && grant === 'copy')); },
    receive: bytes => queue(() => handle(bytes)).catch(() => end('The connection to the owner failed', Error('Room unavailable or passcode incorrect'))),
    closed: () => queue(() => end('The owner is unreachable; editing is locked until you rejoin', Error('Room unavailable or passcode incorrect'))).catch(() => {}),
    async send(message) {
      if (state !== 'joined' || !Object.hasOwn(ACTIONS, message?.t)) throw Error('Not connected');
      send(await channel.seal(message));
    },
    leave() { if (state === 'joined') session.send({ t: 'leave' }).catch(() => {}).finally(() => end('You left the session', null, true)); else end('You left the session', null, true); },
  };
  queue(async () => {
    pair = await subtle.generateKey(ECDH, false, ['deriveBits']); own = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
    if (state !== 'connecting') return;
    state = 'challenge'; send(concat([HELLO], own));
  }).catch(error => end('Secure connection setup failed', error));
  return session;
}
