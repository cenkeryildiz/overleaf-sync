import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const profile = mkdtempSync(join(tmpdir(), 'overleaf-offline-restart-'));
const base = 'http://127.0.0.1:8080';
let context, passed = false;
async function launch(offline) {
  const c = await chromium.launchPersistentContext(profile, { headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  await c.route('**/*', r => new URL(r.request().url()).origin === base ? r.continue() : r.abort());
  await c.setOffline(offline); return c;
}
try {
  context = await launch(false); let page = context.pages()[0];
  await page.goto(base + '/recovery/local-workspace.html');
  await page.waitForFunction(() => !!globalThis.overleafRecovery);
  await page.evaluate(() => overleafRecovery.offlineReady());
  const key = await page.evaluate(() => {
    const text = 'PersistentOfflineMarker\n';
    const record = { schema: 1, account: '1'.repeat(24), project: '2'.repeat(24), doc: '3'.repeat(24), writer: crypto.randomUUID(), revision: 0, name: 'restart.tex', base: { version: 0, text, kind: 'sharejs-text-ot' }, candidate: text, updatedAt: Date.now() };
    return overleafRecovery.save(record);
  });
  await page.goto(base + '/recovery/local-workspace.html#' + encodeURIComponent(key)); await page.reload();
  const editor = page.getByRole('textbox', { name: 'Local source editor', exact: true }); await editor.waitFor();
  await editor.click(); await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.insertText('TypedBeforeBrowserQuit');
  const exact = await editor.evaluate(e => e.cmView.view.state.doc.toString()); const url = page.url();
  await context.close(); context = await launch(true); page = context.pages()[0];
  const responses = []; page.on('response', r => { if (r.url().startsWith(base)) responses.push({ url: r.url(), worker: r.fromServiceWorker() }); });
  await page.goto(url); await page.getByRole('textbox', { name: 'Local source editor', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Local source editor', exact: true }).evaluate(e => e.cmView.view.state.doc.toString()), exact);
  assert(responses.length >= 7 && responses.every(r => r.worker), 'Offline restart must use cached static assets');
  assert.equal(await page.evaluate(async()=> (await fetch('/project/' + '2'.repeat(24))).status),503);
  passed = true; console.log(JSON.stringify({ result: 'passed', browserProcessRestart: true, offlineResponsesFromWorker: responses.length, exactTextRetained: true, scope: 'graceful process close/reopen on macOS Chrome; not power-loss or eviction qualification' }));
} finally { await context?.close(); if (passed) rmSync(profile,{recursive:true,force:true}); else console.log('Retain unresolved synthetic browser profile: '+profile); }
