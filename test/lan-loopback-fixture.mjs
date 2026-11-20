// SPDX-License-Identifier: AGPL-3.0-only
// Loopback-only fixture for the LAN checks: the real relay helper, an owner in this process and every participant in its own
// isolated "profile" (a separate Node process with its own empty HOME/TMPDIR/cwd and no shared memory). Synthetic projects only.
// Entry points are loaded from LAN_REPO (default: this repository) so one harness can test the transport and permission branches.
import { spawn, fork } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

export const ORIGIN = 'chrome-extension://oekjjadnainlmdbgbdjokegaikafafke';
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const until = async (check, what = 'condition', ms = 15000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) throw Error('Timed out: ' + (typeof what === 'function' ? what() : what)); await sleep(20); } };
export const repoRoot = process.env.LAN_REPO || join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- OT: TEST DOUBLE with ShareJS text semantics ({p,i}/{p,d}, positions in UTF-16 units, server wins ties) -------------------
// The production editor's sharejs-text-ot is not importable here; the same double is validated in test/lan-sync.test.mjs.
const isInt = n => Number.isSafeInteger(n) && n >= 0;
function apply(text, ops) {
  for (const c of ops) {
    if (!isInt(c.p) || c.p > text.length) throw Error('Position out of range');
    if (c.i !== undefined) text = text.slice(0, c.p) + c.i + text.slice(c.p);
    else { if (text.slice(c.p, c.p + c.d.length) !== c.d) throw Error('Delete does not match the text'); text = text.slice(0, c.p) + text.slice(c.p + c.d.length); }
  }
  return text;
}
const T = (c, o, side) => {
  if (c.i !== undefined) {
    if (o.i !== undefined) return [c.p < o.p || (c.p === o.p && side === 'left') ? c : { i: c.i, p: c.p + o.i.length }];
    if (c.p <= o.p) return [c];
    if (c.p >= o.p + o.d.length) return [{ i: c.i, p: c.p - o.d.length }];
    return [{ i: c.i, p: o.p }];
  }
  if (o.i !== undefined) {
    if (c.p >= o.p) return [{ d: c.d, p: c.p + o.i.length }];
    if (c.p + c.d.length > o.p) { const k = o.p - c.p; return [{ d: c.d.slice(0, k), p: c.p }, { d: c.d.slice(k), p: c.p + o.i.length }]; }
    return [c];
  }
  if (c.p >= o.p + o.d.length) return [{ d: c.d, p: c.p - o.d.length }];
  if (c.p + c.d.length <= o.p) return [c];
  let d = ''; if (c.p < o.p) d = c.d.slice(0, o.p - c.p); if (c.p + c.d.length > o.p + o.d.length) d += c.d.slice(o.p + o.d.length - c.p);
  return d ? [{ d, p: Math.min(c.p, o.p) }] : [];
};
const xList = (A, B) => {
  if (!A.length || !B.length) return [A, B];
  if (A.length > 1) { const [a0, B1] = xList([A[0]], B), [rest, B2] = xList(A.slice(1), B1); return [[...a0, ...rest], B2]; }
  if (B.length > 1) { const [A1, b0] = xList(A, [B[0]]), [A2, rest] = xList(A1, B.slice(1)); return [A2, [...b0, ...rest]]; }
  return [T(A[0], B[0], 'right'), T(B[0], A[0], 'left')];
};
export const ot = { apply, transformX: xList };
export const invert = ops => ops.map(c => c.i !== undefined ? { p: c.p, d: c.i } : { p: c.p, i: c.d }).reverse();
/** UTF-16 offsets of code-point boundaries: an edit placed on one never splits a surrogate pair. */
export const boundaries = text => { const o = [0]; let i = 0; for (const ch of text) { i += ch.length; o.push(i); } return o; };

// ---- entry points ---------------------------------------------------------------------------------------------------------------
const REQUIRED = [['lan-room', ['OwnerRoom', 'joinRoom']], ['lan-sync', ['OwnerSync', 'ParticipantSync']],
  ['lan-transfer', ['sendSnapshot', 'handleSnapshotRequest', 'SnapshotReceiver']], ['lan-session-store', ['SessionStore', 'connectStore']],
  ['lan-host', ['startHost']], ['lan-guest', ['joinSession']], ['lan-ot', ['ot']], ['lan-grants', ['GrantAuthority', 'GrantGate']]];
/** Imports each module from `repo`; a missing file or export is listed in `missing` as `file.mjs#name` (never mocked). */
export async function loadEntries(repo = repoRoot) {
  const entries = { repo, missing: [], modules: {} };
  for (const [file, names] of REQUIRED) {
    let module = null;
    try { module = await import(pathToFileURL(`${repo}/runtime/chrome-extension/${file}.mjs`).href); }
    catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
    entries.modules[file] = module;
    for (const name of names) if (module?.[name] === undefined) entries.missing.push(`${file}.mjs#${name}`);
  }
  return entries;
}

// ---- real relay helper (native messaging protocol over stdio), bound to 127.0.0.1 only ------------------------------------------
export function startHelper(binary) {
  if (!binary) throw Error('Set LATEX_LAN_HELPER to a built latex-local-lan binary (cargo build --offline --manifest-path runtime/chrome-extension/lan/Cargo.toml)');
  const child = spawn(binary, [`${ORIGIN}/`], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buffer = Buffer.alloc(0), next = 1;
  const pending = new Map(), listeners = new Set();
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const message = JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE(0)));
      buffer = buffer.subarray(4 + buffer.readUInt32LE(0));
      if (message.id) { const { resolve, reject } = pending.get(message.id); pending.delete(message.id); message.error ? reject(Error(message.error)) : resolve(message.result); }
      else for (const listener of listeners) listener(message);
    }
  });
  child.stdin.on('error', () => {});             // a killed helper (host loss) must not crash the harness
  const write = value => { const body = Buffer.from(JSON.stringify(value)), head = Buffer.alloc(4); head.writeUInt32LE(body.length); child.stdin.write(Buffer.concat([head, body])); };
  const call = (op, args = {}) => new Promise((resolve, reject) => { const id = next++; pending.set(id, { resolve, reject }); write({ id, op, ...args }); });
  return { child, call, write, listeners, exited: new Promise(resolve => child.on('exit', code => resolve(code))) };
}

/**
 * Owner profile in this process. `project` ({files:[{path,bytes}], main}) is served to {t:'snapshot',req:true}; every other
 * authorized request goes to OwnerSync. `seen` lists what actually reached the application (denied requests never do).
 */
export async function startOwner(entries, { binary = process.env.LATEX_LAN_HELPER, text = '', project = null } = {}) {
  const { OwnerRoom } = entries.modules['lan-room'], helper = startHelper(binary), seen = [];
  const sync = entries.modules['lan-sync'] ? new entries.modules['lan-sync'].OwnerSync({ room: null, ot: entries.modules['lan-ot']?.ot ?? ot, text }) : null;   // both sides must use one OT
  const transfer = entries.modules['lan-transfer'];
  const room = new OwnerRoom({
    send: (peer, bytes) => helper.write({ op: 'send', peer, data: Buffer.from(bytes).toString('base64') }),
    admit: peer => helper.call('admit', { peer }).catch(() => {}),
    drop: peer => helper.call('drop', { peer }).catch(() => {}),
    onMessage: (peer, message, name) => {
      seen.push({ peer, name, t: message.t });
      if (project && message.t === 'snapshot' && message.req === true) { transfer.handleSnapshotRequest(room, peer, message, () => project)?.catch(() => {}); return; }
      return sync?.handle(peer, message, name);
    },
  });
  if (sync) sync.room = room;
  helper.listeners.add(event => {
    if (event.ev === 'peer') room.connected(event.peer);
    if (event.ev === 'data') room.receive(event.peer, new Uint8Array(Buffer.from(event.data, 'base64')));
    if (event.ev === 'gone') room.disconnected(event.peer);
  });
  const { port } = await helper.call('open', { bind: '127.0.0.1', port: 0, room: room.roomId });
  return ownerShell({ room, sync, seen, helper, port, repo: entries.repo });
}
/** What every owner variant offers the tests: its participant profiles, names, peers and an orderly stop. */
function ownerShell(owner) {
  Object.assign(owner, { profiles: [], url: `ws://127.0.0.1:${owner.port}/r/${owner.room.roomId}`, passcode: owner.room.passcode,
    names: () => owner.room.participants.map(p => p.name),
    peerOf: name => owner.room.participants.find(p => p.name === name)?.peer,
    /** A participant process in its own empty profile directory; `mode` joins at once ('text', 'store' or 'guest'). */
    async profile(name, mode, options = {}) { const p = spawnProfile(name, owner.repo); owner.profiles.push(p); if (mode) await p.join(owner, mode, options); return p; },
    async cleanup() {
      for (const p of owner.profiles) p.cleanup();
      await Promise.race([owner.helper.exited, sleep(3000)]); owner.helper.child.kill();
    } });
  owner.stop ??= async () => {
    await owner.room.stop().catch(() => {}); await Promise.race([owner.helper.call('close').catch(() => {}), sleep(500)]); owner.helper.child.stdin.end(); await owner.cleanup();
  };
  return owner;
}

/**
 * The native stack (lan-host.mjs startHost) on the real helper, serving `files` ({path: text}) to guests that use lan-guest.mjs joinSession.
 * The owner's own editor is `own(path)`; `persisted` records what the host mirrored back to the source.
 */
export async function startStack(entries, { files, binary = process.env.LATEX_LAN_HELPER, permission } = {}) {
  const helper = startHelper(binary), store = new Map(Object.entries(files).map(([path, content]) => [path, { content, revision: 3 }])), persisted = [], cursors = [], editors = {};
  const adapter = { call: helper.call, send: message => helper.write(message), subscribe: listener => { helper.listeners.add(listener); return () => helper.listeners.delete(listener); }, close() {} };
  const source = { tree: () => ({ main: Object.keys(files)[0], docs: [...store.keys()], files: [...store].map(([path, f]) => ({ path, bytes: new TextEncoder().encode(f.content) })) }),
    text: path => store.has(path) ? { text: store.get(path).content, version: store.get(path).revision } : null, persist: (path, text) => persisted.push([path, text]) };
  const host = await entries.modules['lan-host'].startHost({ helper: adapter, source, permission, onRemote: (path, e) => editors[path]?.remote(e.op, e.v), onCursor: c => cursors.push(c) });
  const ot = entries.modules['lan-ot'].ot;
  return ownerShell({ host, room: host.room, port: host.port, link: host.link, helper, persisted, cursors, repo: entries.repo,
    own: path => (editors[path] = new Editor(host, path, host.join(path), ot)), seen: [],
    async stop() { await host.stop().catch(() => {}); helper.child.stdin.end(); await this.cleanup(); } });
}

/**
 * The native editor's client model (as in lan-native.test.mjs): local ops transform against remote ones (client = left), one op in
 * flight, and an undo stack whose inverses are kept valid by transforming them over every later local and remote operation.
 */
export class Editor {
  #undo = [];
  constructor(ctl, path, state, ot) { Object.assign(this, { ctl, path, ot, text: state.text, version: state.v, inflight: null, pending: [], acks: 0, error: null }); }
  #advance(op) { for (const entry of this.#undo) entry.op = this.ot.transformX(entry.op, op)[0]; }
  submit(op, record = true) {
    this.text = this.ot.apply(this.text, op); this.#advance(op);
    if (record) this.#undo.push({ op: invert(op) });
    this.pending.push(op); this.#pump();
  }
  undo() { const entry = this.#undo.pop(); if (!entry) throw Error('Nothing to undo'); this.submit(entry.op, false); }
  remote(op, v) {
    if (v !== this.version) throw Error('remote update out of order');
    if (this.inflight) [this.inflight, op] = this.ot.transformX(this.inflight, op);
    this.pending = this.pending.map(p => { let q; [q, op] = this.ot.transformX(p, op); return q; });
    this.text = this.ot.apply(this.text, op); this.#advance(op); this.version++;
  }
  #pump() {
    if (this.inflight || !this.pending.length) return;
    this.inflight = this.pending.shift();
    this.ctl.edit(this.path, { op: this.inflight, v: this.version }).then(applied => {
      if (applied !== this.version) throw Error('acknowledgement version');
      this.version++; this.inflight = null; this.acks++; this.#pump();
    }).catch(error => { this.error = error.message; });
  }
  get idle() { return !this.inflight && !this.pending.length; }
  view() { return { text: this.text, version: this.version, idle: this.idle, acks: this.acks, error: this.error }; }
}
export const PIECES = ['a', 'Türkçe', '😀', 'ß', '\n', '𝔛y', 'ж', '🇹🇷', '👨‍👩‍👧', 'e\u0301'];
/** One seeded random insert or delete on code-point boundaries (editors never split a surrogate pair); undo on `undoChance`. */
export function randomEdit(editor, random, undoChance = 0) {
  if (random() < undoChance) { try { editor.undo(); return 'undo'; } catch { /* nothing to undo yet: edit instead */ } }
  const chars = [...editor.text], index = Math.floor(random() * (chars.length + 1)), at = chars.slice(0, index).join('').length;
  if (random() < 0.6 || !chars.length) editor.submit([{ p: at, i: PIECES[Math.floor(random() * PIECES.length)] }]);
  else { const i = Math.min(index, chars.length - 1); editor.submit([{ p: chars.slice(0, i).join('').length, d: chars.slice(i, i + 1 + Math.floor(random() * 3)).join('') }]); }
  return 'edit';
}
export const mulberry = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

// ---- participant profiles --------------------------------------------------------------------------------------------------------
export function spawnProfile(name, repo = repoRoot) {
  const dir = mkdtempSync(join(tmpdir(), 'lan-profile-')), child = fork(join(dirname(fileURLToPath(import.meta.url)), 'lan-loopback-profile.mjs'), [],
    { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, LAN_REPO: repo }, execArgv: [] });
  const pending = new Map(); let next = 1, dead = false;
  child.on('message', ({ id, error, result }) => { const p = pending.get(id); pending.delete(id); if (p) error ? p.reject(Error(error)) : p.resolve(result); });
  child.on('exit', () => { dead = true; for (const p of pending.values()) p.reject(Error('Profile process exited')); pending.clear(); });
  const call = (op, args = {}) => new Promise((resolve, reject) => {
    if (dead) return reject(Error('Profile process exited'));
    const id = next++, timer = setTimeout(() => { pending.delete(id); reject(Error(`Profile call ${op} timed out`)); }, 20000);
    pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } }); child.send({ id, op, ...args });
  });
  return { name, dir, call,
    join: (owner, mode, options = {}) => call('connect', { url: owner.url, link: owner.link, roomId: owner.room.roomId, passcode: owner.passcode, username: name, mode, ...options }),
    kill: () => { dead = true; child.kill('SIGKILL'); },
    files: () => readdirSync(dir),            // a profile must stay empty: nothing is persisted outside the process
    cleanup() { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); } };
}

/** Raw TCP WebSocket client for frames or handshakes a browser would never send. */
export function rawSocket(port, path, origin = ORIGIN) {
  const socket = net.connect(port, '127.0.0.1'), state = { socket, data: Buffer.alloc(0), closed: false };
  socket.on('data', chunk => { state.data = Buffer.concat([state.data, chunk]); }); socket.on('close', () => { state.closed = true; }); socket.on('error', () => {});
  socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`);
  return state;
}
/** One masked binary frame (client frames must be masked). */
export function maskedFrame(payload) {
  const mask = randomBytes(4), n = payload.length, head = n < 126 ? Buffer.from([0x82, 0x80 | n]) : n < 65536 ? Buffer.from([0x82, 0xfe, n >> 8, n & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x82; h[1] = 0xff; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
  return Buffer.concat([head, mask, Buffer.from(payload.map((b, i) => b ^ mask[i & 3]))]);
}
