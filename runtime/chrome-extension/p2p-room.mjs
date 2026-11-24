// SPDX-License-Identifier: AGPL-3.0-only
// Stage 4 internet room: one facade for every role a peer can have. Composes the stage 2 session (lan-host.mjs startHost as
// coordinator, lan-guest.mjs joinSession as participant) over WebRTC (p2p-transport.mjs) with the owner-signed member list
// (p2p-membership.mjs), member identities (p2p-identity.mjs) and the log replica (p2p-replica.mjs).
//
// Roles. The coordinator orders edits (CE+ OT needs one). The link creator coordinates first; when the coordinator disappears the
// members listed in its last succession order try, one after another (STEP apart), to take over: the first that registers the room
// with the room finder becomes coordinator of the next epoch, seeded from its replica, and everyone else rejoins it with their
// unchanged session (same client id, so a resubmitted edit is acknowledged, never applied twice). Members holding confirmed
// entries the successor lacks send them first (catch-up); a refused or diverged catch-up goes through the explicit conflict path.
// Coordinators prove their epoch with a member signature; peers refuse a lower epoch (a stale coordinator). Ownership is separate
// from coordination: only the signed member list grants roles, so coordinating never makes anyone owner.
//
// Honest limits: the coordinator sees every edit (it is a member); a malicious coordinator can withhold or reorder edits and grant
// copy tickets it should not (application permissions, as in stage 2), but it cannot forge membership, ownership or another
// member's identity. Unsent text in a coordinator that steps down after a split is rejected back to its editor (rare: split brain).
import { startHost } from './lan-host.mjs';
import { joinSession } from './lan-guest.mjs';
import { newRoomSecrets, parseJoinLink, roomLink, joinBinding, normalizePasscode, validUsername } from './lan-room.mjs';
import { p2pHelper, p2pSocket } from './p2p-transport.mjs';
import { selectSignaling } from './p2p-signal.mjs';
import { identityStore, verify, KEY } from './p2p-identity.mjs';
import { Membership } from './p2p-membership.mjs';
import { Replica } from './p2p-replica.mjs';

export const STEP = 2500, FILL_WINDOW = 10_000, GIVE_UP = 30_000;
const encoder = new TextEncoder(), decoder = new TextDecoder();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const randomHex = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
const epochBytes = (room, epoch, key) => encoder.encode(JSON.stringify(['latex-p2p-epoch-v1', room, epoch, key]));
const within = (path, root) => path === root || path.startsWith(root + '/');
const net = o => ({ signaling: o.signaling ?? selectSignaling(), RTC: o.RTC ?? globalThis.RTCPeerConnection, iceServers: o.iceServers ?? [] });

/** In-memory project for a peer that coordinates without the owner's editor project (a successor, or a reopened copy). */
function memorySource({ files, docs, folders, main }, events) {
  const texts = new Map();
  return {
    tree: () => ({ main, folders: [...folders], docs: [...docs], files: [...files].map(([path, bytes]) => ({ path, bytes: texts.has(path) ? encoder.encode(texts.get(path)) : bytes })) }),
    text: path => docs.has(path) && files.has(path) ? { text: texts.get(path) ?? decoder.decode(files.get(path)), version: 0 } : null,
    persist: (path, text) => { texts.set(path, text); events.persist?.(path, text); },
    apply(op) {
      if (op.kind === 'doc') { files.set(op.path, new Uint8Array()); docs.add(op.path); }
      else if (op.kind === 'put') { files.set(op.path, op.bytes); texts.delete(op.path); if (op.doc) docs.add(op.path); else docs.delete(op.path); }
      else if (op.kind === 'relocate') for (const path of [...files.keys()]) { if (!within(path, op.from)) continue; const to = op.to + path.slice(op.from.length); files.set(to, files.get(path)); files.delete(path); if (texts.has(path)) { texts.set(to, texts.get(path)); texts.delete(path); } if (docs.delete(path)) docs.add(to); }
      else if (op.kind === 'remove') for (const path of [...files.keys()]) if (within(path, op.from)) { files.delete(path); texts.delete(path); docs.delete(path); }
      else if (op.kind === 'main') main = op.path;
      events.onFs?.(op);
    },
  };
}

/**
 * Starts coordinating epoch `ctx.epoch`. ctx: { roomId, passcode, retired, identity, username, membership, epoch, net, events }.
 * Rejects with 'This room is already open' when another peer holds the room at the finder (it won the takeover).
 */
async function coordinate(ctx, { source, seed = {}, client }) {
  const { events } = ctx, sent = new Set(), order = new Map(); // order: member key -> first time seen, for the succession list
  const claim = { t: 'epoch', room: ctx.roomId, epoch: ctx.epoch, key: ctx.identity.key, sig: await ctx.identity.sign(epochBytes(ctx.roomId, ctx.epoch, ctx.identity.key)) };
  const fillUntil = Date.now() + FILL_WINDOW;
  let host; const helper = p2pHelper(ctx.net);
  const succession = () => {
    const rank = r => r === ctx.membership.owner ? 0 : ctx.membership.member(r)?.role === 'copy' ? 1 : 2;
    return host.participants().filter(p => p.id).map(p => p.id).sort((a, b) => rank(a) - rank(b) || order.get(a) - order.get(b));
  };
  const announce = () => host.room.broadcast({ t: 'succession', keys: succession() }).catch(() => {});
  const passcodes = () => ({ t: 'passcodes', current: ctx.passcode, retired: ctx.retired });
  /** After any member-list change: apply roles to connected peers; a removal rotates the passcode for new joins. */
  const enforce = async () => {
    let removed = false;
    for (const p of host.participants()) {
      const m = p.id && ctx.membership.member(p.id);
      if (!p.id) continue;
      if (!m) { removed = true; await host.revoke(p.peer); } else if (m.role !== p.grant) await host.setGrant(p.peer, m.role).catch(() => {});
    }
    if (removed) { ctx.passcode = host.room.rotatePasscode(); ctx.retired = host.room.retired; await host.room.broadcast(passcodes()).catch(() => {}); events.onPasscode?.(ctx.passcode); }
    events.onMembers?.(ctx.membership.members, ctx.membership.frozen);
  };
  const apply = async doc => {
    const result = await ctx.membership.accept(doc);
    if (result === 'applied' || result === 'conflict') { await host?.room.broadcast({ t: 'members', docs: [doc] }).catch(() => {}); if (host) await enforce(); }
    return result;
  };
  const checkJoin = async ({ name, id, proof, roomId, binding, retired }) => {
    if (typeof id !== 'string' || !KEY.test(id) || !await verify(id, proof, joinBinding(roomId, binding.owner, binding.nonce, name))) return { refuse: 'This room needs the current version of the extension' };
    const m = ctx.membership.member(id);
    if (m) return m.name === name ? { grant: m.role } : { refuse: `Join with the name you have in this room (${m.name})` };
    if (ctx.membership.removed(id)) return { refuse: 'The owner removed you from this room' };
    if (retired) return { refuse: 'This passcode was replaced. Ask the owner for the current one' };
    if (ctx.identity.key !== ctx.membership.owner) return { refuse: 'The owner must be online to let someone new in' };
    try { await apply(await ctx.membership.setMember(ctx.identity, id, name, 'online')); }
    catch (error) { return { refuse: /Duplicate member name/.test(error.message) ? 'That name is already used in this room' : 'The member list cannot change right now' }; }
    return { grant: 'online' };
  };
  const onMember = (peer, m) => (async () => {
    const from = host.participants().find(p => p.peer === peer);
    if (!from?.id) return;
    if (Array.isArray(m.docs) && m.docs.length <= 64) {
      for (const doc of m.docs) {
        const result = await apply(doc).catch(() => 'forged');
        if (result === 'forged') return host.revoke(peer);
        if (result === 'gap') return host.room.sendTo(peer, { t: 'members', docs: ctx.membership.chain() });
      }
    } else if (m.offer && typeof m.to === 'string') { // a transfer offer travels to its recipient, who verifies it on acceptance
      const to = host.participants().find(p => p.id === m.to);
      if (to && from.id === ctx.membership.owner) await host.room.sendTo(to.peer, { t: 'offer', doc: m.offer });
      else if (m.to === ctx.identity.key && from.id === ctx.membership.owner) events.onTransferOffer?.(m.offer);
    } else if (m.epoch && typeof m.epoch === 'object') { // a member reports a newer coordinator: verify it, then step down
      const c = m.epoch;
      if (Number.isSafeInteger(c.epoch) && (c.epoch > ctx.epoch || (c.epoch === ctx.epoch && c.key < ctx.identity.key)) && ctx.membership.member(c.key) &&
        await verify(c.key, c.sig, epochBytes(ctx.roomId, c.epoch, c.key))) ctx.stepDown?.(c);
    }
  })().catch(() => {});
  host = await startHost({
    helper, source, secrets: { roomId: ctx.roomId, passcode: ctx.passcode, retired: ctx.retired }, client, seed, checkJoin, onMember,
    fillable: (peer) => Date.now() < fillUntil && ctx.membership.member(host.participants().find(p => p.peer === peer)?.id)?.role === 'copy', // shortcut: catch-up trusts copy members' entries; signed entries would remove that trust
    onRemote: (...a) => events.onRemote?.(...a), onCursor: (...a) => events.onCursor?.(...a), onPool: () => {}, onLost: () => events.onLost?.('The room finder connection was lost', { retrying: false }),
    onPeers: names => {
      for (const p of host?.participants() ?? []) if (!sent.has(p.peer)) {
        sent.add(p.peer); if (p.id && !order.has(p.id)) order.set(p.id, order.size);
        host.room.sendTo(p.peer, { t: 'members', docs: ctx.membership.chain() }).then(() => host.room.sendTo(p.peer, claim)).then(() => host.room.sendTo(p.peer, passcodes())).catch(() => {});
      }
      for (const peer of [...sent]) if (!host.participants().some(p => p.peer === peer)) sent.delete(peer);
      if (host) announce();
      events.onPeers?.(names);
    },
  });
  ctx.retired = host.room.retired;
  return { host, helper, apply };
}

/** The facade a page holds; `role` and the underlying session change on takeover or step-down. */
function facade(ctx) {
  let coord = null, ctl = null, replica = null, leaving = false, electing = false;
  const { events } = ctx;
  const self = {
    get role() { return coord ? 'coordinator' : ctl ? 'participant' : 'none'; },
    get link() { return roomLink(ctx.roomId); },
    get passcode() { return ctx.passcode; },
    get epoch() { return ctx.epoch; },
    get members() { return ctx.membership?.members ?? []; },
    get owner() { return ctx.membership?.owner === ctx.identity.key; },
    get session() { return coord?.host ?? ctl; },
    join: path => coord ? Promise.resolve(coord.host.join(path)) : ctl.join(path),
    edit: (path, update) => (coord ? coord.host : ctl).edit(path, update),
    fs: op => (coord ? coord.host : ctl).fs(op),
    cursor: c => (coord ? coord.host : ctl).cursor(c),
    // ---- membership (owner, backup, transfer recipient); documents go through the coordinator, which every peer re-verifies ----
    async sign(make) {
      const doc = await make(ctx.membership, ctx.identity);
      if (coord) { if (await coord.apply(doc) === 'conflict') throw Error('Permission changes are frozen: two different member lists exist'); }
      else { if (await ctx.membership.accept(doc) === 'conflict') throw Error('Permission changes are frozen'); await ctl.session.send({ t: 'member', docs: [doc] }); }
      events.onMembers?.(ctx.membership.members, ctx.membership.frozen);
    },
    setRole: (key, role) => self.sign((m, id) => m.setMember(id, key, m.member(key)?.name ?? '', role)),
    remove: key => self.sign((m, id) => m.remove(id, key)),
    setBackup: key => self.sign((m, id) => m.setBackup(id, key)),
    claimOwnership: () => self.sign((m, id) => m.claim(id)),
    async offerTransfer(key) {
      const offer = await ctx.membership.offerTransfer(ctx.identity, key);
      if (coord) { const to = coord.host.participants().find(p => p.id === key); if (!to) throw Error('That member is not online'); await coord.host.room.sendTo(to.peer, { t: 'offer', doc: offer }); }
      else await ctl.session.send({ t: 'member', offer, to: key });
    },
    acceptTransfer: offer => self.sign((m, id) => m.acceptTransfer(id, offer)),
    /** A copy holder's saved room state for reopening without anyone online: no passcode (asked again), no session data. */
    async saveForReopen(save) {
      const meta = async files => ({ roomId: ctx.roomId, chain: ctx.membership.chain(), epoch: ctx.epoch,
        heads: coord ? Object.fromEntries(Object.entries(coord.host.docs()).map(([p, d]) => [p, { v: d.version, at: d.log.at(-1)?.id ?? null }])) : replica.heads(),
        digests: Object.fromEntries(await Promise.all(files.map(async f => [f.path, await sha256(f.bytes)]))) });
      if (coord) { const tree = ctx.source.tree(); return save({ files: tree.files, main: tree.main, docs: tree.docs, folders: tree.folders }, await meta(tree.files)); }
      return ctl.saveCopy(async (resources, copy) => save({ files: copy.files, main: copy.main, docs: [...ctl.docs], folders: ctl.folders }, await meta(copy.files)));
    },
    /** Leave this room; as coordinator, disconnect without ending it, so the next member takes over. */
    async leave() { leaving = true; if (coord) { coord.helper.close(); await coord.host.stop(); } else ctl?.leave(); },
    /** Owner only: end the room for everyone (members keep copies they were allowed to save). */
    async endRoom() {
      if (ctx.membership.owner !== ctx.identity.key) throw Error('Only the owner can end the room');
      leaving = true; if (coord) await coord.host.stop(); else ctl?.leave(); // shortcut: a non-coordinating owner only leaves; ending then needs the coordinator's cooperation
    },
  };

  const lead = async (source, seed, client) => {
    coord = await coordinate(ctx, { source, seed, client });
    ctx.source = source; events.onRole?.('coordinator');
  };
  /** Participant on a new or resumed connection, then election on loss. */
  const participate = async ({ link, passcode }) => {
    replica = new Replica({ name: ctx.username });
    const epochs = new Map(); // session -> verified claim
    const tap = (m, session) => {
      replica.tap(m, session);
      if (m.t === 'members' && Array.isArray(m.docs) && m.docs.length <= 1000) members(m.docs, session).catch(() => {});
      else if (m.t === 'epoch') claim(m, session).catch(() => {});
      else if (m.t === 'passcodes' && normalizePasscode(m.current) && Array.isArray(m.retired)) { ctx.passcode = m.current; ctx.retired = m.retired.filter(normalizePasscode).slice(0, 8); }
      else if (m.t === 'succession' && Array.isArray(m.keys) && m.keys.length <= 64 && m.keys.every(k => KEY.test(k))) ctx.succession = m.keys;
      else if (m.t === 'offer' && m.doc) events.onTransferOffer?.(m.doc);
    };
    let tail = Promise.resolve();
    const members = (docs, session) => (tail = tail.then(async () => {
      if (!ctx.membership) { ctx.membership = await Membership.load(ctx.roomId, docs); }
      else {
        for (const doc of docs) if (await ctx.membership.accept(doc) === 'gap') break;
        const theirs = Math.max(...docs.map(d => d?.b?.[2] ?? -1));
        if (ctx.membership.seq > theirs && docs.length > 1) await session.send({ t: 'member', docs: ctx.membership.since(theirs) }); // the coordinator is behind us
      }
      const me = ctx.membership.member(ctx.identity.key);
      events.onMembers?.(ctx.membership.members, ctx.membership.frozen);
      if (!me) events.onRemoved?.();
    }));
    const claim = (m, session) => (tail = tail.then(async () => {
      if (m.room !== ctx.roomId || !Number.isSafeInteger(m.epoch) || !ctx.membership?.member(m.key) || !await verify(m.key, m.sig, epochBytes(ctx.roomId, m.epoch, m.key))) return;
      epochs.set(session, m);
    }));
    const beforeAdopt = async (session, { docs }) => {
      for (let i = 0; i < 50 && !epochs.has(session); i++) { await sleep(100); await tail; }
      const c = epochs.get(session);
      if (!c) throw Error('The room did not prove who coordinates it');
      if (c.epoch < ctx.epoch) { await session.send({ t: 'member', epoch: ctx.claim }).catch(() => {}); throw Error('That computer coordinated an older session of this room'); }
      if (replica.docs.size) { const result = await replica.catchUp(session); if (result.diverged.length) events.onFork?.(result.diverged); }
      ctx.epoch = c.epoch; ctx.claim = c;
      replica.track(session, docs);
    };
    ctl = await joinSession({
      link, passcode, username: ctx.username, identity: ctx.identity, P2PSocketImpl: p2pSocket(ctx.net), retries: [], onTap: tap, beforeAdopt, keepOnLoss: true, // the room outlives its coordinator: the memory copy is wiped when the election gives up
      onRemote: (...a) => events.onRemote?.(...a), onCursor: (...a) => events.onCursor?.(...a), onFs: op => events.onFs?.(op), onGrant: g => events.onGrant?.(g),
      onPresence: n => events.onPeers?.(n), onResumed: conflicts => events.onConflicts?.(conflicts), onGroup: () => {},
      onEnd: reason => { if (!leaving && !self.taking) events.onEnd?.(reason); },
      onLost: reason => { events.onLost?.(reason, { retrying: true }); if (!electing) { electing = true; elect().catch(() => {}).finally(() => { electing = false; }); } },
    });
    ctx.passcode = passcode;
    events.onRole?.('participant');
  };
  /** Coordinator gone: rejoin whoever takes over; members in the succession list take over in turn. */
  const elect = async () => {
    const rank = (ctx.succession ?? []).indexOf(ctx.identity.key), started = Date.now();
    while (ctl?.state === 'lost' && !leaving) {
      if (rank >= 0 && Date.now() - started >= rank * STEP && await takeover().catch(() => false)) return;
      try { await ctl.rejoin({ passcode: ctx.passcode }); return; } catch { if (ctl.state === 'ended') return; }
      if (Date.now() - started > rank * STEP + GIVE_UP) { leaving = true; ctl.leave(); events.onLost?.('Nobody is online in this room', { retrying: false, reopen: ctx.membership?.member(ctx.identity.key)?.role === 'copy' }); return; }
      await sleep(1000);
    }
  };
  const takeover = async () => {
    const store = ctl.store, docs = new Set(ctl.docs);
    const project = { files: new Map(store.paths().map(p => [p, store.read(p)])), docs, folders: ctl.folders, main: ctl.main };
    const seed = replica.seed(), client = { cid: ctl.cid, name: ctx.username };
    const previous = { epoch: ctx.epoch };
    ctx.epoch = previous.epoch + 1;
    try { await lead(memorySource(project, events), seed, client); }
    catch (error) { ctx.epoch = previous.epoch; if (/already open/.test(error.message)) return false; throw error; }
    self.taking = true;
    const pending = ctl.takeOutstanding(); ctl.leave(); ctl = null; self.taking = false;
    for (const o of pending) coord.host.resubmit(o.path, o).then(v => o.resolve(v - o.off), o.reject); // original ids: an edit the old coordinator applied is acknowledged, not repeated
    return true;
  };
  ctx.stepDown = async () => { // a newer coordinator exists (after a split): rejoin it as a participant
    const old = coord; if (!old) return; coord = null; await old.host.stop().catch(() => {}); events.onSuperseded?.();
    await participate({ link: roomLink(ctx.roomId), passcode: ctx.passcode }).catch(error => events.onEnd?.(error.message));
  };
  return { self, lead, participate };
}

/** Owner: share `source` (the open project) in a new internet room. */
export async function createInternetRoom({ source, username, identities = identityStore(), events = {}, ...options }) {
  const name = validUsername(username) ?? 'Owner', { roomId, passcode } = newRoomSecrets(), identity = await identities.forRoom(roomId);
  const ctx = { roomId, passcode, retired: [], identity, username: name, membership: await Membership.create(roomId, identity, name), epoch: 1, net: net(options), events };
  const f = facade(ctx);
  await f.lead(source, {}, { cid: randomHex(16), name });
  return f.self;
}

/** Member: join by link and passcode. With nobody online it rejects with code 'nobody' (see reopenInternetRoom). */
export async function joinInternetRoom({ link, passcode, username, identities = identityStore(), events = {}, ...options }) {
  const t = parseJoinLink(link);
  if (!t.p2p) throw Error('This is not an internet room link');
  const name = validUsername(username);
  if (!name) throw Error('Choose a name of 1 to 32 visible characters');
  const ctx = { roomId: t.roomId, passcode, retired: [], identity: await identities.forRoom(t.roomId), username: name, membership: null, epoch: 0, net: net(options), events };
  const f = facade(ctx);
  try { await f.participate({ link, passcode }); }
  catch (error) { throw /Nobody is sharing/.test(error.message) ? Object.assign(Error('Nobody is online in this room right now'), { code: 'nobody' }) : error; }
  return f.self;
}

/**
 * Nobody online: a member with the copy permission reopens the room from a copy saved with saveForReopen and coordinates it.
 * Files unchanged since the save continue the room's history; files edited offline start a new version, so returning members
 * reconcile them explicitly (p2p-reconcile.mjs) instead of having edits applied on a different text.
 */
export async function reopenInternetRoom({ saved, passcode, username, identities = identityStore(), events = {}, ...options }) {
  const { project, room } = saved;
  if (!normalizePasscode(passcode)) throw Error('Enter the room passcode');
  const membership = await Membership.load(room.roomId, room.chain), identity = await identities.forRoom(room.roomId), me = membership.member(identity.key);
  if (me?.role !== 'copy') throw Error('Only members with the copy permission can reopen this room');
  const files = new Map(project.files.map(f => [f.path, f.bytes])), docs = new Set(project.docs), seed = {};
  for (const path of docs) {
    const head = room.heads[path], bytes = files.get(path);
    if (!head || !bytes) continue;
    const same = await sha256(bytes) === room.digests[path];
    seed[path] = same ? { text: decoder.decode(bytes), version: head.v, log: [], headId: head.at } : { text: decoder.decode(bytes), version: head.v + 1, log: [], headId: `local.${randomHex(8)}` };
  }
  const ctx = { roomId: room.roomId, passcode, retired: [], identity, username: me.name, membership, epoch: room.epoch + 1, net: net(options), events };
  const f = facade(ctx);
  await f.lead(memorySource({ files, docs, folders: project.folders ?? [], main: project.main }, events), seed, { cid: randomHex(16), name: me.name });
  return f.self;
}
