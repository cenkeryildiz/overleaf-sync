import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
const work = fs.mkdtempSync('/tmp/preamble-test-');
const engine = '/opt/overleaf-native-tex/bin/pdflatex';
const original = '/usr/local/texlive/2026/bin/aarch64-linux/pdftex';
const source = String.raw`\documentclass{exam}
\usepackage[T1]{fontenc}
\usepackage{amsmath,amssymb,mathtools,bm,bbm,mathpazo,siunitx,graphicx,tcolorbox,hyperref}
\newcommand{\Version}{First}
\begin{document}
\Version. SyntheticMarker0000. $\widehat{\mathbb{C}ov}(x,y)$.
\begin{questions}
\question First question. $x^2+y^2=z^2$.
\question Second question. $\frac{a+1}{b+2}$.
\question Third question.
\end{questions}
\end{document}
`;
const environment = { ...process.env, SOURCE_DATE_EPOCH: '1735689600', FORCE_SOURCE_DATE: '1', HOME: work };
function run(dir, text, command = engine) {
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(join(dir, 'main.tex'), text);
  const start = performance.now();
  const result = spawnSync(command, [...(command === original ? ['-progname=pdflatex'] : []), '-synctex=1', '-interaction=batchmode', '-recorder', '--jobname=output', 'main.tex'], { cwd: dir, env: environment, encoding: 'utf8' });
  return { status: result.status, ms: performance.now() - start };
}
const text = dir => execFileSync('pdftotext', ['-layout', join(dir, 'output.pdf'), '-'], { encoding: 'utf8' });
const cache = dir => join(dir, '.overleaf-preamble');
const result = { previous: [], candidate: [], boundaries: [] };
try {
  for (const profile of ['previous', 'candidate']) {
    const dir = join(work, profile);
    for (let i = 0; i < 4; i++) {
      const response = run(dir, source.replace('SyntheticMarker0000', 'SyntheticMarker000' + i), profile === 'previous' ? original : engine);
      assert.equal(response.status, 0); result[profile].push(response.ms);
    }
  }
  const previous = join(work, 'previous'), candidate = join(work, 'candidate');
  assert.equal(text(candidate), text(previous));
  assert(fs.statSync(join(cache(candidate), 'preamble.fmt')).size > 0);
  const key = fs.readFileSync(join(cache(candidate), 'key'), 'utf8');
  assert.equal(run(candidate, source.replace('{First}', '{Second}')).status, 0);
  assert.notEqual(fs.readFileSync(join(cache(candidate), 'key'), 'utf8'), key);
  assert(text(candidate).includes('Second')); result.boundaries.push('preamble invalidates format');
  fs.writeFileSync(join(cache(candidate), 'preamble.fmt'), 'corrupted');
  assert.equal(run(candidate, source).status, 0); assert.equal(text(candidate), text(previous).replace('0003', '0000'));
  result.boundaries.push('corrupted format repaired');
  assert.notEqual(run(candidate, source.replace('SyntheticMarker0000', '\\UndefinedVitalMacro')).status, 0);
  assert.equal(run(candidate, source).status, 0); result.boundaries.push('body failure and retry');
  const before = fs.readFileSync(join(cache(candidate), 'key'), 'utf8');
  fs.writeFileSync(join(candidate, 'local.sty'), '\\ProvidesPackage{local}\n');
  assert.equal(run(candidate, source).status, 0);
  assert.equal(fs.readFileSync(join(cache(candidate), 'key'), 'utf8'), before);
  fs.unlinkSync(join(candidate, 'local.sty')); result.boundaries.push('local style bypass');
  fs.writeFileSync(join(candidate, 'latexmkrc'), '# Synthetic custom config\n');
  assert.equal(run(candidate, source).status, 0);
  assert.equal(fs.readFileSync(join(cache(candidate), 'key'), 'utf8'), before);
  fs.unlinkSync(join(candidate, 'latexmkrc')); result.boundaries.push('custom config bypass');
  const dynamic = join(work, 'dynamic'); fs.mkdirSync(dynamic); fs.writeFileSync(join(dynamic, 'preamble.tex'), '\\newcommand{\\Extra}{Extra}\n');
  assert.equal(run(dynamic, source.replace('\\begin{document}', '\\input{preamble.tex}\n\\begin{document}')).status, 0);
  assert(!fs.existsSync(cache(dynamic))); result.boundaries.push('external preamble bypass');
  const invalid = join(work, 'invalid');
  assert.notEqual(run(invalid, source.replace('\\begin{document}', '\\UnknownPreambleMacro\n\\begin{document}')).status, 0);
  const rejected = fs.readFileSync(join(cache(invalid), 'key'), 'utf8'); assert(rejected.startsWith('unsupported:'));
  assert.notEqual(run(invalid, source.replace('\\begin{document}', '\\UnknownPreambleMacro\n\\begin{document}')).status, 0);
  assert.equal(fs.readFileSync(join(cache(invalid), 'key'), 'utf8'), rejected); result.boundaries.push('unsupported dump retained as native fallback');
  const synctex = execFileSync('synctex', ['view', '-i', '8:0:main.tex', '-o', 'output.pdf'], { cwd: candidate, encoding: 'utf8' });
  assert.match(synctex, /Page:1/); result.boundaries.push('source-to-PDF mapping retained');
  console.log(JSON.stringify({ result: 'passed', ...result }));
} finally { fs.rmSync(work, { recursive: true, force: true }); }
