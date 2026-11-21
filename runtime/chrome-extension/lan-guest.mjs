// SPDX-License-Identifier: AGPL-3.0-only
// Participant side of "Share on this network": WebSocket + sealed room session (lan-session-store.mjs) + the document and
// cursor requests that lan-host.mjs serves. Everything stays in memory; ending the session wipes the project store.
import { connectStore } from './lan-session-store.mjs';
import { parseJoinLink, validUsername } from './lan-room.mjs';
import { GrantGate, saveStandaloneCopy, exportCopy, copyResources } from './lan-grants.mjs';

const randomHex = bytes => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');
const TIMEOUT = 15000;

/**
 * Opens the socket, joins with the passcode and username, receives the verified project. Resolves with the controller
 * the native adapter uses: join(path) -> {text, v}, edit(path, {op, v}) -> version, cursor(c), leave(), plus `store`, `docs`, `grant`.
 * Handlers: onRemote(path, {op, v, by}), onCursor({name, path, row, column}), onEnd(reason), onGrant(grant).
 */
export async function joinSession({ link, passcode, username, onRemote = () => {}, onCursor = () => {}, onEnd = () => {}, onGrant = () => {}, onPresence = () => {}, WebSocketImpl = globalThis.WebSocket }) {
  const target = parseJoinLink(link), cid = randomHex(16), counters = new Map(), waiting = new Map(), cursors = new Map(), joined = new Set();
  const name = validUsername(username), gate = new GrantGate({ roomId: target.roomId, name });
  let docs = null, treeSeen = false, project, socket, ended = false;
  const settle = (key, ok, value) => { const w = waiting.get(key); if (w) { waiting.delete(key); ok ? w.resolve(value) : w.reject(value instanceof Error ? value : Error(String(value))); } };
  const failAll = reason => { for (const key of [...waiting.keys()]) settle(key, false, Error(reason)); };
  const wait = key => new Promise((resolve, reject) => {
    const timer = setTimeout(() => settle(key, false, Error('The owner did not answer')), TIMEOUT);
    waiting.set(key, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
  });
  const transfer = new Promise((resolve, reject) => { project = { resolve, reject }; });
  transfer.catch(() => {});
  const end = reason => { if (ended) return; ended = true; gate.end(); failAll(reason); project.reject(Error(reason)); onEnd(reason); };
  const onMessage = m => {
    if (gate.receive(m)) return; // grant key, tickets and the denials that answer a ticket request
    switch (m.t) {
      case 'tree': if (!treeSeen && Array.isArray(m.docs) && m.docs.length <= 1000 && m.docs.every(p => typeof p === 'string')) { treeSeen = true; docs = new Set(m.docs); } break;
      case 'doc': if (typeof m.path === 'string' && typeof m.text === 'string' && Number.isSafeInteger(m.v)) settle(`join\0${m.path}`, true, { text: m.text, v: m.v }); break;
      case 'ack': settle(`${m.path}\0${m.id}`, true, m.v - 1); break;
      case 'refused': settle(m.id ? `${m.path}\0${m.id}` : `join\0${m.path}`, false, Error(`Refused by the owner (${m.reason})`)); break;
      case 'denied': settle(String(m.ref), false, Error('The owner has not allowed this action')); break;
      case 'remote': if (joined.has(m.path) && typeof m.id === 'string' && !m.id.startsWith(cid + '.') && Array.isArray(m.ops) && Number.isSafeInteger(m.v)) onRemote(m.path, { op: m.ops, v: m.v - 1, by: m.by }); break;
      case 'presence': if (Array.isArray(m.names) && m.names.length <= 64) onPresence(m.names.filter(n => typeof n === 'string' && n !== name)); break;
      case 'cursor': if (typeof m.name === 'string' && typeof m.path === 'string') { const c = { name: m.name, path: m.path, row: m.row, column: m.column }; cursors.set(m.name, c); onCursor(c); } break;
    }
  };
  socket = new WebSocketImpl(target.url); socket.binaryType = 'arraybuffer';
  const opened = new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(Error('Cannot reach the owner at this link')); });
  await opened;
  const { session, store, requestSnapshot } = connectStore({
    roomId: target.roomId, passcode, username, send: bytes => socket.send(bytes), close: () => socket.close(),
    onMessage, onGrant: g => { gate.observeGrant(g); onGrant(g); }, onProject: p => project.resolve(p), onTransferError: e => project.reject(e), onEnd: end,
  });
  socket.onmessage = event => session.receive(new Uint8Array(event.data));
  socket.onclose = () => session.closed();
  let timer; const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('The owner did not answer')), TIMEOUT); });
  timeout.catch(() => {});
  try {
    const welcome = await Promise.race([session.joined, timeout]);
    gate.observeGrant(welcome.grant); gate.installStorageGuard();
    await requestSnapshot();
    await Promise.race([transfer, timeout]);
    if (!docs) throw Error('The owner sent an incomplete project');
    clearTimeout(timer);
    return {
      store, session, docs, gate, name, main: store.main, grant: welcome.grant, participants: welcome.participants,
      /** Current text/version of one shared text file; later remote edits to it are delivered through onRemote. */
      async join(path) {
        if (!docs.has(path)) throw Error('Not a shared text file');
        const ref = `join\0${path}`, answer = wait(ref);
        answer.catch(() => {}); await session.send({ t: 'update', k: 'join', path, ref }).catch(error => { settle(ref, false, error); throw error; });
        const state = await answer; joined.add(path); return state;
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
      /** One owner-signed permit for an action that hands out no source copy (the compiled PDF download). */
      authorize: kind => gate.authorize(m => session.send(m), kind),
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
  const project = { id: workspace, account, project: randomHex(12), main: store.has(shared.main) ? shared.main : store.paths()[0], compiler: 'pdflatex', pdf: null, folders: [],
    name: 'Shared project', localOnly: true, native: { ...template, projectMeta: {} } };
  const file = path => docIds.has(path)
    ? { path, workspace, doc: docIds.get(path), content: store.readText(path), revision: revisions.get(path) ?? 0 }
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
      // Compiled PDF/SyncTeX stay on this object (session memory); native-workspace serves them from there, never from IndexedDB.
      output: async (current, expected, pdf, synctex, digest) => ({ ...current, pdf, synctex, outputDigest: digest, pdfImported: false, pdfDigest: undefined }),
      create: refuse, list: refuse, blank: refuse, local: refuse, add: refuse, change: refuse, viewPdf: refuse,
    }),
  };
}
