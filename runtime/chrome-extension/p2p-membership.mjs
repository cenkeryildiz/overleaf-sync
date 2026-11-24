// SPDX-License-Identifier: AGPL-3.0-only
// Stage 4 P2P-OWNER-01: the owner-signed member list. Every peer verifies the whole chain before it accepts a role, so a
// coordinator cannot promote itself and a removed member stays removed on every coordinator.
//
// A chain is a list of documents { b: body, s: signature, a?: acceptance }. body = [VERSION, room, seq, prev, op, owner, backup, members]
// with members = [[key, name, role], ...] sorted by key; prev is the SHA-256 (hex) of the previous body; seq counts from 0.
// Rules for document seq n+1 against document n:
//   create   seq 0 only, signed by its own owner, who is a 'copy' member.
//   update   signed by the current owner; owner unchanged (roles, additions, removals, backup).
//   transfer signed by the current owner AND accepted (a) by the new owner, who must already be a member.
//   claim    signed by the current backup; the backup becomes the owner and the backup slot is cleared.
//            Acceptance rule for a lost owner key: a claim is a deliberate action of the backup's user, never automatic; a network
//            partition or an absent owner is not evidence of key loss and does not trigger one. Without a backup permissions freeze.
// Signatures of a superseded owner fail the signer rule. A second, different valid document for a sequence number already held
// (two competing transfers, a fork) freezes permission changes under the last verified list; editing continues.
import { verify, KEY } from './p2p-identity.mjs';
import { validUsername, GRANTS } from './lan-room.mjs';
const VERSION = 'latex-p2p-members-v1', OPS = ['create', 'update', 'transfer', 'claim'], encoder = new TextEncoder();
export const MAX_MEMBERS = 64, MAX_CHAIN = 1000;
const hex = buffer => [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
const digest = async body => hex(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(body))));
const fields = b => ({ room: b[1], seq: b[2], prev: b[3], op: b[4], owner: b[5], backup: b[6], members: b[7] });
const signedBytes = (body, what) => encoder.encode(JSON.stringify([what, body]));

/** Throws unless the body is well formed on its own (types, bounds, unique keys and names, owner and backup are members). */
function checkBody(b) {
  if (!Array.isArray(b) || b.length !== 8 || b[0] !== VERSION) throw Error('Malformed member list');
  const { room, seq, prev, op, owner, backup, members } = fields(b);
  if (typeof room !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(room) || !Number.isSafeInteger(seq) || seq < 0 || typeof prev !== 'string' || !(seq === 0 ? prev === '' : /^[0-9a-f]{64}$/.test(prev))) throw Error('Malformed member list');
  if (!OPS.includes(op) || (op === 'create') !== (seq === 0) || !KEY.test(owner) || (backup !== null && (!KEY.test(backup) || backup === owner))) throw Error('Malformed member list');
  if (!Array.isArray(members) || members.length < 1 || members.length > MAX_MEMBERS) throw Error('Malformed member list');
  const names = new Set(); let last = '';
  for (const m of members) {
    if (!Array.isArray(m) || m.length !== 3 || !KEY.test(m[0]) || m[0] <= last || validUsername(m[1]) !== m[1] || !GRANTS.includes(m[2])) throw Error('Malformed member');
    const folded = m[1].toLowerCase(); if (names.has(folded)) throw Error('Duplicate member name');
    names.add(folded); last = m[0];
  }
  const role = key => members.find(m => m[0] === key)?.[2];
  if (role(owner) !== 'copy' || (backup !== null && !role(backup))) throw Error('Owner or backup is not a member');
}

export class Membership {
  #docs = []; #digests = []; frozen = false;
  /** A new room: the creator is its owner and first member (copy permission). */
  static async create(roomId, identity, name) {
    const body = [VERSION, roomId, 0, '', 'create', identity.key, null, [[identity.key, validUsername(name) ?? 'Owner', 'copy']]];
    checkBody(body);
    const m = new Membership(roomId); await m.#append({ b: body, s: await identity.sign(signedBytes(body, 'owner')) }); return m;
  }
  /** Verifies a whole received or stored chain from its first document. */
  static async load(roomId, chain) {
    if (!Array.isArray(chain) || !chain.length || chain.length > MAX_CHAIN) throw Error('Malformed member list');
    const m = new Membership(roomId);
    for (const doc of chain) if (await m.accept(doc) !== 'applied') throw Error('The member list is not one chain');
    return m;
  }
  constructor(roomId) { this.roomId = roomId; }
  get head() { return fields(this.#docs.at(-1).b); }
  get seq() { return this.head.seq; }
  get owner() { return this.head.owner; }
  get backup() { return this.head.backup; }
  get members() { return this.head.members.map(([key, name, role]) => ({ key, name, role })); }
  member(key) { const m = this.head.members.find(x => x[0] === key); return m ? { key, name: m[1], role: m[2] } : null; }
  chain() { return this.#docs.map(d => structuredClone(d)); }
  /** Listed earlier, not now: removed by the owner. Such an identity is never re-admitted automatically. */
  removed(key) { return !this.member(key) && this.#docs.some(d => fields(d.b).members.some(m => m[0] === key)); }
  /** The chain from document `seq` on (what a peer behind us is missing). */
  since(seq) { return this.#docs.slice(Math.max(0, seq + 1)).map(d => structuredClone(d)); }

  async #append(doc) { this.#docs.push(doc); this.#digests.push(await digest(doc.b)); }
  /**
   * 'applied' (the next document, verified), 'known' (already held), 'conflict' (a different valid document for a held number:
   * permission changes freeze) or 'gap' (from further ahead: ask for the missing part). Throws on anything invalid or forged.
   */
  async accept(doc) {
    if (!doc || typeof doc !== 'object' || JSON.stringify(doc).length > 64 * 1024) throw Error('Malformed member list');
    checkBody(doc.b);
    const next = fields(doc.b);
    if (next.room !== this.roomId) throw Error('Member list of another room');
    const held = this.#docs.length;
    if (next.seq > held) return 'gap';
    if (next.seq < held) {
      if (await digest(doc.b) === this.#digests[next.seq]) return 'known';
      if (await this.#valid(doc, next.seq ? fields(this.#docs[next.seq - 1].b) : null, next.seq ? this.#digests[next.seq - 1] : '')) { this.frozen = true; return 'conflict'; }
      throw Error('Forged member list');
    }
    if (this.frozen) return 'conflict'; // no further permission changes until the owner resolves the competing lists
    if (!await this.#valid(doc, held ? this.head : null, held ? this.#digests[held - 1] : '')) throw Error('Forged member list');
    await this.#append(structuredClone(doc)); return 'applied';
  }
  async #valid(doc, prev, prevDigest) {
    const next = fields(doc.b), bytes = signedBytes(doc.b, 'owner');
    if (!prev) return next.op === 'create' && await verify(next.owner, doc.s, bytes);
    if (next.prev !== prevDigest || next.seq !== prev.seq + 1) return false;
    if (next.op === 'update') return next.owner === prev.owner && await verify(prev.owner, doc.s, bytes);
    if (next.op === 'transfer') return next.owner !== prev.owner && prev.members.some(m => m[0] === next.owner) && await verify(prev.owner, doc.s, bytes) && await verify(next.owner, doc.a, signedBytes(doc.b, 'accept'));
    if (next.op === 'claim') return prev.backup !== null && next.owner === prev.backup && next.backup === null && await verify(prev.backup, doc.s, bytes);
    return false;
  }
  async #next(op, { owner = this.owner, backup = this.backup, members = this.head.members }) {
    const body = [VERSION, this.roomId, this.seq + 1, this.#digests.at(-1), op, owner, backup, [...members].sort((x, y) => x[0] < y[0] ? -1 : 1)];
    checkBody(body); return body;
  }
  #owner(identity) { if (identity.key !== this.owner) throw Error('Only the owner can change members'); if (this.frozen) throw Error('Permission changes are frozen: two different member lists exist'); }

  // ---- documents the owner (or the backup / the new owner) signs; each returns the document to apply and send -------------------
  /** Add a member or change a role ('online' | 'copy'). */
  async setMember(identity, key, name, role) {
    this.#owner(identity);
    if (key === this.owner && role !== 'copy') throw Error('The owner keeps the copy permission');
    const members = this.head.members.filter(m => m[0] !== key).concat([[key, validUsername(name) ?? '', role]]);
    const b = await this.#next('update', { members }); return { b, s: await identity.sign(signedBytes(b, 'owner')) };
  }
  /** Remove a member (and the backup slot, if it was theirs). The caller rotates the passcode; already downloaded copies remain. */
  async remove(identity, key) {
    this.#owner(identity);
    if (key === this.owner) throw Error('Transfer ownership before leaving');
    const b = await this.#next('update', { members: this.head.members.filter(m => m[0] !== key), backup: this.backup === key ? null : this.backup });
    return { b, s: await identity.sign(signedBytes(b, 'owner')) };
  }
  async setBackup(identity, key) {
    this.#owner(identity);
    const b = await this.#next('update', { backup: key }); return { b, s: await identity.sign(signedBytes(b, 'owner')) };
  }
  /** The owner's half of a transfer; it takes effect only once the recipient signs `acceptTransfer`. */
  async offerTransfer(identity, key) {
    this.#owner(identity);
    const b = await this.#next('transfer', { owner: key, backup: this.backup === key ? null : this.backup, members: this.head.members.map(m => m[0] === key ? [m[0], m[1], 'copy'] : m) });
    return { b, s: await identity.sign(signedBytes(b, 'owner')) };
  }
  async acceptTransfer(identity, offer) {
    checkBody(offer?.b);
    if (fields(offer.b).owner !== identity.key || fields(offer.b).op !== 'transfer') throw Error('This transfer is not addressed to you');
    return { ...offer, a: await identity.sign(signedBytes(offer.b, 'accept')) };
  }
  /** The backup takes ownership because the owner's key is lost (an explicit user decision; see the rule above). */
  async claim(identity) {
    if (identity.key !== this.backup) throw Error('Only the backup owner can claim ownership');
    const b = await this.#next('claim', { owner: identity.key, backup: null, members: this.head.members.map(m => m[0] === identity.key ? [m[0], m[1], 'copy'] : m) });
    return { b, s: await identity.sign(signedBytes(b, 'owner')) };
  }
}
