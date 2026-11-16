import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSyntheticAccounts } from './synthetic-accounts.mjs';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = 'http://127.0.0.1:8080';
const source = String.raw`\documentclass{article}
\usepackage[T1]{fontenc}
\usepackage{lmodern,amsmath,geometry,tikz}
\geometry{letterpaper,margin=1in}
\begin{document}
Participant compilation fixture.
\input{chapter}
\begin{tikzpicture}\draw (0,0) -- (2,1);\end{tikzpicture}
\cite{fixture}
\bibliographystyle{plain}\bibliography{refs}
\end{document}
`;
const work = mkdtempSync(join(tmpdir(), 'participant-check-'));
writeFileSync(join(work, 'main.tex'), source);
writeFileSync(join(work, 'chapter.tex'), 'Exact child source.\n\\[ E=mc^2 + \\int_0^1 x\\,dx \\]\n');
writeFileSync(join(work, 'refs.bib'), '@book{fixture,author={Synthetic Author},title={Participant Fixture},year={2026}}\n');
execFileSync('/usr/bin/zip', ['-q', join(work, 'participant.zip'), 'main.tex', 'chapter.tex', 'refs.bib'], { cwd: work });
try { await withSyntheticAccounts(async users => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  const hardStop = setTimeout(() => browser.close(), 240000);
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, serviceWorkers: 'block' });
    const external = [], nativeCompiles = [], errors = []; let publicBytes = 0;
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) { external.push(url.origin); return route.abort(); }
      if (/\/compile$/.test(url.pathname)) { nativeCompiles.push(url.pathname); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message.slice(0, 200)));
    page.on('response', response => {
      if (new URL(response.url()).pathname.startsWith('/participant/')) publicBytes += Number(response.headers()['content-length'] || 0);
    });
    await page.addInitScript(() => { globalThis.participantResults = []; document.addEventListener('overleaf:participant-result', e => participantResults.push(e.detail)); });
    await page.goto(base + '/login'); await page.locator('input[name=email]').fill(users[0].email);
    await page.locator('input[name=password]').fill(users[0].password); await page.getByRole('button', { name: /^Login/ }).click();
    await page.waitForURL(base + '/project');
    await page.getByRole('button', { name: /^(New project|Create a new project)$/ }).click();
    await page.getByText('Existing project (.zip)', { exact: true }).click();
    await page.locator('input[type=file]').first().setInputFiles(join(work, 'participant.zip'));
    await page.waitForURL(/\/project\/[a-f0-9]+/); const projectUrl = page.url();
    const started = performance.now();
    await page.goto(projectUrl + '?participant-compile=1'); nativeCompiles.length = 0;
    const editor = page.getByRole('textbox', { name: /^Source Editor/ }); await editor.waitFor();
    await page.waitForFunction(() => globalThis.participantResults?.length >= 1, null, { timeout: 180000 });
    await page.locator('.textLayer span').filter({ hasText: /^Participant compilation fixture\./ }).first().waitFor();
    const firstVisibleMs = performance.now() - started;
    assert.equal(await editor.evaluate(e => e.cmView.view.state.doc.toString()), source);
    assert.equal(nativeCompiles.length, 0, 'Participant mode must not request server TeX');
    const output = await page.evaluate(async () => {
      const entries = performance.getEntriesByType('resource').filter(e => /\/output\/output\.pdf/.test(e.name));
      if (!entries.length) throw Error('PDF not requested');
      const response = await fetch(entries.at(-1).name); return Array.from(new Uint8Array(await response.arrayBuffer()));
    });
    writeFileSync(join(work, 'output.pdf'), Buffer.from(output));
    execFileSync('/Users/macc/miniforge3/envs/myproject/bin/pdftotext', ['-layout', join(work, 'output.pdf'), join(work, 'output.txt')]);
    const extracted = readFileSync(join(work, 'output.txt'), 'utf8');
    assert(extracted.includes('Participant compilation fixture.')); assert(extracted.includes('Exact child source.'));
    assert(extracted.includes('Synthetic Author'), 'Bibliography must have completed');
    const target = page.locator('.textLayer span').filter({ hasText: /^Participant compilation fixture\./ }).first();
    const navigation = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/sync/pdf'));
    await target.dblclick(); const nav = await navigation;
    assert(nav.ok(), `Inverse navigation returned ${nav.status()}`);
    const navBody = await nav.json(); assert(navBody.code?.some(p => p.file === 'main.tex' && p.line === 6), JSON.stringify(navBody));
    const exactBefore = await editor.evaluate(e => e.cmView.view.state.doc.toString());
    const warmStart = performance.now();
    await editor.evaluate(e => { const view = e.cmView.view, text = view.state.doc.toString(), pos = text.indexOf('Participant compilation fixture.'); view.dispatch({ changes: { from: pos, to: pos + 'Participant'.length, insert: 'Repeated' } }); });
    await page.getByRole('button', { name: /^Recompile/ }).first().click();
    await page.waitForFunction(() => participantResults.length >= 2, null, { timeout: 120000 });
    await page.locator('.textLayer span').filter({ hasText: /^Repeated compilation fixture\./ }).first().waitFor();
    const warmVisibleMs = performance.now() - warmStart;
    const expected = exactBefore.replace('Participant compilation fixture.', 'Repeated compilation fixture.');
    assert.equal(await editor.evaluate(e => e.cmView.view.state.doc.toString()), expected);
    const compilerWorker = page.workers().find(worker => new URL(worker.url()).pathname.endsWith('/busytex_worker.js'));
    assert(compilerWorker, 'Browser compiler worker must be running');
    const memory = await compilerWorker.evaluate(async () => { const module = await self.pipeline.Module; return module.HEAPU8?.length ?? module.HEAP8?.length; });
    await page.reload(); await editor.waitFor();
    await page.waitForFunction(expected => document.querySelector('[aria-label^="Source Editor"]')?.cmView.view.state.doc.toString() === expected, expected);
    assert.equal(nativeCompiles.length, 0);
    console.log(JSON.stringify({ passed: true, firstVisibleMs, warmVisibleMs, publicResponseBytes: publicBytes,
      workerLinearMemoryBytes: memory, exactSourceAfterReload: true, bibliography: true, inverseNavigation: true,
      nativeCompiles: nativeCompiles.length, externalRequestsBlocked: external.length, pageErrors: errors }));
  } finally { clearTimeout(hardStop); await browser.close(); }
}); } finally { rmSync(work, { recursive: true, force: true }); }
