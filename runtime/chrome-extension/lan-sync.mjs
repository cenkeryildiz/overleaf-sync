// SPDX-License-Identifier: AGPL-3.0-only
// S2-05 rejoin and pending-edit reconciliation over lan-room.mjs. Pure state machines: no sockets, no storage.
// The text OT is injected as `ot = { apply(text, ops) -> text, transformX(clientOps, serverOps) -> [clientOps', serverOps'] }`
// (server wins ties). Production wiring supplies the editor's own sharejs-text-ot; this repo contains no importable transform.
//
// Protocol (participant -> owner use the existing 'update'/'snapshot' types; owner -> participant types are unrestricted):
//   {t:'update',k:'op',cid,n,base,ops}   one op at a time; id = cid.n; the owner transforms it against the log after `base`
//   {t:'update',k:'sync',cid,base}       rejoin: owner replies {t:'sync',entries,done,head} with every log entry after `base`
//   {t:'snapshot'}                       owner replies {t:'snapshot',v,text}; adopting one is always an explicit step
//   owner: {t:'ack',id,v,len} | {t:'remote',v,id,by,ops,len} | {t:'refused',reason,id?} (a refused sync adds hi: the sender's last applied n)
// A rejoining participant replays the missed entries exactly like live ones (own entries acknowledge its pending head, others
// transform its pending ops), then resumes sending, so no owner-side chain transform is needed and a replayed id never applies twice.
export const LIMITS = Object.freeze({ pendingOps: 200, pendingBytes: 256 * 1024, opBytes: 128 * 1024, logEntries: 5000, logBytes: 4 * 1024 * 1024, pageBytes: 200 * 1024, snapshotBytes: 300 * 1024 });
const CID = /^[0-9a-f]{32}$/;
const size = value => JSON.stringify(value).length;
const isInt = n => Number.isSafeInteger(n) && n >= 0;
const noop = () => {};

export class OwnerSync {
  #log = []; #head = null; #bytes = 0; #index = new Map(); #clients = new Map(); #owner = 0; #ops = false; // #ops: an op of this coordinator's own epoch was committed
  constructor({ room, ot, text = '', version = 0, limits = {}, log = [], headId = null }) {
    Object.assign(this, { room, ot, text, version, limits: { ...LIMITS, ...limits } });
    this.#head = headId; // id of the entry at `version` when the seed carries no log (a room reopened from a saved copy)
    // Stage 4 handover: a successor coordinator continues the previous coordinator's numbering and log (p2p-replica.mjs).
    // Seeded ids acknowledge a resubmission without applying it again; their original submission is unknown, so it is not compared.
    for (const e of log) {
      if (!isInt(e?.v) || typeof e.id !== 'string' || !Array.isArray(e.ops)) throw Error('Malformed seed');
      const entry = { v: e.v, id: e.id, by: String(e.by ?? ''), ops: e.ops, len: e.len };
      this.#log.push(entry); this.#bytes += size(entry); this.#index.set(e.id, { v: e.v, len: e.len, submitted: null });
      const [cid, n] = e.id.split('.'); const c = this.#clients.get(cid);
      if (CID.test(cid) && isInt(Number(n))) { if (!c) this.#clients.set(cid, { name: entry.by, hi: Number(n) }); else c.hi = Math.max(c.hi, Number(n)); }
    }
    if (log.length && log.at(-1).v !== version) throw Error('Seed log does not end at the seeded version');
  }
  /** Version and text of this document, the log tail after `base` (or null when it no longer covers it) and the client high marks. */
  state() { return { text: this.text, version: this.version, log: this.log }; }
  get log() { return this.#log.map(e => ({ ...e })); }
  /** Id of the entry at the current version (null for an unedited document): identifies this history, not just its length. */
  get headId() { return this.#log.at(-1)?.id ?? this.#head; }
  /** The owner's own edits enter the same ordered log; `ops` apply to the current `this.text` (the editor mirrors the result). */
  localEdit(ops) { this.#ops = true; return this.#commit(`owner.${++this.#owner}`, 'Owner', ops, null, `[${this.version},${JSON.stringify(ops)}]`); }
  /** Pass as OwnerRoom's onMessage. Throwing drops the peer: only malformed, replayed or tampered input throws. */
  handle(peer, message, name) {
    if (message.t === 'snapshot') return this.#snapshot(peer);
    if (message.t !== 'update') return;
    if (message.k === 'sync') return this.#sync(peer, name, message);
    if (message.k === 'op') return this.#op(peer, name, message);
    if (message.k === 'fill') return this.#fill(peer, name, message);
    throw Error('Unknown update kind');
  }
  #send(peer, message) { this.room.sendTo(peer, message).catch(noop); }
  #refuse(peer, reason, id) { this.#send(peer, { t: 'refused', reason, ...(id ? { id } : {}) }); }
  #bind(cid, name) {
    if (!CID.test(cid)) throw Error('Malformed client id');
    const bound = this.#clients.get(cid);
    if (!bound) this.#clients.set(cid, { name, hi: 0 }); else if (bound.name !== name) throw Error('Client id belongs to another participant');
    return this.#clients.get(cid);
  }
  /** Log entries after `base`, or the refusal reason when the log cannot cover it. */
  #since(base) {
    if (base > this.version) return 'unknown_base';
    const first = this.#log[0]?.v ?? this.version + 1;
    return base < first - 1 ? 'base_too_old' : this.#log.slice(base - first + 1);
  }
  #commit(id, by, ops, except, submitted) {
    const text = this.ot.apply(this.text, ops);
    this.text = text; this.version++;
    const entry = { v: this.version, id, by, ops, len: text.length };
    this.#log.push(entry); this.#bytes += size(entry); this.#index.set(id, { v: entry.v, len: entry.len, submitted });
    while (this.#log.length > this.limits.logEntries || this.#bytes > this.limits.logBytes) {
      const old = this.#log.shift(); this.#bytes -= size(old); this.#index.delete(old.id);
    }
    this.room.broadcast({ t: 'remote', ...entry }, except).catch(noop);
    return entry;
  }
  #op(peer, name, m) {
    const { cid, n, base, ops } = m;
    if (!isInt(n) || n < 1 || !isInt(base) || !Array.isArray(ops) || size(ops) > this.limits.opBytes) throw Error('Malformed op');
    const client = this.#bind(cid, name), id = `${cid}.${n}`, submitted = `[${base},${JSON.stringify(ops)}]`, seen = this.#index.get(id);
    if (seen) { // the same op again: acknowledge, never apply twice; different content under a used id is tampering
      if (seen.submitted !== null && seen.submitted !== submitted) throw Error('Op id reused with different content');
      return this.#send(peer, { t: 'ack', id, v: seen.v, len: seen.len });
    }
    if (n !== client.hi + 1) throw Error('Replayed or skipped op id');
    const since = this.#since(base);
    if (typeof since === 'string') return this.#refuse(peer, since, id);
    let cur = ops;
    try { for (const entry of since) cur = this.ot.transformX(cur, entry.ops)[0]; this.ot.apply(this.text, cur); }
    catch { return this.#refuse(peer, 'invalid_op', id); }
    client.hi = n; this.#ops = true;
    const entry = this.#commit(id, name, cur, peer, submitted);
    this.#send(peer, { t: 'ack', id, v: entry.v, len: entry.len, ops: cur }); // ops: the applied form, so every replica can follow the log
  }
  #sync(peer, name, m) {
    if (!isInt(m.base)) throw Error('Malformed sync');
    const client = this.#bind(m.cid, name), since = this.#since(m.base);
    // Stage 4: `at` names the entry the sender holds at `base`; another entry there means separately edited histories (a fork).
    if (typeof m.at === 'string' && typeof since !== 'string' && m.base > 0) {
      const at = m.base === this.version ? this.headId : this.#log[m.base - (this.#log[0]?.v ?? 1)]?.id;
      if (at !== undefined && at !== null && at !== m.at) return this.#send(peer, { t: 'refused', reason: 'diverged', hi: client.hi });
    }
    // hi: this client's last applied op number, so a participant the log no longer covers knows whether its in-flight edit landed
    if (typeof since === 'string') return this.#send(peer, { t: 'refused', reason: since, hi: client.hi });
    const entries = since; // own entries keep their ops too: replicas (p2p-replica.mjs) follow the whole log
    let page = [], bytes = 0;
    for (const entry of entries) {
      const s = size(entry);
      if (page.length && bytes + s > this.limits.pageBytes) { this.#send(peer, { t: 'sync', entries: page, done: false, head: this.version }); page = []; bytes = 0; }
      page.push(entry); bytes += s;
    }
    this.#send(peer, { t: 'sync', entries: page, done: true, head: this.version });
  }
  /**
   * Stage 4 handover catch-up: a member that saw entries of the previous coordinator's log beyond this successor's version sends
   * them verbatim. Accepted only while `this.open` allows (the successor has committed nothing of its own epoch yet) and only
   * contiguous from the current version; anything else is refused and the sender reconciles explicitly.
   */
  #fill(peer, name, m) {
    if (!Array.isArray(m.entries) || m.entries.length > this.limits.logEntries || size(m.entries) > this.limits.logBytes) throw Error('Malformed fill');
    if (this.#ops || !this.fillable?.(peer, name)) return this.#refuse(peer, 'fill_closed');
    let text = this.text;
    try { for (const [i, e] of m.entries.entries()) { if (e?.v !== this.version + 1 + i || typeof e.id !== 'string' || !Array.isArray(e.ops)) throw Error(); text = this.ot.apply(text, e.ops); } }
    catch { return this.#refuse(peer, 'fill_mismatch'); }
    for (const e of m.entries) if (!this.#index.has(e.id)) {
      const [cid, n] = e.id.split('.'), c = this.#clients.get(cid);
      if (CID.test(cid) && isInt(Number(n))) { if (!c) this.#clients.set(cid, { name: String(e.by ?? ''), hi: Number(n) }); else c.hi = Math.max(c.hi, Number(n)); }
      this.#commit(e.id, String(e.by ?? ''), e.ops, null, null);
    }
    this.#send(peer, { t: 'filled', v: this.version });
  }
  #snapshot(peer) {
    if (this.text.length > this.limits.snapshotBytes / 2 || size(this.text) > this.limits.snapshotBytes) return this.#refuse(peer, 'too_large'); // whole-project transfer is a separate path
    this.#send(peer, { t: 'snapshot', v: this.version, text: this.text });
  }
}

const randomCid = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');

/**
 * States: awaiting_snapshot -> live <-> syncing; locked (host lost, pending kept in memory); needs_snapshot (log cannot cover us);
 * diverged (an invariant failed). Only `live` accepts edits. Nothing is ever persisted here.
 */
export class ParticipantSync {
  #send = null; #inflight = false; #pending = []; #n = 0; #offered = null;
  constructor({ ot, send = null, cid = randomCid(), limits = {}, onState = noop, onRemote = noop }) {
    Object.assign(this, { ot, cid, limits: { ...LIMITS, ...limits }, onState, onRemote, text: null, version: 0, state: 'awaiting_snapshot', reason: '' });
    this.#send = send;
  }
  get pending() { return this.#pending.map(({ id, ops }) => ({ id, ops })); }
  get offered() { return this.#offered ? { v: this.#offered.v } : null; }
  #set(state, reason = '') { this.state = state; this.reason = reason; this.onState(state, reason); }
  #transmit(message) { Promise.resolve().then(() => this.#send(message)).catch(() => this.hostLost()); }
  /** Begin on a fresh or re-established session: first join asks for a snapshot, a rejoin replays the missed entries. */
  attach(send) {
    this.#send = send; this.#inflight = false;
    if (this.text === null) this.#transmit({ t: 'snapshot' });
    else if (this.state === 'live' || this.state === 'syncing' || this.state === 'locked') { this.#set('syncing'); this.#transmit({ t: 'update', k: 'sync', cid: this.cid, base: this.version }); }
  }
  /** Host or connection lost: editing locks, pending edits stay in memory for explicit reconciliation. */
  hostLost() { this.#send = null; this.#inflight = false; if (this.state === 'live' || this.state === 'syncing') this.#set('locked', 'The host is unreachable'); }
  requestSnapshot() { if (this.#send) this.#transmit({ t: 'snapshot' }); }
  edit(ops) {
    if (this.state !== 'live') throw Error(`Editing is paused (${this.state})`);
    const bytes = size(ops);
    if (!Array.isArray(ops) || bytes > this.limits.opBytes) throw Error('Edit is too large');
    if (this.#pending.length >= this.limits.pendingOps || this.#pending.reduce((n, p) => n + p.bytes, bytes) > this.limits.pendingBytes) throw Error('Too many unsent edits; stop editing and save a copy');
    const text = this.ot.apply(this.text, ops); // throws on an invalid op before anything is queued
    this.text = text; const id = `${this.cid}.${++this.#n}`;
    this.#pending.push({ id, n: this.#n, ops, bytes }); this.#flush();
    return id;
  }
  #flush() {
    const head = this.#pending[0];
    if (this.state !== 'live' || this.#inflight || !head || !this.#send) return;
    this.#inflight = true;
    this.#transmit({ t: 'update', k: 'op', cid: this.cid, n: head.n, base: this.version, ops: head.ops });
  }
  #diverge(reason) { this.#inflight = false; this.#set('diverged', reason); }
  /** One owner log entry, in order: own = acknowledgement of the pending head, other = remote edit transformed past the pending ops. */
  #entry(e) {
    if (!e || !isInt(e.v) || typeof e.id !== 'string') return this.#diverge('Malformed entry');
    if (e.v <= this.version) return;
    if (e.v !== this.version + 1) { if (this.state === 'live') { this.#set('syncing'); this.#transmit({ t: 'update', k: 'sync', cid: this.cid, base: this.version }); } return; }
    if (e.id.startsWith(this.cid + '.')) {
      if (this.#pending[0]?.id !== e.id) return this.#diverge('Acknowledged an edit that is not pending');
      this.#pending.shift(); this.#inflight = false;
    } else {
      if (!Array.isArray(e.ops)) return this.#diverge('Malformed remote edit');
      let remote = e.ops;
      try {
        for (const p of this.#pending) [p.ops, remote] = this.ot.transformX(p.ops, remote);
        this.text = this.ot.apply(this.text, remote);
      } catch { return this.#diverge('A remote edit does not fit this copy'); }
      this.onRemote(remote);
    }
    this.version = e.v;
    if (!this.#pending.length && typeof e.len === 'number' && this.text.length !== e.len) return this.#diverge('Copy length differs from the owner');
  }
  receive(m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'remote' || m.t === 'ack') { if (this.text !== null && this.state !== 'diverged' && this.state !== 'needs_snapshot') { this.#entry(m); this.#flush(); } }
    else if (m.t === 'sync') {
      if (this.state !== 'syncing') return;
      for (const e of Array.isArray(m.entries) ? m.entries : []) { this.#entry(e); if (this.state !== 'syncing') return; }
      if (m.done) { this.#set('live'); this.#flush(); }
    } else if (m.t === 'snapshot') this.#snapshot(m);
    else if (m.t === 'refused') {
      if (['base_too_old', 'unknown_base', 'too_large'].includes(m.reason)) { this.#inflight = false; this.#set('needs_snapshot', m.reason); }
      else this.#diverge(`The owner refused an edit (${m.reason})`);
    }
  }
  #snapshot(m) {
    if (!isInt(m.v) || typeof m.text !== 'string') return;
    if (this.text === null && !this.#pending.length) { this.text = m.text; this.version = m.v; this.#inflight = false; this.#set('live'); return; } // first join: nothing to lose
    this.#offered = { v: m.v, text: m.text }; this.onState('snapshot_offered', '');
  }
  /** Explicit adoption of an offered snapshot. Never automatic: it replaces this copy, so unsent edits must be handed back. */
  acceptSnapshot({ discardPending = false } = {}) {
    const offer = this.#offered;
    if (!offer) throw Error('No snapshot offered');
    if (offer.v <= this.version && this.state !== 'diverged' && this.state !== 'needs_snapshot') throw Error('Stale snapshot: this copy is already newer');
    if (this.#pending.length && !discardPending) throw Error('Unsent edits would be lost; save a copy first, then accept with discardPending');
    const discarded = this.#pending.splice(0).map(({ id, ops }) => ({ id, ops }));
    this.text = offer.text; this.version = offer.v; this.#offered = null; this.#inflight = false;
    this.#set(this.#send ? 'live' : 'locked');
    return { discarded };
  }
}
