// SPDX-License-Identifier: AGPL-3.0-only
// OPT-04 long-session check: repeated carried compiles with the staging site's own browser compiler; prints the total
// resident memory of the browser's processes after selected compiles and fails if it keeps growing after warm-up.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.HOSTING_TEST_BASE || 'http://127.0.0.1:8081';
assert.equal(new URL(base).hostname, '127.0.0.1');
const compiles = Number(process.env.LONG_SESSION_COMPILES || 40);
// Resident memory of the launched browser and all of its descendants, in MiB (macOS/Linux ps).
const marker = '--long-session-marker=' + randomUUID();
function residentMiB() {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' }).trim().split('\n')
    .map(line => { const [pid, ppid, rss, ...command] = line.trim().split(/\s+/); return [Number(pid), Number(ppid), Number(rss), command.join(' ')]; });
  const root = rows.find(([, ppid, , command]) => command.includes(marker) && !rows.some(([pid, , , parent]) => pid === ppid && parent.includes(marker)));
  assert(root, 'Launched browser process not found');
  const tree = new Set([root[0]]); let grew = true;
  while (grew) { grew = false; for (const [pid, ppid] of rows) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); grew = true; } }
  return Math.round(rows.filter(([pid]) => tree.has(pid)).reduce((sum, [, , rss]) => sum + rss, 0) / 1024);
}
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH, args: [marker] });
try {
  const page = await browser.newPage(); await page.goto(base + '/login');
  await page.evaluate(async () => {
    const { BusyTexRunner, PdfLatex } = await import('/recovery/busytex-sdk.mjs');
    const runner = new BusyTexRunner({ busytexBasePath: '/recovery/busytex', engineMode: 'combined', initRetries: 0,
      preloadDataPackages: ['/recovery/busytex/texlive-basic.js'],
      catalogDataPackages: ['/recovery/busytex/texlive-recommended.js', '/recovery/busytex/texlive-extra.js'] });
    await runner.initialize(true);
    let carry = {};
    globalThis.compileOnce = async n => {
      const input = `\\documentclass{article}\n\\begin{document}\n\\section{One}\\label{one}Edit ${n}. See~\\ref{two}.\n\\clearpage\\section{Two}\\label{two}Back to~\\ref{one}.\n\\end{document}\n`;
      const result = await new PdfLatex(runner).compile({ input, mainTexPath: 'main.tex', rerun: true, shellEscape: false, remoteEndpoint: '', shellHandlerScripts: [],
        additionalFiles: Object.entries(carry).map(([path, content]) => ({ path, content })) });
      if (!result.success || !result.pdf) throw Error('Compile ' + n + ' failed');
      carry = result.logs?.at(-1)?.carry || {};
      return (String(result.log).match(/^\$ pdflatex /gm) || []).length;
    };
  });
  const samples = [];
  for (let n = 1; n <= compiles; n++) {
    const started = Date.now(), passes = await page.evaluate(n => compileOnce(n), n);
    if ([1, 5, 10, 20, 30, compiles].includes(n)) samples.push({ compile: n, passes, ms: Date.now() - started, residentMiB: residentMiB() });
  }
  console.log(JSON.stringify({ longSession: samples }));
  // After warm-up (compile 5), memory must not keep climbing: allow 15% plus 64 MiB of allocator noise.
  const warm = samples.find(s => s.compile === 5).residentMiB, last = samples.at(-1).residentMiB;
  assert(last <= warm * 1.15 + 64, `Resident memory grew from ${warm} MiB to ${last} MiB over ${compiles} compiles`);
} finally { await browser.close(); }
