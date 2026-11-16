import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const work = mkdtempSync(join(tmpdir(), 'synctex-questions-')), base = 'http://127.0.0.1:8080';
const tex = String.raw`\documentclass{exam}
\usepackage{graphicx}
\begin{document}
\begin{questions}
\question First question.
\newpage
\question Second question.
\begin{figure}[ht]
\centering
\includegraphics[width=8cm]{graph.pdf}
\caption{A separate caption}
\end{figure}
\newpage
\question Third question.
\end{questions}
\end{document}
`;
writeFileSync(join(work, 'graph.tex'), String.raw`\documentclass{article}
\usepackage[paperwidth=8cm,paperheight=4cm,margin=5mm]{geometry}
\pagestyle{empty}
\begin{document}
\begin{center}\textbf{Errors}\end{center}
\noindent\rule{6cm}{1pt}\par
Synthetic plot with a heading inside its PDF asset.
\end{document}
`);
const latex = process.env.LATEX_BINARY || '/Users/macc/texlive-dfv/2026/bin/universal-darwin/pdflatex';
execFileSync(latex, ['-interaction=batchmode', '-halt-on-error', 'graph.tex'], { cwd: work, stdio: 'pipe' });
writeFileSync(join(work, 'main.tex'), tex);
execFileSync('/usr/bin/zip', ['-q', join(work, 'VITAL-NAV-' + Date.now() + '.zip'), 'main.tex', 'graph.pdf'], { cwd: work });
const { readdirSync } = await import('node:fs');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
let projectUrl;
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  await page.goto(base + '/login'); await page.locator('input[name=email]').fill(process.env.OVERLEAF_TEST_ALICE_EMAIL||'alice@example.test');
  await page.locator('input[name=password]').fill(process.env.OVERLEAF_TEST_ALICE_PASSWORD);
  await page.getByRole('button', { name: /^Login/ }).click(); await page.waitForURL(base + '/project');
  await page.getByRole('button', { name: /^(New project|Create a new project)$/ }).click();
  await page.getByText('Existing project (.zip)', { exact: true }).click();
  await page.locator('input[type=file]').first().setInputFiles(join(work, readdirSync(work).find(f => f.endsWith('.zip'))));
  await page.waitForURL(/\/project\/[a-f0-9]+/); projectUrl = page.url(); console.log('Synthetic project: ' + projectUrl);
  await page.waitForFunction(() => document.querySelectorAll('.textLayer span').length > 0);
  for (const pdfPage of await page.locator('.page[data-page-number]').all()) { await pdfPage.scrollIntoViewIfNeeded(); await page.waitForTimeout(100); }
  const editor = page.getByRole('textbox', { name: /^Source Editor/ });
  const samples = [];
  for (const [number, targetSource] of [[2, '\\question Second'], [3, '\\question Third']]) {
    const target = page.locator('.textLayer span').filter({ hasText: new RegExp('^' + number + '\\.\\s') }).first();
    await target.scrollIntoViewIfNeeded();
    const response = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/sync/pdf'));
    await target.dblclick({ position: { x: 5, y: 5 } }); await response;
    await page.waitForFunction(position => { const v = document.querySelector('[aria-label^="Source Editor"]')?.cmView.view; return v?.state.selection.main.from === position; }, tex.indexOf(targetSource));
    const selected = await editor.evaluate(e => { const v = e.cmView.view; return v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to); });
    assert.equal(selected, '\\question'); samples.push({ question: number, exact: true });
  }
  const heading = page.locator('.textLayer span').filter({ hasText: /^Errors$/ }).first(); await heading.scrollIntoViewIfNeeded();
  const response = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/sync/pdf'));
  await heading.dblclick(); await response;
  await page.waitForFunction(position => document.querySelector('[aria-label^="Source Editor"]')?.cmView.view.state.selection.main.from === position, tex.indexOf('\\includegraphics'));
  const selected = await editor.evaluate(e => { const v = e.cmView.view; return v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to); });
  assert(selected.startsWith('\\includegraphics')); assert.equal(await editor.evaluate(e => e.cmView.view.state.doc.toString()), tex);
  console.log(JSON.stringify({ result: 'passed', samples, graphInclusion: true, sourceUnchanged: true, projectUrl, browser: browser.version() }));
} finally { await browser.close(); rmSync(work, { recursive: true, force: true }); if (projectUrl) console.log('Retain for scoped cleanup: ' + projectUrl); }
