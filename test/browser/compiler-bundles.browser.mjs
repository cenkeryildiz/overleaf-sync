// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic disposable profile; no real projects, network or helper.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const extension = process.env.LATEX_EXTENSION_PATH;
const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json')));
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].map(b => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('');
const work = mkdtempSync(join(tmpdir(), 'latex-bundle-check-'));
const context = await chromium.launchPersistentContext(join(work, 'profile'), {
  headless: true, executablePath: process.env.EXTENSION_CHROME_PATH,
  ignoreDefaultArgs: ['--disable-extensions'], args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
});
const external = [];
await context.route('**/*', route => { if (/^(https?|wss?):/.test(route.request().url())) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
try {
  await context.setOffline(true);
  const page = await context.newPage();
  const deadline = setTimeout(() => context.close(), 180000);
  try {
    await page.goto(`chrome-extension://${id}/extension/index.html`);
    await page.getByRole('textbox', { name: 'New local project name', exact: true }).waitFor();
    const source = String.raw`\documentclass{article}
\usepackage{tikz}
\usepackage[backend=biber]{biblatex}
\addbibresource{refs.bib}
\begin{document}
Compact bundle check.
\begin{tikzpicture}\node {Diagram};\end{tikzpicture}
\nocite{fixture}\printbibliography
\end{document}`;
    const project = await page.evaluate(async source => {
      const template = await (await fetch('/extension/native-template.json')).json();
      return overleafLocalProjects.local(template, 'Compact optional bundles', [
        { path: 'main.tex', content: source },
        { path: 'refs.bib', content: '@book{fixture,author={Ada Example},title={Compact Bibliography},year={2020},publisher={Example}}' },
      ], 'main.tex', 'pdflatex');
    }, source);
    const started = performance.now();
    await page.goto(`chrome-extension://${id}/recovery/native-workspace.html#${project}`);
    await Promise.race([
      page.locator('.textLayer').filter({ hasText: /Compact\s*Bibliography/ }).first().waitFor({ timeout: 30000 }),
      page.waitForFunction(() => document.querySelector('#local-status')?.dataset.error === 'true', null, { timeout: 30000 }).then(async () => { throw Error(await page.locator('#local-status').textContent()); }),
    ]);
    const state = await page.evaluate(() => overleafLocalProjects.read(location.hash.slice(1)));
    assert(state.project.pdf && state.project.outputDigest && state.project.synctex);
    assert.deepEqual(external, []);
    const biberReady = await Promise.all(page.workers().map(w => w.evaluate(() => !!self.pipeline?.biber?.assets_promise)));
    assert(biberReady.some(Boolean), 'Actual Biber engine must run');
    console.log(JSON.stringify({ optionalBundlePdfMs: Math.round(performance.now() - started), biberEngineRan: true, actualPdfAndBibliography: true, noExternal: true }));
  } catch (error) {
    console.error(JSON.stringify({ status: await page.locator('#local-status').allTextContents() })); throw error;
  } finally { clearTimeout(deadline); }
} finally { await context.close(); rmSync(work, { recursive: true, force: true }); }
