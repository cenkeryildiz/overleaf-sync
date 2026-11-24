// SPDX-License-Identifier: AGPL-3.0-only
// Owner side of "Share on this network": helper relay + OwnerRoom (auth/crypto) + one OwnerSync log per text file.
// The owner's own editor is a local client of the same logs, so every edit has one order and one version number.
// Participant requests: {t:'update',k:'join',path} -> {t:'doc',path,v,text}; {t:'update',k:'op',path,...}; {t:'cursor',path,row,column};
// {t:'snapshot',req:true} -> {t:'tree',docs,folders,seq} + the verified project transfer (lan-transfer.mjs);
// {t:'fs',k:'blob',m} (a one-file transfer) and {t:'fs',k:'op',ref,op} -> checked here, applied by the owner, then broadcast in order as
// [{t:'fs',k:'blob',m}...] {t:'fs',k:'change',seq,by,ref,op,xfer} or answered {t:'fs',k:'refused',ref,reason}.
// Stage 3 {t:'work'|'compile'} go to lan-compile.mjs (shared compile jobs on opted-in participants). No filesystem access beyond the project the owner passed in.
import { OwnerRoom, MAX_MESSAGE, joinLink } from './lan-room.mjs';
import { GrantAuthority } from './lan-grants.mjs';
import { OwnerSync } from './lan-sync.mjs';
import { handleSnapshotRequest, streamFiles, SnapshotReceiver, ProjectTree, within, rekey } from './lan-transfer.mjs';
import { ot } from './lan-ot.mjs';
import { ownerGroup } from './lan-compile.mjs';

const LOCAL = 'owner', OWNER_CID = '0'.repeat(32), NAME = 'Owner';
// network: true binds this computer's private LAN address (the helper refuses public ones); tests keep the loopback default.
export const LOOPBACK = '127.0.0.1';

/** Shown wherever the helper is missing: the one install step, in the words the package uses. */
export const HELPER_HINT = 'Install the sharing helper once on this computer: in the folder you loaded this extension from, double-click "Install Sharing Helper", then quit and reopen the browser.';
/** True when the helper answers within 3 s; it is closed again either way. */
export async function helperAvailable(connectNative = chrome.runtime.connectNative.bind(chrome.runtime)) {
  let helper; try { helper = nativeHelper(connectNative); } catch { return false; }
  let clock; const late = new Promise((_, reject) => { clock = setTimeout(() => reject(Error('timeout')), 3000); });
  try { await Promise.race([helper.call('addresses'), late]); return true; } catch { return false; } finally { clearTimeout(clock); helper.close(); }
}
/** Native-messaging helper client with the same shape the tests use for a child process. */
export function nativeHelper(connectNative = chrome.runtime.connectNative.bind(chrome.runtime), name = 'com.cenker.latex_lan') {
  const port = connectNative(name), pending = new Map(), listeners = new Set(); let next = 1, closed = null;
  port.onMessage.addListener(message => {
    if (message?.id) { const entry = pending.get(message.id); pending.delete(message.id); if (entry) message.error ? entry.reject(Error(message.error)) : entry.resolve(message.result); }
    else for (const listener of listeners) listener(message);
  });
  port.onDisconnect.addListener(() => { closed = Error('The sharing helper is not available. ' + HELPER_HINT); for (const entry of pending.values()) entry.reject(closed); pending.clear(); for (const listener of listeners) listener({ ev: 'helper-lost' }); });
  return {
    call: (op, args = {}) => new Promise((resolve, reject) => { if (closed) return reject(closed); const id = next++; pending.set(id, { resolve, reject }); try { port.postMessage({ id, op, ...args }); } catch (error) { pending.delete(id); reject(error); } }),
    send: message => { if (!closed) port.postMessage(message); },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    close: () => { closed ??= Error('Sharing stopped'); port.disconnect(); },
  };
}
/**
 * WebSocket-shaped participant connection that the helper opens (op "connect"). Chrome's local-network rules stop extension
 * pages from opening a WebSocket to another computer; the helper is a normal program, so it can. It relays sealed bytes only.
 */
export function helperSocket(connectNative = chrome.runtime.connectNative.bind(chrome.runtime)) {
  return class HelperSocket {
    #helper; #state = 0;
    constructor(url) {
      this.binaryType = 'arraybuffer'; const helper = this.#helper = nativeHelper(connectNative);
      helper.subscribe(e => { if (e.ev === 'data' && typeof e.data === 'string' && this.#state === 1) this.onmessage?.({ data: unb64(e.data).buffer }); else if (e.ev === 'closed' || e.ev === 'helper-lost') this.#end(); });
      helper.call('connect', { url }).then(() => { if (this.#state !== 0) return; this.#state = 1; this.onopen?.(); }, error => { if (this.#state === 3) return; this.onerror?.(error); this.#end(); });
    }
    get readyState() { return this.#state; }
    send(bytes) { if (this.#state === 1) this.#helper.send({ op: 'send', data: b64(bytes) }); }
    close() { this.#end(); }
    #end() { if (this.#state === 3) return; const open = this.#state === 1; this.#state = 3; this.#helper.call('close').catch(() => {}).finally(() => this.#helper.close()); if (open) this.onclose?.(); }
  };
}
const b64 = bytes => { let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(text); };
const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const ACTION = { update: 'edit', cursor: 'edit', fs: 'edit', snapshot: 'view' };
/**
 * source: { tree() -> {files:[{path,bytes}], docs:[path], folders:[path], main}, text(path) -> {text, version} or null,
 *           persist(path, text), apply(op, by) }   persist runs after every committed entry (the editor mirrors it when open);
 *           apply performs one checked file-tree change (put ops carry `bytes`) on the owner's project and editor, or throws.
 * permission(info) is the owner-permission hook (see report): info = {peer, name, action:'view'|'edit', message}; return false to deny.
 * Events: onRemote(path, {op, v, by}), onCursor({name, path, row, column}), onPeers(names[]), onLost().
 */
export async function startHost({ helper, source, permission = () => true, onRemote = () => {}, onCursor = () => {}, onPeers = () => {}, onLost = () => {}, onPool = () => {}, network = false, secrets }) {
  const syncs = new Map(), waiting = new Map(), counters = new Map(), uploads = new Map(), aliases = new Map(), removed = new Set();
  let room, grants, group, stopped = false, fsTail = Promise.resolve(), fsSeq = 0, moving = null;
  const initial = source.tree();
  const tree = new ProjectTree({ files: initial.files.map(file => ({ path: file.path, size: file.bytes.length })), folders: initial.folders ?? [], main: initial.main });
  const current = path => aliases.get(path) ?? path; // a participant may still use a name the owner has just changed
  const queue = task => { const run = fsTail.then(task); fsTail = run.catch(() => {}); return run; }; // one structural change at a time
  const names = () => room.participants.map(p => p.name);
  const local = (path, m) => {
    if (m.t === 'remote') { onRemote(path, { op: m.ops, v: m.v - 1, by: m.by, id: m.id }); source.persist?.(path, syncs.get(path).text); }
    else if (m.t === 'ack' || m.t === 'refused') { const key = `${path}\0${m.id}`, w = waiting.get(key); if (w) { waiting.delete(key); m.t === 'ack' ? w.resolve(m.v - 1) : w.reject(Error(`The edit was refused (${m.reason})`)); } }
  };
  const hub = ref => ({ // ref.path follows renames, so acknowledgements and broadcasts always carry the current name
    sendTo: (peer, m) => peer === LOCAL ? Promise.resolve(local(ref.path, m)) : room.sendTo(peer, { ...m, path: ref.path }),
    broadcast: (m, except) => { if (except !== LOCAL) local(ref.path, m); return room.broadcast({ ...m, path: ref.path }, except); },
  });
  const sync = path => {
    let entry = syncs.get(path);
    if (!entry) {
      const current = source.text(path); // null: not a text file of this project
      if (!current) return null;
      const ref = { path };
      entry = new OwnerSync({ room: hub(ref), ot, text: current.text, version: current.version }); entry.ref = ref;
      syncs.set(path, entry);
    }
    return entry;
  };
  /** Checks, applies (owner first: the host is the authority) and broadcasts one file-tree change. Resolves with source.apply's result. */
  const change = (op, by, bytes, ref = null) => queue(async () => {
    if (stopped) throw Error('Sharing stopped');
    const checked = tree.check(op?.kind === 'put' ? { ...op, size: bytes?.length } : op);
    if (checked.kind === 'put' && !(bytes instanceof Uint8Array)) throw Error('The upload was incomplete or damaged');
    let done; if (checked.from) moving = { from: checked.from, done: new Promise(resolve => { done = resolve; }) };
    try {
      const result = await source.apply?.(checked.kind === 'put' ? { ...checked, bytes } : checked, by);
      const seq = ++fsSeq;
      for (const [from, to] of tree.apply(checked)) {
        if (to === null) removed.add(from); else { removed.delete(to); aliases.delete(to); aliases.set(from, to); }
        if (to !== null) for (const [old, target] of aliases) if (target === from) aliases.set(old, to); // a deleted target keeps its aliases: late edits are refused, not fatal
      }
      if (checked.path && checked.kind !== 'main') { removed.delete(checked.path); aliases.delete(checked.path); }
      if (checked.from) {
        const to = checked.kind === 'relocate' ? checked.to : null;
        for (const entry of rekey(syncs, checked.from, null)) {
          if (to === null) continue;
          entry.ref.path = to + entry.ref.path.slice(checked.from.length); syncs.set(entry.ref.path, entry);
          source.persist?.(entry.ref.path, entry.text); // edits that landed while the owner was renaming
        }
        rekey(counters, checked.from, to);
        for (const w of rekey(waiting, checked.from, to)) w.reject(Error('The file was deleted'));
      }
      let xfer = null;
      if (checked.kind === 'put') ({ xfer } = await streamFiles(m => room.broadcast({ t: 'fs', k: 'blob', m }), { files: [{ path: checked.path, bytes }] }));
      await room.broadcast({ t: 'fs', k: 'change', seq, by, ref, op: checked, xfer });
      return result;
    } finally { if (done) { moving = null; done(); } }
  });
  const refuse = (peer, ref, error) => room.sendTo(peer, { t: 'fs', k: 'refused', ref, reason: String(error?.message ?? error).slice(0, 200) });
  /** Participant file-tree requests: one ordered lane per peer, so an upload's chunks, end and op stay together. */
  const fsRequest = (peer, m, name) => {
    let lane = uploads.get(peer);
    if (!lane) uploads.set(peer, lane = { receiver: new SnapshotReceiver(), tail: Promise.resolve(), blob: null });
    const run = lane.tail.then(async () => {
      if (m.k === 'blob') { lane.blob = null; lane.blob = await lane.receiver.accept(m.m).catch(() => null); return; } // a bad chunk discards the upload
      if (m.k !== 'op' || typeof m.ref !== 'string' || !/^[0-9a-f]{1,64}$/.test(m.ref)) throw Error('Malformed file change');
      const blob = lane.blob; lane.blob = null;
      let bytes;
      if (m.op?.kind === 'put') {
        bytes = blob?.xfer === m.op.xfer && blob.files.size === 1 ? blob.files.get(m.op.path) : undefined;
        if (!bytes) return refuse(peer, m.ref, 'The upload was incomplete or damaged');
      }
      await change(m.op, name, bytes, m.ref).catch(error => refuse(peer, m.ref, error));
    });
    lane.tail = run.catch(() => room.revoke(peer));
  };
  const presence = () => { const list = names(); onPeers(list); room.broadcast({ t: 'presence', names: [NAME, ...list] }).catch(() => {}); };
  const deny = (peer, m) => room.sendTo(peer, { t: 'denied', request: m.t, ref: m.ref ?? null });
  const onMessage = (peer, m, name) => {
    if (grants.onMessage(room, peer, m, name)) return; // copy/export/download: owner-signed tickets (lan-grants.mjs); the room already refused non-grantees
    if (m.t === 'work' || m.t === 'compile') return group.onMessage(peer, name, m);
    const action = ACTION[m.t];
    if (!action || permission({ peer, name, action, message: m }) === false) return deny(peer, m);
    if (m.t === 'cursor') {
      if (typeof m.path !== 'string' || !Number.isSafeInteger(m.row) || !Number.isSafeInteger(m.column) || m.row < 0 || m.column < 0) throw Error('Malformed cursor');
      const cursor = { name, path: m.path, row: m.row, column: m.column };
      onCursor(cursor); return room.broadcast({ t: 'cursor', ...cursor }, peer);
    }
    if (m.t === 'snapshot') {
      if (m.req !== true) throw Error('Unknown snapshot request');
      return queue(async () => { // the tree, its change number and the bytes are taken together; later changes follow in order
        const { docs, folders, ...project } = source.tree();
        await room.sendTo(peer, { t: 'tree', docs, folders: tree.folders, seq: fsSeq });
        handleSnapshotRequest(room, peer, m, () => project)?.catch(() => {});
      });
    }
    if (m.t === 'fs') return fsRequest(peer, m, name);
    if (typeof m.path !== 'string' || m.path.length > 1024) throw Error('Malformed update');
    if (moving && within(current(m.path), moving.from)) return moving.done.then(() => onMessage(peer, m, name)).catch(() => room.revoke(peer)); // wait for the rename/delete
    const path = current(m.path), entry = sync(path);
    if (!entry && removed.has(path)) return room.sendTo(peer, { t: 'refused', reason: 'no_such_file', path: m.path, ...(m.k === 'op' ? { id: `${m.cid}.${m.n}` } : {}) });
    if (m.k === 'join') {
      if (!entry) return room.sendTo(peer, { t: 'refused', reason: 'no_such_file', path: m.path });
      if (entry.text.length > entry.limits.snapshotBytes / 2) return room.sendTo(peer, { t: 'refused', reason: 'too_large', path: m.path });
      return room.sendTo(peer, { t: 'doc', path: m.path, v: entry.version, text: entry.text });
    }
    if (!entry) throw Error('Unknown file');
    entry.handle(peer, m, name);
  };
  room = new OwnerRoom({
    send: (peer, bytes) => helper.send({ op: 'send', peer, data: b64(bytes) }),
    admit: peer => helper.call('admit', { peer }).catch(() => {}),
    drop: peer => helper.call('drop', { peer }).catch(() => {}),
    onJoin: peer => { grants.onJoin(room, peer); group.announce(peer); presence(); }, onLeave: peer => { group.leave(peer, 'gone'); presence(); },
    onMessage: (peer, m, name) => { try { return onMessage(peer, m, name); } catch { room.revoke(peer); } },
  }, secrets);
  grants = await GrantAuthority.create(room.roomId);
  group = ownerGroup({ room, onChange: onPool, current: async () => { // the logs, not the saved files, hold the shared text
    const { files } = source.tree();
    return files.map(file => syncs.has(file.path) ? { path: file.path, bytes: new TextEncoder().encode(syncs.get(file.path).text) } : file);
  } });
  const unsubscribe = helper.subscribe(event => {
    if (event.ev === 'peer') { uploads.delete(event.peer); room.connected(event.peer); }
    else if (event.ev === 'data' && typeof event.data === 'string') { const bytes = unb64(event.data); if (bytes.length <= MAX_MESSAGE) room.receive(event.peer, bytes); }
    else if (event.ev === 'gone') room.disconnected(event.peer);
    else if (event.ev === 'helper-lost' && !stopped) { stopped = true; for (const w of waiting.values()) w.reject(Error('Sharing stopped')); onLost(); }
  });
  const bind = network ? (await helper.call('addresses').catch(error => { unsubscribe(); throw error; })).addresses?.find(a => a !== LOOPBACK) : LOOPBACK;
  if (!bind) { unsubscribe(); throw Error('No private network address found. Connect this computer to Wi-Fi or Ethernet and try again.'); }
  const { port, link } = await helper.call('open', { bind, port: 0, room: room.roomId }).catch(error => { unsubscribe(); throw error; }); // link: an internet room (p2p-transport.mjs)
  const stop = async () => {
    if (stopped) return; stopped = true; unsubscribe(); group.stop();
    await room.stop().catch(() => {}); await helper.call('close').catch(() => {}); helper.close();
    for (const w of waiting.values()) w.reject(Error('Sharing stopped'));
    waiting.clear();
  };
  return {
    room, port, link: link ?? joinLink(bind, port, room.roomId), get passcode() { return room.passcode; }, stop, get stopped() { return stopped; },
    /** Current text/version for the owner's editor; the log, not the file, is authoritative while sharing. */
    text: path => syncs.get(current(path))?.text,
    /** An owner file-tree change ({kind, ...}; put carries `bytes`): checked, applied through source.apply, then sent to everyone. */
    fs: op => { const { bytes, ...rest } = op ?? {}; return change(rest, NAME, bytes); },
    join(path) { const entry = sync(path); return entry && { text: entry.text, v: entry.version }; },
    /** An owner edit {op, v} from the native editor; resolves with the version the editor must report as applied. */
    edit(path, update) {
      path = current(path); if (removed.has(path) && !syncs.has(path)) return Promise.reject(Error('The file was deleted'));
      const entry = sync(path), n = (counters.get(path) ?? 0) + 1; counters.set(path, n);
      if (!entry) return Promise.reject(Error('Unknown file'));
      const key = `${path}\0${OWNER_CID}.${n}`, done = new Promise((resolve, reject) => waiting.set(key, { resolve, reject }));
      try { entry.handle(LOCAL, { t: 'update', k: 'op', cid: OWNER_CID, n, base: update.v, ops: update.op }, NAME); } catch (error) { waiting.delete(key); return Promise.reject(error); }
      return done;
    },
    cursor(c) { return room.broadcast({ t: 'cursor', name: NAME, ...c }).catch(() => {}); },
    participants: () => room.participants,
    setGrant: async (peer, grant) => { await room.setGrant(peer, grant); group.grant(peer, grant); },
    group,
    revoke: peer => room.revoke(peer),
    /** Remove one participant: their session ends and new joins need the new passcode this returns. */
    async remove(peer) { await room.revoke(peer); return room.rotatePasscode(); },
  };
}
