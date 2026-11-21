// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { mathSnippets, snippetAt, trimSelection, mathRequest, declarations, contextFor, analysisSpecs, resultBlocks, resultBlock, parseCsv, buildRequest, renderLatex, projectState } from '../runtime/research/manuscript.mjs';

test('math snippets carry exact content offsets and skip comments and escaped dollars', () => {
  const doc = 'Cost \\$5 and $x^2$.\n% $y$ in a comment\n\\[ \\frac{a}{b} \\]\n\\begin{equation}\\label{e} z = 1 \\end{equation}\n50\\% off $w$';
  const found = mathSnippets(doc);
  assert.deepEqual(found.map(s => s.text), ['x^2', ' \\frac{a}{b} ', '\\label{e} z = 1 ', 'w']);
  for (const s of found) assert.equal(doc.slice(s.base, s.end), s.text);
  assert.equal(snippetAt(doc, doc.indexOf('x^2') + 1).text, 'x^2');
  assert.equal(snippetAt(doc, doc.indexOf('Cost')), null);
});

test('a selection is trimmed of delimiters, labels and punctuation without moving offsets', () => {
  const doc = 'See $\\sqrt{x^2} = x$, then';
  const from = doc.indexOf('$'), to = doc.indexOf(',') + 1, t = trimSelection(doc.slice(from, to), from);
  assert.equal(t.text, '\\sqrt{x^2} = x'); assert.equal(doc.slice(t.base, t.base + t.text.length), t.text);
  const eq = '\\begin{equation}\\label{k} a = b. \\end{equation}', e = trimSelection(eq, 10);
  assert.equal(e.text, 'a = b'); assert.equal(eq.slice(e.base - 10, e.base - 10 + 5), 'a = b');
});

test('inequalities and several relations become a constraint check with exact part offsets', () => {
  const text = 'x > 2, \\quad x < 1', r = mathRequest(text, 100, {});
  assert.equal(r.op, 'constraints'); assert.deepEqual(r.texts, ['x > 2', 'x < 1']);
  for (const p of r.parts) assert.equal(text.slice(p.base - 100, p.base - 100 + p.text.length), p.text);
  assert.deepEqual(mathRequest('f(x, y) = 1', 0, {}).op, 'check');   // commas inside parentheses do not split
  assert.equal(mathRequest('a \\le b', 0, {}).op, 'constraints');
});

test('% assume: declarations give the check context; the panel overrides one symbol', () => {
  const doc = 'x\n% assume: x positive nonzero; \\alpha real, y_{1} integer\n% assume x negative\n%assume: q postive';
  const d = declarations(doc);
  assert.deepEqual(d.map(v => [v.name, v.assumptions]), [['x', ['positive', 'nonzero']], ['alpha', ['real']], ['y_1', ['integer']], ['x', ['negative']], ['q', ['postive']]]);
  for (const v of d) assert.equal(doc.slice(...v.range).split(/\s+/)[0], v.symbol);
  assert.deepEqual(contextFor(d, { alpha: ['positive'] }).symbols, { x: ['positive', 'nonzero'], alpha: ['positive'], y_1: ['integer'], q: [] });
});

test('analysis specs are data: ops are whitelisted, paths are project-relative, flags and quoted captions parse', () => {
  const doc = '% analysis wages python ols data=data/w.csv y=wage x=educ,exper robust caption="Wage & schooling"\n% analysis bad r lm data=x.csv\n% analysis p r ols data=../etc/passwd\n% analysis 9x r ols data=a.csv\n% analysis s r ttest data=a.csv x=v inputs=@wages,notes.txt';
  const [w, bad, up, id, s] = analysisSpecs(doc, 'main.tex');
  assert.equal(w.error, null); assert.deepEqual(w.params, { data: 'data/w.csv', y: 'wage', x: 'educ,exper', caption: 'Wage & schooling', robust: true });
  assert.match(bad.error, /ols, panel_fe, ttest, arima/); assert.match(up.error, /project file/); assert.match(id.error, /letter/);
  assert.deepEqual(s.inputs, ['a.csv', '@wages', 'notes.txt']);
  const request = buildRequest(w, { columns: { wage: [1], 'educ': [2], exper: [3] } });
  assert.deepEqual(request, { op: 'ols', data: { wage: [1], educ: [2], exper: [3] }, y: 'wage', x: ['educ', 'exper'], robust: true });
});

test('CSV parsing keeps quoted commas, maps empty cells to null and refuses ragged rows', () => {
  assert.deepEqual(parseCsv('a,b,"c,d"\r\n1,,x\n2.5,3,"say ""hi"""\n').columns, { a: [1, 2.5], b: [null, 3], 'c,d': ['x', 'say "hi"'] });
  assert.throws(() => parseCsv('a,b\n1\n'), /as many cells/); assert.throws(() => parseCsv('a,a\n1,2'), /distinct/); assert.throws(() => parseCsv(undefined), /missing/);
});

test('inserted LaTeX is escaped and the t-test sentence states its interval and hypothesis', () => {
  const [spec] = analysisSpecs('% analysis m r ttest data=a.csv x=v caption="50% & $"');
  const sentence = renderLatex(spec, { status: 'computed', estimate: 2.5, mu: 0, t: 3.872983, df: 3, p: 0.0304663, conf_level: 0.95, ci_low: 0.4457397, ci_high: 4.55426 });
  assert.equal(sentence, '$\\bar{x} = 2.5$ (95\\% CI $[0.4457, 4.554]$; $t_{3} = 3.873$, $p = 0.0305$, $H_0\\colon \\mu = 0$)');
  const [ols] = analysisSpecs('% analysis o python ols data=a.csv y=y x=x_1 caption="50% & $" label=tab:o');
  const table = renderLatex(ols, { status: 'computed', terms: ['(Intercept)', 'x_1'], estimate: [1, 2], std_error: [0.1, 0.2], p: [0.5, 0.01], nobs: 10, r_squared: 0.9, method: 'OLS' });
  assert.match(table, /\\caption\{50\\% \\& \\\$\}/); assert.match(table, /x\\_1 & 2 & 0\.2 & 0\.01/); assert.match(table, /\\label\{tab:o\}/);
  assert.throws(() => renderLatex(ols, { status: 'inconclusive' }), /computed/);
});

test('stale marking follows declared inputs only, survives reload through the block key, and refuses cycles and missing inputs', async () => {
  const tex = extra => `\\section{R}\n% analysis a r ols data=d.csv y=y x=x\n% analysis b r ttest data=e.csv x=v inputs=@a\n% analysis c r ttest data=e.csv x=v\n${extra}`;
  const files = (main, d = 'y,x\n1,2\n', e = 'v\n1\n2\n') => ({ 'main.tex': { content: main }, 'd.csv': { content: d }, 'e.csv': { content: e }, 'fig.png': { hash: 'abc' } });
  let s = await projectState(files(tex('')));
  assert.deepEqual([...s.states.values()].map(v => v.status), ['new', 'new', 'new']);
  assert.ok(s.order.indexOf('a') < s.order.indexOf('b'), 'a dependency is recomputed first');
  const blocks = ['a', 'b', 'c'].map(id => resultBlock(id, s.states.get(id).key, 'X', 'note')).join('\n');
  assert.deepEqual(resultBlocks(tex(blocks)).map(b => b.id), ['a', 'b', 'c']);
  s = await projectState(files(tex(blocks)));
  assert.deepEqual([...s.states.values()].map(v => v.status), ['fresh', 'fresh', 'fresh'], 'a reload with unchanged inputs is fresh without running anything');
  s = await projectState(files(tex(blocks), 'y,x\n1,3\n'));
  assert.deepEqual([...s.states.values()].map(v => v.status), ['stale', 'stale', 'fresh'], 'd.csv feeds a, and b declares @a; c is independent');
  s = await projectState(files(tex(blocks)));
  assert.equal(s.states.get('a').status, 'fresh', 'reverting the data makes it fresh again');
  s = await projectState(files(tex(blocks).replace('x=x', 'x=x robust')));
  assert.equal(s.states.get('a').status, 'stale', 'a changed spec is a code change');
  s = await projectState(files(tex('% analysis d r ttest data=e.csv x=v inputs=@f\n% analysis f r ttest data=e.csv x=v inputs=@d\n% analysis g r ttest data=nope.csv x=v\n% analysis h r ttest data=e.csv x=v inputs=@d\n% analysis g r ols data=e.csv y=v x=v')));
  assert.match(s.states.get('d').reason, /cycle: (d → f → d|f → d → f)/); assert.match(s.states.get('g').reason, /Missing input nope\.csv/); assert.match(s.states.get('h').reason, /Missing input d/, 'depending on a refused result is refused'); assert.equal(s.states.get('c').status, 'new');
  assert.equal((await projectState(files(tex('% analysis a r ttest data=e.csv x=v')))).states.get('a').status, 'new', 'the first declaration of an id wins');
  const dup = [...(await projectState(files('% analysis a r ttest data=e.csv x=v\n% analysis a r ttest data=e.csv x=v'))).states.values()];
  assert.deepEqual(dup.map(v => v.status), ['new', 'refused']); assert.match(dup[1].reason, /Duplicate analysis id a/);
  assert.equal(s.order, null, 'nothing is ordered for a refresh while the graph is refused');
});
