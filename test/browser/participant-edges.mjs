import assert from 'node:assert/strict';

export async function checkEdges(page) {
  const editor = page.getByRole('textbox', { name: /^Source Editor/ });
  await page.waitForFunction(() => participantResults.length >= 1, null, { timeout: 120000 });
  await page.locator('.textLayer span').filter({ hasText: /^Repeated compilation fixture\./ }).first().waitFor();
  await page.getByRole('button', { name: /toggle.*compile.*options/i }).click();
  await page.getByRole('menuitem', { name: 'Off', exact: true }).click();
  const source = await editor.evaluate(e => e.cmView.view.state.doc.toString());
  await editor.evaluate(e => { const v = e.cmView.view; v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf('Repeated compilation fixture.') }, scrollIntoView: true }); });
  const forward = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/sync/code'));
  await page.getByRole('button', { name: /go to code location in pdf/i }).click();
  const response = await forward; assert(response.ok());
  const locations = (await response.json()).pdf;
  assert(locations.some(p => p.page === 1 && p.h >= 71 && p.v > 72 && p.v < 120), 'Forward navigation must locate the actual body line');
  const pdfUrl = await page.evaluate(() => performance.getEntriesByType('resource').filter(e => /\/output\/output\.pdf/.test(e.name)).at(-1).name);
  const checksum = await page.evaluate(async url => {
    const bytes = await (await fetch(url)).arrayBuffer(); return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).join(',');
  }, pdfUrl);
  async function replace(text) { await editor.evaluate((e, text) => { const v = e.cmView.view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } }); }, text); }
  const failedSource = source.replace('\\begin{document}', '\\usepackage{qualificationmissingpackage}\n\\begin{document}');
  const beforeFailure = await page.evaluate(() => participantResults.length);
  await replace(failedSource); await page.getByRole('button', { name: /^Recompile/ }).first().click();
  await page.locator('.recovery-controls [role=status]').filter({ hasText: 'Compilation failed; source remains saved' }).waitFor({ timeout: 30000 });
  assert.equal(await page.evaluate(() => participantResults.length), beforeFailure, 'A failed compile must not publish an old PDF');
  assert.equal(await editor.evaluate(e => e.cmView.view.state.doc.toString()), failedSource);
  assert.equal(await page.evaluate(async url => {
    const bytes = await (await fetch(url)).arrayBuffer(); return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).join(',');
  }, pdfUrl), checksum, 'Previous valid export must remain intact');
  await replace(source); await page.getByRole('button', { name: /^Recompile/ }).first().click();
  await page.waitForFunction(count => participantResults.length > count, beforeFailure, { timeout: 60000 });
  const loop = '\\documentclass{article}\n\\begin{document}\n\\loop\\iftrue\\repeat\n\\end{document}\n';
  await replace(loop);
  const heartbeat = page.waitForRequest(req => {
    if (!new URL(req.url()).pathname.endsWith('/participant-compile')) return false;
    try { return req.postDataJSON()?.op === 'heartbeat'; } catch { return false; }
  });
  await page.getByRole('button', { name: /^Recompile/ }).first().click(); await heartbeat;
  const compiler = page.workers().find(w => new URL(w.url()).pathname.endsWith('/busytex_worker.js'));
  const nextWorker = page.waitForEvent('worker', { predicate: w => new URL(w.url()).pathname.endsWith('/busytex_worker.js') });
  const beforeStop = await page.evaluate(() => participantResults.length), stoppedAt = performance.now();
  await page.getByRole('button', { name: /toggle.*compile.*options/i }).click();
  await page.getByRole('menuitem', { name: /stop.*compil/i }).click(); await nextWorker;
  await assert.rejects(() => compiler.evaluate(() => true));
  const stoppedMs = performance.now() - stoppedAt;
  assert.equal(await editor.evaluate(e => e.cmView.view.state.doc.toString()), loop);
  assert.equal(await page.evaluate(() => participantResults.length), beforeStop, 'Canceled work must not publish');
  await replace(source); await page.getByRole('button', { name: /^Recompile/ }).first().click();
  await page.waitForFunction(count => participantResults.length > count, beforeStop, { timeout: 60000 });
  assert.equal(await editor.evaluate(e => e.cmView.view.state.doc.toString()), source);
  console.log(JSON.stringify({ edgeChecksPassed: true, forwardNavigation: true, missingPackageRefused: true,
    previousPdfUnchanged: true, sourceExact: true, canceledWorkerTerminatedMs: stoppedMs, retryAfterCancellation: true }));
}
