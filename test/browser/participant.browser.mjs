import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSyntheticAccounts } from './synthetic-accounts.mjs';
import { compileTimeline, now } from './compile-marks.mjs';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
// Default is the original LAN demo; set HOSTING_TEST_BASE/HOSTING_APP_CONTAINER to check a staging candidate.
const base = process.env.HOSTING_TEST_BASE || 'http://127.0.0.1:8080';
assert.equal(new URL(base).hostname, '127.0.0.1', 'This check is restricted to local instances');
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
    const external = [], nativeCompiles = [], errors = [], packageDownloads = new Set(); let publicBytes = 0;
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) { external.push(url.origin); return route.abort(); }
      if (/\/compile(?:\/stop)?$/.test(url.pathname)) { nativeCompiles.push(url.pathname); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message.slice(0, 200)));
    page.on('response', response => {
      if (new URL(response.url()).pathname.startsWith('/participant/')) publicBytes += Number(response.headers()['content-length'] || 0);
      if (/\/texlive-[^/]+\.data$/.test(new URL(response.url()).pathname)) packageDownloads.add(new URL(response.url()).pathname.split('/').pop());
    });
    await page.addInitScript(() => { globalThis.participantResults = []; document.addEventListener('overleaf:participant-result', e => participantResults.push(e.detail)); });
    await page.goto(base + '/login'); await page.locator('input[name=email]').fill(users[0].email);
    await page.locator('input[name=password]').fill(users[0].password); await page.getByRole('button', { name: /^Login/ }).click();
    await page.waitForURL(base + '/project');
    await page.getByRole('button', { name: /^(New project|Create a new project)$/ }).click();
    await page.getByText('Existing project (.zip)', { exact: true }).click();
    await page.locator('input[type=file]').first().setInputFiles(join(work, 'participant.zip'));
    await page.waitForURL(/\/project\/[a-f0-9]+/); const projectUrl = page.url();
    const started = performance.now(), origin = await now(page);
    await page.goto(projectUrl + '?participant-compile=1'); nativeCompiles.length = 0;
    const editor = page.getByRole('textbox', { name: /^Source Editor/ }); await editor.waitFor();
    await page.waitForFunction(() => globalThis.participantResults?.length >= 1, null, { timeout: 180000 });
    await page.locator('.textLayer span').filter({ hasText: /^Participant compilation fixture\./ }).first().waitFor();
    const firstVisibleMs = performance.now() - started, firstVisible = await now(page) - origin;
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
    const info = execFileSync('/Users/macc/miniforge3/envs/myproject/bin/pdfinfo', [join(work, 'output.pdf')], { encoding: 'utf8' });
    assert(/Page size:\s+612 x 792 pts/.test(info), 'The exported PDF must preserve letter-page geometry');
    const fonts = execFileSync('/Users/macc/miniforge3/envs/myproject/bin/pdffonts', [join(work, 'output.pdf')], { encoding: 'utf8' });
    assert(/LMRoman10/.test(fonts) && !/Type 3/.test(fonts), 'The PDF must use the requested scalable Latin Modern text font');
    execFileSync('/Users/macc/miniforge3/envs/myproject/bin/pdftotext', ['-bbox', join(work, 'output.pdf'), join(work, 'bbox.html')]);
    const word = readFileSync(join(work, 'bbox.html'), 'utf8').match(/<word xMin="([\d.]+)"[^>]*>Participant<\/word>/);
    assert(word && Math.abs(Number(word[1]) - 86.944) < 0.2, 'Requested margin and paragraph indentation must survive compilation');
    const target = page.locator('.textLayer span').filter({ hasText: /^Participant compilation fixture\./ }).first();
    const navigation = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/sync/pdf'));
    await target.dblclick(); const nav = await navigation;
    assert(nav.ok(), `Inverse navigation returned ${nav.status()}`);
    const navBody = await nav.json(); assert(navBody.code?.some(p => p.file === 'main.tex' && p.line === 6), JSON.stringify(navBody));
    const exactBefore = await editor.evaluate(e => e.cmView.view.state.doc.toString());
    const warmStart = performance.now(), warmOrigin = await now(page);
    await editor.evaluate(e => { const view = e.cmView.view, text = view.state.doc.toString(), pos = text.indexOf('Participant compilation fixture.'); view.dispatch({ changes: { from: pos, to: pos + 'Participant'.length, insert: 'Repeated' } }); });
    await page.getByRole('button', { name: /^Recompile/ }).first().click();
    await page.waitForFunction(() => participantResults.length >= 2, null, { timeout: 120000 });
    await page.locator('.textLayer span').filter({ hasText: /^Repeated compilation fixture\./ }).first().waitFor();
    const warmVisibleMs = performance.now() - warmStart, warmVisible = await now(page) - warmOrigin;
    const expected = exactBefore.replace('Participant compilation fixture.', 'Repeated compilation fixture.');
    assert.equal(await editor.evaluate(e => e.cmView.view.state.doc.toString()), expected);
    const compilerWorker = page.workers().find(worker => new URL(worker.url()).pathname.endsWith('/busytex_worker.js'));
    assert(compilerWorker, 'Browser compiler worker must be running');
    const memory = await compilerWorker.evaluate(async () => { const module = await self.pipeline.Module; return {
      linearBytes: module.HEAPU8?.length ?? module.HEAP8?.length,
      transferBytes: performance.getEntriesByType('resource').reduce((sum, entry) => sum + entry.transferSize, 0),
    }; });
    // Page marks restart with the project page load; the timeline is relative to that page's origin.
    const timeline = await compileTimeline(page, compilerWorker, await page.evaluate(() => performance.timeOrigin));
    const queueToClaimMs = timeline.filter(e => e.name === 'participant:queue').map(queued => {
      const claimed = timeline.find(e => e.name === 'participant:claimed' && e.t >= queued.t);
      return claimed ? claimed.t - queued.t : null;
    });
    console.log(JSON.stringify({ participantCompileTimeline: { navigationStartsAt: Math.round(await page.evaluate(() => performance.timeOrigin) - origin),
      firstVisible: Math.round(firstVisible), warmVisible: Math.round(warmVisible), warmStartsAt: Math.round(warmOrigin - await page.evaluate(() => performance.timeOrigin)), timeline } }));
    await page.reload(); await editor.waitFor();
    await page.waitForFunction(expected => document.querySelector('[aria-label^="Source Editor"]')?.cmView.view.state.doc.toString() === expected, expected);
    assert.equal(nativeCompiles.length, 0);
    if (process.env.PARTICIPANT_CATALOG_CHECK === '1') {
      assert(packageDownloads.has('texlive-recommended.data'), 'TikZ uses the recommended segment');
      assert(!packageDownloads.has('texlive-extra.data'), 'This fixture must not load extra');
    }
    if (process.env.PARTICIPANT_POOL === '1') {
      const { checkPool } = await import('./participant-pool.mjs');
      await checkPool({ browser, alice: page, users, projectUrl, base });
    }
    if (process.env.PARTICIPANT_EDGES === '1') {
      const { checkEdges } = await import('./participant-edges.mjs'); await checkEdges(page);
    }
    assert.equal(nativeCompiles.length, 0);
    console.log(JSON.stringify({ passed: true, firstVisibleMs, warmVisibleMs, queueToClaimMs, publicResponseBytes: publicBytes, packageDownloads: [...packageDownloads],
      workerLinearMemoryBytes: memory, exactSourceAfterReload: true, bibliography: true, inverseNavigation: true,
      nativeCompiles: nativeCompiles.length, externalRequestsBlocked: external.length, pageErrors: errors }));
  } finally { clearTimeout(hardStop); await browser.close(); }
}, process.env.PARTICIPANT_POOL === '1' ? 5 : 2, process.env.HOSTING_APP_CONTAINER || 'sharelatex'); } finally { rmSync(work, { recursive: true, force: true }); }
