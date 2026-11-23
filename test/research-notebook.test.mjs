// SPDX-License-Identifier: AGPL-3.0-only
// DOCEXEC-01 notebook import/export (runtime/research/notebook.mjs): round trips, refusals, dropped outputs, and the exported
// JSON checked by Jupyter's own nbformat validator when RESEARCH_PYTHON (a Python with nbformat) is given.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { toNotebook, fromNotebook, convertedPath, LIMITS } from '../runtime/research/notebook.mjs';

const script = '# %% setup\nimport math\nx = 21\n# %% [markdown] Notes\n# A *result*:\n#\n# $x^2$\n# %%\nprint(x * 2)\n';

test('script -> notebook -> script is exact for percent-format text', () => {
  const nb = JSON.parse(toNotebook(script, 'python'));
  assert.equal(nb.nbformat, 4); assert.equal(nb.metadata.kernelspec.name, 'python3');
  assert.deepEqual(nb.cells.map(c => c.cell_type), ['code', 'markdown', 'code']);
  assert.deepEqual(nb.cells[0], { cell_type: 'code', execution_count: null, metadata: { title: 'setup' }, outputs: [], source: ['import math\n', 'x = 21'] });
  assert.deepEqual(nb.cells[1].source, ['A *result*:\n', '\n', '$x^2$']); assert.equal(nb.cells[1].metadata.title, 'Notes');
  const back = fromNotebook(toNotebook(script, 'python'));
  assert.deepEqual(back, { language: 'python', text: script, dropped: 0 });
});

test('R scripts export with the ir kernel and come back as R', () => {
  const r = '# %%\nv <- c(1, 2, 3)\nmean(v)\n', nb = JSON.parse(toNotebook(r, 'r'));
  assert.equal(nb.metadata.kernelspec.name, 'ir'); assert.equal(nb.metadata.kernelspec.language, 'R');
  assert.deepEqual(fromNotebook(JSON.stringify(nb)), { language: 'r', text: r, dropped: 0 });
});

test('a file without markers becomes one code cell', () => {
  assert.deepEqual(JSON.parse(toNotebook('print(1)\n', 'python')).cells.map(c => c.source), [['print(1)']]);
});

test('imported outputs are counted and dropped, never carried into the script', () => {
  const nb = { nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { language: 'python' } }, cells: [
    { cell_type: 'code', source: 'display(x)', outputs: [{ output_type: 'display_data', data: { 'text/html': '<script>alert(1)</script>' } }, { output_type: 'stream', text: 'secret' }] },
    { cell_type: 'markdown', source: ['<img src=x onerror=alert(1)>'] }, { cell_type: 'raw', source: '\\section{Raw}' }] };
  const r = fromNotebook(JSON.stringify(nb));
  assert.equal(r.dropped, 2); assert.doesNotMatch(r.text, /alert\(1\)<\/script>|secret/);
  assert.equal(r.text, '# %%\ndisplay(x)\n# %% [markdown]\n# <img src=x onerror=alert(1)>\n# %% [raw]\n# \\section{Raw}\n', 'markdown and raw stay commented text');
});

test('refusals are explicit', () => {
  assert.throws(() => fromNotebook('{'), /does not parse/);
  assert.throws(() => fromNotebook(JSON.stringify({ nbformat: 3, worksheets: [] })), /nbformat 4/);
  assert.throws(() => fromNotebook(JSON.stringify({ nbformat: 4, cells: [], metadata: { kernelspec: { language: 'julia' } } })), /julia cannot be converted/);
  assert.throws(() => fromNotebook(JSON.stringify({ nbformat: 4, cells: [] })), /unknown language/);
  assert.throws(() => fromNotebook(JSON.stringify({ nbformat: 4, cells: Array(LIMITS.cells + 1).fill({ cell_type: 'code', source: '' }), metadata: { language_info: { name: 'python' } } })), /too many cells/);
  assert.throws(() => fromNotebook('x'.repeat(LIMITS.bytes + 1)), /too large/);
  assert.throws(() => toNotebook('x', 'julia'), /\.py or \.R/);
  assert.throws(() => toNotebook('# %%\n'.repeat(LIMITS.cells + 1), 'python'), /too many cells/);
});

test('converted paths stay beside the source', () => {
  assert.equal(convertedPath('code/analysis.py', 'notebook'), 'code/analysis.ipynb');
  assert.equal(convertedPath('code/model.R', 'notebook'), 'code/model.ipynb');
  assert.equal(convertedPath('nb/run.ipynb', 'python'), 'nb/run.py'); assert.equal(convertedPath('nb/run.ipynb', 'r'), 'nb/run.R');
});

test('exported notebooks pass Jupyter\'s nbformat validator', { skip: !process.env.RESEARCH_PYTHON && 'set RESEARCH_PYTHON to a Python with nbformat' }, () => {
  for (const [text, language] of [[script, 'python'], ['# %%\nmean(c(1, 2))\n', 'r']]) {
    const run = spawnSync(process.env.RESEARCH_PYTHON, ['-I', '-c', 'import sys, nbformat; nbformat.validate(nbformat.reads(sys.stdin.read(), as_version=4)); print("valid")'], { input: toNotebook(text, language), encoding: 'utf8' });
    assert.equal(run.stdout.trim(), 'valid', run.stderr);
  }
});
