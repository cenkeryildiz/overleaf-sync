// SPDX-License-Identifier: AGPL-3.0-only
// Participant side of "Share on this network": WebSocket + sealed room session (lan-session-store.mjs) + the document and
// cursor requests that lan-host.mjs serves. Everything stays in memory; ending the session wipes the project store.
import { connectStore } from './lan-session-store.mjs';
import { parseJoinLink, validUsername } from './lan-room.mjs';
import { GrantGate, saveStandaloneCopy, exportCopy, copyResources } from './lan-grants.mjs';
import { ProjectTree, SnapshotReceiver, streamFiles, rekey, within } from './lan-transfer.mjs';

const randomHex = bytes => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');
const TIMEOUT = 15000;

/**
 * Opens the socket, joins with the passcode and username, receives the verified project. Resolves with the controller
 * the native adapter uses: join(path) -> {text, v}, edit(path, {op, v}) -> version, fs(op) -> onFs result, cursor(c), leave(),
 * plus `store`, `docs`, `folders`, `grant`.
 * Handlers: onRemote(path, {op, v, by}), onCursor({name, path, row, column}), onEnd(reason), onGrant(grant),
 * onFs(op) for every file-tree change the owner accepted (already applied to `store`; put ops carry `bytes`); its result answers our own fs().
 */
export async function joinSession({ link, passcode, username, onRemote = () => {}, onCursor = () => {}, onEnd = () => {}, onGrant = () => {}, onPresence = () => {}, onFs = () => {}, WebSocketImpl = globalThis.WebSocket }) {
  const target = parseJoinLink(link), cid = randomHex(16), counters = new Map(), waiting = new Map(), cursors = new Map(), joined = new Map();
  const name = validUsername(username), gate = new GrantGate({ roomId: target.roomId, name }), blobs = new SnapshotReceiver(), early = [];
  let docs = null, folders = [], treeSeen = false, seq = 0, tree = null, blob = null, tail = Promise.resolve(), project, socket, ended = false, store;
  const settle = (key, ok, value) => { const w = waiting.get(key); if (w) { waiting.delete(key); ok ? w.resolve(value) : w.reject(value instanceof Error ? value : Error(String(value))); } };
  const failAll = reason => { for (const key of [...waiting.keys()]) settle(key, false, Error(reason)); };
  const wait = key => new Promise((resolve, reject) => {
    const timer = setTimeout(() => settle(key, false, Error('The owner did not answer')), TIMEOUT);
    waiting.set(key, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
  });
  const transfer = new Promise((resolve, reject) => { project = { resolve, reject }; });
  transfer.catch(() => {});
  const end = reason => { if (ended) return; ended = true; gate.end(); blobs.abort(); failAll(reason); project.reject(Error(reason)); onEnd(reason); };
  /** One owner-accepted file-tree change, in the owner's order, on this session's memory copy and then the native editor. */
  const change = async (m, upload) => {
    if (!Number.isSafeInteger(m.seq) || m.seq <= seq) return; // already part of the received project
    if (m.seq !== seq + 1) throw Error('A change to the shared files was lost');
    const op = tree.check(m.op), bytes = op.kind === 'put' ? (upload?.xfer === m.xfer && upload.files.size === 1 ? upload.files.get(op.path) : null) : undefined;
    if (bytes === null || (bytes && bytes.length !== op.size)) throw Error('An uploaded file did not arrive intact');
    if (op.kind === 'doc' || op.kind === 'put') store.write(op.path, op.kind === 'doc' ? '' : bytes);
    else if (op.kind === 'relocate') store.move(op.from, op.to);
    else if (op.kind === 'main') { if (!docs.has(op.path)) throw Error('The owner chose a main document that is not text'); store.setMain(op.path); }
    else if (op.kind === 'remove') for (const path of tree.paths) if (within(path, op.from)) store.remove(path);
    const moved = tree.apply(op); seq = m.seq;
    if (op.kind === 'doc' || (op.kind === 'put' && op.doc)) docs.add(op.path);
    for (const [from, to] of moved) if (docs.delete(from) && to !== null) docs.add(to);
    if (op.from) {
      const to = op.kind === 'relocate' ? op.to : null;
      rekey(joined, op.from, to); rekey(counters, op.from, to);
      for (const w of rekey(waiting, op.from, to)) w.reject(Error('The file was deleted'));
    }
    const result = await (async () => onFs({ ...op, ...(bytes ? { bytes } : {}), by: typeof m.by === 'string' ? m.by : '' }))().catch(error => error);
    if (typeof m.ref === 'string') settle(`fs:${m.ref}`, !(result instanceof Error), result);
  };
  const fs = async m => {
    if (m.k === 'blob') { blob = null; blob = await blobs.accept(m.m).catch(() => null); }
    else if (m.k === 'refused') settle(`fs:${m.ref}`, false, Error(String(m.reason ?? 'Refused by the owner')));
    else if (m.k === 'change') { const upload = blob; blob = null; if (tree) await change(m, upload); else early.push([m, upload]); } // early: the project is still arriving
  };
  const onMessage = m => { tail = tail.then(() => handle(m)).catch(error => end(error.message)); }; // in order; a file change finishes before the next message
  const handle = async m => {
    if (gate.receive(m)) return; // grant key, tickets and the denials that answer a ticket request
    switch (m.t) {
      case 'fs': await fs(m); break;
      case 'tree': if (!treeSeen && Array.isArray(m.docs) && m.docs.length <= 1000 && m.docs.every(p => typeof p === 'string') && Number.isSafeInteger(m.seq)) {
        treeSeen = true; docs = new Set(m.docs); seq = m.seq; folders = Array.isArray(m.folders) && m.folders.length <= 1000 ? m.folders.filter(p => typeof p === 'string') : [];
      } break;
      case 'doc': if (typeof m.path === 'string' && typeof m.text === 'string' && Number.isSafeInteger(m.v)) settle(`${m.path}\0join`, true, { text: m.text, v: m.v }); break;
      case 'ack': settle(`${m.path}\0${m.id}`, true, m.v - 1); break;
      case 'refused': settle(m.id ? `${m.path}\0${m.id}` : `${m.path}\0join`, false, Error(`Refused by the owner (${m.reason})`)); break;
      case 'denied': settle(String(m.ref), false, Error('The owner has not allowed this action')); break;
      case 'remote': if (joined.has(m.path) && typeof m.id === 'string' && !m.id.startsWith(cid + '.') && Array.isArray(m.ops) && Number.isSafeInteger(m.v)) onRemote(m.path, { op: m.ops, v: m.v - 1, by: m.by }); break;
      case 'presence': if (Array.isArray(m.names) && m.names.length <= 64) onPresence(m.names.filter(n => typeof n === 'string' && n !== name)); break;
      case 'cursor': if (typeof m.name === 'string' && typeof m.path === 'string') { const c = { name: m.name, path: m.path, row: m.row, column: m.column }; cursors.set(m.name, c); onCursor(c); } break;
    }
  };
  socket = new WebSocketImpl(target.url); socket.binaryType = 'arraybuffer';
  const opened = new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(Error('Cannot reach the owner at this link')); });
  await opened;
  const connected = connectStore({
    roomId: target.roomId, passcode, username, send: bytes => socket.send(bytes), close: () => socket.close(),
    onMessage, onGrant: g => { gate.observeGrant(g); onGrant(g); }, onProject: p => project.resolve(p), onTransferError: e => project.reject(e), onEnd: end,
  });
  const { session, requestSnapshot } = connected; store = connected.store;
  socket.onmessage = event => session.receive(new Uint8Array(event.data));
  socket.onclose = () => session.closed();
  let timer; const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('The owner did not answer')), TIMEOUT); });
  timeout.catch(() => {});
  try {
    const welcome = await Promise.race([session.joined, timeout]);
    gate.observeGrant(welcome.grant); gate.installStorageGuard();
    await requestSnapshot();
    const received = await Promise.race([transfer, timeout]);
    await (tail = tail.then(async () => { // the tree message precedes the bytes; changes made meanwhile are replayed on top, in order
      if (!docs) throw Error('The owner sent an incomplete project');
      tree = new ProjectTree({ files: [...received.files].map(([path, bytes]) => [path, bytes.length]), folders, main: received.main });
      for (const [m, upload] of early.splice(0)) await change(m, upload);
    }));
    if (ended) throw Error('The session ended');
    clearTimeout(timer);
    return {
      store, session, docs, gate, name, main: store.main, grant: welcome.grant, participants: welcome.participants, get folders() { return tree.folders; },
      /** Current text/version of one shared text file; later remote edits to it are delivered through onRemote. */
      async join(path) {
        if (!docs.has(path)) throw Error('Not a shared text file');
        const ref = `${path}\0join`, answer = wait(ref);
        answer.catch(() => {}); await session.send({ t: 'update', k: 'join', path, ref }).catch(error => { settle(ref, false, error); throw error; });
        const state = await answer; joined.set(path, true); return state;
      },
      /** Asks the owner for one file-tree change ({kind, ...}; put carries `bytes`); resolves once it is applied here (onFs's result). */
      async fs(op) {
        const { bytes, ...rest } = op ?? {}, ref = randomHex(8), key = `fs:${ref}`;
        if (rest.kind === 'put') ({ xfer: rest.xfer } = await streamFiles(m => session.send({ t: 'fs', k: 'blob', m }), { files: [{ path: rest.path, bytes }] }));
        const answer = wait(key); answer.catch(() => {});
        await session.send({ t: 'fs', k: 'op', ref, op: rest }).catch(error => { settle(key, false, error); throw error; });
        return answer;
      },
      leaveDoc: path => joined.delete(path),
      async edit(path, update) {
        const n = (counters.get(path) ?? 0) + 1; counters.set(path, n);
        const id = `${cid}.${n}`, key = `${path}\0${id}`, answer = wait(key);
        answer.catch(() => {}); await session.send({ t: 'update', k: 'op', path, cid, n, base: update.v, ops: update.op, ref: key }).catch(error => { settle(key, false, error); throw error; });
        return answer.catch(error => { if (counters.get(path) === n) counters.set(path, n - 1); throw error; }); // the owner did not consume a refused op id
      },
      cursor: ({ path, row, column }) => session.send({ t: 'cursor', path, row, column }).catch(() => {}),
      cursors: () => [...cursors.values()],
      leave: () => session.leave(),
      /** Owner-permitted, explicit copies. `save(copy)` must create the standalone project (overleafLocalProjects.local); file export gets the released copy. */
      saveCopy: save => saveStandaloneCopy({ gate, store, send: m => session.send(m), save: copy => save(copyResources(copy), copy) }),
      exportCopy: kind => exportCopy({ gate, store, send: m => session.send(m), kind }),
    };
  } catch (error) { clearTimeout(timer); session.leave(); store.wipe(); socket.close(); throw error; }
}

/**
 * A memory-only stand-in for the local project store (project-store.js) so the native adapter can run unchanged on a shared
 * project: reads and saves touch only the session store; everything else the offline store offers is refused.
 */
export async function memoryProjects(shared, template) {
  const store = shared.store, workspace = crypto.randomUUID(), account = randomHex(12), docIds = new Map([...shared.docs].map(path => [path, randomHex(12)]));
  const revisions = new Map();
  const encode = bytes => { let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(text); };
  const refuse = async () => { throw Error('This is not available in a shared session'); };
  const project = { id: workspace, account, project: randomHex(12), main: store.has(shared.main) ? shared.main : store.paths()[0], compiler: 'pdflatex', pdf: null, folders: shared.folders,
    name: 'Shared project', localOnly: true, native: { ...template, projectMeta: {} } };
  const file = path => shared.docs.has(path)
    ? { path, workspace, doc: docIds.get(path) ?? docIds.set(path, randomHex(12)).get(path), content: store.readText(path), revision: revisions.get(path) ?? 0 }
    : { path, workspace, data: encode(store.read(path)), revision: 0 };
  return {
    project, docIds,
    api: Object.freeze({
      read: async () => ({ project, files: store.paths().map(file) }),
      save: async (current, text) => {
        if (!docIds.has(current.path) || (revisions.get(current.path) ?? 0) !== current.revision) throw Error('Another change replaced this file');
        store.write(current.path, text); revisions.set(current.path, current.revision + 1);
        return { ...current, content: text, revision: current.revision + 1 };
      },
      // File-tree changes reach here only after the owner accepted them and lan-guest applied them to the store: these calls
      // just give the native adapter the updated view, keeping each document's id across a rename.
      add: async (_, kind, path) => { project.folders = shared.folders; return { project, ...(kind === 'doc' ? { file: file(path) } : {}) }; },
      change: async (_, __, action) => {
        const main = action.kind === 'settings' && action.main !== undefined && action.compiler === undefined && action.name === undefined && action.preferences === undefined;
        if (action.kind !== 'relocate' && action.kind !== 'remove' && action.kind !== 'put' && !main) return refuse();
        if (action.kind === 'relocate' || action.kind === 'remove') { const to = action.kind === 'relocate' ? action.to : null; rekey(docIds, action.from, to); rekey(revisions, action.from, to); }
        Object.assign(project, { main: store.main, folders: shared.folders });
        return { project, files: store.paths().map(file) };
      },
      create: refuse, list: refuse, output: refuse, blank: refuse, local: refuse, viewPdf: refuse,
    }),
  };
}
