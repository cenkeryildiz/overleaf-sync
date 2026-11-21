// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderOutput, latexText, latexCoefficientTable, provenance, LIMITS } from '../runtime/research/outputs.mjs';

const png = (w = 2, h = 3, extra = 0) => {
  const bytes = new Uint8Array(33 + extra); bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer); view.setUint32(16, w); view.setUint32(20, h); return Buffer.from(bytes).toString('base64');
};

test('only text, PNG and plain tables render; HTML, SVG, scripts and widgets are blocked', () => {
  for (const mime of ['text/html', 'image/svg+xml', 'application/javascript', 'application/vnd.jupyter.widget-view+json', 'text/latex', 'image/jpeg', '']) {
    const r = renderOutput(mime, '<script>alert(1)</script>'); assert.equal(r.kind, 'blocked', mime); assert.ok(!JSON.stringify(r).includes('<script>') || mime.length === 0);
  }
  assert.deepEqual(renderOutput('text/plain', '<b>x</b>\u202e\u0007ok'), { kind: 'text', text: '<b>x</b>\ufffd\ufffdok', truncated: false });
  const big = renderOutput('text/plain', 'a'.repeat(LIMITS.text + 5)); assert.equal(big.text.length, LIMITS.text); assert.ok(big.truncated);
});

test('PNG validation: signature, header dimensions and size are checked before anything reaches an <img>', () => {
  assert.deepEqual(renderOutput('image/png', png(2, 3)), { kind: 'image', mime: 'image/png', base64: png(2, 3), width: 2, height: 3 });
  for (const bad of [Buffer.from('<svg onload=alert(1)>').toString('base64'), png(0, 5), png(5000, 5), 'not base64!!', png(1, 1, LIMITS.png)]) assert.equal(renderOutput('image/png', bad).kind, 'blocked');
  assert.equal(renderOutput('image/png', 42).kind, 'blocked');
  const forged = Uint8Array.from(atob(png(2, 3)), c => c.charCodeAt(0)); forged[1] = 0x58;       // valid IHDR, wrong magic
  assert.equal(renderOutput('image/png', Buffer.from(forged).toString('base64')).kind, 'blocked');
});

test('tables are bounded, cells are text, malformed shapes are blocked', () => {
  const r = renderOutput('application/x.table+json', { columns: ['a', '<i>b</i>'], rows: [[1, '<img src=x onerror=1>'], [null, 'z', 'extra']] });
  assert.deepEqual(r, { kind: 'table', columns: ['a', '<i>b</i>'], rows: [['1', '<img src=x onerror=1>'], ['', 'z']], truncated: false });
  const wide = renderOutput('application/x.table+json', JSON.stringify({ columns: Array(30).fill('c'), rows: Array(500).fill([1]) }));
  assert.equal(wide.columns.length, LIMITS.columns); assert.equal(wide.rows.length, LIMITS.rows); assert.ok(wide.truncated);
  for (const bad of [null, '{', '{"columns":1,"rows":[]}', { columns: [], rows: 'x' }]) assert.equal(renderOutput('application/x.table+json', bad).kind, 'blocked');
});

test('LaTeX staging escapes hostile names and never emits an unescaped special', () => {
  const hostile = '\\write18{rm -rf ~}%$#_^&{}';
  const escaped = latexText(hostile);
  assert.equal(escaped, '\\textbackslash{}write18\\{rm -rf \\textasciitilde{}\\}\\%\\$\\#\\_\\textasciicircum{}\\&\\{\\}');
  assert.ok(!escaped.includes('\\write18'));
  const result = { status: 'computed', method: 'OLS (lm), classical standard errors', nobs: 12, r_squared: 0.912345, terms: ['(Intercept)', hostile, 'x_1'], estimate: [1.23456789, -2, 3e-8], std_error: [0.1, 0.25, null], p: [0.00012, 0.5, 1] };
  const tex = latexCoefficientTable(result, { caption: 'Wages & hours', label: 'tab:ols' });
  assert.match(tex, /\\caption\{Wages \\& hours\}/); assert.match(tex, /\\label\{tab:ols\}/); assert.match(tex, /x\\_1 & 3e-8 & -- & 1 \\\\/);
  assert.match(tex, /1\.235 & 0\.1 & 0\.000120 ?|1\.235 & 0\.1 & 0\.00012/); assert.match(tex, /\$n=12\$, \$R\^2=0\.9123\$/);
  assert.ok(!tex.includes('\\write18')); assert.ok(tex.startsWith('\\begin{table}') && tex.endsWith('\\end{table}'));
  assert.throws(() => latexCoefficientTable(result, { label: 'x}\\input{/etc/passwd' }), /label/);
  assert.throws(() => latexCoefficientTable({ status: 'inconclusive' }), /Not a computed/);
  assert.throws(() => latexCoefficientTable({ ...result, p: [1] }), /Not a computed/);
});

test('provenance records digests and versions, and refuses absolute or traversing paths', async () => {
  const p = await provenance({ cell: 'analysis/model.R', language: 'R', runtime: 'R 4.6.1', packages: { stats: '4.6.1' }, order: 3, seed: 7, code: 'lm(y~x)', inputs: { 'data/wages.csv': 'a,b\n1,2\n' }, output: { ok: 1 } });
  assert.match(p.code, /^[0-9a-f]{64}$/); assert.match(p.inputs['data/wages.csv'], /^[0-9a-f]{64}$/); assert.equal(p.seed, 7);
  assert.equal(p.code, (await provenance({ cell: 'c', language: 'R', runtime: 'x', order: 0, code: 'lm(y~x)', output: '' })).code);
  for (const bad of ['/Users/macc/secret.csv', '../x.csv', 'a/../../x', 'C:\\x.csv', '~/x', '']) await assert.rejects(provenance({ cell: 'c', language: 'R', runtime: 'x', code: '', inputs: { [bad]: 'x' }, output: '' }), /relative/);
  await assert.rejects(provenance({ cell: '/abs', language: 'R', runtime: 'x', code: '', output: '' }), /relative/);
  assert.ok(!JSON.stringify(p).includes('/Users'));
});
