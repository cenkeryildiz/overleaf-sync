// SPDX-License-Identifier: AGPL-3.0-only
// DOCEXEC-01 / RESEARCH-RUNTIME-01 browser check: Settings › This computer rows, consent, Run cell in .py and .R with the
// user's real Jupyter kernels (python3 in the selected env, ir), inert outputs, Insert with stale refusal, Stop, Restart,
// fresh ordered Rerun, kernel/language mismatch, nothing run on open or reload. The latex-local-research helper is Chromium's
// native-messaging host; a spy around chrome.runtime.connectNative only records which ops the page sends. Settings go to a
// temporary file, never the user's. Synthetic code only.
//   cargo build --offline --release --manifest-path runtime/chrome-extension/research-host/Cargo.toml   (CARGO_TARGET_DIR outside the repo)
//   PLAYWRIGHT_MODULE=<playwright> EXTENSION_CHROME_PATH=<Chromium that honours --load-extension> LATEX_EXTENSION_BASE=<built extension dir> \
//   LATEX_RESEARCH_HELPER=<latex-local-research> RESEARCH_PYTHON=<python with ipykernel+pandas+matplotlib> node test/browser/cells.browser.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repository = resolve(import.meta.dirname, '../..'), base = resolve(process.env.LATEX_EXTENSION_BASE), helper = resolve(process.env.LATEX_RESEARCH_HELPER), python = process.env.RESEARCH_PYTHON;
const work = mkdtempSync(join(tmpdir(), 'latex-cells-check-')), extension = join(work, 'extension'), profile = join(work, 'profile');
cpSync(base, extension, { recursive: true });   // the base package is the parent build: overlay this branch's editor modules
cpSync(join(repository, 'runtime/browser-recovery/native-workspace.mjs'), join(extension, 'recovery/native-workspace.mjs'));
for (const name of readdirSync(join(repository, 'runtime/chrome-extension'))) if (/^(lan-.*|research-ui|cells-ui|this-computer)\.mjs$/.test(name)) cpSync(join(repository, 'runtime/chrome-extension', name), join(extension, 'extension', name));
mkdirSync(join(extension, 'extension/research'), { recursive: true }); for (const name of ['manuscript.mjs', 'deps.mjs', 'outputs.mjs']) cpSync(join(repository, 'runtime/research', name), join(extension, 'extension/research', name));
const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8'));
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
mkdirSync(join(profile, 'NativeMessagingHosts'), { recursive: true });
writeFileSync(join(profile, 'NativeMessagingHosts', 'com.cenker.latex_research.json'), JSON.stringify({ name: 'com.cenker.latex_research', description: 'Research helper (test)', path: helper, type: 'stdio', allowed_origins: [`chrome-extension://${id}/`] }));
const results = [], timings = {}, ops = [], errors = [], note = (name, detail = '') => { results.push(name); console.log('ok -', name, detail); };
const until = async (check, what, ms = 30000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await check(); if (last) return last; } catch (error) { last = error; } await new Promise(r => setTimeout(r, 50)); } throw Error('Timed out: ' + what + (last instanceof Error ? ' (' + last.message + ')' : last ? ' (last: ' + String(last).slice(0, 300) + ')' : '')); };

const editorOf = page => page.getByRole('textbox', { name: /^Source Editor/ });
const docOf = page => editorOf(page).evaluate(node => node.cmView.view.state.doc.toString());
const place = (page, text, after = false) => editorOf(page).evaluate((node, [text, after]) => { const view = node.cmView.view, at = view.state.doc.toString().indexOf(text); if (at < 0) throw Error('not found: ' + text);
  view.dispatch({ selection: { anchor: at + (after ? text.length : 0) }, scrollIntoView: true }); view.focus(); }, [text, after]);
const replace = (page, from, to) => editorOf(page).evaluate((node, [from, to]) => { const view = node.cmView.view, at = view.state.doc.toString().indexOf(from); if (at < 0) throw Error('not found: ' + from);
  view.dispatch({ changes: { from: at, to: at + from.length, insert: to } }); }, [from, to]);
const upload = (page, path, text) => page.evaluate(async ([path, text]) => { const id = document.querySelector('meta[name="ol-project_id"]').content, name = path.split('/').pop();
  const form = new FormData(); form.append('qqfile', new File([text], name)); form.append('relativePath', path); form.append('name', name);
  const r = await fetch(`/project/${id}/upload`, { method: 'POST', body: form }); return r.status + ' ' + (await r.text()).slice(0, 200); }, [path, text]);
const files = page => page.evaluate(async () => { const id = document.querySelector('meta[name="ol-project_id"]').content; return Object.fromEntries(Object.entries((await (await fetch(`/project/${id}/latest/history`)).json()).chunk.history.snapshot.files).map(([p, f]) => [p, f.content ?? 'hash:' + f.hash])); });
const open = (page, name, start) => until(async () => { if ((await docOf(page)).startsWith(start)) return true; await page.locator(`li[role=treeitem][aria-label="${name}"]`).click(); await page.waitForTimeout(300); return (await docOf(page)).startsWith(start); }, name + ' open');   // the tree can shift (new generated/ folder) under a click
const panel = page => page.locator('#research-results'), entries = page => panel(page).locator('li'), state = page => panel(page).locator('header [role=status]').textContent();
const header = (page, name) => panel(page).locator('header').getByRole('button', { name, exact: true });
const entry = (page, title) => entries(page).filter({ hasText: title }).last();
/** Cursor into the cell that contains `text`, Ctrl+Enter, wait for a new finished entry; returns its text. */
async function runAt(page, text, what, { consent = false, ms = 90000 } = {}) {
  const before = await entries(page).count().catch(() => 0), started = Date.now();
  await place(page, text); await page.keyboard.press('Control+Enter');
  if (consent) { await page.getByRole('dialog', { name: 'Allow this project to run code' }).getByRole('button', { name: 'Allow on this computer' }).click(); note('first Run cell asks per-project consent'); }
  const body = await until(async () => { const n = await entries(page).count(); if (n <= before) return false; const t = await entries(page).last().innerText(); return /· running/.test(t) ? false : t; }, what, ms);
  timings[what] = Date.now() - started; return body;
}
async function thisComputer(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'This computer' }).click();
  await page.locator('#ide-settings-tabs-tabpane-this-computer').waitFor();
  return () => page.getByRole('button', { name: 'Close dialog' }).click();
}
const describe = (page, row) => page.locator(`#setting-${row} .ide-setting-description`).textContent();
const runCells = async (page, on) => { const box = page.locator('#computer-run-cells input'); await until(async () => !(await box.isDisabled()), 'Run cells switch enabled');
  if ((await box.isChecked()) !== on) await box.click(); await until(async () => (await describe(page, 'computer-run-cells')).startsWith(on ? 'On.' : 'Off.'), 'Run cells ' + on); };
const pickKernel = async (page, name) => { await until(async () => (await page.locator(`#computer-kernel option[value="${name}"]`).count()) > 0, 'kernel listed: ' + name); await page.selectOption('#computer-kernel', name);
  await until(async () => (await page.locator('#computer-kernel').inputValue()) === name, 'kernel selected: ' + name);
  await until(async () => !(await page.locator('#computer-run-cells input').isChecked()) && (await describe(page, 'computer-run-cells')).startsWith('Off.'), 'a new kernel switches Run cells off until enabled again'); };

const analysis = `# %% setup
x = 21
# %% double
print(x * 2)
# %% table
import pandas as pd
pd.set_option("display.html.table_schema", True)   # pandas sends a plain table only with this option
pd.DataFrame({"a": [1, 2], "b": [3, 4]})
# %% html
from IPython.display import HTML
HTML("<script>window.pwned = 1</script><b>bold</b>")
# %% figure
import matplotlib.pyplot as plt
plt.plot([0, 1], [0, 1]); plt.show()
`;
const slow = '# %% slow\nimport time\ntime.sleep(40)\nprint("finished")\n', model = '# %% r\nv <- c(1, 2, 3)\nmean(v)\n';
const manuscript = '\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\nResults here.\n\\end{document}\n';

let context;
try {
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, executablePath: process.env.EXTENSION_CHROME_PATH, ignoreDefaultArgs: ['--disable-extensions'],
    env: { ...process.env, LATEX_LOCAL_RESEARCH_SETTINGS: join(work, 'research.json') }, viewport: { width: 1400, height: 900 }, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
  context.setDefaultTimeout(30000);
  await context.exposeBinding('__hostOp', (_, name, op) => { if (name === 'com.cenker.latex_research') ops.push(op); });
  await context.addInitScript(() => { const rt = globalThis.chrome?.runtime; if (!rt?.connectNative) return; const connect = rt.connectNative.bind(rt);
    rt.connectNative = name => { const port = connect(name), post = port.postMessage.bind(port); port.postMessage = message => { globalThis.__hostOp(name, message?.op); return post(message); }; return port; }; });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message.slice(0, 200)));
  await page.goto(`chrome-extension://${id}/extension/index.html`);
  await page.getByRole('link', { name: 'Work offline', exact: true }).click();
  await page.getByRole('textbox', { name: 'New local project name', exact: true }).fill('Synthetic cells project');
  await page.getByRole('button', { name: 'Create local project', exact: true }).click();
  await editorOf(page).waitFor({ timeout: 60000 });
  for (const [path, text] of [['analysis.py', analysis], ['slow.py', slow], ['model.R', model]]) assert.match(await upload(page, path, text), /^200 /, path);
  await editorOf(page).evaluate((node, text) => { const view = node.cmView.view; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }); }, manuscript);
  await until(async () => (await files(page))['main.tex'] === manuscript && (await files(page))['analysis.py'] === analysis, 'project saved');
  await page.waitForTimeout(500); assert.deepEqual(ops, [], 'no helper contact on open'); note('project with .py/.R files opened; the helper was not contacted');

  // ---- Settings › This computer: the user's choices, then nothing has run
  let close = await thisComputer(page);
  await until(async () => (await page.locator(`#computer-python option[value="${python}"]`).count()) > 0, 'selected Python listed');
  assert.match(await describe(page, 'computer-run-cells'), /^Unavailable: No Python environment is selected/i);
  await page.selectOption('#computer-python', python); await until(async () => /Ready for the tools below/.test(await describe(page, 'computer-python')), 'Python ready');
  await pickKernel(page, 'python3'); await runCells(page, true);
  assert.match(await describe(page, 'computer-project-consent'), /Asked the first time/); await close();
  assert.ok(ops.includes('select') && ops.includes('kernel') && ops.includes('feature'), 'choices went to the helper: ' + ops.join(','));
  assert.ok(!ops.some(op => ['start', 'run', 'script'].includes(op)), 'choosing runs nothing'); note('This computer rows: Python, kernel and Run cells chosen; nothing ran', ops.join(','));

  // ---- Run cell, outputs
  await open(page, 'analysis.py', '# %% setup');
  let out = await runAt(page, 'x = 21', 'first cell', { consent: true });
  assert.match(out, /analysis\.py · cell 1 · ok \[1\]/); timings.kernelStart = Number((await state(page)).match(/started in (\d+) ms/)?.[1]); note('kernel started and cell 1 ran', `${timings['first cell']} ms incl. consent, kernel start ${timings.kernelStart} ms`);
  out = await runAt(page, 'print(x * 2)', 'cell round trip'); assert.match(out, /cell 2 · ok \[2\]/); assert.match(out, /^42$/m); note('Ctrl+Enter runs the cursor cell; state carries over', `${timings['cell round trip']} ms`);
  await runAt(page, 'pd.DataFrame', 'table cell');
  const heads = await entry(page, 'cell 3').locator('table th').allTextContents(); assert.ok(heads.includes('a') && heads.includes('b'), 'table headers ' + heads + ' in: ' + await entry(page, 'cell 3').innerText()); note('DataFrame shown as a plain table', heads.join('|'));
  out = await runAt(page, 'HTML(', 'html cell'); assert.match(out, /Not displayed \(rich output is never rendered\): text\/html/);
  assert.equal(await page.evaluate(() => globalThis.pwned), undefined); assert.equal(await panel(page).locator('b, script').count(), 0); note('HTML output is not rendered or executed');
  out = await runAt(page, 'plt.plot', 'figure cell'); assert.equal(await entry(page, 'cell 5').locator('img').count(), 1); note('matplotlib figure shown as an image');

  // ---- Insert into the manuscript; stale refusal
  await open(page, 'main.tex', '\\documentclass');
  await place(page, 'Results here.', true); await entry(page, 'cell 2').getByRole('button', { name: 'Insert' }).click();
  await until(async () => (await docOf(page)).includes('% generated: analysis.py/cell-2 (run'), 'text inserted');
  let doc = await docOf(page); assert.match(doc, /% generated: analysis\.py\/cell-2 \(run \d+, python3 [^,]+, code sha256:[0-9a-f]{12}, output sha256:[0-9a-f]{12}\)\n42\n/); note('Insert puts the output with a provenance comment at the cursor');
  await place(page, '\\end{document}'); await entry(page, 'cell 5').getByRole('button', { name: 'Insert' }).click();
  const graphic = (await until(async () => (await docOf(page)).match(/\\includegraphics\[width=\\linewidth\]\{(generated\/analysis\.py-cell-5-[0-9a-f]{8}\.png)\}/), 'figure inserted'))[1];
  await until(async () => (await files(page))[graphic]?.startsWith('hash:'), 'figure file saved'); note('figure Insert saves one generated/ file and references it', graphic);
  await open(page, 'analysis.py', '# %% setup'); await replace(page, 'print(x * 2)', 'print(x * 3)');
  await open(page, 'main.tex', '\\documentclass'); doc = await docOf(page); await place(page, 'Results here.');
  await entry(page, 'cell 2').getByRole('button', { name: 'Insert' }).click();
  await until(async () => /stale: the code changed after this run/.test(await entry(page, 'cell 2').innerText()), 'stale refusal'); assert.equal(await docOf(page), doc, 'nothing inserted'); note('changed code: Insert refuses and marks the result stale');

  // ---- Restart clears state; fresh ordered Rerun reports the change
  await header(page, 'Restart').click(); await until(async () => /Restarted: variables cleared/.test(await state(page)), 'restart');
  await open(page, 'analysis.py', '# %% setup'); out = await runAt(page, 'print(x * 3)', 'after restart'); assert.match(out, /NameError/); note('Restart clears variables (cell 2 alone fails with NameError)');
  await header(page, 'Rerun').click();
  const rerun = await until(async () => { const e = entries(page).filter({ hasText: 'Rerun of analysis.py' }); return (await e.count()) && e.last().innerText(); }, 'rerun summary', 120000);
  assert.match(rerun, /complete/); assert.match(rerun, /analysis\.py\/cell-2: status error → ok/, 'the earlier run failed only because of missing hidden state'); assert.match(await entry(page, 'cell 2').innerText(), /^63$/m); note('fresh Rerun runs every cell in order and reports the hidden-state difference');

  // ---- Stop interrupts a long cell
  await open(page, 'slow.py', '# %% slow'); const n = await entries(page).count(); await place(page, 'time.sleep'); await page.keyboard.press('Control+Enter');
  await until(async () => (await entries(page).count()) > n && /· running/.test(await entries(page).last().innerText()), 'slow cell running'); await page.waitForTimeout(500);
  const stopAt = Date.now(); await header(page, 'Stop').click();
  out = await until(async () => { const t = await entries(page).last().innerText(); return !/· running/.test(t) && t; }, 'interrupted', 15000); timings.interruptMs = Date.now() - stopAt;
  assert.match(out, /KeyboardInterrupt/); assert.doesNotMatch(out, /^finished$/m); note('Stop interrupts a running cell', `${timings.interruptMs} ms`);

  // ---- language mismatch, then the R kernel
  await open(page, 'model.R', '# %% r'); out = await runAt(page, 'mean(v)', 'mismatch'); assert.match(out, /runs Python, but this is an R file/); note('an .R file with a Python kernel is refused with the reason');
  close = await thisComputer(page); await pickKernel(page, 'ir'); await runCells(page, true); await close();
  out = await runAt(page, 'mean(v)', 'r cell'); assert.match(out, /model\.R · cell 1 · ok/); assert.match(out, /\[1\] 2/); note('R cell runs in the ir kernel', `${timings['r cell']} ms incl. kernel switch`);

  // ---- reload starts nothing
  const opsBefore = ops.length; await page.reload(); await editorOf(page).waitFor({ timeout: 60000 }); await page.waitForTimeout(2000);
  assert.ok(!ops.slice(opsBefore).some(op => ['start', 'run', 'script'].includes(op)), 'nothing ran on reload: ' + ops.slice(opsBefore).join(',')); note('reload runs nothing');
  assert.deepEqual(errors, [], 'no page errors');
  console.log(JSON.stringify({ cellsBrowser: { passed: results.length, timingsMs: timings, hostOps: ops.length } }));
} catch (error) { console.log('page errors:', errors); throw error; } finally {
  await context?.close().catch(() => {});
  rmSync(work, { recursive: true, force: true });
}
