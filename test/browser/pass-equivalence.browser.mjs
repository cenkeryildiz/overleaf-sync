// SPDX-License-Identifier: AGPL-3.0-only
// OPT-02 pass check: compiles fixed fixtures with the staging site's own browser compiler and prints, per fixture, the
// PDF text (pdftotext), page count and number of pdflatex passes. Run on the previous and candidate images, then diff.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.HOSTING_TEST_BASE || 'http://127.0.0.1:8081';
assert.equal(new URL(base).hostname, '127.0.0.1');
const bin = process.env.POPPLER_BIN || '/Users/macc/miniforge3/envs/myproject/bin';
const sections = Array.from({ length: 70 }, (_, i) => `\\section{Section ${i + 1}}\\label{s${i + 1}}Body ${i + 1}.\\clearpage`).join('\n');
const fixtures = {
  plain: { 'main.tex': '\\documentclass{article}\n\\begin{document}\nPlain fixture.\n\\end{document}\n' },
  references: { 'main.tex': '\\documentclass{article}\n\\begin{document}\n\\section{One}\\label{one}See Section~\\ref{two} on page~\\pageref{two}.\n\\clearpage\\section{Two}\\label{two}Back to~\\ref{one}.\n\\end{document}\n' },
  bibliography: { 'main.tex': '\\documentclass{article}\n\\begin{document}\nCited~\\cite{key}.\n\\bibliographystyle{plain}\\bibliography{refs}\n\\end{document}\n',
    'refs.bib': '@book{key, author = {Synthetic Author}, title = {Synthetic Title}, publisher = {Press}, year = {2026}}\n' },
  shiftingContents: { 'main.tex': `\\documentclass{article}\n\\begin{document}\n\\tableofcontents\\clearpage\n${sections}\nLast refers to~\\ref{s70} on page~\\pageref{s70}.\n\\end{document}\n` },
};
const work = mkdtempSync(join(tmpdir(), 'latex-passes-'));
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
try {
  const page = await browser.newPage(); await page.goto(base + '/login');
  const results = await page.evaluate(async fixtures => {
    const { BusyTexRunner, PdfLatex } = await import('/recovery/busytex-sdk.mjs');
    const runner = new BusyTexRunner({ busytexBasePath: '/recovery/busytex', engineMode: 'combined', initRetries: 0,
      preloadDataPackages: ['/recovery/busytex/texlive-basic.js'],
      catalogDataPackages: ['/recovery/busytex/texlive-recommended.js', '/recovery/busytex/texlive-extra.js'] });
    await runner.initialize(true);
    const out = {};
    for (const [name, files] of Object.entries(fixtures)) {
      const started = performance.now();
      const result = await new PdfLatex(runner).compile({ input: files['main.tex'], mainTexPath: 'main.tex', rerun: true, shellEscape: false, remoteEndpoint: '', shellHandlerScripts: [],
        additionalFiles: Object.entries(files).filter(([path]) => path !== 'main.tex').map(([path, content]) => ({ path, content })) });
      out[name] = { success: result.success, ms: Math.round(performance.now() - started), passes: (String(result.log).match(/^\$ pdflatex /gm) || []).length,
        pdf: result.pdf ? btoa(Array.from(result.pdf, b => String.fromCharCode(b)).join('')) : null };
    }
    runner.terminate(); return out;
  }, fixtures);
  const summary = {};
  for (const [name, result] of Object.entries(results)) {
    assert(result.success && result.pdf, name + ' must compile');
    const pdf = join(work, name + '.pdf'); writeFileSync(pdf, Buffer.from(result.pdf, 'base64'));
    execFileSync(join(bin, 'pdftotext'), ['-layout', pdf, join(work, name + '.txt')]);
    const pages = Number(execFileSync(join(bin, 'pdfinfo'), [pdf], { encoding: 'utf8' }).match(/Pages:\s+(\d+)/)[1]);
    summary[name] = { passes: result.passes, ms: result.ms, pages, text: readFileSync(join(work, name + '.txt'), 'utf8') };
  }
  // The contents page must list the final page of every section, not the first pass's numbers.
  assert.match(summary.shiftingContents.text, /Section 70\s*\.*\s*7[0-9]/);
  console.log(JSON.stringify(summary));
} finally { await browser.close(); rmSync(work, { recursive: true, force: true }); }
