// SPDX-License-Identifier: AGPL-3.0-only
// Run: node --test test/lan-session-store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { connectStore, SessionStore } from '../runtime/chrome-extension/lan-session-store.mjs';
import { handleSnapshotRequest, CHUNK, MAX_FILES, MAX_FILE, MAX_TOTAL } from '../runtime/chrome-extension/lan-transfer.mjs';
import { harness, until, settle } from './lan-transfer-harness.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const text = value => new TextEncoder().encode(value);
const source = () => ({ main: 'main.tex', files: [
  { path: 'main.tex', bytes: text('\\input{ch/one} Türkçe 😀') }, { path: 'ch/one.tex', bytes: text('one\n'.repeat(50_000)) },
  { path: 'img/a.bin', bytes: Uint8Array.from({ length: CHUNK + 5 }, (_, i) => (i * 31) & 255) },
] });

/** Owner + one participant whose connection is a memory-only store; resolves once the project has been received. */
async function session(extra = {}) {
  const loaded = [], errors = [], ended = [], grants = [], events = {};
  const h = harness({ join: args => { const c = connectStore({ ...args, onProject: p => loaded.push(p), onTransferError: e => errors.push(e), onEnd: r => ended.push(r), onGrant: g => grants.push(g) }); events.c = c; return c.session; },
    onMessage: (peer, message) => handleSnapshotRequest(h.room, peer, message, () => source()), ...extra });
  const link = h.connect(); await link.session.joined;
  const { store, requestSnapshot } = events.c; await requestSnapshot(); await until(() => loaded.length + errors.length > 0);
  return { ...h, link, store, loaded, errors, ended, grants, requestSnapshot };
}

test('a joined participant holds the project in memory with read and edit, and only the default host-online grant', async () => {
  const { store, loaded, errors } = await session();
  assert.deepEqual(errors, []); assert.equal(store.grant, 'online'); assert.equal(store.main, 'main.tex');
  assert.deepEqual(store.paths(), ['ch/one.tex', 'img/a.bin', 'main.tex']);
  for (const file of source().files) assert.equal(sha(store.read(file.path)), sha(file.bytes));
  assert.match(store.readText('main.tex'), /Türkçe 😀/); assert.throws(() => store.readText('img/a.bin'), /UTF-8/); assert.throws(() => store.read('nope'), /No such/);
  store.read('main.tex')[0] = 0; assert.equal(store.readText('main.tex')[0], '\\');                      // reads are copies
  store.write('main.tex', '% edited é'); store.write('new/dir/x.bin', Uint8Array.of(1, 2, 3)); assert.equal(store.readText('main.tex'), '% edited é'); assert.deepEqual([...store.read('new/dir/x.bin')], [1, 2, 3]);
  assert.equal(store.bytes, [...store.paths()].reduce((n, p) => n + store.read(p).length, 0));
  store.remove('new/dir/x.bin'); assert.throws(() => store.remove('main.tex'), /main/); assert.equal(loaded.length, 1);
});

test('edits obey path, conflict and size limits', async () => {
  const { store } = await session();
  for (const bad of ['../x', '/abs', 'a\\b', 'a//b', 'x\u0000']) assert.throws(() => store.write(bad, 'x'), /path/i, bad);
  store.write('MAIN.TEX', '% case variant');                                              // updates main.tex in place: no duplicate, main stays valid
  assert.deepEqual(store.paths(), ['ch/one.tex', 'img/a.bin', 'main.tex']); assert.equal(store.readText('main.tex'), '% case variant');
  assert.throws(() => store.write('ch/one.tex/inner', 'x'), /Conflicting/); assert.throws(() => store.write('ch', 'x'), /Conflicting/);
  assert.throws(() => store.write('big.bin', new Uint8Array(MAX_FILE + 1)), /oversized/); assert.throws(() => store.write('p', 5), /Invalid/);
  for (let i = 0; i < 3; i++) store.write(`fill${i}.bin`, new Uint8Array(MAX_FILE / 2 - 1));
  assert.throws(() => store.write('fill9.bin', new Uint8Array(MAX_FILE / 2 + MAX_FILE / 2)), /size|oversized/); assert.ok(store.bytes <= MAX_TOTAL);
  assert.ok(MAX_FILES >= 100);
});

test('every export, download, copy and persist request is refused unless the owner granted copy', async () => {
  const { store } = await session();
  for (const kind of ['copy', 'export', 'download', 'persist']) { assert.equal(store.can(kind), false); assert.throws(() => store.release(kind), { code: 'denied' }); }
  assert.throws(() => store.copy(), { code: 'denied' }); assert.throws(() => store.release('upload'), /Unknown/); assert.equal(store.can('upload'), false);
  store.setGrant('admin'); assert.equal(store.grant, 'online');                                 // unknown grants are ignored
  const bare = new SessionStore(); assert.throws(() => bare.paths(), /No project/); assert.equal(bare.can('copy'), false);
});

test('copy grant, explicit independent copies, and a downgrade that stops new copies without recalling old ones', async () => {
  const { room, link, store, grants } = await session();
  await room.setGrant(link.peer, 'copy'); await until(() => store.grant === 'copy'); assert.deepEqual(grants, ['copy']);
  const first = store.copy(), second = store.release('export');
  assert.match(first.id, /^[a-f0-9]{24}$/); assert.notEqual(first.id, second.id); assert.equal(first.main, 'main.tex'); assert.equal(first.files.length, 3);
  assert.ok(!('store' in first) && !('origin' in first));
  first.files.find(f => f.path === 'main.tex').bytes.fill(0x41); assert.match(store.readText('main.tex'), /^\\input/);        // not linked: copy edits do not reach the shared project
  store.write('main.tex', '% shared change'); assert.match(new TextDecoder().decode(second.files.find(f => f.path === 'main.tex').bytes), /^\\input/);
  await room.setGrant(link.peer, 'online'); await until(() => store.grant === 'online');
  for (const kind of ['copy', 'export', 'download', 'persist']) assert.throws(() => store.release(kind), { code: 'denied' });
  assert.equal(second.files.length, 3); assert.equal(store.readText('main.tex'), '% shared change');          // earlier copies are not recalled
  await room.setGrant(link.peer, 'copy'); await until(() => store.grant === 'copy'); assert.ok(store.copy().id);
});

test('revoke, stop, leave and host loss each wipe the project; copies already released survive', async () => {
  for (const how of ['revoke', 'stop', 'leave', 'host loss']) {
    const { room, link, store, loaded, ended } = await session(), buffers = [...loaded[0].files.values()];
    await room.setGrant(link.peer, 'copy'); await until(() => store.grant === 'copy'); const copy = store.copy();
    if (how === 'revoke') await room.revoke(link.peer);
    if (how === 'stop') await room.stop();
    if (how === 'leave') link.session.leave();
    if (how === 'host loss') room.disconnected(link.peer), link.session.closed();
    await until(() => ended.length > 0); assert.equal(store.ended, true, how);
    assert.ok(buffers.every(b => b.every(byte => byte === 0)), `${how}: buffers zeroed`);
    for (const call of [() => store.paths(), () => store.read('main.tex'), () => store.write('x', 'y'), () => store.copy(), () => store.release('export')]) assert.throws(call, /ended/, how);
    assert.equal(store.can('copy'), false, how); assert.equal(store.grant, null, how);
    assert.equal(new TextDecoder().decode(copy.files.find(f => f.path === 'main.tex').bytes).slice(0, 6), '\\input', `${how}: released copy intact`);
  }
});

test('a failed or late transfer never replaces or resurrects the project; a verified one replaces it atomically', async () => {
  let version = 1; const events = {};
  const loaded = [], errors = [];
  const h = harness({ join: args => (events.c = connectStore({ ...args, onProject: p => loaded.push(p), onTransferError: e => errors.push(e) })).session,
    onMessage: (peer, message) => handleSnapshotRequest(h.room, peer, message, () => ({ main: 'v.tex', files: [{ path: 'v.tex', bytes: text(`version ${version}`) }] })) });
  const link = h.connect(); await link.session.joined; const { store, requestSnapshot } = events.c;
  await requestSnapshot(); await until(() => loaded.length === 1); const firstBuffer = loaded[0].files.get('v.tex'); assert.equal(store.readText('v.tex'), 'version 1');
  // a hostile owner sends a manifest with a traversal path, then a corrupted chunk: previous project stays intact
  const bad = { t: 'snapshot', xfer: 'c'.repeat(32), main: null, total: 1, files: [{ path: '../evil', size: 1, sha256: '0'.repeat(64), chunks: 1 }] };
  await h.room.sendTo(link.peer, bad); await until(() => errors.length === 1); assert.equal(store.readText('v.tex'), 'version 1');
  const ok = { t: 'snapshot', xfer: 'd'.repeat(32), main: null, total: 1, files: [{ path: 'x', size: 1, sha256: '0'.repeat(64), chunks: 1 }] };
  await h.room.sendTo(link.peer, ok); await h.room.sendTo(link.peer, { t: 'file', xfer: ok.xfer, i: 0, seq: 0, data: 'AA==' }); await until(() => errors.length === 2); assert.equal(store.readText('v.tex'), 'version 1');
  version = 2; await requestSnapshot(); await until(() => loaded.length === 2); assert.equal(store.readText('v.tex'), 'version 2'); assert.ok(firstBuffer.every(b => b === 0));
  const late = (await import('../runtime/chrome-extension/lan-session-store.mjs')).SessionStore; const dead = new late(); dead.wipe();
  const stale = new Map([['a', Uint8Array.of(7, 7)]]); dead.load({ files: stale, main: null, total: 2 }); assert.deepEqual([...stale.get('a')], [0, 0]); assert.throws(() => dead.paths(), /ended/);
});

test('no storage, cache or log is touched during join, transfer, edit, copy, downgrade and wipe', async () => {
  const hits = []; const names = ['indexedDB', 'localStorage', 'sessionStorage', 'caches', 'cookieStore'], saved = new Map();
  for (const name of names) { saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, get() { hits.push(name); throw Error(`${name} must not be used`); } }); }
  const logs = ['log', 'info', 'warn', 'error', 'debug'], originals = logs.map(name => console[name]); logs.forEach(name => { console[name] = () => hits.push(`console.${name}`); });
  try {
    const { room, link, store } = await session();
    await room.setGrant(link.peer, 'copy'); await until(() => store.grant === 'copy'); store.write('a.tex', 'x'); store.copy(); store.release('persist');
    await room.setGrant(link.peer, 'online'); await until(() => store.grant === 'online'); assert.throws(() => store.copy());
    await room.revoke(link.peer); await until(() => store.ended); await settle();
  } finally { logs.forEach((name, i) => { console[name] = originals[i]; }); for (const [name, d] of saved) d ? Object.defineProperty(globalThis, name, d) : delete globalThis[name]; }
  assert.deepEqual(hits, []);
});

test('the modules contain no storage, cache, logging or network API at all', () => {
  const forbidden = /\b(indexedDB|localStorage|sessionStorage|caches|cookieStore|console|fetch|XMLHttpRequest|WebSocket|BroadcastChannel|postMessage|navigator\.storage|document\.cookie|importScripts|eval)\b|new Function/;
  for (const file of ['lan-session-store.mjs', 'lan-transfer.mjs']) {
    const code = readFileSync(new URL(`../runtime/chrome-extension/${file}`, import.meta.url), 'utf8').split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(code, forbidden, file);
  }
});
