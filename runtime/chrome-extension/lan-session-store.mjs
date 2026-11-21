// SPDX-License-Identifier: AGPL-3.0-only
// S2-04 memory-only project store for a LAN participant. The shared project lives only in this object's memory:
// no IndexedDB, localStorage, caches or logging. Leaving the session (revoke, stop, leave, host loss) wipes it.
// Copies are released only while the owner's grant is 'copy', and each is an independent project with a new identity.
import { joinRoom, GRANTS } from './lan-room.mjs';
import { SnapshotReceiver, validPath, pathKey, MAX_FILES, MAX_FILE, MAX_TOTAL } from './lan-transfer.mjs';

const KINDS = new Set(['copy', 'export', 'download', 'persist']);
const identity = () => [...globalThis.crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join('');
const denied = () => Object.assign(Error('The project owner has not allowed copies of this project'), { code: 'denied' });

export class SessionStore {
  #files = null; #main = null; #grant = null; #bytes = 0; #ended = false;
  get grant() { return this.#grant; }
  get ended() { return this.#ended; }
  get main() { return this.#main; }
  get bytes() { return this.#bytes; }
  #live() { if (this.#ended) throw Error('This session has ended'); if (!this.#files) throw Error('No project received yet'); return this.#files; }
  /** Adopts a verified project (the store takes ownership of its buffers); replaces and zeroes the previous one. */
  load(project) {
    if (this.#ended) { for (const bytes of project.files.values()) bytes.fill(0); return; }
    for (const bytes of this.#files?.values() ?? []) bytes.fill(0);
    this.#files = new Map(project.files); this.#main = project.main; this.#bytes = project.total;
  }
  setGrant(grant) { if (!this.#ended && GRANTS.includes(grant)) this.#grant = grant; }
  can(kind) { return !this.#ended && !!this.#files && KINDS.has(kind) && this.#grant === 'copy'; }
  paths() { return [...this.#live().keys()].sort(); }
  has(path) { return this.#live().has(path); }
  read(path) { const bytes = this.#live().get(path); if (!bytes) throw Error('No such file'); return bytes.slice(); }
  readText(path) {
    const bytes = this.#live().get(path); if (!bytes) throw Error('No such file');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw Error('Not a UTF-8 text file'); }
  }
  /** Create or replace a file in memory (text or bytes), within the same limits as a received project. */
  write(path, data) {
    const files = this.#live(); if (!validPath(path)) throw Error('Invalid project path');
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data.slice() : null;
    if (!bytes || bytes.length > MAX_FILE) throw Error('Invalid or oversized file');
    const key = pathKey(path), existing = [...files.keys()].find(name => pathKey(name) === key);
    const others = [...files.keys()].filter(name => name !== existing).map(pathKey);
    if (others.some(other => other.startsWith(`${key}/`) || key.startsWith(`${other}/`))) throw Error('Conflicting project paths');
    const next = this.#bytes - (files.get(existing)?.length ?? 0) + bytes.length;
    if (next > MAX_TOTAL || (!existing && files.size >= MAX_FILES)) throw Error('Project size outside limits');
    files.get(existing)?.fill(0); files.set(existing ?? path, bytes); this.#bytes = next;   // a case variant updates the existing name, so main stays valid
  }
  remove(path) {
    const files = this.#live(), bytes = files.get(path); if (!bytes) throw Error('No such file');
    if (path === this.#main) throw Error('The main file cannot be removed');
    bytes.fill(0); files.delete(path); this.#bytes -= bytes.length;
  }
  /** Renames a file, or every file below a folder, keeping the bytes; the owner has already checked the change. */
  move(from, to) {
    const files = this.#live(); if (!validPath(to)) throw Error('Invalid project path');
    for (const [path, bytes] of [...files]) if (path === from || path.startsWith(from + '/')) { files.delete(path); files.set(to + path.slice(from.length), bytes); }
    if (this.#main === from || this.#main?.startsWith(from + '/')) this.#main = to + this.#main.slice(from.length);
  }
  setMain(path) { if (!this.#live().has(path)) throw Error('No such file'); this.#main = path; }
  /** Explicit independent copy for an export/download/save: fresh buffers, new identity, no link back to this store. */
  release(kind) {
    if (!KINDS.has(kind)) throw Error('Unknown request');
    if (!this.can(kind)) { this.#live(); throw denied(); }
    return { id: identity(), main: this.#main, files: [...this.#files].map(([path, bytes]) => ({ path, bytes: bytes.slice() })) };
  }
  copy() { return this.release('copy'); }
  /** Zero and forget everything; the store cannot be reused. Copies already released are not recalled. */
  wipe() { for (const bytes of this.#files?.values() ?? []) bytes.fill(0); this.#files = null; this.#main = null; this.#grant = null; this.#bytes = 0; this.#ended = true; }
}

/**
 * joinRoom + receiver + store. Verified snapshots replace the project atomically; failed transfers keep the previous one.
 * Any end of the session (owner revoked/stopped, you left, host lost) aborts staging and wipes the store.
 */
export function connectStore({ onProject = () => {}, onTransferError = () => {}, onMessage = () => {}, onGrant = () => {}, onEnd = () => {}, ...join }) {
  const store = new SessionStore(), receiver = new SnapshotReceiver();
  const session = joinRoom({
    ...join,
    onMessage: message => {
      if (message.t !== 'snapshot' && message.t !== 'file') return onMessage(message);
      receiver.accept(message).then(project => { if (project) { store.load(project); onProject(project); } }, error => onTransferError(error));
    },
    onGrant: grant => { store.setGrant(grant); onGrant(grant); },
    onEnd: reason => { receiver.abort(); store.wipe(); onEnd(reason); },
  });
  session.joined.then(({ grant }) => { if (store.grant === null) store.setGrant(grant); }, () => {});
  return { session, store, requestSnapshot: () => session.send({ t: 'snapshot', req: true }) };
}
