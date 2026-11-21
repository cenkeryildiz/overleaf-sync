// SPDX-License-Identifier: AGPL-3.0-only
// S2-04 owner-signed copy grants for LAN participants. No sockets, storage or logging: the room supplies the hook below.
// Hook (all that a room has to call; lan-room.mjs's OwnerRoom already provides participants/sendTo/roomId):
//   owner:        authority = await GrantAuthority.create(room.roomId)
//                 OwnerRoom({ onJoin: peer => authority.onJoin(room, peer),
//                             onMessage: (peer, m, name) => authority.onMessage(room, peer, m, name) || otherHandlers(...) })
//   participant:  gate = new GrantGate({ roomId, name }); feed it every owner message (gate.receive), the grant from welcome and
//                 every grant message (gate.observeGrant) and the end of the session (gate.end); then saveStandaloneCopy/exportCopy.
// A ticket is ECDSA-signed by the room's key over (room, participant name, kind, epoch, issue/expiry time). Epochs rise with every
// ticket, so a ticket works once, a replay or an older ticket fails, and a downgrade locks the gate until a new copy grant.
// Honest limit: these are application permissions. The owner's room check (OwnerRoom.authorize) is the authority; the gate and the
// storage guard stop this client's own save/export paths, not a participant who copies visible source by hand or patches the client.
import { encode } from './lan-transfer.mjs';
const subtle = globalThis.crypto.subtle, encoder = new TextEncoder();
export const KINDS = Object.freeze(['copy', 'export', 'download', 'persist']);
export const LIMITS = Object.freeze({ request: 512, window: 120_000, ttl: 120_000, skew: 60_000, permit: 30_000, seen: 256, wait: 10_000 });
const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' }, SIGN = { name: 'ECDSA', hash: 'SHA-256' };
const REF = /^[A-Za-z0-9_-]{16,32}$/, B64 = /^[A-Za-z0-9_-]+$/;
const b64u = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const unb64u = text => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
const signed = t => encoder.encode(JSON.stringify(['latex-lan-grant-v1', t.room, t.sub, t.kind, t.epoch, t.iat, t.exp]));
const int = n => Number.isSafeInteger(n) && n >= 0;

export class GrantAuthority {
  #pair; #epoch = 0; #seen = new Map(); #tail = Promise.resolve();
  static async create(roomId, now = Date.now) {
    const pair = await subtle.generateKey(ALGORITHM, false, ['sign', 'verify']);   // the private key never leaves this object
    return new GrantAuthority(roomId, pair, b64u(new Uint8Array(await subtle.exportKey('raw', pair.publicKey))), now);
  }
  constructor(roomId, pair, publicKey, now) { this.#pair = pair; Object.assign(this, { roomId, publicKey, now }); }
  /** Call from onJoin: sends the room's public key over the authenticated channel so the participant can pin it. */
  onJoin(room, peer) { return room.sendTo(peer, { t: 'grantkey', room: this.roomId, key: this.publicKey }); }
  /** Handles copy/export/download requests; returns true when the message was one (the answer is sent asynchronously). */
  onMessage(room, peer, message, name) {
    if (message?.t !== 'copy' && message?.t !== 'export' && message?.t !== 'download') return false;
    this.#answer(room, peer, name, message).catch(() => {});
    return true;
  }
  #grantee(room, peer, name) { return room.participants.some(p => p.peer === peer && p.name === name && p.grant === 'copy'); }
  async #answer(room, peer, name, m) {
    const deny = reason => room.sendTo(peer, { t: 'denied', request: m.t, ref: typeof m.ref === 'string' && REF.test(m.ref) ? m.ref : null, reason });
    const kind = m.t === 'copy' ? m.kind : m.t, now = this.now();
    if (JSON.stringify(m).length > LIMITS.request) return deny('oversized');
    if (!KINDS.includes(kind) || typeof m.ref !== 'string' || !REF.test(m.ref) || !int(m.ts)) return deny('malformed');
    if (Math.abs(now - m.ts) > LIMITS.window) return deny('stale');
    for (const [key, at] of this.#seen) if (now - at > LIMITS.window) this.#seen.delete(key);
    const id = `${name}|${m.ref}`;
    if (this.#seen.has(id)) return deny('replayed');
    if (this.#seen.size >= LIMITS.seen) return deny('busy');
    this.#seen.set(id, now);
    if (!this.#grantee(room, peer, name)) return deny('not allowed');
    const ticket = await (this.#tail = this.#tail.then(async () => {   // serialized, so epochs reach the participant in order
      const t = { room: this.roomId, sub: name, kind, epoch: ++this.#epoch, iat: this.now(), exp: this.now() + LIMITS.ttl };
      return { ...t, sig: b64u(new Uint8Array(await subtle.sign(SIGN, this.#pair.privateKey, signed(t)))) };
    }));
    if (!this.#grantee(room, peer, name)) return deny('not allowed');   // downgraded or removed while signing
    await room.sendTo(peer, { t: 'ticket', ref: m.ref, ticket });
  }
}

export class GrantGate {
  #key = null; #raw = null; #max = 0; #locked = true; #pending = new Map(); #permit = null; #guard = null;
  constructor({ roomId, name, now = Date.now }) { Object.assign(this, { roomId, name, now }); }
  get locked() { return this.#locked; }
  /** The owner's grant (from welcome and grant messages). Anything but 'copy' locks the gate and cancels what is pending. */
  observeGrant(grant) {
    this.#locked = grant !== 'copy';
    if (this.#locked) { this.#permit = null; this.#rejectAll('The project owner has not allowed copies of this project'); }
  }
  /** Session over (revoked, stopped, left, host lost): nothing more can be authorized and the storage guard is removed. */
  end() {
    this.#locked = true; this.#permit = null; this.#rejectAll('This session has ended');
    if (this.#guard && globalThis.overleafLanGate === this.#guard) delete globalThis.overleafLanGate;
    this.#guard = null;
  }
  /** Make IndexedDB creation (project-store.js create) refuse anything but a verified, one-shot persist permit. */
  installStorageGuard() { globalThis.overleafLanGate = this.#guard = { consume: () => this.#consume('persist') }; }
  #consume(kind) {
    const p = this.#permit; this.#permit = null;
    return !this.#locked && !!p && p.kind === kind && this.now() - p.at <= LIMITS.permit;
  }
  #rejectAll(reason) { for (const [ref, p] of this.#pending) { clearTimeout(p.timer); p.reject(Object.assign(Error(reason), { code: 'denied' })); this.#pending.delete(ref); } }
  /** Feed every message from the owner; returns true when it belonged to the grant protocol. */
  receive(m) {
    if (m?.t === 'grantkey') {
      if (!this.#raw && m.room === this.roomId && typeof m.key === 'string' && B64.test(m.key) && m.key.length === 87) {   // first key wins (pinned)
        this.#raw = m.key; this.#key = subtle.importKey('raw', unb64u(m.key), ALGORITHM, false, ['verify']);
      }
      return true;
    }
    if ((m?.t !== 'ticket' && m?.t !== 'denied') || !this.#pending.has(m.ref)) return false;
    const p = this.#pending.get(m.ref); this.#pending.delete(m.ref); clearTimeout(p.timer);
    if (m.t === 'denied') p.reject(Object.assign(Error(`The project owner refused (${m.reason ?? 'not allowed'})`), { code: 'denied' }));
    else this.#check(m.ticket, p.kind).then(ok => ok ? p.resolve({ kind: p.kind, epoch: m.ticket.epoch }) : p.reject(Object.assign(Error('The owner\'s grant could not be verified'), { code: 'denied' })), p.reject);
    return true;
  }
  async #check(t, kind) {
    try {
      if (!t || typeof t !== 'object' || !this.#key || this.#locked || t.room !== this.roomId || t.sub !== this.name || t.kind !== kind || typeof t.sig !== 'string' || !B64.test(t.sig)) return false;
      const now = this.now();
      if (!int(t.epoch) || !int(t.iat) || !int(t.exp) || t.exp - t.iat > LIMITS.ttl || now < t.iat - LIMITS.skew || now > t.exp + LIMITS.skew) return false;
      if (!await subtle.verify(SIGN, await this.#key, unb64u(t.sig), signed(t))) return false;
      if (this.#locked || t.epoch <= this.#max) return false;   // downgraded, or an equal/newer ticket was used while verifying
      this.#max = t.epoch; this.#permit = { kind, at: this.now() };
      return true;
    } catch { return false; }
  }
  /** Ask the owner for a one-shot permit for `kind` (send = session.send). Resolves when a verified ticket arrives; rejects {code:'denied'}. */
  authorize(send, kind) {
    if (!KINDS.includes(kind)) return Promise.reject(Error('Unknown request'));
    if (this.#locked) return Promise.reject(Object.assign(Error('The project owner has not allowed copies of this project'), { code: 'denied' }));
    const ref = b64u(globalThis.crypto.getRandomValues(new Uint8Array(12)));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(ref); reject(Object.assign(Error('The owner did not answer'), { code: 'denied' })); }, LIMITS.wait); timer.unref?.();
      this.#pending.set(ref, { kind, resolve, reject, timer });
      send({ t: 'copy', kind, ref, ts: this.now() }).catch(error => { clearTimeout(timer); this.#pending.delete(ref); reject(error); });
    });
  }
}

/** Project files for IndexedDB creation: text sources as `content`, everything else as base64 `data`. */
export function copyResources(copy) {
  const text = new TextDecoder('utf-8', { fatal: true });
  const resources = copy.files.map(({ path, bytes }) => { try { return { path, content: text.decode(bytes) }; } catch { return { path, data: encode(bytes) }; } }); // chunked: spreading a whole binary overflows the call stack
  return { main: copy.main, resources };
}
/**
 * Explicit "Save a standalone copy": owner ticket -> store.release('persist') -> `save(copy)` (which calls overleafLocalProjects.local,
 * guarded by installStorageGuard). Returns whatever `save` returns; the copy is independent of the session and survives its end.
 */
export async function saveStandaloneCopy({ gate, store, send, save }) {
  await gate.authorize(send, 'persist');
  return save(store.release('persist'));
}
/** Explicit export/download of an independent copy; the caller turns it into a file. */
export async function exportCopy({ gate, store, send, kind = 'export' }) {
  await gate.authorize(send, kind);
  return store.release(kind);
}
