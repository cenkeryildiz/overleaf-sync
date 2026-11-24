// SPDX-License-Identifier: AGPL-3.0-only
// P2P-ROOM-01 real-WebRTC check: separate isolated Chrome profiles, real RTCPeerConnection data channels, the unchanged sealed room
// protocol, lan-host startHost and lan-guest joinSession. The room finder is the in-process hub (p2p-signal.mjs memorySignaling)
// run here in Node and reached from each page through a Playwright binding; iceServers are empty, so this is a same-computer
// loopback result, not a two-network one. No external service is contacted. Synthetic project only.
//   PLAYWRIGHT_MODULE=<playwright> [EXTENSION_CHROME_PATH=<chrome>] node test/browser/p2p-room.browser.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { memorySignaling } from '../../runtime/chrome-extension/p2p-signal.mjs';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const runtime = resolve(import.meta.dirname, '../../runtime/chrome-extension'), work = mkdtempSync(join(tmpdir(), 'latex-p2p-check-'));
const ok = (name, detail = '') => console.log('ok -', name, detail);

// Loopback server: the room modules and an empty page (127.0.0.1 is a secure context, so WebCrypto and WebRTC are available).
const server = createServer((req, res) => {
  const name = req.url === '/' ? null : req.url.slice(1);
  if (name && !/^[a-z0-9-]+\.mjs$/.test(name)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': name ? 'text/javascript' : 'text/html' }).end(name ? readFileSync(join(runtime, name)) : '<!doctype html><title>p2p</title>');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const taps = [], hub = memorySignaling({ tap: (...a) => taps.push(a) }), contexts = [];
async function profile(name) {
  const context = await chromium.launchPersistentContext(join(work, name), { headless: true, executablePath: process.env.EXTENSION_CHROME_PATH || undefined });
  contexts.push(context);
  const page = context.pages()[0] ?? await context.newPage(), open = new Map();
  await context.addInitScript(() => { globalThis.LATEX_P2P_TEST_SIGNAL = true; });
  const deliver = (handle, kind, from, message) => page.evaluate(([h, k, f, m]) => globalThis.__p2pDeliver?.(h, k, f, m), [handle, kind, from, message]).catch(() => {});
  await page.exposeBinding('__p2pSignal', async (_, op, args) => {
    if (op === 'open') { open.set(args.handle, await hub.open({ roomId: args.roomId, role: args.role, onSignal: (from, m) => deliver(args.handle, 'signal', from, m), onState: up => deliver(args.handle, 'state', null, up) })); return true; }
    if (op === 'send') return open.get(args.handle)?.send(args.to, args.message);
    if (op === 'close') { open.get(args.handle)?.close(); open.delete(args.handle); }
  });
  await page.goto(origin + '/');
  page.on('pageerror', error => console.error(name, 'page error:', error.message));
  return page;
}

try {
  const owner = await profile('owner'), ada = await profile('ada'), eve = await profile('eve');
  const shared = await owner.evaluate(async () => {
    const [{ startHost }, { p2pHelper }] = await Promise.all([import('/lan-host.mjs'), import('/p2p-transport.mjs')]);
    const big = Uint8Array.from({ length: 900_000 }, (_, i) => (i * 7919) & 255), text = 'MARKER-SOURCE Merhaba Türkçe 😀 𝔛\n';
    const source = { tree: () => ({ main: 'main.tex', docs: ['main.tex'], files: [{ path: 'main.tex', bytes: new TextEncoder().encode(text) }, { path: 'fig/plot.bin', bytes: big }] }),
      text: path => path === 'main.tex' ? { text, version: 1 } : null, persist: () => {} };
    const host = globalThis.host = await startHost({ helper: p2pHelper(), source, onPeers: () => {} });
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', big))].map(b => b.toString(16).padStart(2, '0')).join('');
    return { link: host.link, passcode: host.passcode, digest, text };
  });
  assert.match(shared.link, /#room=[A-Za-z0-9_-]{22}$/);
  ok('owner opened an internet room', shared.link.replace(/.*#/, '#'));

  const joinIn = (page, passcode, username) => page.evaluate(async ({ link, passcode, username }) => {
    const { joinSession } = await import('/lan-guest.mjs'), started = performance.now();
    try {
      const remotes = globalThis.remotes = [];
      const ctl = globalThis.ctl = await joinSession({ link, passcode, username, retries: [], onRemote: (path, e) => remotes.push(e.op) });
      const big = ctl.store.read('fig/plot.bin');
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', big))].map(b => b.toString(16).padStart(2, '0')).join('');
      return { ms: Math.round(performance.now() - started), text: new TextDecoder().decode(ctl.store.read('main.tex')), digest, size: big.length };
    } catch (error) { return { error: error.message }; }
  }, { link: shared.link, passcode, username });

  const joined = await joinIn(ada, shared.passcode, 'Ada 😀');
  assert.ok(!joined.error, joined.error);
  assert.equal(joined.text, shared.text); assert.equal(joined.digest, shared.digest); assert.equal(joined.size, 900_000);
  ok('participant joined over a real data channel with a byte-exact snapshot', `${joined.ms} ms, 0.9 MB binary + Unicode source`);

  const edits = await ada.evaluate(async () => {
    const doc = await ctl.join('main.tex'), t0 = performance.now();
    const v = await ctl.edit('main.tex', { op: [{ p: 0, i: 'é' }], v: doc.v });
    return { v, before: doc.v, ackMs: Math.round(performance.now() - t0) };
  });
  assert.equal(edits.v, edits.before);
  assert.equal(await owner.evaluate(() => host.text('main.tex')), 'é' + shared.text);
  await owner.evaluate(async () => { const d = host.join('main.tex'); await host.edit('main.tex', { op: [{ p: host.text('main.tex').length, i: '∑' }], v: d.v }); });
  await ada.waitForFunction(() => globalThis.remotes.length === 1);
  assert.deepEqual(await ada.evaluate(() => globalThis.remotes[0]), [{ p: shared.text.length + 1, i: '∑' }]);
  ok('live edits converge both ways', `participant edit acknowledged in ${edits.ackMs} ms`);

  const refused = await joinIn(eve, 'AAAA-AAAA-AAAA-AAAA', 'Eve');
  assert.ok(refused.error, 'wrong passcode must be refused');
  assert.deepEqual(await owner.evaluate(() => host.participants().map(p => p.name)), ['Ada 😀']);
  ok('wrong passcode refused; nothing adopted', refused.error);

  const seen = JSON.stringify(taps);
  assert.ok(taps.length && taps.every(([, , , m]) => ['offer', 'answer', 'ice', 'bye'].includes(m.t)));
  for (const secret of [shared.passcode, shared.passcode.replaceAll('-', ''), 'MARKER-SOURCE', 'Ada', 'Eve', 'Türkçe']) assert.ok(!seen.includes(secret), `finder saw ${secret}`);
  ok('room finder carried only offers, answers and ICE', `${taps.length} messages, ${seen.length} bytes; no passcode, name or source`);

  hub.outage(true);
  const after = await ada.evaluate(async () => (await ctl.edit('main.tex', { op: [{ p: 0, i: 'z' }], v: (await ctl.join('main.tex')).v })) >= 0);
  assert.ok(after); hub.outage(false);
  ok('a finder outage does not interrupt the open session');

  await ada.evaluate(() => ctl.leave());
  await owner.waitForFunction(() => host.participants().length === 0);
  await owner.evaluate(() => host.stop());
  ok('leave and stop sharing');
  console.log('p2p-room.browser: all checks passed');
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  server.close(); rmSync(work, { recursive: true, force: true });
}
