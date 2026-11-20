// SPDX-License-Identifier: AGPL-3.0-only
// One isolated participant profile (forked by lan-loopback-fixture.mjs): its own process, memory and empty HOME/TMPDIR/cwd.
// It answers command messages {id, op, ...} with {id, result} or {id, error}. It writes nothing to disk and never prints secrets.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ot as doubleOt, invert, ORIGIN, Editor, randomEdit, mulberry } from './lan-loopback-fixture.mjs';

const load = async name => import(pathToFileURL(`${process.env.LAN_REPO}/runtime/chrome-extension/${name}.mjs`).href).catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return null; throw error; });
const [{ joinRoom }, syncModule, storeModule, guestModule, otModule] = await Promise.all([load('lan-room'), load('lan-sync'), load('lan-session-store'), load('lan-guest'), load('lan-ot')]);
const ot = otModule?.ot ?? doubleOt;   // production OT when the repository has it, else the documented test double
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const state = { sent: [], received: [], ended: [], messages: [], errors: [], unhandled: [], grants: [], cursors: [], editors: {}, mode: null, session: null, sync: null, store: null, socket: null, undo: [] };
for (const event of ['unhandledRejection', 'uncaughtException']) process.on(event, error => state.unhandled.push(String(error?.message ?? error)));   // recorded, then asserted by the tests
const advance = ops => { for (const entry of state.undo) entry.ops = ot.transformX(entry.ops, ops)[0]; };   // keep stacked inverses valid against later edits

const commands = {
  async connect({ url, link, roomId, passcode, username, mode, headers = { Origin: ORIGIN } }) {
    state.mode = mode;
    if (mode === 'guest') {                                         // the native stack: lan-guest.mjs joinSession over a recording socket
      class Recording extends WebSocket {
        constructor(target) { super(target, { headers }); state.socket = this; this.addEventListener('message', event => state.received.push(Buffer.from(new Uint8Array(event.data)))); }
        send(bytes) { state.sent.push(Buffer.from(bytes)); super.send(bytes); }
      }
      const ctl = state.ctl = await guestModule.joinSession({ link, passcode, username, WebSocketImpl: Recording,
        onRemote: (path, e) => state.editors[path]?.remote(e.op, e.v), onCursor: c => state.cursors.push(c), onEnd: r => state.ended.push(r), onGrant: g => state.grants.push(g) });
      Object.assign(state, { session: ctl.session, store: ctl.store });
      return { grant: ctl.grant, docs: [...ctl.docs].sort(), participants: ctl.participants };
    }
    const socket = state.socket = new WebSocket(url, { headers }); socket.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(Error('Connection refused')); });
    const send = bytes => { state.sent.push(Buffer.from(bytes)); socket.send(bytes); }, close = () => socket.close(), onEnd = reason => state.ended.push(reason);
    if (mode === 'text') {
      const psync = state.sync = new syncModule.ParticipantSync({ ot, onRemote: advance });
      state.session = joinRoom({ roomId, passcode, username, send, close, onMessage: message => { state.messages.push(message.t); psync.receive(message); }, onEnd: reason => { onEnd(reason); psync.hostLost(); } });
    } else {
      const connected = storeModule.connectStore({ roomId, passcode, username, send, close, onEnd, onMessage: message => state.messages.push(message.t), onTransferError: error => state.errors.push(error.message), onProject: () => state.messages.push('project') });
      Object.assign(state, { session: connected.session, store: connected.store, requestSnapshot: connected.requestSnapshot });
    }
    socket.onmessage = event => { const bytes = new Uint8Array(event.data); state.received.push(Buffer.from(bytes)); state.session.receive(bytes); };
    socket.onclose = () => state.session.closed();
    const { grant } = await state.session.joined;
    if (mode === 'text') { state.sync.attach(message => state.session.send(message)); await until(() => state.sync.state === 'live'); }
    return { grant };
  },
  text() { const s = state.sync; return { text: s.text, version: s.version, state: s.state, reason: s.reason, pending: s.pending.length, cid: s.cid, offered: s.offered }; },
  edit({ ops }) { const id = state.sync.edit(ops); advance(ops); state.undo.push({ ops: invert(ops) }); return id; },
  undo() { const entry = state.undo.pop(); if (!entry) throw Error('Nothing to undo'); state.sync.edit(entry.ops); advance(entry.ops); },
  send({ message }) { return state.session.send(message); },
  rawSend({ data }) { const bytes = Buffer.from(data, 'base64'); state.socket.send(bytes); },   // a frame exactly as given: replayed, forged or malformed
  inject({ index }) { state.session.receive(new Uint8Array(state.received[index])); },           // a recorded owner frame arriving again
  frames() { return { sent: state.sent.map(b => b.toString('base64')), received: state.received.length }; },
  status() {
    const grant = state.store?.grant ?? state.session.grant;
    return { state: state.session.state, grant, ended: state.ended, messages: state.messages, errors: state.errors, storeEnded: state.store?.ended ?? null, can: state.session.can('copy') };
  },
  requestSnapshot() { return state.requestSnapshot(); },
  storeInfo() {
    const { store } = state, hashes = Object.fromEntries(store.paths().map(path => [path, sha(store.read(path))]));
    return { hashes, main: store.main, bytes: store.bytes, grant: store.grant };
  },
  release({ kind }) { const copy = state.store.release(kind); return { id: copy.id, main: copy.main, hashes: Object.fromEntries(copy.files.map(f => [f.path, sha(f.bytes)])) }; },
  storeCan({ kind }) { return state.store.can(kind); },
  diag() { return { unhandled: state.unhandled }; },
  async open({ path }) { state.editors[path] = new Editor(state.ctl, path, await state.ctl.join(path), ot); return state.editors[path].view(); },
  view({ path }) { return state.editors[path].view(); },
  type({ path, ops }) { state.editors[path].submit(ops); },
  undoDoc({ path }) { state.editors[path].undo(); },
  random({ path, seed, rounds, undoChance }) { const random = mulberry(seed); for (let i = 0; i < rounds; i++) randomEdit(state.editors[path], random, undoChance); },
  cursor({ path, row, column }) { return state.ctl.cursor({ path, row, column }); },
  permit() { return globalThis.overleafLanGate?.consume() ?? null; },
  cursorEvents() { return state.cursors; },
  grants() { return state.grants; },
  async exportCopy({ kind }) { const copy = await state.ctl.exportCopy(kind); return { id: copy.id, main: copy.main, hashes: Object.fromEntries(copy.files.map(f => [f.path, sha(f.bytes)])) }; },
  async saveCopy() {  // the storage guard's one-shot permit is consumed by the save itself, as overleafLocalProjects.local does
    return state.ctl.saveCopy((resources, copy) => ({ first: globalThis.overleafLanGate.consume(), second: globalThis.overleafLanGate.consume(), main: resources.main, id: copy.id,
      hashes: Object.fromEntries(copy.files.map(f => [f.path, sha(f.bytes)])) }));
  },
  leave() { state.session.leave(); },
};
const until = async check => { const end = Date.now() + 15000; while (!check()) { if (Date.now() > end) throw Error('Timed out waiting for live state'); await new Promise(r => setTimeout(r, 10)); } };

process.on('message', async ({ id, op, ...args }) => {
  try { process.send({ id, result: await commands[op](args) ?? null }); }
  catch (error) { process.send({ id, error: error?.code ? `${error.code}: ${error.message}` : String(error?.message ?? error) }); }
});
process.on('disconnect', () => process.exit(0));
