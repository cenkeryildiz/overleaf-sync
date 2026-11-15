import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

// Opt-in: run against the configured local sharelatex container after building the image.
const host = mkdtempSync(join(tmpdir(), 'overleaf-texlive-smoke-'));
const remote = '/tmp/' + basename(host);
const tex = String.raw`\documentclass{exam}
\usepackage[all]{foreign}
\usepackage{mathtools,bbm,subdepth,stackengine,siunitx}
\usepackage{float,booktabs,threeparttable,caption,subcaption,xcolor}
\usepackage{mathrsfs,dsfont,enumitem,setspace,cleveref,dashrule}
\usepackage[sc]{mathpazo}
\usepackage[most]{tcolorbox}
\begin{document}
\begin{questions}
\question Local compilation with required document classes, styles and fonts.
\[\mathbbm{1}+\mathds{R}+\mathscr{F}\]
\begin{tcolorbox}A local box with all standard libraries loaded.\end{tcolorbox}
\end{questions}
\end{document}
`;
try {
  writeFileSync(join(host, 'smoke.tex'), tex);
  execFileSync('docker', ['exec', 'sharelatex', 'mkdir', remote]);
  execFileSync('docker', ['cp', join(host, 'smoke.tex'), 'sharelatex:' + remote + '/smoke.tex']);
  const start = performance.now();
  for (let i = 0; i < 2; i++) {
    let output;
    try {
      output = execFileSync('docker', ['exec', '-w', remote, 'sharelatex', 'pdflatex', '-interaction=nonstopmode', '-halt-on-error', 'smoke.tex'], { encoding: 'utf8' });
    } catch (error) {
      throw new Error(String(error.stdout || error.message).split('\n').filter(line => /^!|not found|not loadable|^l\.\d/.test(line)).slice(0, 8).join('\n'));
    }
    assert(!/Missing character:|Font .*not found|font .*not loadable/i.test(output), 'Missing font or glyph');
  }
  execFileSync('docker', ['cp', 'sharelatex:' + remote + '/smoke.pdf', join(host, 'smoke.pdf')]);
  const pdf = readFileSync(join(host, 'smoke.pdf'));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  console.log(JSON.stringify({ result: 'passed', workload: 'synthetic exam class, required styles, fonts and tcolorbox most libraries', runs: 2, elapsedMs: Math.round(performance.now() - start), pdfBytes: pdf.length }));
} finally {
  execFileSync('docker', ['exec', 'sharelatex', 'rm', '-rf', remote]);
  rmSync(host, { recursive: true, force: true });
}
