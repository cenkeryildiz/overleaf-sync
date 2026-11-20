// SPDX-License-Identifier: AGPL-3.0-only
// Owner side of "Share on this network": helper relay + OwnerRoom (auth/crypto) + one OwnerSync log per text file.
// The owner's own editor is a local client of the same logs, so every edit has one order and one version number.
// Participant requests: {t:'update',k:'join',path} -> {t:'doc',path,v,text}; {t:'update',k:'op',path,...}; {t:'cursor',path,row,column};
// {t:'snapshot',req:true} -> {t:'tree',docs} + the verified project transfer (lan-transfer.mjs). Nothing else is served:
// no compile, no filesystem access beyond the project the owner passed in.
import { OwnerRoom, MAX_MESSAGE, joinLink } from './lan-room.mjs';
import { GrantAuthority } from './lan-grants.mjs';
import { OwnerSync } from './lan-sync.mjs';
import { handleSnapshotRequest } from './lan-transfer.mjs';
import { ot } from './lan-ot.mjs';

const LOCAL = 'owner', OWNER_CID = '0'.repeat(32), NAME = 'Owner';
// shortcut: the listener is loopback-only until the user authorizes exposing a LAN address; then pass the address from the helper's 'addresses'.
export const LOOPBACK = '127.0.0.1';

/** Native-messaging helper client with the same shape the tests use for a child process. */
export function nativeHelper(connectNative = chrome.runtime.connectNative.bind(chrome.runtime), name = 'com.cenker.latex_lan') {
  const port = connectNative(name), pending = new Map(), listeners = new Set(); let next = 1, closed = null;
  port.onMessage.addListener(message => {
    if (message?.id) { const entry = pending.get(message.id); pending.delete(message.id); if (entry) message.error ? entry.reject(Error(message.error)) : entry.resolve(message.result); }
    else for (const listener of listeners) listener(message);
  });
  port.onDisconnect.addListener(() => { closed = Error('The sharing helper is not available. Install it, then share again.'); for (const entry of pending.values()) entry.reject(closed); pending.clear(); for (const listener of listeners) listener({ ev: 'helper-lost' }); });
  return {
    call: (op, args = {}) => new Promise((resolve, reject) => { if (closed) return reject(closed); const id = next++; pending.set(id, { resolve, reject }); try { port.postMessage({ id, op, ...args }); } catch (error) { pending.delete(id); reject(error); } }),
    send: message => { if (!closed) port.postMessage(message); },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    close: () => { closed ??= Error('Sharing stopped'); port.disconnect(); },
  };
}
const b64 = bytes => { let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(text); };
const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const ACTION = { update: 'edit', cursor: 'edit', snapshot: 'view' };

/**
 * source: { tree() -> {files:[{path,bytes}], docs:[path], main}, text(path) -> {text, version} or null,
 *           persist(path, text) }   persist runs after every committed entry (the editor mirrors it when open).
 * permission(info) is the owner-permission hook (see report): info = {peer, name, action:'view'|'edit', message}; return false to deny.
 * Events: onRemote(path, {op, v, by}), onCursor({name, path, row, column}), onPeers(names[]), onLost().
 */
export async function startHost({ helper, source, permission = () => true, onRemote = () => {}, onCursor = () => {}, onPeers = () => {}, onLost = () => {}, secrets }) {
  const syncs = new Map(), waiting = new Map(), counters = new Map(); let room, grants, stopped = false;
  const names = () => room.participants.map(p => p.name);
  const local = (path, m) => {
    if (m.t === 'remote') { onRemote(path, { op: m.ops, v: m.v - 1, by: m.by, id: m.id }); source.persist?.(path, syncs.get(path).text); }
    else if (m.t === 'ack' || m.t === 'refused') { const key = `${path}\0${m.id}`, w = waiting.get(key); if (w) { waiting.delete(key); m.t === 'ack' ? w.resolve(m.v - 1) : w.reject(Error(`The edit was refused (${m.reason})`)); } }
  };
  const hub = path => ({
    sendTo: (peer, m) => peer === LOCAL ? Promise.resolve(local(path, m)) : room.sendTo(peer, { ...m, path }),
    broadcast: (m, except) => { if (except !== LOCAL) local(path, m); return room.broadcast({ ...m, path }, except); },
  });
  const sync = path => {
    let entry = syncs.get(path);
    if (!entry) {
      const current = source.text(path); // null: not a text file of this project
      if (!current) return null;
      entry = new OwnerSync({ room: hub(path), ot, text: current.text, version: current.version });
      syncs.set(path, entry);
    }
    return entry;
  };
  const presence = () => { const list = names(); onPeers(list); room.broadcast({ t: 'presence', names: [NAME, ...list] }).catch(() => {}); };
  const deny = (peer, m) => room.sendTo(peer, { t: 'denied', request: m.t, ref: m.ref ?? null });
  const onMessage = (peer, m, name) => {
    if (grants.onMessage(room, peer, m, name)) return; // copy/export/download: owner-signed tickets (lan-grants.mjs); the room already refused non-grantees
    const action = ACTION[m.t];
    if (!action || permission({ peer, name, action, message: m }) === false) return deny(peer, m);
    if (m.t === 'cursor') {
      if (typeof m.path !== 'string' || !Number.isSafeInteger(m.row) || !Number.isSafeInteger(m.column) || m.row < 0 || m.column < 0) throw Error('Malformed cursor');
      const cursor = { name, path: m.path, row: m.row, column: m.column };
      onCursor(cursor); return room.broadcast({ t: 'cursor', ...cursor }, peer);
    }
    if (m.t === 'snapshot') {
      if (m.req !== true) throw Error('Unknown snapshot request');
      const { docs, ...project } = source.tree();
      return room.sendTo(peer, { t: 'tree', docs }).then(() => handleSnapshotRequest(room, peer, m, () => project));
    }
    if (typeof m.path !== 'string' || m.path.length > 1024) throw Error('Malformed update');
    const entry = sync(m.path);
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
    onJoin: peer => { grants.onJoin(room, peer); presence(); }, onLeave: presence,
    onMessage: (peer, m, name) => { try { return onMessage(peer, m, name); } catch { room.revoke(peer); } },
  }, secrets);
  grants = await GrantAuthority.create(room.roomId);
  const unsubscribe = helper.subscribe(event => {
    if (event.ev === 'peer') room.connected(event.peer);
    else if (event.ev === 'data' && typeof event.data === 'string') { const bytes = unb64(event.data); if (bytes.length <= MAX_MESSAGE) room.receive(event.peer, bytes); }
    else if (event.ev === 'gone') room.disconnected(event.peer);
    else if (event.ev === 'helper-lost' && !stopped) { stopped = true; for (const w of waiting.values()) w.reject(Error('Sharing stopped')); onLost(); }
  });
  const { port } = await helper.call('open', { bind: LOOPBACK, port: 0, room: room.roomId }).catch(error => { unsubscribe(); throw error; });
  const stop = async () => {
    if (stopped) return; stopped = true; unsubscribe();
    await room.stop().catch(() => {}); await helper.call('close').catch(() => {}); helper.close();
    for (const w of waiting.values()) w.reject(Error('Sharing stopped'));
    waiting.clear();
  };
  return {
    room, port, link: joinLink(LOOPBACK, port, room.roomId), passcode: room.passcode, stop, get stopped() { return stopped; },
    /** Current text/version for the owner's editor; the log, not the file, is authoritative while sharing. */
    text: path => syncs.get(path)?.text,
    join(path) { const entry = sync(path); return entry && { text: entry.text, v: entry.version }; },
    /** An owner edit {op, v} from the native editor; resolves with the version the editor must report as applied. */
    edit(path, update) {
      const entry = sync(path), n = (counters.get(path) ?? 0) + 1; counters.set(path, n);
      if (!entry) return Promise.reject(Error('Unknown file'));
      const key = `${path}\0${OWNER_CID}.${n}`, done = new Promise((resolve, reject) => waiting.set(key, { resolve, reject }));
      try { entry.handle(LOCAL, { t: 'update', k: 'op', cid: OWNER_CID, n, base: update.v, ops: update.op }, NAME); } catch (error) { waiting.delete(key); return Promise.reject(error); }
      return done;
    },
    cursor(c) { return room.broadcast({ t: 'cursor', name: NAME, ...c }).catch(() => {}); },
    participants: () => room.participants,
    setGrant: (peer, grant) => room.setGrant(peer, grant),
    revoke: peer => room.revoke(peer),
  };
}
