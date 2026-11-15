import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url = process.env.OVERLEAF_TEST_PROJECT_URL;
assert(url?.startsWith('http://127.0.0.1:8080/project/'), 'Designate the disposable copy explicitly');
const base = new URL(url).origin, browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
let original, page;
const replies = [], errors = [], samples = [];
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  page = await context.newPage(); page.setDefaultTimeout(35000);
  page.on('request', r => { if(r.method()==='POST' && r.url().includes('preview'))console.log(JSON.stringify({requestPath:new URL(r.url()).pathname})); });
  page.on('response', r => { if(r.request().method()==='POST')console.log(JSON.stringify({responsePath:new URL(r.url()).pathname,status:r.status()})); });
  page.on('pageerror', e => errors.push(e.message.slice(0, 200)));
  page.on('response', async r => { if (new URL(r.url()).pathname.endsWith('/live-preview')) { let data; try { data = await r.json(); } catch {} replies.push({ status: r.status(), ok: data?.ok, error: data?.error, frame: data?.frame, active: data?.active }); } });
  await page.goto(base + '/login'); await page.locator('input[name=email]').fill('alice@example.test');
  await page.locator('input[name=password]').fill(process.env.OVERLEAF_TEST_ALICE_PASSWORD);
  await page.getByRole('button', { name: /^Login/ }).click(); await page.waitForURL(base + '/project');
  await page.goto(url); const editor = page.getByRole('textbox', { name: /^Source Editor/ }); await editor.waitFor();
  original = await editor.evaluate(e => e.cmView.view.state.doc.toString());
  const env = [...original.matchAll(/\\begin\{questions\}/g)].at(-1); assert(env);
  const questions = [...original.slice(env.index).matchAll(/\\question(?:\[[^\]]*\])?/g)]; assert(questions.length >= 3);
  const position = env.index + questions[1].index + questions[1][0].length;
  await editor.evaluate((e, at) => { const v = e.cmView.view; v.dispatch({ selection: { anchor: at }, scrollIntoView: true }); v.focus(); }, position);
  await page.waitForFunction(() => document.querySelector('[aria-label="Live preview"] img')?.complete || document.querySelector('.recovery-controls button:last-child')?.textContent.includes('Retry'), null, { timeout: 40000 });
  if (!await page.locator('[aria-label="Live preview"] img').count()) throw Error('Initial live page unavailable');
  await editor.evaluate((e, at) => { const v = e.cmView.view; v.dispatch({ changes: { from: at, insert: ' LiveProbeA ' }, selection: { anchor: at + 11 } }); v.focus(); }, position);
  await page.waitForFunction(() => document.querySelector('[aria-label="Live preview"]')?.dataset.page === '4', null, { timeout: 20000 });
  await page.waitForTimeout(500);
  for (const letter of ['B', 'C', 'D']) {
    await editor.evaluate(e => { const v = e.cmView.view, at = v.state.doc.toString().indexOf('LiveProbe') + 9; v.dispatch({ selection: { anchor: at, head: at + 1 } }); v.focus(); });
    await page.evaluate(() => {
      globalThis.liveInput = null; globalThis.livePaint = null;
      document.addEventListener('beforeinput', () => { globalThis.liveInput ??= performance.now(); }, { once: true, capture: true });
      document.addEventListener('overleaf:live-frame', () => requestAnimationFrame(() => requestAnimationFrame(() => { globalThis.livePaint = performance.now(); })), { once: true });
    });
    await page.keyboard.type(letter);
    await page.waitForFunction(() => globalThis.livePaint !== null && globalThis.liveInput !== null);
    samples.push(await page.evaluate(() => livePaint - liveInput));
    assert((await editor.evaluate(e => e.cmView.view.state.doc.toString())).includes('LiveProbe' + letter));
  }
  assert(replies.some(r => JSON.stringify(r.frame?.text).includes('LiveProbeD')), 'Rendered text must contain actual latest edit');
  await page.getByRole('button', { name: 'Show final PDF', exact: true }).click();
  assert.equal(await page.locator('[aria-label="Live preview"]').count(), 0);
  assert(await page.locator('.textLayer').count() > 0, 'Native PDF remains available');
  const exact = await editor.evaluate(e => e.cmView.view.state.doc.toString());
  await page.reload(); await editor.waitFor(); assert.equal(await editor.evaluate(e => e.cmView.view.state.doc.toString()), exact);
  console.log(JSON.stringify({ passed: true, samplesMs: samples, frames: replies.filter(r => r.frame).length, errors, sourceReloadExact: true }));
} catch (e) {
  console.log(JSON.stringify({ passed: false, failure: e.message, clientFailure: await page?.evaluate(() => globalThis.__liveFailure), requests: replies.map(r => ({ status: r.status, ok: r.ok, error: r.error, revision: r.frame?.revision })), errors }));
  process.exitCode = 1;
} finally {
  if (original && page && !page.isClosed()) {
    const editor = page.getByRole('textbox', { name: /^Source Editor/ });
    if (await editor.count()) await editor.evaluate((e, text) => { const v = e.cmView.view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } }); }, original);
    await page.waitForTimeout(800);
  }
  if (process.env.HYBRID_RESULT_FILE) fs.writeFileSync(process.env.HYBRID_RESULT_FILE, JSON.stringify({ samples, replies: replies.map(r => ({ status:r.status, ok:r.ok, error:r.error, revision:r.frame?.revision })), errors }), { mode: 0o600 });
  await browser.close();
}
