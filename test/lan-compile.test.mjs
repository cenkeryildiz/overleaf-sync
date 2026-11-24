// SPDX-License-Identifier: AGPL-3.0-only
// LAN-COMPILE-01 logic: owner scheduler (ownerGroup), helping participant and requester (participantGroup) over an in-process
// room. The room's grant check is lan-room.mjs's own (tested in lan-room.test.mjs); here every peer is already authorized.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerGroup, participantGroup, texHost, identity, LEASE, ATTEMPTS } from '../runtime/chrome-extension/lan-compile.mjs';

const enc = text => new TextEncoder().encode(text), everyone = [];
test.afterEach(() => { for (const group of everyone.splice(0)) group.lost(); }); // stops heartbeat timers of abandoned workers
const PDF = enc('%PDF-1.5 synthetic'), GZ = Uint8Array.from([0x1f, 0x8b, 8, 0, 1, 2]);
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const until = async (check, what, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 2)); } throw Error('Timed out: ' + what); };

/** A TeX double: each compile waits until the test releases it; `fail` makes it return a TeX error. */
function fakeTex(engines = ['pdflatex']) {
  const tex = { runs: [], cancels: 0, status: async () => ({ directory: '/tex/bin', sandbox: true, engines }), cancel: async () => { tex.cancels++; tex.runs.at(-1)?.reject(Error('Compilation canceled')); },
    compile: (files, main, compiler) => new Promise((resolve, reject) => tex.runs.push({ files, main, compiler, resolve, reject, ok: () => resolve({ pdf: PDF, synctex: GZ, log: 'ok' }) })) };
  return tex;
}
function harness() {
  let clock = 1000; const now = () => clock;
  const files = [{ path: 'main.tex', bytes: enc('\\documentclass{article}\\begin{document}x\\end{document}') }, { path: 'fig/a.bin', bytes: Uint8Array.of(0, 255, 7) }];
  const peers = new Map(), sent = [];
  const room = { sendTo: async (peer, m) => { sent.push([peer, m]); const p = peers.get(peer); if (!p) throw Error('gone'); await p.group.handle(structuredClone(m)); },
    broadcast: async m => { for (const peer of peers.keys()) await room.sendTo(peer, m); } };
  const info = [];
  const owner = ownerGroup({ room, now, timer: false, current: async () => files.map(f => ({ ...f })), onChange: i => info.push(i) });
  const join = (peer, name, tex = null) => {
    const group = participantGroup({ send: async m => owner.onMessage(peer, name, structuredClone(m)), tex, now });
    peers.set(peer, { group, tex }); everyone.push(group); return group;
  };
  return { owner, join, peers, files, sent, info, tick: ms => { clock += ms; owner.tick(); } };
}
const request = (group, files, compiler = 'pdflatex') => group.request({ main: 'main.tex', compiler, files: files.map(f => ({ ...f })) });

test('no helping computer: shared compilation reports unavailable and never queues', async () => {
  const h = harness(), b = h.join('b', 'Bea');
  await assert.rejects(request(b, h.files), /unavailable: no computer is helping/);
  await assert.rejects(h.owner.request({ main: 'main.tex', compiler: 'pdflatex', files: h.files }), /unavailable/);
  assert.equal(h.owner.queued, 0);
});

test('a requester gets the PDF compiled by the one opted-in participant; the identity is the exact input', async () => {
  const h = harness(), texA = fakeTex(), a = h.join('a', 'Ana', texA), b = h.join('b', 'Bea'), c = h.join('c', 'Cem');
  await a.help(true); await settle();
  assert.deepEqual(h.info.at(-1), { workers: 1, engines: ['pdflatex'] }); assert.equal(b.state.workers, 1); assert.equal(c.state.workers, 1);
  const statuses = [], pending = b.request({ main: 'main.tex', compiler: 'pdflatex', files: h.files }, s => statuses.push(s));
  await until(() => texA.runs.length === 1, 'job reaches the contributor');
  assert.deepEqual(texA.runs[0].files.map(f => f.path).sort(), ['fig/a.bin', 'main.tex']);
  assert.deepEqual([...texA.runs[0].files.find(f => f.path === 'fig/a.bin').bytes], [0, 255, 7]);
  texA.runs[0].ok();
  const result = await pending;
  assert.deepEqual([...result.pdf], [...PDF]); assert.deepEqual([...result.synctex], [...GZ]);
  assert.equal(result.stats.by, 'Ana'); assert.ok(result.stats.inBytes > 0 && result.stats.outBytes === PDF.length + GZ.length);
  assert.ok(statuses.some(s => /Compiling on Ana/.test(s)));
  assert.equal(h.sent.filter(([peer, m]) => peer === 'c' && m.t === 'work').length, 0, 'the non-contributor never receives a job');
  await until(() => a.state.done === 1, 'contributor sees the accepted result');
});

test('two contributors share concurrent jobs fairly and take turns on sequential ones', async () => {
  const h = harness(), ta = fakeTex(), tc = fakeTex(), a = h.join('a', 'Ana', ta), c = h.join('c', 'Cem', tc), b = h.join('b', 'Bea'), d = h.join('d', 'Dev');
  await a.help(true); await c.help(true); await settle();
  const one = request(b, h.files), two = request(d, h.files);
  await until(() => ta.runs.length === 1 && tc.runs.length === 1, 'one job per contributor');
  ta.runs[0].ok(); tc.runs[0].ok();
  assert.notEqual((await one).stats.by, (await two).stats.by);
  const by = [];
  for (let i = 0; i < 4; i++) {
    const before = [ta.runs.length, tc.runs.length], p = request(b, h.files);
    await until(() => ta.runs.length + tc.runs.length === before[0] + before[1] + 1, 'next job');
    (ta.runs.length > before[0] ? ta : tc).runs.at(-1).ok(); by.push((await p).stats.by);
  }
  for (let i = 1; i < by.length; i++) assert.notEqual(by[i], by[i - 1], 'sequential jobs alternate: ' + by.join(','));
});

test('stale, foreign and repeated results are refused and never published', async () => {
  const h = harness(), ta = fakeTex(), a = h.join('a', 'Ana', ta), b = h.join('b', 'Bea');
  await a.help(true); await settle();
  const pending = request(b, h.files);
  await until(() => ta.runs.length === 1, 'job');
  const job = h.sent.find(([peer, m]) => peer === 'a' && m.k === 'job')[1];
  const refusedFor = peer => h.sent.filter(([p, m]) => p === peer && m.k === 'refused').length;
  await h.owner.onMessage('a', 'Ana', { t: 'work', k: 'done', job: job.job, lease: job.lease + 1, digest: job.digest, compiler: 'pdflatex', xfer: 'x' }); await settle();
  assert.equal(refusedFor('a'), 1, 'wrong lease');
  await h.owner.onMessage('a', 'Ana', { t: 'work', k: 'done', job: job.job, lease: job.lease, digest: '0'.repeat(64), compiler: 'pdflatex', xfer: 'x' }); await settle();
  assert.equal(refusedFor('a'), 2, 'wrong input identity');
  await h.owner.onMessage('a', 'Ana', { t: 'work', k: 'done', job: job.job, lease: job.lease, digest: job.digest, compiler: 'lualatex', xfer: 'x' }); await settle();
  assert.equal(refusedFor('a'), 3, 'wrong engine');
  await h.owner.onMessage('b', 'Bea', { t: 'work', k: 'done', job: job.job, lease: job.lease, digest: job.digest, compiler: 'pdflatex', xfer: 'x' }); await settle();
  assert.equal(refusedFor('b'), 1, 'a participant that is not helping cannot deliver');
  ta.runs[0].ok(); await pending;
  await h.owner.onMessage('a', 'Ana', { t: 'work', k: 'done', job: job.job, lease: job.lease, digest: job.digest, compiler: 'pdflatex', xfer: 'x' }); await settle();
  assert.equal(refusedFor('a'), 4, 'a duplicate completion');
  assert.equal(h.sent.filter(([p, m]) => p === 'b' && m.k === 'done').length, 1, 'exactly one publication');
});

test('worker loss, opt-out and a lost grant release the job to another contributor; attempts are bounded', async () => {
  const h = harness(), ta = fakeTex(), tc = fakeTex(), a = h.join('a', 'Ana', ta), c = h.join('c', 'Cem', tc), b = h.join('b', 'Bea');
  await a.help(true); await settle();
  const first = request(b, h.files);
  await until(() => ta.runs.length === 1, 'job on Ana');
  await c.help(true); await settle();
  await a.help(false); await settle(); // opt-out: Ana is told to stop, the job moves to Cem
  assert.ok(ta.cancels >= 1); assert.equal(a.state.helping, false);
  await until(() => tc.runs.length === 1, 'released job reaches Cem');
  tc.runs[0].ok(); assert.equal((await first).stats.by, 'Cem');
  // loss: Cem disappears mid-job; with Ana back the job is retried once, then a second loss fails visibly
  await a.help(true); await settle();
  const second = request(b, h.files); second.catch(() => {});
  await until(() => ta.runs.length + tc.runs.length === 3, 'second job');
  const holder = ta.runs.length === 2 ? 'a' : 'c';
  h.owner.leave(holder, 'gone'); h.peers.delete(holder); await settle();
  const other = holder === 'a' ? tc : ta;
  await until(() => other.runs.length === 2, 'retried on the other contributor');
  h.owner.leave(holder === 'a' ? 'c' : 'a', 'gone'); await settle();
  await assert.rejects(second, /failed: the helping computer left/); assert.equal(ATTEMPTS, 2);
});

test('a TeX helper that stops mid-job is a lost worker: the job is retried, not reported as a TeX error', async () => {
  const h = harness(), ta = fakeTex(), tc = fakeTex(), a = h.join('a', 'Ana', ta), c = h.join('c', 'Cem', tc), b = h.join('b', 'Bea');
  await a.help(true); await c.help(true); await settle();
  const p = request(b, h.files);
  await until(() => ta.runs.length + tc.runs.length === 1, 'job started');
  const [dead, other] = ta.runs.length ? [ta, tc] : [tc, ta];
  dead.runs[0].reject(Object.assign(Error('The TeX helper is not installed or stopped.'), { lost: true }));
  await until(() => other.runs.length === 1, 'retried on the other contributor');
  other.runs[0].ok(); assert.equal((await p).stats.by, other === ta ? 'Ana' : 'Cem');
});

test('a downgraded grant stops new work; lease expiry releases a silent worker', async () => {
  const h = harness(), ta = fakeTex(), tc = fakeTex(), a = h.join('a', 'Ana', ta), c = h.join('c', 'Cem', tc), b = h.join('b', 'Bea');
  await a.help(true); await settle();
  h.owner.grant('a', 'online'); await settle();
  assert.equal(a.state.helping, false); assert.match(a.state.status, /no longer allows/); assert.equal(h.owner.workers.length, 0);
  await c.help(true); await settle();
  const p = request(b, h.files);
  await until(() => tc.runs.length === 1, 'job on Cem');
  await a.help(true); await settle(); // Ana opts in again (the grant check is the room's; here the owner simply has two workers)
  h.tick(LEASE + 1); await settle(); // Cem's page stopped sending heartbeats
  await until(() => ta.runs.length === 1, 'expired lease moves the job');
  ta.runs[0].ok(); assert.equal((await p).stats.by, 'Ana');
});

test('a participant copy out of step is retried, a newer request supersedes, an engine nobody has fails at once, TeX errors keep the prior PDF', async () => {
  const h = harness(), ta = fakeTex(), a = h.join('a', 'Ana', ta), b = h.join('b', 'Bea');
  await a.help(true); await settle();
  const copy = [{ path: 'main.tex', bytes: enc('newer text') }, h.files[1]], ahead = request(b, copy); // the participant's edit has not reached the owner yet
  await until(() => h.sent.some(([peer, m]) => peer === 'b' && m.k === 'failed' && m.retry), 'refused while out of step');
  h.files[0].bytes = enc('newer text'); // now it has
  await until(() => ta.runs.length === 1, 'retried request compiles');
  assert.equal(new TextDecoder().decode(ta.runs[0].files.find(f => f.path === 'main.tex').bytes), 'newer text');
  ta.runs[0].ok(); await ahead; ta.runs.length = 0;
  await assert.rejects(request(b, h.files, 'xelatex'), /No helping computer has xelatex/);
  const old = request(b, h.files); old.catch(() => {}); await until(() => ta.runs.length === 1, 'first');
  const newer = request(b, h.files); newer.catch(() => {});
  await assert.rejects(old, /Superseded/);
  await until(() => ta.runs.length === 2, 'newer job reaches Ana after the stop');
  ta.runs[1].reject(Object.assign(Error('Local TeX compilation failed (exit 12, signal 0). Check packages and source.'), { log: '! LaTeX Error: File `nosuch.sty\' not found.' }));
  await assert.rejects(newer, error => /Local TeX compilation failed/.test(error.message) && /Your files and previous PDF are retained/.test(error.message) && /nosuch\.sty/.test(error.log));
  assert.equal(await identity('main.tex', 'pdflatex', h.files), await identity('main.tex', 'pdflatex', [...h.files].reverse()), 'identity ignores file order');
  assert.notEqual(await identity('main.tex', 'pdflatex', h.files), await identity('main.tex', 'lualatex', h.files), 'identity includes the engine');
});

test('texHost stages exact chunks and reassembles streamed PDF and SyncTeX parts', async () => {
  const posted = [], listeners = {};
  let hold = false; const port = { postMessage: m => { posted.push(m); if (!hold) queueMicrotask(() => reply(m)); }, onMessage: { addListener: f => { listeners.message = f; } }, onDisconnect: { addListener: f => { listeners.gone = f; } }, disconnect() {} };
  let first = true;
  const reply = m => {
    if (m.op === 'begin' && first) { first = false; return listeners.message({ id: m.id, error: 'Compilation already running' }); }
    if (m.op !== 'compile') return listeners.message({ id: m.id, result: { ok: true } });
    listeners.message({ id: m.id, part: 'pdf', offset: 0, data: btoa('%PDF-') }); listeners.message({ id: m.id, part: 'pdf', offset: 5, data: btoa('1.5') });
    listeners.message({ id: m.id, part: 'synctex', offset: 0, data: btoa('\x1f\x8b') }); listeners.message({ id: m.id, done: true, log: 'fine' });
  };
  const host = texHost(() => port), big = new Uint8Array(600000).fill(65);
  const out = await host.compile([{ path: 'main.tex', bytes: big }], 'main.tex', 'pdflatex');
  assert.equal(new TextDecoder().decode(out.pdf), '%PDF-1.5'); assert.deepEqual([...out.synctex], [0x1f, 0x8b]); assert.equal(out.log, 'fine');
  const chunks = posted.filter(m => m.op === 'chunk');
  assert.deepEqual(chunks.map(m => m.offset), [0, 270000, 540000]); assert.ok(chunks.every(m => m.data.length <= 360000));
  assert.equal(posted.filter(m => m.op === 'begin').length, 2, 'a just-finished compile is waited for, not reported');
  hold = true; const asked = host.status(); listeners.gone(); await assert.rejects(asked, error => /not installed/.test(error.message) && error.lost === true); // the helper went away mid-call
});
