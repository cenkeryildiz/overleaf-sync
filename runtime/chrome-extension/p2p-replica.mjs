// SPDX-License-Identifier: AGPL-3.0-only
// Stage 4 P2P-HANDOVER-01: every member follows the coordinator's log for every shared text file (not only the open ones), so
// whoever coordinates next starts from the same numbering, text and recent log (lan-host.mjs `seed`). Fed by joinSession's
// onTap; it only reads messages and sends its own 'join' requests and handover catch-up ('fill'). Memory only.
import { ot } from './lan-ot.mjs';
export const LIMITS = Object.freeze({ entries: 2000, bytes: 2 * 1024 * 1024, docs: 1000, wait: 5_000 });
const isInt = n => Number.isSafeInteger(n) && n >= 0, size = v => JSON.stringify(v).length;
const within = (path, root) => path === root || path.startsWith(root + '/');

export class Replica {
  docs = new Map(); // path -> { text, v, at, log: [{v,id,by,ops,len}], bytes }
  #session = null; #waits = new Map();
  constructor({ name, limits = {} }) { Object.assign(this, { name, limits: { ...LIMITS, ...limits } }); }
  /** Ask the coordinator on `session` for every shared text file; their replies (re)start the documents. */
  track(session, paths) {
    this.#session = session;
    for (const path of [...paths].slice(0, this.limits.docs)) session.send({ t: 'update', k: 'join', path, ref: 'replica' }).catch(() => {});
  }
  /** One coordinator message (onTap). Anything that does not continue a document exactly makes it ask for that document again. */
  tap(m, session) {
    if (!m || typeof m.path !== 'string' && m.t !== 'fs') return;
    if (m.t === 'doc') return this.#doc(m, session);
    if (m.t === 'remote' || (m.t === 'ack' && Array.isArray(m.ops))) return this.#entry(m.path, { v: m.v, id: m.id, by: m.t === 'ack' ? this.name : m.by, ops: m.ops, len: m.len }, session);
    if (m.t === 'sync' && Array.isArray(m.entries)) { for (const e of m.entries) if (Array.isArray(e?.ops)) this.#entry(m.path, e, session); return; }
    if (m.t === 'filled' || (m.t === 'refused' && String(m.reason).startsWith('fill'))) { this.#waits.get(`fill\0${m.path}`)?.(m); return; }
    if (m.t === 'fs' && m.k === 'change' && m.op && typeof m.op === 'object') this.#tree(m.op, session);
  }
  #doc(m, session) {
    if (typeof m.text !== 'string' || !isInt(m.v)) return;
    const d = this.docs.get(m.path), at = typeof m.at === 'string' ? m.at : null;
    this.#waits.get(`doc\0${m.path}`)?.({ v: m.v, at, text: m.text });
    if (session !== this.#session) return;
    if (d && d.v === m.v && d.at === at && d.text === m.text) return; // the same history: keep the log
    if (this.docs.size >= this.limits.docs && !d) return;
    this.docs.set(m.path, { text: m.text, v: m.v, at, base: at, log: [], bytes: 0 }); // base: the id at the version before the log
  }
  #entry(path, e, session) {
    if (session !== this.#session) return;
    const d = this.docs.get(path);
    if (!d || !isInt(e?.v) || e.v <= d.v || typeof e.id !== 'string') return;
    try {
      if (e.v !== d.v + 1) throw Error('gap');
      const text = ot.apply(d.text, e.ops), entry = { v: e.v, id: e.id, by: String(e.by ?? ''), ops: e.ops, len: text.length };
      Object.assign(d, { text, v: e.v, at: e.id }); d.log.push(entry); d.bytes += size(entry);
      while (d.log.length > this.limits.entries || d.bytes > this.limits.bytes) { const old = d.log.shift(); d.bytes -= size(old); d.base = old.id; }
    } catch { this.docs.delete(path); session.send({ t: 'update', k: 'join', path, ref: 'replica' }).catch(() => {}); }
  }
  #tree(op, session) {
    if (op.kind === 'relocate' && typeof op.from === 'string' && typeof op.to === 'string') {
      for (const [path, d] of [...this.docs]) if (within(path, op.from)) { this.docs.delete(path); this.docs.set(op.to + path.slice(op.from.length), d); }
    } else if (op.kind === 'remove' && typeof op.from === 'string') { for (const path of [...this.docs.keys()]) if (within(path, op.from)) this.docs.delete(path); }
    else if ((op.kind === 'doc' || (op.kind === 'put' && op.doc)) && typeof op.path === 'string') session.send({ t: 'update', k: 'join', path: op.path, ref: 'replica' }).catch(() => {});
  }
  #wait(key) {
    return new Promise(resolve => { const clock = setTimeout(() => { this.#waits.delete(key); resolve(null); }, this.limits.wait); this.#waits.set(key, value => { clearTimeout(clock); this.#waits.delete(key); resolve(value); }); });
  }
  /** What a successor coordinator starts from: per document text, version, log tail and the id of its last entry. */
  seed() { return Object.fromEntries([...this.docs].map(([path, d]) => [path, { text: d.text, version: d.v, log: d.log.map(e => ({ ...e })), headId: d.at }])); }
  heads() { return Object.fromEntries([...this.docs].map(([path, d]) => [path, { v: d.v, at: d.at }])); }

  /**
   * Handover catch-up, before joinSession resumes on a new coordinator (its beforeAdopt hook): for every document where this
   * member holds confirmed entries the coordinator lacks, and the coordinator's head is one of ours, send them ('fill').
   * Returns { filled, refused, diverged } paths. The coordinator accepts fills only while it has committed nothing of its own.
   */
  async catchUp(session) {
    const out = { filled: [], refused: [], diverged: [] };
    await Promise.all([...this.docs].map(async ([path, d]) => {
      const reply = this.#wait(`doc\0${path}`);
      await session.send({ t: 'update', k: 'join', path, ref: 'replica' }).catch(() => {});
      const theirs = await reply;
      if (!theirs || theirs.v >= d.v) return;
      const first = d.log[0]?.v ?? d.v + 1, i = theirs.v - first + 1; // index of our entry right after their head
      if (i < 0) { out.refused.push(path); return; } // our log no longer reaches back to their head
      const ours = i === 0 ? d.base : d.log[i - 1].id;
      if (theirs.v > 0 && ours !== theirs.at) { out.diverged.push(path); return; }
      const filled = this.#wait(`fill\0${path}`);
      await session.send({ t: 'update', k: 'fill', path, entries: d.log.slice(i) }).catch(() => {});
      ((await filled)?.t === 'filled' ? out.filled : out.refused).push(path);
    }));
    this.#session = session;
    return out;
  }
}
