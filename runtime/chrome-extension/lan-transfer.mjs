// SPDX-License-Identifier: AGPL-3.0-only
// S2-03 project snapshot transfer over the sealed room layer (lan-room.mjs). The owner sends a manifest, bounded
// base64 chunks and an end marker as 'snapshot'/'file' messages; the participant stages everything privately,
// verifies it and exposes a project only when every byte matches (all-or-nothing). Pure logic: no I/O, no storage.
import { MAX_MESSAGE } from './lan-room.mjs';

export const CHUNK = 360_000;                 // raw bytes per chunk (base64 + JSON stays far below MAX_MESSAGE)
export const MAX_FILES = 1000, MAX_FILE = 32 * 1024 * 1024, MAX_TOTAL = 64 * 1024 * 1024; // count/total as project-store.js and native MAX; per-file is new
if (Math.ceil(CHUNK / 3) * 4 + 512 >= MAX_MESSAGE) throw Error('Chunk size exceeds the sealed message limit');
const subtle = globalThis.crypto.subtle;
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
// Union of project-store.js `path` and native safe_path: controls, backslash, colon, quote, backtick and shell characters are refused.
const FORBIDDEN = /[\\:"`$;&|<>\u0000-\u001f\u007f-\u009f]/;
export const validPath = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !FORBIDDEN.test(value) &&
  value.split('/').every(part => part && part !== '.' && part !== '..');
export const pathKey = path => path.normalize('NFC').toLowerCase();      // case-insensitive file systems must not see duplicates

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/, native = typeof Uint8Array.fromBase64 === 'function' && typeof Uint8Array.prototype.toBase64 === 'function';
export const encodeFallback = bytes => { let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(text); };
export const decodeFallback = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
export const encode = native ? bytes => bytes.toBase64() : encodeFallback;
export const decode = text => {
  if (typeof text !== 'string' || text.length % 4 || !BASE64.test(text)) throw Error('Invalid chunk encoding');
  return native ? Uint8Array.fromBase64(text) : decodeFallback(text);
};
const hex = buffer => [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async bytes => hex(await subtle.digest('SHA-256', bytes));
const randomId = () => hex(globalThis.crypto.getRandomValues(new Uint8Array(16)));

/** Throws unless the manifest is one both sides accept: bounded, unique, non-conflicting, internally consistent. */
export function checkManifest(m) {
  if (!m || typeof m.xfer !== 'string' || !/^[a-f0-9]{32}$/.test(m.xfer) || !Array.isArray(m.files) || m.files.length < 1 || m.files.length > MAX_FILES) throw Error('Invalid snapshot manifest');
  const keys = new Set(); let total = 0;
  for (const file of m.files) {
    if (!file || !validPath(file.path)) throw Error('Invalid project path');
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE) throw Error('File size outside limits');
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || file.chunks !== Math.ceil(file.size / CHUNK)) throw Error('Invalid file entry');
    const key = pathKey(file.path); if (keys.has(key)) throw Error('Duplicate project path');
    keys.add(key); total += file.size;
  }
  if (total > MAX_TOTAL || m.total !== total) throw Error('Project size outside limits');
  for (const key of keys) for (let i = key.indexOf('/'); i > 0; i = key.indexOf('/', i + 1)) if (keys.has(key.slice(0, i))) throw Error('Conflicting project paths');
  if (m.main !== null && m.main !== undefined && !m.files.some(file => file.path === m.main)) throw Error('Main file is not in the project');
}

/** Participant side. accept() takes owner 'snapshot'/'file' messages in order; it resolves a project only on a verified end. */
export class SnapshotReceiver {
  #tail = Promise.resolve(); #x = null;
  accept(message) { const run = this.#tail.then(() => this.#accept(message)); this.#tail = run.catch(() => {}); return run; }
  abort() { this.#discard(); }
  #discard() { for (const buffer of this.#x?.bufs ?? []) buffer?.fill(0); this.#x = null; }
  #advance(x) { // empty files carry no chunks; their hash is the constant empty digest
    while (x.i < x.files.length && x.files[x.i].chunks === 0) { if (x.files[x.i].sha256 !== EMPTY) throw Error('File content does not match manifest'); x.bufs[x.i++] = new Uint8Array(0); }
  }
  async #accept(m) {
    try {
      if (m?.t === 'snapshot' && Array.isArray(m.files)) {
        this.#discard(); checkManifest(m);
        this.#x = { id: m.xfer, files: m.files, total: m.total, main: m.main ?? null, bufs: new Array(m.files.length).fill(null), i: 0, seq: 0 };
        this.#advance(this.#x); return null;
      }
      const x = this.#x;
      if (!x || m?.xfer !== x.id) throw Error('No matching transfer in progress');
      if (m.t === 'snapshot' && m.end === true) {
        if (x.i !== x.files.length) throw Error('Transfer incomplete');
        this.#x = null;                                   // ownership of the verified buffers passes to the caller
        return { files: new Map(x.files.map((file, i) => [file.path, x.bufs[i]])), main: x.main, total: x.total, xfer: x.id };
      }
      if (m.t !== 'file' || x.i >= x.files.length || m.i !== x.i || m.seq !== x.seq) throw Error('Out-of-order, repeated or unexpected chunk');
      const file = x.files[x.i], bytes = decode(m.data);
      if (bytes.length !== Math.min(CHUNK, file.size - x.seq * CHUNK)) throw Error('Chunk length does not match manifest');
      (x.bufs[x.i] ??= new Uint8Array(file.size)).set(bytes, x.seq * CHUNK);
      if (++x.seq === file.chunks) {
        const digest = await sha256(x.bufs[x.i]);
        if (this.#x !== x) throw Error('Transfer was cancelled');
        if (digest !== file.sha256) throw Error('File content does not match manifest');
        x.i++; x.seq = 0; this.#advance(x);
      }
      return null;
    } catch (error) { this.#discard(); throw error; }
  }
}

const sending = new WeakMap();                            // room -> peers with a transfer in flight
/** Validates the whole project first, then sends manifest, chunks and end marker through `send`. Resolves with the transfer id. */
export async function streamFiles(send, project) {
  const files = project?.files; if (!Array.isArray(files) || files.some(file => !(file?.bytes instanceof Uint8Array))) throw Error('Invalid project');
  const entries = await Promise.all(files.map(async file => ({ path: file.path, size: file.bytes.length, sha256: await sha256(file.bytes), chunks: Math.ceil(file.bytes.length / CHUNK) })));
  const manifest = { t: 'snapshot', xfer: randomId(), main: project.main ?? null, total: entries.reduce((n, e) => n + e.size, 0), files: entries };
  checkManifest(manifest);
  await send(manifest);
  for (let i = 0; i < files.length; i++) for (let seq = 0; seq < entries[i].chunks; seq++)
    await send({ t: 'file', xfer: manifest.xfer, i, seq, data: encode(files[i].bytes.subarray(seq * CHUNK, (seq + 1) * CHUNK)) });
  await send({ t: 'snapshot', xfer: manifest.xfer, end: true });
  return { xfer: manifest.xfer, files: entries };
}
/** Owner side: the whole project to one participant. project: {files:[{path, bytes}], main?} */
export const sendSnapshot = (room, peer, project) => streamFiles(m => room.sendTo(peer, m), project);
/** Plug into OwnerRoom onMessage: answers a participant's {t:'snapshot', req:true}; one transfer per peer at a time. Returns the send promise or null. */
export function handleSnapshotRequest(room, peer, message, getProject) {
  if (message?.t !== 'snapshot' || message.req !== true) return null;
  const busy = sending.get(room) ?? sending.set(room, new Set()).get(room);
  if (busy.has(peer)) return null;
  busy.add(peer);
  return Promise.resolve().then(() => sendSnapshot(room, peer, getProject())).finally(() => busy.delete(peer));
}

const parentOf = path => path.slice(0, Math.max(0, path.lastIndexOf('/')));
export const within = (path, root) => path === root || path.startsWith(root + '/');
/** Moves every key of `map` at or below `from` ('path' or 'path\0suffix') to `to` (null: deletes); returns the removed values. */
export const rekey = (map, from, to) => {
  const gone = [];
  for (const [key, value] of [...map]) {
    const cut = key.indexOf('\0'), path = cut < 0 ? key : key.slice(0, cut);
    if (!within(path, from)) continue;
    map.delete(key);
    if (to === null) gone.push(value); else map.set(to + key.slice(from.length), value);
  }
  return gone;
};
/**
 * S2-03 file tree during a session: the owner checks every structural change against this model before applying it, and
 * every participant replays the accepted changes on its own copy. Ops (paths are project paths):
 *   {kind:'folder'|'doc', path}   {kind:'put', path, size, doc}   {kind:'relocate', from, to}   {kind:'remove', from}   {kind:'main', path}
 * A put's bytes travel separately as a verified one-file transfer (streamFiles/SnapshotReceiver) named by the op's `xfer`.
 * Same rules as project-store.js: no overwrite, existing parent folder, the main file stays, one name per case-folded path.
 */
export class ProjectTree {
  #files = new Map(); #folders = new Set(); #keys = new Map(); #total = 0;
  constructor({ files = [], folders = [], main = null } = {}) {   // files: [{path, size}] or [path, size] pairs
    for (const entry of files) { const [path, size] = Array.isArray(entry) ? entry : [entry.path, entry.size]; this.#addFile(path, size); }
    for (const path of folders) this.#addFolder(path);
    this.main = main;
  }
  get paths() { return [...this.#files.keys()]; }
  get folders() { return [...this.#folders]; }
  isFile(path) { return this.#files.has(path); }
  #addFolder(path) { for (let p = path; p && !this.#folders.has(p); p = parentOf(p)) { this.#folders.add(p); this.#keys.set(pathKey(p), p); } }
  #addFile(path, size) { this.#files.set(path, size); this.#keys.set(pathKey(path), path); this.#total += size; if (parentOf(path)) this.#addFolder(parentOf(path)); }
  #free(path, self = null) { const at = this.#keys.get(pathKey(path)); if (at !== undefined && at !== self) throw Error('A file or folder with this name already exists'); }
  #parent(path) { const parent = parentOf(path); if (parent && !this.#folders.has(parent)) throw Error('The destination folder is missing'); }
  /** Returns a clean copy of `op` that apply() accepts, or throws a user-facing reason. Does not change the model. */
  check(op) {
    const kind = op?.kind, count = this.#files.size + this.#folders.size;
    if (['folder', 'doc', 'put'].includes(kind)) {
      if (!validPath(op.path)) throw Error('Invalid project path');
      this.#free(op.path);
      if (kind !== 'put') this.#parent(op.path);
      else for (let p = parentOf(op.path); p; p = parentOf(p)) { const at = this.#keys.get(pathKey(p)); if (at !== undefined && (at !== p || this.#files.has(p))) throw Error('A file or folder with this name already exists'); } // an upload creates its folders, as project-store.js does
      if (count >= MAX_FILES) throw Error('Project exceeds the supported file and folder limit');
      if (kind !== 'put') return { kind, path: op.path };
      if (!Number.isSafeInteger(op.size) || op.size < 0 || op.size > MAX_FILE || this.#total + op.size > MAX_TOTAL) throw Error('File size outside limits');
      if (typeof op.doc !== 'boolean') throw Error('Invalid uploaded file');
      return { kind, path: op.path, size: op.size, doc: op.doc };
    }
    if (kind === 'main') { if (!this.#files.has(op.path)) throw Error('Choose an existing text main document'); return { kind, path: op.path }; }
    if (kind !== 'relocate' && kind !== 'remove') throw Error('Unknown file change');
    if (!validPath(op.from) || (!this.#files.has(op.from) && !this.#folders.has(op.from))) throw Error('The file or folder is missing');
    if (kind === 'remove') { if (this.main && within(this.main, op.from)) throw Error('Choose another main document before deleting this one'); return { kind, from: op.from }; }
    if (!validPath(op.to) || within(op.to, op.from)) throw Error('Choose a different valid destination outside this folder');
    this.#free(op.to, op.from); this.#parent(op.to);
    return { kind, from: op.from, to: op.to };
  }
  /** Applies a checked op; returns the [from, to] path pairs it moved or removed (to = null). */
  apply(op) {
    if (op.kind === 'main') { this.main = op.path; return []; }
    if (op.kind === 'folder') { this.#addFolder(op.path); return []; }
    if (op.kind === 'doc' || op.kind === 'put') { this.#addFile(op.path, op.kind === 'put' ? op.size : 0); return []; }
    const moved = [], target = path => op.kind === 'remove' ? null : op.to + path.slice(op.from.length);
    for (const [path, size] of [...this.#files]) if (within(path, op.from)) { moved.push([path, target(path)]); this.#files.delete(path); this.#keys.delete(pathKey(path)); this.#total -= size; if (op.kind === 'relocate') this.#addFile(target(path), size); }
    for (const path of [...this.#folders]) if (within(path, op.from)) { this.#folders.delete(path); this.#keys.delete(pathKey(path)); if (op.kind === 'relocate') this.#addFolder(target(path)); }
    if (op.kind === 'relocate') { this.#addFolder(parentOf(op.to)); if (this.main && within(this.main, op.from)) this.main = target(this.main); }
    return moved;
  }
}
