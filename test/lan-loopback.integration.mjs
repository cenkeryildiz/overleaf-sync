// SPDX-License-Identifier: AGPL-3.0-only
// CEX-LAN-01 / CEX-LAN-PERM-01 loopback checks: the real relay helper on 127.0.0.1, an owner in this process, and participants in
// separate isolated profile processes (test/lan-loopback-fixture.mjs). Loopback only: this does NOT establish two-device acceptance.
//   cargo build --offline --manifest-path runtime/chrome-extension/lan/Cargo.toml
//   LATEX_LAN_HELPER=<target>/debug/latex-local-lan [LAN_REPO=<worktree to test>] node --test test/lan-loopback.integration.mjs
// A check whose entry point does not exist in LAN_REPO is reported as BLOCKED (node:test "todo" plus a summary), never as a pass.
// LAN_STRICT=1 turns every blocked check into a failure.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { loadEntries, startOwner, startStack, randomEdit, mulberry, rawSocket, maskedFrame, boundaries, until, sleep } from './lan-loopback-fixture.mjs';

const entries = await loadEntries(), blocked = [];
const SYNC = ['lan-room.mjs#OwnerRoom', 'lan-room.mjs#joinRoom', 'lan-sync.mjs#OwnerSync', 'lan-sync.mjs#ParticipantSync'];
const STACK = ['lan-host.mjs#startHost', 'lan-guest.mjs#joinSession', 'lan-ot.mjs#ot', 'lan-session-store.mjs#connectStore'];
const STORE = ['lan-room.mjs#OwnerRoom', 'lan-transfer.mjs#sendSnapshot', 'lan-transfer.mjs#handleSnapshotRequest', 'lan-transfer.mjs#SnapshotReceiver', 'lan-session-store.mjs#SessionStore', 'lan-session-store.mjs#connectStore'];
const block = (t, reason) => {
  blocked.push(`${t.name}: ${reason}`);
  if (process.env.LAN_STRICT) throw Error('BLOCKED: ' + reason);
  t.todo('BLOCKED: ' + reason);
  return true;
};
const guard = (t, ...needs) => { const missing = needs.filter(name => entries.missing.includes(name)); return missing.length ? block(t, 'missing ' + missing.join(', ')) : false; };
after(() => { if (blocked.length) console.log(`LAN LOOPBACK BLOCKED (${blocked.length}), not passed:\n  ${blocked.join('\n  ')}`); });
const run = { timeout: 120000 };

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const BASE = 'Merhaba dünya 😀 İstanbul ığş 𝒳 数学 🇹🇷 👨‍👩‍👧 é ✓\n', EMOJI = ['😀', '𝒳', '🇹🇷', '👨‍👩‍👧', 'İ', '数'];
const inside = (text, p) => [...text.matchAll(/⟨[^⟩]*⟩/g)].some(m => p > m.index && p < m.index + m[0].length);
const cpAt = (text, p) => String.fromCodePoint(text.codePointAt(p));
const pick = (rng, text) => { const o = boundaries(text).filter(p => !inside(text, p)); return o[Math.floor(rng() * o.length)]; };
/** Every profile and the owner hold the identical, well-formed text at the owner's version with nothing pending. */
async function converged(owner, profiles) {
  let views = [];
  await until(async () => { views = await Promise.all(profiles.map(p => p.call('text'))); return views.every(v => v.state === 'live' && !v.pending && v.version === owner.sync.version && v.text === owner.sync.text); },
    () => `convergence ${JSON.stringify(views.map(v => [v.state, v.pending, v.version]))} owner v${owner.sync.version}`);
  assert(owner.sync.text.isWellFormed(), 'no lone surrogate may appear');
  return views;
}
/** Profiles stayed empty on disk and (where still running) raised no unhandled rejection, which Chrome would list as an extension error. */
const finish = async owner => {
  for (const p of owner.profiles) {
    assert.deepEqual(p.files(), [], `${p.name}: profile directory must stay empty`);
    assert.deepEqual((await p.call('diag').catch(() => ({ unhandled: [] }))).unhandled, [], `${p.name}: unhandled rejection in the participant`);
  }
};

test('Unicode (BMP, supplementary, ZWJ, flags, combining): concurrent edits from two isolated profiles and the owner converge exactly', run, async t => {
  if (guard(t, ...SYNC)) return;
  const owner = await startOwner(entries, { text: BASE });
  try {
    const ada = await owner.profile('Ada', 'text'), bob = await owner.profile('Bob', 'text'), rng = mulberry(7), tokens = [];
    await converged(owner, [ada, bob]);
    for (let round = 0; round < 8; round++) {
      const [a, b] = await Promise.all([ada.call('text'), bob.call('text')]), e = EMOJI[round % EMOJI.length];
      const ta = `⟨a${round}${e}⟩`, tb = `⟨b${round}${e}⟩`, to = `⟨o${round}${e}⟩`; tokens.push(ta, tb, to);
      const bobOps = [{ p: pick(rng, b.text), i: tb }], deletable = boundaries(b.text).slice(0, -1).filter(p => !inside(b.text, p) && !/[⟨⟩]/.test(b.text[p]) && p !== bobOps[0].p);
      if (round % 2 && deletable.length) { const p = deletable[Math.floor(rng() * deletable.length)]; bobOps.push({ p, d: cpAt(b.text, p) }); bobOps.sort((x, y) => y.p - x.p); } // higher position first keeps both valid
      await Promise.all([ada.call('edit', { ops: [{ p: pick(rng, a.text), i: ta }] }), bob.call('edit', { ops: bobOps }), owner.sync.localEdit([{ p: pick(rng, owner.sync.text), i: to }])]);
      await converged(owner, [ada, bob]);
    }
    for (let i = 0; i < 3; i++) await Promise.all([ada.call('edit', { ops: [{ p: 0, i: `⟨A${i}😀⟩` }] }), bob.call('edit', { ops: [{ p: 0, i: `⟨B${i}𝒳⟩` }] })]); // bursts queue behind one in-flight op
    tokens.push(...[0, 1, 2].flatMap(i => [`⟨A${i}😀⟩`, `⟨B${i}𝒳⟩`]));
    const [view] = await converged(owner, [ada, bob]);
    for (const token of tokens) assert.equal(view.text.split(token).length, 2, `token ${token} survives exactly once and unsplit`);
    // A large supplementary-only edit (≈80 KB of surrogate pairs) crosses helper and channel intact, and a later joiner receives it in its snapshot.
    const big = '😀'.repeat(20000); await ada.call('edit', { ops: [{ p: 0, i: big }] }); await converged(owner, [ada, bob]);
    const carol = await owner.profile('Carol', 'text'); await converged(owner, [ada, bob, carol]);
    assert.equal(sha((await carol.call('text')).text), sha(owner.sync.text)); assert(owner.sync.text.startsWith(big));
    assert.deepEqual(owner.names().sort(), ['Ada', 'Bob', 'Carol']); await finish(owner);
  } finally { await owner.stop(); }
});

test('undo: each profile reverts only its own edits and the replicas still converge, with concurrent edits in flight', run, async t => {
  if (guard(t, ...SYNC)) return;
  const base = 'A😀B𝒳C', owner = await startOwner(entries, { text: base });
  try {
    const ada = await owner.profile('Ada', 'text'), bob = await owner.profile('Bob', 'text'), end = text => text.length;
    await converged(owner, [ada, bob]);
    await Promise.all([ada.call('edit', { ops: [{ p: end(base), i: '⟨a1⟩' }] }), bob.call('edit', { ops: [{ p: 0, i: '⟨b1😀⟩' }] })]);
    await converged(owner, [ada, bob]);
    await Promise.all([ada.call('edit', { ops: [{ p: end((await ada.call('text')).text), i: '⟨a2😀⟩' }] }), bob.call('edit', { ops: [{ p: end((await bob.call('text')).text), i: '⟨b2⟩' }] })]);
    await converged(owner, [ada, bob]);
    await Promise.all([ada.call('undo'), bob.call('undo'), owner.sync.localEdit([{ p: owner.sync.text.length, i: '⟨o⟩' }])]);   // undo races with a third writer
    let [view] = await converged(owner, [ada, bob]);
    assert(!view.text.includes('a2') && !view.text.includes('b2') && view.text.includes('⟨a1⟩') && view.text.includes('⟨b1😀⟩') && view.text.includes('⟨o⟩'), view.text);
    await ada.call('undo'); await bob.call('undo'); [view] = await converged(owner, [ada, bob]);
    assert.equal(view.text, base + '⟨o⟩', 'only the owner’s own edit remains');
    await assert.rejects(ada.call('undo'), /Nothing to undo/);
    await finish(owner);
  } finally { await owner.stop(); }
});

test('wrong code, wrong room, wrong origin and a half-open join are denied; the owner application never hears them', run, async t => {
  if (guard(t, ...SYNC)) return;
  const owner = await startOwner(entries, { text: BASE });
  try {
    const wrong = [['code', { passcode: 'AAAA-AAAA-AAAA-AAAA' }, /passcode incorrect|unavailable/], ['room id in the key derivation', { roomId: 'Z'.repeat(22) }, /passcode incorrect|unavailable/],
      ['room path', { url: `ws://127.0.0.1:${owner.port}/r/${'Z'.repeat(22)}` }, /refused/], ['origin', { headers: { Origin: 'http://192.168.1.9' } }, /refused/],
      ['room path shape', { url: `ws://127.0.0.1:${owner.port}/` }, /refused/]];
    for (const [label, options, error] of wrong) {
      const eve = await owner.profile('Eve', null);
      await assert.rejects(eve.join(owner, 'text', options), error, `wrong ${label}`); eve.kill();
    }
    const half = rawSocket(owner.port, `/r/${owner.room.roomId}`);                                  // handshake, one bogus hello, then vanish
    await until(() => half.data.includes('101 Switching')); half.socket.write(maskedFrame(new Uint8Array([1, ...randomBytes(65)]))); await sleep(100); half.socket.destroy();
    await sleep(300);
    assert.deepEqual(owner.names(), []); assert.deepEqual(owner.seen, []);
    const ada = await owner.profile('Ada', 'text');                                                     // the room is still healthy afterwards
    await ada.call('edit', { ops: [{ p: 0, i: '😀' }] }); await converged(owner, [ada]); await finish(owner);
  } finally { await owner.stop(); }
});

test('forged, replayed, stale, skipped, oversized and malformed frames and requests are denied while the others keep editing', run, async t => {
  if (guard(t, ...SYNC)) return;
  const owner = await startOwner(entries, { text: BASE });
  try {
    const ada = await owner.profile('Ada', 'text'), bob = await owner.profile('Bob', 'text');
    await ada.call('edit', { ops: [{ p: 0, i: '⟨a⟩' }] }); await converged(owner, [ada, bob]);
    const adaFrame = Buffer.from((await ada.call('frames')).sent.at(-1), 'base64'), seenFor = name => owner.seen.filter(s => s.name === name).length;
    const sentFrame = async eve => Buffer.from((await eve.call('frames')).sent.at(-1), 'base64');
    const raw = frame => ({ data: Buffer.from(frame).toString('base64') });
    const op = (eve, v, extra = {}) => ({ message: { t: 'update', k: 'op', cid: v.cid, n: 1, base: v.version, ops: [{ p: 0, i: 'x' }], ...extra } });
    const attacks = {
      'replayed frame': { prepare: eve => eve.call('edit', { ops: [{ p: 0, i: 'e' }] }), hit: async eve => eve.call('rawSend', raw(await sentFrame(eve))) },
      'frame from another session': { hit: eve => eve.call('rawSend', raw(adaFrame)) },
      'skipped counter': { prepare: eve => eve.call('edit', { ops: [{ p: 0, i: 'e' }] }), hit: async eve => { const f = await sentFrame(eve); f.writeBigUInt64BE(f.readBigUInt64BE(1) + 5n, 1); return eve.call('rawSend', raw(f)); } },
      'forged ciphertext at the right counter': { prepare: eve => eve.call('edit', { ops: [{ p: 0, i: 'e' }] }), hit: async eve => { const f = await sentFrame(eve); f.writeBigUInt64BE(f.readBigUInt64BE(1) + 1n, 1); f[f.length - 1] ^= 1; return eve.call('rawSend', raw(f)); } },
      'zeroed sealed body': { hit: eve => eve.call('rawSend', raw(Buffer.concat([Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 2]), Buffer.alloc(40)]))) },
      'truncated frame': { hit: eve => eve.call('rawSend', raw(Buffer.from([3, 1, 2]))) },
      'unknown frame type': { hit: eve => eve.call('rawSend', raw(Buffer.alloc(40, 9))) },
      'frame over the helper limit (600 KiB)': { hit: eve => eve.call('rawSend', raw(Buffer.alloc(600 * 1024, 3))) },
      'sealed frame at the limit, garbage body': { hit: eve => eve.call('rawSend', raw(Buffer.concat([Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 2]), randomBytes(512 * 1024 - 9)]))) },
      'op over the owner size limit': { app: true, hit: async eve => eve.call('send', op(eve, await eve.call('text'), { ops: [{ p: 0, i: 'x'.repeat(200000) }] })) },
      'malformed op': { app: true, hit: async eve => eve.call('send', op(eve, await eve.call('text'), { ops: 'not ops', n: '1' })) },
      'skipped op id': { app: true, hit: async eve => eve.call('send', op(eve, await eve.call('text'), { n: 9 })) },
      'op under another participant’s client id': { app: true, hit: async eve => eve.call('send', op(eve, await ada.call('text'), { ops: [] })) },
    };
    for (const [label, { prepare, hit, app }] of Object.entries(attacks)) {
      const name = ('Eve ' + label.slice(0, 12)).trim(), eve = await owner.profile(name, 'text');
      await prepare?.(eve); await converged(owner, [ada, bob, eve]);
      const textBefore = owner.sync.text, heard = seenFor(name);
      await hit(eve).catch(() => {});                                  // the client may also refuse to send; the owner must still stay unchanged
      await until(() => !owner.names().includes(name), `${label}: owner drops the peer`);
      await until(async () => (await eve.call('status')).state === 'ended', `${label}: the peer's connection is closed`);
      assert.equal(seenFor(name) - heard, app ? 1 : 0, app ? `${label}: reached the application once and was rejected there` : `${label}: nothing reached the application`);
      assert.equal(owner.sync.text, textBefore, `${label}: owner text unchanged`);
      await ada.call('edit', { ops: [{ p: 0, i: '·' }] }); await converged(owner, [ada, bob]);    // others unaffected
    }
    const eve = await owner.profile('Eve range', 'text'), before = owner.sync.text;                 // well-formed but invalid: refused, text untouched
    await eve.call('send', op(eve, await eve.call('text'), { ops: [{ p: 10 ** 6, i: 'x' }] }));
    await until(async () => (await eve.call('text')).state === 'diverged', 'out-of-range op is refused'); assert.equal(owner.sync.text, before);
    assert(owner.names().includes('Ada') && owner.names().includes('Bob')); await finish(owner);
  } finally { await owner.stop(); }
});

const project = () => ({ main: 'main.tex', files: [
  { path: 'main.tex', bytes: new TextEncoder().encode('\\documentclass{article}\\begin{document}Türkçe 数学 😀 𝒳\\input{chapters/one/two}\\end{document}\n') },
  { path: 'chapters/one/two.tex', bytes: new TextEncoder().encode('Üç ✓ 🇹🇷\n') },
  { path: 'figures/plot.bin', bytes: new Uint8Array(randomBytes(800_000)) },                                  // several 360 KB chunks, arbitrary bytes
  { path: 'out/paper.pdf', bytes: new Uint8Array(Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(150_000), Buffer.from('\n%%EOF\n')])) }] });

test('transfer and permissions: exact nested/binary/PDF bytes; restricted peer cannot copy, export or persist; copy grant, downgrade, revoke, stop, reload', run, async t => {
  if (guard(t, ...STORE)) return;
  const files = project(), expected = Object.fromEntries(files.files.map(f => [f.path, sha(f.bytes)])), owner = await startOwner(entries, { project: files });
  const received = async p => { await p.call('requestSnapshot'); await until(async () => (await p.call('status')).messages.includes('project'), 'project received'); return p.call('storeInfo'); };
  try {
    const ada = await owner.profile('Ada', 'store'), info = await received(ada);
    assert.deepEqual(info.hashes, expected); assert.equal(info.main, 'main.tex'); assert.equal(info.grant, 'online');
    for (const kind of ['copy', 'export', 'download', 'persist']) { assert.equal(await ada.call('storeCan', { kind }), false); await assert.rejects(ada.call('release', { kind }), /denied/); }
    await ada.call('send', { message: { t: 'export', ref: 7 } });                                        // the owner, not the UI, refuses
    await until(async () => (await ada.call('status')).messages.includes('denied'), 'owner denies export');
    assert(!owner.seen.some(s => ['export', 'copy', 'download'].includes(s.t)), 'denied requests never reach the application');
    const peer = owner.peerOf('Ada'); await owner.room.setGrant(peer, 'copy');
    await until(async () => (await ada.call('status')).grant === 'copy', 'copy grant');
    const grantFrame = (await ada.call('frames')).received - 1, one = await ada.call('release', { kind: 'copy' }), two = await ada.call('release', { kind: 'export' });
    assert.deepEqual(one.hashes, expected); assert.deepEqual(two.hashes, expected); assert.notEqual(one.id, two.id, 'each copy is an independent project');
    await ada.call('send', { message: { t: 'export', ref: 8 } }); await until(() => owner.seen.some(s => s.t === 'export'), 'authorized export reaches the owner');
    await owner.room.setGrant(peer, 'online');                                                           // downgrade: no new copies, no recall of the old ones
    await until(async () => (await ada.call('status')).grant === 'online', 'downgrade');
    await assert.rejects(ada.call('release', { kind: 'copy' }), /denied/); assert.deepEqual((await ada.call('storeInfo')).hashes, expected);
    await ada.call('inject', { index: grantFrame });                                                     // replaying the old copy grant must not restore it
    await until(async () => (await ada.call('status')).state === 'ended', 'replayed grant ends the session');
    const after = await ada.call('status'); assert.notEqual(after.grant, 'copy'); assert.equal(after.can, false); assert.equal(after.storeEnded, true);
    await assert.rejects(ada.call('storeInfo'), /ended/);

    const bob = await owner.profile('Bob', 'store'); await received(bob);
    await owner.room.revoke(owner.peerOf('Bob'));
    await until(async () => (await bob.call('status')).state === 'ended', 'revoked peer ends');
    assert.match((await bob.call('status')).ended[0], /removed/); await assert.rejects(bob.call('storeInfo'), /ended/); await assert.rejects(bob.call('send', { message: { t: 'snapshot', req: true } }), /Not connected/);
    bob.kill();
    const bob2 = await owner.profile('Bob', 'store');                                                     // "reload": a new profile holds no project until it asks again
    await assert.rejects(bob2.call('storeInfo'), /No project received/); assert.deepEqual(bob2.files(), []);
    await received(bob2); await owner.room.stop();                                                        // stop sharing revokes everyone
    await until(async () => (await bob2.call('status')).state === 'ended', 'stop ends the session');
    assert.match((await bob2.call('status')).ended[0], /stopped sharing/); await assert.rejects(bob2.call('storeInfo'), /ended/);
    await finish(owner);
  } finally { await owner.stop(); }
});

test('interrupted join, killed participant and host loss keep the owner’s data and lock the participant', run, async t => {
  if (guard(t, ...SYNC)) return;
  const owner = await startOwner(entries, { text: BASE });
  try {
    const ada = await owner.profile('Ada', 'text'), bob = await owner.profile('Bob', 'text');
    await converged(owner, [ada, bob]);
    ada.call('edit', { ops: [{ p: 0, i: '⟨in flight😀⟩' }] }).catch(() => {}); ada.kill();                 // killed with an edit in flight
    await until(() => !owner.names().includes('Ada'), 'owner notices the lost participant');
    assert(owner.sync.text.isWellFormed() && owner.sync.text.includes('İstanbul'));
    const ada2 = await owner.profile('Ada', 'text'); await converged(owner, [bob, ada2]);                  // rejoin gets exactly the owner's text
    const kept = owner.sync.text; owner.helper.child.kill('SIGKILL');                                        // host process lost
    await until(async () => (await bob.call('status')).state === 'ended', 'participant notices host loss');
    const view = await bob.call('text'); assert.equal(view.state, 'locked'); assert.equal(view.text, kept);
    await assert.rejects(bob.call('edit', { ops: [{ p: 0, i: 'x' }] }), /paused/); assert.equal(owner.sync.text, kept);
    await finish(owner);
  } finally { await owner.stop(); }
});

// ---- the native stack: lan-host.mjs + lan-guest.mjs + lan-ot.mjs (production OT) + lan-grants.mjs, guests in isolated profiles ------------------
const FILES = { 'main.tex': 'Hello Türkçe 😀 world\nline two\n', 'sec/a.tex': 'alpha' };
const stackSettled = (stack, owners, profiles, path) => until(async () => {
  const all = [...owners.map(e => e.view()), ...await Promise.all(profiles.map(p => p.call('view', { path })))];
  return all.every(v => v.idle && !v.error && v.version === all[0].version && v.text === all[0].text) && all[0].text === stack.host.text(path);
}, `native convergence on ${path}`);

test('native stack: Unicode edits and undo from two isolated profiles and the owner converge with the production OT', run, async t => {
  if (guard(t, ...STACK)) return;
  const stack = await startStack(entries, { files: FILES });
  try {
    const ada = await stack.profile('Ada', 'guest'), bob = await stack.profile('Bob', 'guest'), own = stack.own('main.tex'), rng = mulberry(11), path = 'main.tex';
    assert.deepEqual((await ada.call('status')).grant, 'online'); await ada.call('open', { path }); await bob.call('open', { path });
    for (let round = 0; round < 12; round++) {
      await Promise.all([ada.call('random', { path, seed: 3 * round + 1, rounds: 4, undoChance: 0.3 }), bob.call('random', { path, seed: 3 * round + 2, rounds: 4, undoChance: 0.3 }), randomEdit(own, rng, 0.3)]);
      if (round % 3 === 2) await stackSettled(stack, [own], [ada, bob], path);
    }
    await stackSettled(stack, [own], [ada, bob], path);
    const text = stack.host.text(path); assert(text.isWellFormed()); assert((await ada.call('view', { path })).acks > 5);
    const big = '😀'.repeat(20000); await ada.call('type', { path, ops: [{ p: 0, i: big }] }); await stackSettled(stack, [own], [ada, bob], path);
    const carol = await stack.profile('Carol', 'guest'); await carol.call('open', { path });                       // a late joiner receives the exact text
    await stackSettled(stack, [own], [ada, bob, carol], path); assert(stack.host.text(path).startsWith(big));
    await bob.call('undoDoc', { path }).catch(() => {});                                                           // may have nothing to undo; the next one is Ada's
    await ada.call('undoDoc', { path }).catch(() => {}); await stackSettled(stack, [own], [ada, bob, carol], path); assert(stack.host.text(path).isWellFormed());
    const other = 'sec/a.tex'; await ada.call('open', { path: other }); await bob.call('open', { path: other });    // files are independent logs
    await Promise.all([ada.call('type', { path: other, ops: [{ p: 5, i: '😀A' }] }), bob.call('type', { path: other, ops: [{ p: 0, i: '𝒳B' }] })]);
    await stackSettled(stack, [], [ada, bob], other); assert.equal(stack.host.text(other).length, 'alpha'.length + 6);
    assert(stack.persisted.some(([p, value]) => p === path && value === stack.host.text(path)), 'the host mirrors committed text back to the source'); await finish(stack);
  } finally { await stack.stop(); }
});

test('native stack carets: relayed with the authenticated name, forged names ignored, malformed carets end the sender', run, async t => {
  if (guard(t, ...STACK)) return;
  const stack = await startStack(entries, { files: FILES });
  try {
    const ada = await stack.profile('Ada', 'guest'), bob = await stack.profile('Bob', 'guest'), path = 'main.tex';
    const seen = async (p, c) => (await p.call('cursorEvents')).some(e => e.name === c.name && e.path === c.path && e.row === c.row && e.column === c.column);
    await ada.call('cursor', { path, row: 0, column: 12 });                                                        // after "Hello Türkçe 😀": a column past a surrogate pair
    await until(() => seen(bob, { name: 'Ada', path, row: 0, column: 12 }), 'Bob sees Ada’s caret'); assert(stack.cursors.some(c => c.name === 'Ada' && c.column === 12), 'the owner sees it too');
    assert.equal(await seen(ada, { name: 'Ada', path, row: 0, column: 12 }), false, 'a caret is not echoed to its sender');
    await stack.host.cursor({ path, row: 1, column: 3 }); await until(() => seen(ada, { name: 'Owner', path, row: 1, column: 3 }), 'participants see the owner’s caret');
    await ada.call('send', { message: { t: 'cursor', name: 'Owner', path, row: 9, column: 9 } });                  // forged attribution
    await until(() => seen(bob, { name: 'Ada', path, row: 9, column: 9 }), 'forged name replaced by the session name'); assert.equal(await seen(bob, { name: 'Owner', path, row: 9, column: 9 }), false);
    await ada.call('send', { message: { t: 'cursor', path, row: -1, column: 2 } });                                // malformed: the host revokes the sender
    await until(() => !stack.names().includes('Ada'), 'malformed caret ends the sender'); await until(async () => (await ada.call('status')).state === 'ended', 'sender is closed');
    await stack.host.cursor({ path, row: 0, column: 1 }); await until(() => seen(bob, { name: 'Owner', path, row: 0, column: 1 }), 'others keep receiving'); await finish(stack);
  } finally { await stack.stop(); }
});

test('native stack permissions: restricted by default, owner-signed one-shot tickets, forged/stale/oversized/replayed requests, downgrade, revoke', run, async t => {
  if (guard(t, ...STACK, 'lan-grants.mjs#GrantAuthority', 'lan-grants.mjs#GrantGate')) return;
  const stack = await startStack(entries, { files: FILES }), expected = Object.fromEntries(Object.entries(FILES).map(([path, text]) => [path, sha(new TextEncoder().encode(text))]));
  try {
    const ada = await stack.profile('Ada', 'guest'), peer = stack.peerOf('Ada'), ref = c => c.repeat(16), now = () => Date.now();
    await assert.rejects(ada.call('exportCopy', { kind: 'export' }), /denied/); await assert.rejects(ada.call('saveCopy'), /denied/);
    for (const message of [{ t: 'copy', kind: 'persist', ref: ref('a'), ts: now() }, { t: 'export' }, { t: 'download' }]) await ada.call('send', { message });   // hand-written requests
    await sleep(300); assert.equal(await ada.call('permit'), false, 'no permit without an owner ticket'); assert.equal((await stack.host.participants()).find(p => p.name === 'Ada').grant, 'online');
    await stack.host.setGrant(peer, 'copy'); await until(async () => (await ada.call('grants')).includes('copy'), 'copy grant');
    const one = await ada.call('exportCopy', { kind: 'export' }), two = await ada.call('exportCopy', { kind: 'download' });
    assert.deepEqual(one.hashes, expected); assert.deepEqual(two.hashes, expected); assert.notEqual(one.id, two.id, 'each copy is independent');
    const saved = await ada.call('saveCopy'); assert.equal(saved.first, true); assert.equal(saved.second, false, 'the storage permit is one-shot'); assert.deepEqual(saved.hashes, expected);
    for (const message of [{ t: 'copy', kind: 'persist', ref: ref('b'), ts: now() - 10 * 60_000 }, { t: 'copy', kind: 'persist', ref: ref('c'), ts: now(), pad: 'x'.repeat(600) },
      { t: 'copy', kind: 'bogus', ref: ref('d'), ts: now() }, { t: 'copy', kind: 'persist', ref: 'x', ts: now() }, ...Array(2).fill({ t: 'copy', kind: 'persist', ref: ref('e'), ts: now() })]) await ada.call('send', { message });
    await sleep(500); assert.equal(await ada.call('permit'), false, 'forged, stale, oversized, malformed and replayed requests earn no usable permit');
    await stack.host.setGrant(peer, 'online'); await until(async () => (await ada.call('grants')).at(-1) === 'online', 'downgrade');
    await assert.rejects(ada.call('exportCopy', { kind: 'export' }), /denied/); await assert.rejects(ada.call('saveCopy'), /denied/);
    assert.deepEqual((await ada.call('storeInfo')).hashes, expected);                                              // no recall: the session still holds what it had, the earlier copies exist
    await stack.host.revoke(peer); await until(async () => (await ada.call('status')).state === 'ended', 'revoked');
    await assert.rejects(ada.call('storeInfo'), /ended/); await assert.rejects(ada.call('exportCopy', { kind: 'export' }), /denied|ended/); await finish(stack);
  } finally { await stack.stop(); }
});
