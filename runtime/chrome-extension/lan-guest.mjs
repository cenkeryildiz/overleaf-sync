// SPDX-License-Identifier: AGPL-3.0-only
// Participant side of "Share on this network": WebSocket + sealed room session (lan-session-store.mjs) + the document and
// cursor requests that lan-host.mjs serves. Everything stays in memory; ending the session wipes the project store.
// A lost connection wipes it too: a rejoin transfers the project again, so only unacknowledged edits outlive the loss.
import { connectStore } from './lan-session-store.mjs';
import { parseJoinLink, validUsername } from './lan-room.mjs';
import { GrantGate, saveStandaloneCopy, exportCopy, copyResources } from './lan-grants.mjs';
import { apply, invert, diff } from './lan-ot.mjs';

const randomHex = bytes => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');
const TIMEOUT = 15000, HOLD = 5000;
/** Bounded automatic rejoin after a lost connection (about 30 s in all); then the participant rejoins or leaves explicitly. */
export const RETRIES = Object.freeze([1000, 2000, 4000, 8000, 15000]);
const macrotask = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Opens the socket, joins with the passcode and username, receives the verified project. Resolves with the controller
 * the native adapter uses: join(path) -> {text, v}, edit(path, {op, v}) -> version, cursor(c), leave(), plus `store`, `docs`, `gate`.
 * Handlers: onRemote(path, {op, v, by}), onCursor({name, path, row, column}), onEnd(reason), onGrant(grant), onPresence(names),
 * onLost(reason, {retrying}), onResumed(conflicts).
 *
 * S2-05 host loss: editing locks (onLost), unacknowledged edits stay in this closure only, and a rejoin to the same room
 * (resume token from the last welcome) replays the owner's log after the last known version: own entries acknowledge the
 * pending edit with its original id (cid.n), so an edit applied before the loss never applies twice; unsent edits are then
 * resent with their ids and the owner transforms them. A new room or a log that no longer covers us is reported in
 * onResumed(conflicts); `reconcile` below settles those explicitly. Revoke, stop and leave end everything.
 */
export async function joinSession({ link, passcode, username, onRemote = () => {}, onCursor = () => {}, onEnd = () => {}, onGrant = () => {}, onPresence = () => {},
  onLost = () => {}, onResumed = () => {}, retries = RETRIES, WebSocketImpl = globalThis.WebSocket }) {
  let target = parseJoinLink(link), current = link, code = passcode; // the passcode stays in this closure for the bounded rejoin; never logged or stored
  const name = validUsername(username), cid = randomHex(16), waiting = new Map(), cursors = new Map(), files = new Map(), byKey = new Map(), counters = new Map();
  let conn = null, state = 'joining', token = null, timer = null, syncs = 0, conflicts = [];
  const settle = (key, ok, value) => { const w = waiting.get(key); if (w) { waiting.delete(key); ok ? w.resolve(value) : w.reject(value instanceof Error ? value : Error(String(value))); } };
  const failAll = reason => { for (const key of [...waiting.keys()]) settle(key, false, Error(reason)); };
  const wait = key => new Promise((resolve, reject) => {
    const clock = setTimeout(() => settle(key, false, Error('The owner did not answer')), TIMEOUT);
    waiting.set(key, { resolve: value => { clearTimeout(clock); resolve(value); }, reject: error => { clearTimeout(clock); reject(error); } });
  });
  // ---- outstanding edits: o = {path, n, id, key, base, ops, resolve, reject}; one list per file, in submission order
  const ready = f => conn && !conn.dead && !f.hold && !f.stale && !f.syncing; // per file: a released file sends while others still catch up
  const transmit = o => conn.session.send({ t: 'update', k: 'op', path: o.path, cid, n: o.n, base: o.base, ops: o.ops, ref: o.key }).catch(() => {}); // a lost send is resent on rejoin
  const finish = (o, value, error) => {
    byKey.delete(o.key); const f = files.get(o.path); if (f) f.out = f.out.filter(x => x !== o);
    if (error) { if (counters.get(o.path) === o.n) counters.set(o.path, o.n - 1); o.reject(error); } else o.resolve(value); // the owner did not consume a refused op id
  };
  const name_ = (o, n) => { byKey.delete(o.key); Object.assign(o, { n, id: `${cid}.${n}`, key: `${o.path}\0${cid}.${n}` }); byKey.set(o.key, o); };
  // ---- the owner's log for one file, in order: own entries acknowledge, others go to the editor
  const step = (path, f, e) => {
    f.known = e.v;
    if (e.id.startsWith(cid + '.')) { const o = byKey.get(`${path}\0${e.id}`); if (o) finish(o, e.v - 1 - f.off); return true; }
    onRemote(path, { op: e.ops, v: e.v - 1 - f.off, by: e.by }); return false;
  };
  const entry = (path, e) => {
    const f = files.get(path);
    if (!f || f.stale || !Number.isSafeInteger(e.v) || e.v <= f.known) return;
    if (f.hold) { if (f.hold.length < HOLD) f.hold.push(e); else f.overflow = true; return; }
    if (e.v !== f.known + 1) { f.hold = [e]; sync(path); return; } // a gap: catch up from the log
    step(path, f, e);
  };
  const release = (path, f) => { const held = f.hold ?? []; f.hold = null; for (const e of held) entry(path, e); for (const o of f.out) transmit(o); };
  const resumed = () => { if (--syncs > 0) return; syncs = 0; state = 'live'; onResumed(conflicts.splice(0)); };
  const conflict = path => { const f = files.get(path); Object.assign(f, { syncing: false, stale: true, hold: null }); conflicts.push(path); resumed(); };
  function sync(path) {
    const f = files.get(path); f.syncing = true; f.hold ??= []; f.replay = Promise.resolve(); syncs++;
    conn.session.send({ t: 'update', k: 'sync', path, cid, base: f.known }).catch(() => {});
  }
  function page(m) {
    const f = files.get(m.path);
    if (!f?.syncing || !Array.isArray(m.entries)) return;
    f.replay = f.replay.then(async () => {
      for (const e of m.entries) {
        if (!f.syncing) return;
        if (!e || !Number.isSafeInteger(e.v) || typeof e.id !== 'string' || (!e.id.startsWith(cid + '.') && !Array.isArray(e.ops))) return conflict(m.path);
        if (e.v <= f.known) continue;
        if (e.v !== f.known + 1) return conflict(m.path);
        if (step(m.path, f, e)) await macrotask(); // the editor takes the acknowledgement before the next remote edit
      }
      if (m.done && f.syncing) { f.syncing = false; release(m.path, f); resumed(); }
    });
  }
  const onMessage = c => m => {
    if (c.dead || c.gate.receive(m)) return; // grant key, tickets and the denials that answer a ticket request
    if (m.t === 'tree') { if (!c.docs && Array.isArray(m.docs) && m.docs.length <= 1000 && m.docs.every(p => typeof p === 'string')) c.docs = new Set(m.docs); return; }
    if (c !== conn) return; // replies to a connection still being opened; the rejoin catches up from the log
    switch (m.t) {
      case 'doc': if (typeof m.path === 'string' && typeof m.text === 'string' && Number.isSafeInteger(m.v)) settle(`join\0${m.path}`, true, { text: m.text, v: m.v }); break;
      case 'ack': { const o = byKey.get(`${m.path}\0${m.id}`), f = files.get(m.path); if (o && f && Number.isSafeInteger(m.v)) { f.known = Math.max(f.known, m.v); finish(o, m.v - 1 - f.off); } break; }
      case 'refused': {
        const o = m.id && byKey.get(`${m.path}\0${m.id}`);
        if (o) finish(o, null, Error(`Refused by the owner (${m.reason})`));
        else if (!m.id && files.get(m.path)?.syncing) conflict(m.path); // the log no longer covers us
        else settle(`join\0${m.path}`, false, Error(`Refused by the owner (${m.reason})`));
        break;
      }
      case 'denied': { const o = byKey.get(String(m.ref)); if (o) finish(o, null, Error('The owner has not allowed this action')); else settle(String(m.ref), false, Error('The owner has not allowed this action')); break; }
      case 'remote': if (typeof m.id === 'string' && !m.id.startsWith(cid + '.') && Array.isArray(m.ops)) entry(m.path, m); break;
      case 'sync': page(m); break;
      case 'presence': if (Array.isArray(m.names) && m.names.length <= 64) onPresence(m.names.filter(n => typeof n === 'string' && n !== name)); break;
      case 'cursor': if (typeof m.name === 'string' && typeof m.path === 'string') { const c = { name: m.name, path: m.path, row: m.row, column: m.column }; cursors.set(m.name, c); onCursor(c); } break;
    }
  };
  /** One authenticated connection with a freshly transferred project; nothing is adopted until it is complete. */
  async function open(t, pass, resume) {
    const c = { gate: new GrantGate({ roomId: t.roomId, name }), docs: null, dead: false };
    let project; const transfer = new Promise((resolve, reject) => { project = { resolve, reject }; }); transfer.catch(() => {});
    const socket = new WebSocketImpl(t.url); socket.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(Error('Cannot reach the owner at this link')); });
    Object.assign(c, connectStore({
      roomId: t.roomId, passcode: pass, username, resume, send: bytes => socket.send(bytes), close: () => socket.close(), onMessage: onMessage(c),
      onGrant: g => { c.gate.observeGrant(g); if (c === conn) onGrant(g); }, onProject: p => project.resolve(p), onTransferError: e => project.reject(e),
      onEnd: (reason, final) => { project.reject(Error(reason)); lost(c, reason, final); },
    }));
    socket.onmessage = event => c.session.receive(new Uint8Array(event.data));
    socket.onclose = () => c.session.closed();
    let clock; const timeout = new Promise((_, reject) => { clock = setTimeout(() => reject(Error('The owner did not answer')), TIMEOUT); }); timeout.catch(() => {});
    try {
      c.welcome = await Promise.race([c.session.joined, timeout]);
      c.gate.observeGrant(c.welcome.grant);
      await c.requestSnapshot();
      await Promise.race([transfer, timeout]);
      if (!c.docs) throw Error('The owner sent an incomplete project');
      return c;
    } catch (error) { c.dead = true; c.session.leave(); c.store.wipe(); socket.close(); throw error; }
    finally { clearTimeout(clock); }
  }
  const adopt = c => { conn = c; token = c.welcome.resume; c.gate.installStorageGuard(); };
  function end(reason) {
    if (state === 'ended') return; state = 'ended'; clearTimeout(timer);
    conn.gate.end(); conn.store.wipe(); failAll(reason);
    for (const o of [...byKey.values()]) finish(o, null, Error(reason));
    onEnd(reason);
  }
  function lost(c, reason, final) {
    if (c.dead) return; c.dead = true; c.gate.end();
    if (c !== conn || state === 'ended') return;
    if (final) return end(reason);
    state = 'lost'; syncs = 0; conflicts = []; failAll(reason);
    for (const f of files.values()) Object.assign(f, { syncing: false, hold: null });
    onLost(reason, { retrying: retries.length > 0 }); retry(0, reason);
  }
  function retry(i, reason) {
    clearTimeout(timer);
    if (i >= retries.length) { if (state === 'lost') onLost(reason, { retrying: false }); return; }
    timer = setTimeout(() => rejoin().catch(error => { if (state === 'lost') retry(i + 1, error.message); }), retries[i]);
  }
  /** Rejoin after a loss: the same link resumes (passcode kept in memory); another link is a new room and every open file is a conflict. */
  async function rejoin({ link: next, passcode: pass } = {}) {
    if (state === 'ended') throw Error('This session has ended');
    if (state !== 'lost') throw Error(state === 'rejoining' ? 'Already reconnecting' : 'Still connected');
    const t = next ? parseJoinLink(next) : target, same = t.url === target.url;
    clearTimeout(timer); state = 'rejoining';
    let c;
    try { c = await open(t, pass || code, same ? token : undefined); }
    catch (error) { state = 'lost'; if (error.code === 'resume') end('The owner removed you from this session'); throw error; }
    if (state === 'ended') { c.dead = true; c.session.leave(); throw Error('This session has ended'); } // left while reconnecting
    adopt(c); target = t; current = next || current; code = pass || code;
    onGrant(c.welcome.grant);
    if (!same) { counters.clear(); for (const f of files.values()) Object.assign(f, { stale: true, hold: null }); conflicts = [...files.keys()]; }
    syncs = 1; // released by resumed() below once every file has caught up
    for (const [path, f] of files) if (!f.stale) { if (c.docs.has(path)) sync(path); else conflicts.push(path), f.stale = true; }
    resumed();
  }
  async function request(path) {
    if (state !== 'live') throw Error('Not connected');
    if (!conn.docs.has(path)) throw Error('Not a shared text file');
    const ref = `join\0${path}`, answer = wait(ref);
    answer.catch(() => {}); await conn.session.send({ t: 'update', k: 'join', path, ref }).catch(error => { settle(ref, false, error); throw error; });
    return answer;
  }
  try {
    adopt(await open(target, code));
    state = 'live';
  return {
      cid, name, get state() { return state; }, get link() { return current; }, get store() { return conn.store; }, get session() { return conn.session; },
      get docs() { return conn.docs; }, get gate() { return conn.gate; }, get main() { return conn.store.main; }, get grant() { return conn.session.grant; },
      participants: conn.welcome.participants,
      /** Current text/version of one shared text file; later remote edits to it are delivered through onRemote. */
      async join(path) {
        const s = await request(path);
        files.set(path, { known: s.v, off: 0, out: [], hold: null, stale: false, syncing: false });
        return s;
      },
      leaveDoc: path => files.delete(path),
      /** Resolves with the version the editor must report as applied, or null when reconciliation dropped the edit. */
      edit(path, update) {
        const f = files.get(path);
        if (!f || state === 'ended') return Promise.reject(Error('Not connected'));
        let base = update.v + f.off, ops = update.op;
        if (update.v < f.floor) { // queued before a reconciliation: the editor's own op was already replaced or dropped there
          const x = f.expect; f.expect = undefined; if (!x) return Promise.resolve(null); ({ base, ops } = x);
        }
        const n = (counters.get(path) ?? 0) + 1; counters.set(path, n);
        return new Promise((resolve, reject) => {
          const o = { path, n, id: `${cid}.${n}`, key: `${path}\0${cid}.${n}`, base, ops, resolve, reject };
          byKey.set(o.key, o); f.out.push(o);
          if (ready(f)) transmit(o);
        });
      },
      cursor: ({ path, row, column }) => state === 'live' ? conn.session.send({ t: 'cursor', path, row, column }).catch(() => {}) : Promise.resolve(),
      cursors: () => [...cursors.values()],
      rejoin,
      /** The owner's current text for a conflicted file; its remote edits are held until rebase(). */
      async adopt(path) {
        const s = await request(path), f = files.get(path) ?? { off: 0, out: [], syncing: false };
        files.set(path, Object.assign(f, { known: s.v, hold: [], overflow: false, stale: false, floor: undefined, expect: undefined }));
        return s;
      },
      /** Keep a conflicted file aside (no remote edits) until the participant chooses. */
      park(path) { const f = files.get(path); if (f) Object.assign(f, { hold: null, stale: true }); },
      /** After adopt(): the editor now stands at version v; `op` is its in-flight edit to resend, or null to drop it. */
      rebase(path, { v, op }) {
        const f = files.get(path);
        if (!f?.hold || f.overflow) throw Error('The owner changed this file meanwhile; choose again');
        f.off = f.known - v; f.floor = v;
        const [first, ...rest] = f.out;
        for (const o of rest) finish(o, null); // shortcut: the native client has one edit in flight; extra ones would be dropped here
        if (first && op) { name_(first, (counters.get(path) ?? 0) + 1); counters.set(path, first.n); Object.assign(first, { base: f.known, ops: op }); }
        else if (first) finish(first, null);
        else f.expect = op ? { base: f.known, ops: op } : null;
        release(path, f);
      },
      forget(path) { const f = files.get(path); if (!f) return; for (const o of [...f.out]) finish(o, null); files.delete(path); },
      leave: () => { if (state === 'live') conn.session.leave(); else end('You left the session'); },
      /** Owner-permitted, explicit copies. `save(copy)` must create the standalone project (overleafLocalProjects.local); file export gets the released copy. */
      saveCopy: save => saveStandaloneCopy({ gate: conn.gate, store: conn.store, send: m => conn.session.send(m), save: copy => save(copyResources(copy), copy) }),
      exportCopy: kind => exportCopy({ gate: conn.gate, store: conn.store, send: m => conn.session.send(m), kind }),
    };
  } catch (error) { if (conn) { conn.dead = true; conn.session.leave(); conn.store.wipe(); } throw error; }
}

/**
 * Explicit reconciliation of one open document after an unsafe rejoin (a new room, or a log that no longer reaches back).
 * doc is the editor's ShareJS document (getSnapshot/getVersion/getInflightOp/getPendingOp/clearInflightAndPendingOps);
 * deliver(op, v) hands it an owner op. The owner's text is never replaced: its changes since our base reach the editor as one
 * op that the editor's own OT applies under the unsent edits ('keep'), or the unsent edits are dropped ('discard').
 * 'auto' succeeds only when nothing can be lost (the owner's text is unchanged, or there is nothing unsent); otherwise false.
 */
export async function reconcile(ctl, path, doc, deliver, choice = 'auto') {
  const mine = doc.getSnapshot(), base = [doc.getPendingOp(), doc.getInflightOp()].reduce((text, op) => op?.length ? apply(text, invert(op)) : text, mine);
  const host = await ctl.adopt(path);
  if (choice === 'auto' && mine !== base && host.text !== base) { ctl.park(path); return false; }
  if (choice === 'discard') doc.clearInflightAndPendingOps();
  const op = diff(choice === 'discard' ? mine : base, host.text);
  let v = doc.getVersion();
  if (op.length) { deliver(op, v); v++; }
  ctl.rebase(path, { v, op: choice === 'discard' ? null : doc.getInflightOp() ?? null });
  return true;
}

/**
 * A memory-only stand-in for the local project store (project-store.js) so the native adapter can run unchanged on a shared
 * project: reads and saves touch only the session store; everything else the offline store offers is refused.
 */
export async function memoryProjects(shared, template) {
  const workspace = crypto.randomUUID(), account = randomHex(12), docIds = new Map([...shared.docs].map(path => [path, randomHex(12)]));
  const revisions = new Map();
  const encode = bytes => { let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(text); };
  const refuse = async () => { throw Error('This is not available in a shared session'); };
  const project = { id: workspace, account, project: randomHex(12), main: shared.store.has(shared.main) ? shared.main : shared.store.paths()[0], compiler: 'pdflatex', pdf: null, folders: [],
    name: 'Shared project', localOnly: true, native: { ...template, projectMeta: {} } };
  const file = path => docIds.has(path)
    ? { path, workspace, doc: docIds.get(path), content: shared.store.readText(path), revision: revisions.get(path) ?? 0 }
    : { path, workspace, data: encode(shared.store.read(path)), revision: 0 };
  return {
    project, docIds,
    api: Object.freeze({
      read: async () => ({ project, files: shared.store.paths().map(file) }),
      save: async (current, text) => {
        if (!docIds.has(current.path) || (revisions.get(current.path) ?? 0) !== current.revision) throw Error('Another change replaced this file');
        shared.store.write(current.path, text); revisions.set(current.path, current.revision + 1);
        return { ...current, content: text, revision: current.revision + 1 };
      },
      create: refuse, list: refuse, output: refuse, blank: refuse, local: refuse, add: refuse, change: refuse, viewPdf: refuse,
    }),
  };
}
