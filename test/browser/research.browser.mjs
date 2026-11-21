// SPDX-License-Identifier: AGPL-3.0-only
// MATH-CHECK-01 / ANALYSIS-01 browser check: the real native editor, right-click and Ctrl+Alt shortcuts, the results panel,
// Insert / Stop / Rerun, stale marking and reload without autorun. Execution is real: each run goes through the
// latex-local-research host (macOS sandbox) with the user's selected interpreters. The page↔host link here is a test
// binding standing in for the native-messaging bridge (lane S3-B); everything else is product code. Synthetic data only.
//   CARGO_TARGET_DIR=<dir> cargo build --offline --release --manifest-path runtime/chrome-extension/research-host/Cargo.toml
//   PLAYWRIGHT_MODULE=<playwright> EXTENSION_CHROME_PATH=<Chrome for Testing> LATEX_EXTENSION_BASE=<built extension dir> \
//   LATEX_RESEARCH_HELPER=<latex-local-research> MATH_PYTHON=<python with SymPy> ANALYSIS_PYTHON=<python with statsmodels> RSCRIPT=<Rscript> \
//   node test/browser/research.browser.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repository = resolve(import.meta.dirname, '../..'), base = resolve(process.env.LATEX_EXTENSION_BASE), helper = resolve(process.env.LATEX_RESEARCH_HELPER);
const interpreters = { math: process.env.MATH_PYTHON, python: process.env.ANALYSIS_PYTHON, r: process.env.RSCRIPT };
const scripts = { math: 'runtime/math-check/mathcheck.py', python: 'runtime/research/analysis.py', r: 'runtime/research/analysis.R' };
const work = mkdtempSync(join(tmpdir(), 'latex-research-check-')), extension = join(work, 'extension');
cpSync(base, extension, { recursive: true });   // the base package is this branch's parent build: overlay only what this lane changes
cpSync(join(repository, 'runtime/browser-recovery/native-workspace.mjs'), join(extension, 'recovery/native-workspace.mjs'));
cpSync(join(repository, 'runtime/chrome-extension/research-ui.mjs'), join(extension, 'extension/research-ui.mjs'));
mkdirSync(join(extension, 'extension/research')); for (const name of ['manuscript.mjs', 'deps.mjs', 'outputs.mjs']) cpSync(join(repository, 'runtime/research', name), join(extension, 'extension/research', name));
const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8'));
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
const results = [], timings = {}, note = (name, detail = '') => { results.push(name); console.log('ok -', name, detail); };
const until = async (check, what, ms = 30000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await check(); if (last) return last; } catch (error) { last = error; } await new Promise(r => setTimeout(r, 50)); } throw Error('Timed out: ' + what + (last instanceof Error ? ' (' + last.message + ')' : last ? ' (last: ' + String(last).slice(0, 300) + ')' : '')); };

// ---- the host link: one latex-local-research process per run, cancel on Stop
const jobs = new Map(), calls = [];
function runOnHost(job, tool, request) {
  calls.push({ tool, op: request.op });
  return new Promise(resolveRun => {
    const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, TMPDIR: tmpdir() } }); jobs.set(job, child);
    let buffer = '';
    child.stdout.on('data', chunk => { buffer += chunk; let i; while ((i = buffer.indexOf('\n')) >= 0) { const event = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
      if (event.ev !== 'result') continue;
      jobs.delete(job); child.stdin.end();
      if (event.status === 'canceled') resolveRun({ status: 'canceled', host: 'canceled' });
      else if (event.status !== 'ok') resolveRun({ status: 'error', reason: `The research host stopped the run (${event.status})` });
      else { try { resolveRun(JSON.parse(event.stdout)); } catch { resolveRun({ status: 'error', reason: 'The script returned no result' }); } }
    } });
    child.stdin.write(JSON.stringify({ op: 'run', interpreter: interpreters[tool], script: join(repository, scripts[tool]), stdin: JSON.stringify(request), timeout_s: 60 }) + '\n');
  });
}

const editorOf = page => page.getByRole('textbox', { name: /^Source Editor/ });
const docOf = page => editorOf(page).evaluate(node => node.cmView.view.state.doc.toString());
const select = (page, text, { at = 0, cursor = false } = {}) => editorOf(page).evaluate((node, [text, at, cursor]) => {
  const view = node.cmView.view, from = view.state.doc.toString().indexOf(text) + at; if (from < at) throw Error('not found: ' + text);
  view.dispatch({ selection: cursor ? { anchor: from } : { anchor: from, head: from + text.length }, scrollIntoView: true }); view.focus();
  const box = view.coordsAtPos(from + (cursor ? 0 : 1)); return { x: box.left + 1, y: (box.top + box.bottom) / 2 };
}, [text, at, cursor]);
const panel = page => page.locator('#research-results');
const state = page => panel(page).locator('header [role=status]').textContent();
const body = page => panel(page).locator('#rr-body').innerText();
const settle = async (page, label) => { const t = Date.now(); await until(async () => !/Running/.test(await state(page)) && (await state(page)).length > 0, label); return Date.now() - t; };
const upload = (page, path, text) => page.evaluate(async ([path, text]) => { const id = document.querySelector('meta[name="ol-project_id"]').content, name = path.split('/').pop();
  const form = new FormData(); form.append('qqfile', new File([text], name)); form.append('relativePath', path); form.append('name', name);
  const r = await fetch(`/project/${id}/upload`, { method: 'POST', body: form }); return r.status + ' ' + (await r.text()).slice(0, 200); }, [path, text]);
const files = page => page.evaluate(async () => { const id = document.querySelector('meta[name="ol-project_id"]').content; return Object.fromEntries(Object.entries((await (await fetch(`/project/${id}/latest/history`)).json()).chunk.history.snapshot.files).map(([p, f]) => [p, f.content ?? 'hash:' + f.hash])); });

// ---- synthetic data with independently computed expectations (closed forms, not the adapters)
const educ = Array.from({ length: 20 }, (_, i) => i), wage = educ.map((x, i) => 3 + 0.5 * x + (i % 2 ? 0.25 : -0.25) + (i % 5 === 0 ? 0.4 : 0));
const csv = (x, y) => 'educ,wage\n' + x.map((v, i) => `${v},${y[i]}`).join('\n') + '\n';
const ols = (x, y) => { const mx = x.reduce((a, b) => a + b) / x.length, my = y.reduce((a, b) => a + b) / y.length; const b = x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0) / x.reduce((s, v) => s + (v - mx) ** 2, 0); return [my - b * mx, b]; };
const score = [52, 47, 55, 61, 49, 58, 53, 50, 46, 57, 60, 54, 51, 48, 56, 59, 45, 62, 53, 55];
const tstat = (v, mu) => { const n = v.length, m = v.reduce((a, b) => a + b) / n, sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)); return { m, t: (m - mu) / (sd / Math.sqrt(n)), df: n - 1 }; };
const sig = (v, d = 4) => String(Number(v.toPrecision(d)));
const manuscript = String.raw`\documentclass{article}
\usepackage{graphicx}
\begin{document}
% assume: x positive
% assume: y real
Cancellation at zero: $\frac{u^2}{u} = u$. Cancellation: $\frac{x^2 - 1}{x - 1} = x + 1$.
Root: $\sqrt{y^2} = y$. Wrong: $(a+b)^2 = a^2 + b^2$. Sum: $\sum_{i=1}^{n} i = \frac{n(n+1)}{2}$.
Constraints: $t > 2, \quad t < 1$. Function: $x^3 - 3x$. Ratio: $\frac{\sin(x)}{x}$. Macro: $\foo{x} = 1$.
% analysis wages python ols data=data/wages.csv y=wage x=educ caption="Wages and schooling"
% analysis scores r ttest data=data/scores.csv x=score mu=50
% analysis fig python figure data=data/wages.csv y=wage x=educ caption="Fit"
\end{document}
`;

let context; const errors = [];
try {
  context = await chromium.launchPersistentContext(join(work, 'profile'), { channel: 'chromium', headless: true, executablePath: process.env.EXTENSION_CHROME_PATH, ignoreDefaultArgs: ['--disable-extensions'],
    viewport: { width: 1400, height: 900 }, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
  context.setDefaultTimeout(30000);
  await context.exposeBinding('__researchRun', (_, job, tool, request) => runOnHost(job, tool, request));
  await context.exposeBinding('__researchCancel', (_, job) => { const child = jobs.get(job); if (child) child.stdin.write('{"op":"cancel"}\n'); });
  await context.addInitScript(() => { globalThis.overleafResearchRun = ({ tool, request }, { signal }) => { const job = crypto.randomUUID(); signal.addEventListener('abort', () => globalThis.__researchCancel(job), { once: true }); return globalThis.__researchRun(job, tool, request); }; });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message.slice(0, 200))); if (process.env.RESEARCH_DEBUG) page.on('console', m => console.log('[console]', m.text().slice(0, 300)));
  await page.goto(`chrome-extension://${id}/extension/index.html`);
  await page.getByRole('link', { name: 'Work offline', exact: true }).click();
  await page.getByRole('textbox', { name: 'New local project name', exact: true }).fill('Synthetic research project');
  await page.getByRole('button', { name: 'Create local project', exact: true }).click();
  await editorOf(page).waitFor({ timeout: 60000 });
  for (const [path, text] of [['data/wages.csv', csv(educ, wage)], ['data/scores.csv', 'score\n' + score.join('\n') + '\n']]) assert.match(await upload(page, path, text), /^200 /, path);
  await editorOf(page).evaluate((node, text) => { const view = node.cmView.view; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }); }, manuscript);
  await until(async () => (await files(page))['main.tex'] === manuscript, 'manuscript saved');
  assert.equal(calls.length, 0, 'nothing runs on open'); note('project opened; no research process started on open');

  // ---- readiness row (rendered by this lane's module into the drawer container S3-B owns)
  const readiness = await page.evaluate(async () => { const box = document.createElement('div'); document.body.append(box); const row = await (await import('/extension/research-ui.mjs')).renderReadiness(box, globalThis.overleafResearchRun); const text = row.textContent; box.remove(); return text; });
  assert.match(readiness, /^Math check: ready \(SymPy [\d.]+ in the selected Python\)$/); note('readiness row', readiness);

  // ---- right-click → Check equation: sqrt(y^2) = y without a sign assumption, then set y positive in the panel
  const before = await docOf(page);
  let point = await select(page, String.raw`\sqrt{y^2} = y`);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await page.getByRole('menuitem', { name: /Check equation/ }).click();
  timings.sqrt = await settle(page, 'sqrt check');
  assert.equal(await state(page), 'Issue found'); let text = await body(page);
  assert.match(text, /Counterexample at y = -[\d./]+/); assert.match(text, /line 7:/); assert.match(text, /Read as:\n?\s*\\sqrt\{y\^\{2\}\} = y|sqrt/);
  await panel(page).locator('fieldset', { hasText: 'y' }).getByLabel('positive', { exact: true }).check();
  await settle(page, 'sqrt with y positive');
  assert.equal(await state(page), 'No issue found in the supported check'); note('right-click check: sqrt(y^2)=y flagged, then clear with y positive', `${timings.sqrt} ms`);

  // ---- Ctrl+Alt+M with only the cursor inside math: cancellation at zero and an undeclared symbol
  await select(page, String.raw`\frac{u^2}{u}`, { cursor: true, at: 3 }); let t0 = Date.now();
  await page.keyboard.press('Control+Alt+KeyM'); await settle(page, 'u check'); timings.cancel = Date.now() - t0;
  text = await body(page); assert.equal(await state(page), 'Issue found');
  assert.match(text, /undefined at \{'u': '0'\}|undefined at \{"u": "0"\}|u \\neq 0/); assert.match(text, /u is not declared/); note('shortcut check: cancellation at zero and undeclared u as suggestions', `${timings.cancel} ms`);
  await select(page, String.raw`\frac{x^2 - 1}{x - 1} = x + 1`); await page.keyboard.press('Control+Alt+KeyM'); await settle(page, 'cancellation x=1');
  assert.equal(await state(page), 'Issue found'); assert.match(await body(page), /x \\neq 1/); note('cancellation at x = 1 under x positive');
  await select(page, '(a+b)^2 = a^2 + b^2'); await page.keyboard.press('Control+Alt+KeyM'); await settle(page, 'wrong identity');
  assert.equal(await state(page), 'Issue found'); assert.match(await body(page), /Counterexample at a = .*, b = /); note('wrong expansion gets a counterexample');
  await select(page, String.raw`\sum_{i=1}^{n} i = \frac{n(n+1)}{2}`); await page.keyboard.press('Control+Alt+KeyM'); await settle(page, 'sum');
  assert.equal(await state(page), 'No issue found in the supported check'); text = await body(page);
  assert.match(text, /Bound variables .*: i/); assert.match(text, /summation limit/); note('bound summation index is local; free limit sampled at integers');
  await select(page, String.raw`t > 2, \quad t < 1`); await page.keyboard.press('Control+Alt+KeyM'); await settle(page, 'constraints');
  assert.equal(await state(page), 'Issue found'); assert.equal((await body(page)).match(/part of the contradiction/g)?.length, 2); note('explicit contradictory constraints');
  await select(page, String.raw`\foo{x} = 1`); await page.keyboard.press('Control+Alt+KeyM'); await settle(page, 'macro');
  assert.equal(await state(page), 'Unsupported notation'); assert.match(await body(page), /Unsupported macro \\foo/); note('unknown macro is unsupported, not an error');

  // ---- computations on a selected expression
  await select(page, 'x^3 - 3x'); await page.keyboard.press('Control+Alt+KeyM'); await settle(page, 'expression');
  const compute = async (name, fill = {}) => {
    await panel(page).getByLabel('Computation').selectOption(name);
    for (const [label, value] of Object.entries(fill)) await panel(page).getByLabel(label).fill(value);
    await panel(page).getByRole('button', { name: 'Compute' }).click(); await settle(page, name);
    return panel(page).locator('.rr-computed').innerText();
  };
  assert.match(await compute('diff'), /Computed: Result: 3 x\^\{2\} - 3/);
  assert.match(await compute('integrate'), /Result: \\frac\{x\^\{4\}\}\{4\} - \\frac\{3 x\^\{2\}\}\{2\}/);
  assert.match(await compute('solve'), /Result: \\left\\\{\\sqrt\{3\}\\right\\\}/);   // x is declared positive (% assume:), so 0 and -sqrt(3) are not solutions
  const opt = await compute('optimize', { 'Interval start': '-2', 'Interval end': '2' });
  assert.match(opt, /Minimum -2 at (-2, 1|1, -2); maximum 2 at (-1, 2|2, -1)/); note('derivative, integral, solve and optimization on [-2, 2]');
  await select(page, String.raw`\frac{\sin(x)}{x}`); await page.keyboard.press('Control+Alt+KeyM'); await settle(page, 'ratio');
  assert.match(await compute('limit', { 'Limit point': '0' }), /Result: 1/); note('limit sin(x)/x at 0');
  assert.equal(await docOf(page), before, 'math checks never change the source'); note('source unchanged by every check and computation');

  // ---- Stop during a run, then Rerun
  await select(page, '(a+b)^2 = a^2 + b^2'); await page.keyboard.press('Control+Alt+KeyM');
  await panel(page).getByRole('button', { name: 'Stop', exact: true }).click();
  assert.equal(await state(page), 'Stopped'); await until(() => jobs.size === 0, 'host process ended after Stop');
  await panel(page).getByRole('button', { name: 'Rerun', exact: true }).click(); await settle(page, 'rerun');
  assert.equal(await state(page), 'Issue found'); note('Stop cancels the host run; Rerun repeats it');

  // ---- analysis: Python OLS via the shortcut, preview, explicit Insert
  const [a0, b0] = ols(educ, wage);
  await select(page, '% analysis wages', { cursor: true, at: 3 }); t0 = Date.now(); await page.keyboard.press('Control+Alt+KeyR');
  await until(async () => /Computed|Could not|Unavailable/.test(await state(page)), 'python ols', 60000); timings.pythonOls = Date.now() - t0;
  assert.equal(await state(page), 'Computed', await body(page)); text = await body(page);
  assert.ok(text.includes(sig(b0, 5)) && text.includes(sig(a0, 5)), `preview shows ${sig(a0, 5)} and ${sig(b0, 5)}`);
  assert.equal(await docOf(page), before, 'a preview does not change the source');
  await panel(page).getByRole('button', { name: 'Insert' }).click();
  await until(async () => (await docOf(page)).includes('% research-result wages end'), 'inserted table');
  let doc = await docOf(page);
  assert.match(doc, new RegExp(String.raw`educ & ${sig(b0).replace('.', '\\.')} & `)); assert.match(doc, /\\caption\{Wages and schooling\}/);
  assert.ok(doc.indexOf('% analysis wages') < doc.indexOf('% research-result wages key='), 'block follows its analysis line');
  await until(async () => /wages\s*Up to date/.test(await panel(page).locator('#rr-list').innerText()), 'wages up to date');
  note('Python OLS preview → Insert; coefficients match the closed form', `${timings.pythonOls} ms`);

  // ---- R t-test via right-click → Run analysis, scalar insert
  const tt = tstat(score, 50);
  point = await select(page, '% analysis scores', { cursor: true, at: 4 }); await page.mouse.click(point.x, point.y, { button: 'right' });
  await page.getByRole('menuitem', { name: /Run analysis/ }).click(); t0 = Date.now();
  await until(async () => /Computed|Could not|Unavailable/.test(await state(page)), 'r ttest', 60000); timings.rTtest = Date.now() - t0;
  await panel(page).getByRole('button', { name: 'Insert' }).click();
  await until(async () => (await docOf(page)).includes('% research-result scores end'), 'inserted scalar');
  doc = await docOf(page);
  assert.ok(doc.includes(`$\\bar{x} = ${sig(tt.m)}$`) && doc.includes(`$t_{${tt.df}} = ${sig(tt.t)}$`), 'sentence matches the hand-computed mean and t');
  note('R t-test → Insert scalar with CI; t matches the hand computation', `${timings.rTtest} ms`);

  // ---- Python figure → Insert saves research/fig.png and an \includegraphics block
  await select(page, '% analysis fig', { cursor: true, at: 3 }); await page.keyboard.press('Control+Alt+KeyR');
  await until(async () => /Computed|Could not|Unavailable/.test(await state(page)), 'figure', 60000);
  assert.equal(await panel(page).locator('img').count(), 1);
  await panel(page).getByRole('button', { name: 'Insert' }).click();
  await until(async () => (await docOf(page)).includes('% research-result fig end'), 'figure inserted');
  const figure = (await docOf(page)).match(/\\includegraphics\[width=\\linewidth\]\{(research\/fig-[a-z0-9]+\.png)\}/)?.[1];
  assert.ok(figure && (await files(page))[figure].startsWith('hash:'), 'the figure file exists in the project'); note('figure preview → Insert writes one new file', figure);

  // ---- data change marks only its dependants stale; Rerun + Insert replaces the block
  const changed = wage.map((v, i) => i === 0 ? v + 3 : v), [a1, b1] = ols(educ, changed), callsBefore = calls.length;
  // edit the data file in the editor, as a user would; the panel list watches declared inputs
  const tree = name => page.locator(`li[role=treeitem][aria-label="${name}"]`);
  if (!(await tree('wages.csv').count())) await tree('data').click();
  await tree('wages.csv').click(); await until(async () => (await docOf(page)).startsWith('educ,wage'), 'data file open');
  await editorOf(page).evaluate((node, text) => { const view = node.cmView.view; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }); }, csv(educ, changed));
  await until(async () => { const l = await panel(page).locator('#rr-list').innerText(); return /wages\s*Stale/.test(l) && /fig\s*Stale/.test(l) && /scores\s*Up to date/.test(l); }, 'stale after data change', 20000);
  assert.equal(calls.length, callsBefore, 'a data change marks stale; it does not run anything (trusted refresh is off)');
  await panel(page).getByRole('button', { name: 'Rerun wages' }).click();
  await until(async () => /Computed/.test(await state(page)) && (await body(page)).includes(sig(b1, 5)), 'rerun with new data', 60000);
  await panel(page).getByRole('button', { name: 'Insert' }).click();
  await until(async () => /Open main\.tex, which declares analysis wages/.test(await body(page)), 'insert asks for the manuscript');
  assert.ok((await docOf(page)).startsWith('educ,wage'), 'the data file was not touched');
  await tree('main.tex').click(); await until(async () => (await docOf(page)).includes('\\documentclass'), 'manuscript open');
  await panel(page).getByRole('button', { name: 'Insert' }).click();
  await until(async () => (await docOf(page)).includes(`educ & ${sig(b1)} & `), 'replaced table');
  doc = await docOf(page); assert.equal(doc.split('% research-result wages end').length - 1, 1, 'replaced, not duplicated');
  await until(async () => /wages\s*Up to date/.test(await panel(page).locator('#rr-list').innerText()), 'fresh again');
  note('data change → only wages and fig stale; Rerun → Insert replaces the block');

  // ---- trusted project: a live data change recomputes its dependants in order and stages them; nothing is inserted
  await page.evaluate(() => { globalThis.overleafResearchTrusted = () => true; });
  const mainBefore = (await files(page))['main.tex'], runsBefore = calls.length, setData = async values => { await tree('wages.csv').click(); await until(async () => (await docOf(page)).startsWith('educ,wage'), 'data file open');
    await editorOf(page).evaluate((node, text) => { const view = node.cmView.view; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }); }, csv(educ, values)); };
  await setData(changed.map((v, i) => i === 1 ? v + 1 : v));
  await until(() => calls.slice(runsBefore).filter(c => c.tool === 'python').length >= 2 && jobs.size === 0, 'trusted refresh ran wages and fig', 60000);
  assert.deepEqual(calls.slice(runsBefore).map(c => c.op), ['ols', 'figure'], 'dependants recomputed once each, in plan order');
  assert.equal((await files(page))['main.tex'], mainBefore, 'a refresh stages results; it never inserts');
  await page.evaluate(() => { globalThis.overleafResearchTrusted = () => false; });
  await setData(changed); await tree('main.tex').click(); await until(async () => (await docOf(page)).includes('\\documentclass'), 'manuscript open');
  await until(async () => /wages\s*Up to date/.test(await panel(page).locator('#rr-list').innerText()), 'reverted data is fresh again');
  note('trusted refresh: live change → wages, fig recomputed in order and staged; manuscript unchanged');

  // ---- reload: no execution on open, staleness recomputed from the stored keys
  await until(async () => (await files(page))['main.tex'] === await docOf(page), 'saved before reload');
  const callsAtReload = calls.length; await page.reload(); await editorOf(page).waitFor({ timeout: 60000 });
  await page.waitForTimeout(2000); assert.equal(calls.length, callsAtReload, 'nothing ran on reopen');
  await select(page, '(a+b)^2 = a^2 + b^2'); await page.keyboard.press('Control+Alt+KeyM'); await settle(page, 'check after reload');   // shows the panel and its list
  await until(async () => { const l = await panel(page).locator('#rr-list').innerText(); return /wages\s*Up to date/.test(l) && /scores\s*Up to date/.test(l) && /fig\s*Stale/.test(l); }, 'statuses after reload');
  assert.deepEqual(calls.slice(callsAtReload).map(c => c.tool), ['math'], 'only the requested check ran; no analysis reran on open');
  note('reload starts nothing; statuses come back from the stored keys (wages, scores up to date; fig stale)');

  // ---- missing SymPy in the selected Python: readiness says so, check is unavailable (nothing installed)
  interpreters.math = process.env.ANALYSIS_PYTHON_NO_SYMPY || interpreters.python;
  const unavailable = await page.evaluate(async () => { const box = document.createElement('div'); document.body.append(box); const row = await (await import('/extension/research-ui.mjs')).renderReadiness(box, globalThis.overleafResearchRun); const text = row.textContent; box.remove(); return text; });
  assert.match(unavailable, /Math check: unavailable — SymPy is not installed in the selected Python environment/); note('environment without SymPy reports unavailable', unavailable);
  assert.deepEqual(errors, [], 'no page errors');
  console.log(JSON.stringify({ researchBrowser: { passed: results.length, timingsMs: timings, hostRuns: calls.length } }));
} catch (error) { console.log('page errors:', errors); throw error; } finally {
  for (const child of jobs.values()) child.kill('SIGKILL');
  await context?.close().catch(() => {});
  rmSync(work, { recursive: true, force: true });
}
