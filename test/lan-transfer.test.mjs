// SPDX-License-Identifier: AGPL-3.0-only
// Run: node --test test/lan-transfer.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { joinRoom, MAX_MESSAGE } from '../runtime/chrome-extension/lan-room.mjs';
import { SnapshotReceiver, sendSnapshot, handleSnapshotRequest, checkManifest, validPath, encode, decode, encodeFallback, decodeFallback, CHUNK, MAX_FILE, MAX_FILES, MAX_TOTAL } from '../runtime/chrome-extension/lan-transfer.mjs';
import { harness, until, settle } from './lan-transfer-harness.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const noise = (length, seed = 1) => { const out = new Uint8Array(length); let s = seed >>> 0; for (let i = 0; i < length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; out[i] = s >>> 24; } return out; };
const text = value => new TextEncoder().encode(value);
const pdf = () => { const body = noise(900_000, 9); body.set(text('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n'), 0); body.set(text('\n%%EOF\n'), body.length - 7); return body; };
const project = () => ({ main: 'main.tex', files: [
  { path: 'main.tex', bytes: text('\\documentclass{article}\n\\begin{document}Türkçe é 数学 😀\\input{chapters/one}\\end{document}\n') },
  { path: 'chapters/one.tex', bytes: text('Chapter one — ğüşiöç 😀\n'.repeat(40_000)) },        // ≈ 1 MB, several chunks
  { path: 'figures/plot.png', bytes: noise(1_100_000, 3) },
  { path: 'out/paper.pdf', bytes: pdf() },
  { path: 'notes/empty.txt', bytes: new Uint8Array(0) },
  { path: 'refs/ünïcode name.bib', bytes: text('@book{a,title={Ä}}') },
] });
const entries = files => files.map(file => ({ path: file.path, size: file.bytes.length, sha256: sha(file.bytes), chunks: Math.ceil(file.bytes.length / CHUNK) }));
/** The messages an honest owner would send, built independently of sendSnapshot. */
const messages = (files, { main = null, xfer = 'a'.repeat(32) } = {}) => {
  const list = entries(files), out = [{ t: 'snapshot', xfer, main, total: list.reduce((n, e) => n + e.size, 0), files: list }];
  files.forEach((file, i) => { for (let seq = 0; seq < list[i].chunks; seq++) out.push({ t: 'file', xfer, i, seq, data: Buffer.from(file.bytes.subarray(seq * CHUNK, (seq + 1) * CHUNK)).toString('base64') }); });
  out.push({ t: 'snapshot', xfer, end: true }); return out;
};
const feed = async (receiver, list) => { let result = null; for (const m of list) result = await receiver.accept(m); return result; };
const small = () => [{ path: 'a.tex', bytes: text('hello') }, { path: 'b/c.bin', bytes: noise(CHUNK + 10, 5) }];

test('a whole project crosses the sealed room layer with exact bytes, and every sealed frame fits the limit', async () => {
  const source = project(), loaded = [], errors = [];
  const { room, connect, links } = harness({ onMessage: (peer, message) => handleSnapshotRequest(room, peer, message, () => source) });
  const link = connect({ onMessage: message => { receiver.accept(message).then(p => { if (p) loaded.push(p); }, e => errors.push(e)); } });
  const receiver = new SnapshotReceiver();
  await link.session.joined; await link.session.send({ t: 'snapshot', req: true });
  await until(() => loaded.length + errors.length > 0);
  assert.deepEqual(errors, []);
  const got = loaded[0]; assert.equal(got.main, 'main.tex'); assert.equal(got.files.size, source.files.length);
  for (const file of source.files) assert.equal(sha(got.files.get(file.path)), sha(file.bytes), file.path);
  assert.equal(got.files.get('main.tex').length, source.files[0].bytes.length);
  assert.ok(links.get(link.peer).toParticipant.length >= 1 + 3 + 3 + 3 + 3 + 1);         // manifest, multi-chunk files, end
  assert.ok(links.get(link.peer).toParticipant.every(frame => frame.length <= MAX_MESSAGE));
  assert.equal(new TextDecoder().decode(got.files.get('refs/ünïcode name.bib')), '@book{a,title={Ä}}');
});

test('a participant cannot make the owner send twice at once, and only a request starts a transfer', async () => {
  let sends = 0; const source = { files: [{ path: 'a.tex', bytes: noise(3 * CHUNK) }] };
  const { room, connect } = harness({ onMessage: (peer, message) => { const run = handleSnapshotRequest(room, peer, message, () => { sends++; return source; }); if (run) run.catch(() => {}); } });
  const link = connect(); await link.session.joined;
  await link.session.send({ t: 'snapshot', req: true }); await link.session.send({ t: 'snapshot', req: true }); await link.session.send({ t: 'file', i: 0 });
  await link.session.send({ t: 'snapshot', xfer: 'a'.repeat(32), files: [] });             // a participant "manifest" is ignored
  await settle(); assert.equal(sends, 1);
  assert.equal(handleSnapshotRequest(room, 1, { t: 'update' }, () => source), null);
});

test('unsafe, duplicate, conflicting or oversized manifests are refused before any byte is staged', async () => {
  const good = messages(small(), { main: 'a.tex' })[0], mutate = change => structuredClone(Object.assign(structuredClone(good), change(structuredClone(good))));
  for (const bad of ['../x', '/abs', 'a//b', 'a/./b', 'a\\b', 'C:x', 'a:b', 'a\u0000b', 'a\nb', 'a\u0085b', '$(x)', 'a;b', 'a|b', 'a"b', '`x`', '', 'a/', './a', 'x'.repeat(1025)])
    assert.throws(() => checkManifest(mutate(m => ({ files: [{ ...m.files[0], path: bad }, m.files[1]], main: null }))), /path/i, JSON.stringify(bad));
  assert.throws(() => checkManifest(mutate(m => ({ files: [m.files[0], { ...m.files[1], path: 'a.tex' }] }))), /Duplicate/);
  assert.throws(() => checkManifest(mutate(m => ({ files: [m.files[0], { ...m.files[1], path: 'A.TEX' }] }))), /Duplicate/);
  assert.throws(() => checkManifest(mutate(m => ({ files: [m.files[0], { ...m.files[1], path: 'a.tex/inner.tex' }] }))), /Conflicting/);
  assert.throws(() => checkManifest(mutate(m => ({ files: [{ ...m.files[0], size: MAX_FILE + 1, chunks: Math.ceil((MAX_FILE + 1) / CHUNK) }, m.files[1]], total: MAX_FILE + 1 + m.files[1].size }))), /size/);
  const big = Array.from({ length: 3 }, (_, i) => ({ path: `f${i}`, size: MAX_FILE, sha256: '0'.repeat(64), chunks: Math.ceil(MAX_FILE / CHUNK) }));
  assert.throws(() => checkManifest({ xfer: 'a'.repeat(32), total: 3 * MAX_FILE, files: big }), /size/);
  assert.throws(() => checkManifest({ ...good, files: Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ path: `f${i}`, size: 0, sha256: '0'.repeat(64), chunks: 0 })), total: 0 }), /manifest/);
  assert.throws(() => checkManifest({ ...good, files: [] }), /manifest/);
  assert.throws(() => checkManifest(mutate(m => ({ total: m.total + 1 }))), /size/);
  assert.throws(() => checkManifest(mutate(m => ({ files: [{ ...m.files[0], chunks: 7 }, m.files[1]] }))), /entry/);
  assert.throws(() => checkManifest(mutate(() => ({ main: 'missing.tex' }))), /Main/);
  assert.throws(() => checkManifest(mutate(() => ({ xfer: 'short' }))), /manifest/);
  assert.throws(() => checkManifest(mutate(m => ({ files: [{ ...m.files[0], sha256: 'ABC' }, m.files[1]] }))), /entry/);
  assert.throws(() => checkManifest(null), /manifest/);
  assert.ok(MAX_TOTAL >= MAX_FILE && validPath('chapters/Türkçe notes.tex'));
  assert.equal(await new SnapshotReceiver().accept({ ...good, files: [{ ...good.files[0], path: '../x' }, good.files[1]] }).then(() => 'accepted', () => 'rejected'), 'rejected');
});

test('out-of-order, repeated, missing, malformed and tampered chunks fail the transfer and expose nothing', async () => {
  const honest = messages(small(), { main: 'a.tex' }), manifest = honest[0], chunks = honest.slice(1, -1), end = honest.at(-1);
  const attacks = {
    'skipped chunk': [manifest, chunks[2], chunks[1], chunks[0], end],
    'repeated chunk': [manifest, chunks[0], chunks[0]],
    'chunk before manifest': [chunks[0]],
    'wrong transfer id': [manifest, { ...chunks[0], xfer: 'b'.repeat(32) }],
    'wrong file index': [manifest, { ...chunks[0], i: 1 }],
    'non-integer seq': [manifest, { ...chunks[0], seq: '0' }],
    'short chunk': [manifest, chunks[0], { ...chunks[1], data: chunks[1].data.slice(0, 8) }],
    'bad base64': [manifest, { ...chunks[0], data: '***' }],
    'wrong length': [manifest, { ...chunks[0], data: Buffer.from('hellox').toString('base64') }],
    'flipped byte': [manifest, { ...chunks[0], data: Buffer.from('jello').toString('base64') }],
    'end too early': [manifest, chunks[0], end],
    'end without manifest': [end],
    'extra chunk after complete': [manifest, ...chunks, { ...chunks[2], seq: 3 }],
    'unknown message type': [manifest, { t: 'update', xfer: manifest.xfer }],
  };
  for (const [name, list] of Object.entries(attacks)) {
    const receiver = new SnapshotReceiver(), results = [];
    await assert.rejects(async () => { for (const m of list) results.push(await receiver.accept(m)); }, undefined, name);
    assert.ok(results.every(r => r === null), `${name}: no project before a verified end`);
    await assert.rejects(receiver.accept(chunks[0]), /No matching/, `${name}: a failed transfer cannot be resumed`);
    assert.ok(await feed(receiver, honest), `${name}: receiver recovers for the next honest transfer`);
  }
  const receiver = new SnapshotReceiver();
  const project1 = await feed(receiver, honest);
  await assert.rejects(receiver.accept(chunks[0]), /No matching/);                    // nothing is accepted after the end marker
  await assert.rejects(receiver.accept(end), /No matching/); assert.equal(project1.main, 'a.tex'); assert.equal(Buffer.from(project1.files.get('a.tex')).toString(), 'hello');
});

test('a new manifest abandons a half-received transfer, which can neither resume nor be exposed', async () => {
  const receiver = new SnapshotReceiver(), first = messages(small(), { xfer: '1'.repeat(32) }), second = messages([{ path: 'z.tex', bytes: text('second') }], { xfer: '2'.repeat(32) });
  await receiver.accept(first[0]); await receiver.accept(first[1]);
  const done = await feed(receiver, second); assert.deepEqual([...done.files.keys()], ['z.tex']);
  await assert.rejects(receiver.accept(first[2]), /No matching/);                         // the old transfer cannot resume
  await receiver.accept(first[0]); await receiver.accept(first[1]); receiver.abort();
  await assert.rejects(receiver.accept(first[2]), /No matching/);
});

test('the owner refuses to send an invalid project and sends nothing', async () => {
  const sent = []; const room = { sendTo: async (...args) => { sent.push(args); } };
  for (const bad of [{ files: [{ path: '../x', bytes: text('x') }] }, { files: [{ path: 'a', bytes: text('x') }, { path: 'A', bytes: text('y') }] }, { files: [{ path: 'a', bytes: 'text' }] },
                     { files: [] }, { files: [{ path: 'a', bytes: text('x') }], main: 'nope' }, null])
    await assert.rejects(sendSnapshot(room, 1, bad));
  assert.deepEqual(sent, []);
});

test('base64: native and fallback agree, and malformed input is refused', () => {
  const bytes = noise(100_003, 7);
  assert.equal(encode(bytes), encodeFallback(bytes)); assert.deepEqual(decode(encode(bytes)), bytes); assert.deepEqual(decodeFallback(encodeFallback(bytes)), bytes);
  for (const bad of ['abc', 'ab=c', 'a b=', '', 'é===', 42, null]) assert.throws(() => decode(bad), /encoding/, String(bad));
});

test('measured: a 20 MB project transfers exactly; time and peak memory are reported', async () => {
  const files = [{ path: 'data/blob.bin', bytes: noise(12 * 1024 * 1024, 11) }, { path: 'text/big.tex', bytes: text('Ünïcode line of text\n'.repeat(400_000)) }, { path: 'out/paper.pdf', bytes: pdf() }];
  const total = files.reduce((n, f) => n + f.bytes.length, 0), expected = new Map(files.map(f => [f.path, sha(f.bytes)]));
  let received = null, failure = null; const receiver = new SnapshotReceiver();
  const { room, connect } = harness({ record: false, onMessage: (peer, message) => handleSnapshotRequest(room, peer, message, () => ({ files, main: null })) });
  const link = connect({ onMessage: message => { receiver.accept(message).then(p => { if (p) received = p; }, e => { failure = e; }); } });
  await link.session.joined; globalThis.gc?.(); const base = process.memoryUsage(); let peak = 0;
  const sampler = setInterval(() => { const m = process.memoryUsage(); peak = Math.max(peak, m.heapUsed + m.arrayBuffers + m.external - base.heapUsed - base.arrayBuffers - base.external); }, 2);
  const started = performance.now(); await link.session.send({ t: 'snapshot', req: true }); await until(() => received || failure, 60_000);
  const seconds = (performance.now() - started) / 1000; clearInterval(sampler);
  assert.equal(failure, null); assert.ok(total >= 20 * 1024 * 1024 - 1);
  for (const [path, digest] of expected) assert.equal(sha(received.files.get(path)), digest, path);
  console.error(`[lan-transfer] ${(total / 1048576).toFixed(1)} MiB, ${files.length} files: ${seconds.toFixed(2)} s (${(total / 1048576 / seconds).toFixed(1)} MiB/s), peak extra heap+buffers ${(peak / 1048576).toFixed(0)} MiB over the already-held source`);
  assert.ok(seconds < 30); assert.ok(peak < 6 * total);
});
