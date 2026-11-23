// SPDX-License-Identifier: AGPL-3.0-only
// S3-16 absent/disabled-tool and offline check. Two profiles, browser offline, every request recorded:
//   "absent": no research helper installed. Editing and the stage-1 in-browser compile work; Check equation, analyses,
//             Run cell and Settings › This computer say the helper is not installed; no helper process exists.
//   "off":    helper installed, nothing chosen, then a Python chosen with every feature off. Each action explains why and
//             no script, kernel or cell is started (only `status`, `select` and the probe reach the helper).
// No profile makes a request outside the extension. Synthetic project; settings in a temporary file.
//   PLAYWRIGHT_MODULE=<playwright> EXTENSION_CHROME_PATH=<Chromium that honours --load-extension> LATEX_EXTENSION_BASE=<built extension dir> \
//   LATEX_RESEARCH_HELPER=<latex-local-research> RESEARCH_PYTHON=<a discovered python> node test/browser/research-absent.browser.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repository = resolve(import.meta.dirname, '../..'), base = resolve(process.env.LATEX_EXTENSION_BASE), helper = resolve(process.env.LATEX_RESEARCH_HELPER), python = process.env.RESEARCH_PYTHON;
const work = mkdtempSync(join(tmpdir(), 'latex-absent-check-')), extension = join(work, 'extension');
cpSync(base, extension, { recursive: true });
cpSync(join(repository, 'runtime/browser-recovery/native-workspace.mjs'), join(extension, 'recovery/native-workspace.mjs'));
for (const name of readdirSync(join(repository, 'runtime/chrome-extension'))) if (/^(lan-.*|research-ui|cells-ui|this-computer)\.mjs$/.test(name)) cpSync(join(repository, 'runtime/chrome-extension', name), join(extension, 'extension', name));
mkdirSync(join(extension, 'extension/research'), { recursive: true }); for (const name of ['manuscript.mjs', 'deps.mjs', 'outputs.mjs']) cpSync(join(repository, 'runtime/research', name), join(extension, 'extension/research', name));
const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8'));
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
const results = [], measures = {}, errors = [], note = (name, detail = '') => { results.push(name); console.log('ok -', name, detail); };
const until = async (check, what, ms = 30000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await check(); if (last) return last; } catch (error) { last = error; } await new Promise(r => setTimeout(r, 50)); } throw Error('Timed out: ' + what + (last instanceof Error ? ' (' + last.message + ')' : last ? ' (last: ' + String(last).slice(0, 300) + ')' : '')); };
const helpers = () => { try { return execFileSync('/usr/bin/pgrep', ['-f', helper], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length; } catch { return 0; } };

const editorOf = page => page.getByRole('textbox', { name: /^Source Editor/ });
const docOf = page => editorOf(page).evaluate(node => node.cmView.view.state.doc.toString());
const setDoc = (page, text) => editorOf(page).evaluate((node, value) => { const view = node.cmView.view; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }); }, text);
const place = (page, text) => editorOf(page).evaluate((node, text) => { const view = node.cmView.view, at = view.state.doc.toString().indexOf(text); if (at < 0) throw Error('not found: ' + text); view.dispatch({ selection: { anchor: at + 1 } }); view.focus(); }, text);
const upload = (page, path, text) => page.evaluate(async ([path, text]) => { const id = document.querySelector('meta[name="ol-project_id"]').content, name = path.split('/').pop();
  const form = new FormData(); form.append('qqfile', new File([text], name)); form.append('relativePath', path); form.append('name', name);
  const r = await fetch(`/project/${id}/upload`, { method: 'POST', body: form }); return r.status; }, [path, text]);
const files = page => page.evaluate(async () => { const id = document.querySelector('meta[name="ol-project_id"]').content; return Object.fromEntries(Object.entries((await (await fetch(`/project/${id}/latest/history`)).json()).chunk.history.snapshot.files).map(([p, f]) => [p, f.content ?? 'hash:' + f.hash])); });
const open = (page, name, start) => until(async () => { if ((await docOf(page)).startsWith(start)) return true; await page.locator(`li[role=treeitem][aria-label="${name}"]`).click(); await page.waitForTimeout(300); return (await docOf(page)).startsWith(start); }, name + ' open');
const panelText = page => page.locator('#research-results').innerText();
const pdfText = page => page.locator('.textLayer').allTextContents().then(list => list.join(' '));
async function thisComputer(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: 'This computer' }).click();
  await page.locator('#ide-settings-tabs-tabpane-this-computer').waitFor(); return () => page.getByRole('button', { name: 'Close dialog' }).click();
}
/** Run one editor action and wait until the results panel shows `pattern`; returns the panel text. */
async function act(page, keys, at, pattern, what) { await place(page, at); await page.keyboard.press(keys); return until(async () => { const t = await panelText(page); return pattern.test(t) && t; }, what); }

const manuscript = String.raw`\documentclass{article}
\begin{document}
ABSENTMARK $\frac{u^2}{u} = u$
% analysis wages python ols data=data.csv y=y x=x
\end{document}
`;
const code = '# %% one\nprint(1 + 1)\n';

async function profileRun(name, { installed }) {
  const dir = join(work, name), requests = [], ops = [];
  if (installed) { mkdirSync(join(dir, 'NativeMessagingHosts'), { recursive: true });
    writeFileSync(join(dir, 'NativeMessagingHosts', 'com.cenker.latex_research.json'), JSON.stringify({ name: 'com.cenker.latex_research', description: 'Research helper (test)', path: helper, type: 'stdio', allowed_origins: [`chrome-extension://${id}/`] })); }
  const context = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true, executablePath: process.env.EXTENSION_CHROME_PATH, ignoreDefaultArgs: ['--disable-extensions'], offline: true,
    env: { ...process.env, LATEX_LOCAL_RESEARCH_SETTINGS: join(work, name + '-research.json') }, viewport: { width: 1400, height: 900 }, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
  context.setDefaultTimeout(30000); context.on('request', request => requests.push(request.url()));
  await context.exposeBinding('__hostOp', (_, host, op) => { if (host === 'com.cenker.latex_research') ops.push(op); });
  await context.addInitScript(() => { const rt = globalThis.chrome?.runtime; if (!rt?.connectNative) return; const connect = rt.connectNative.bind(rt);
    rt.connectNative = host => { const port = connect(host), post = port.postMessage.bind(port); port.postMessage = message => { globalThis.__hostOp(host, message?.op); return post(message); }; return port; }; });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(name + ': ' + error.message.slice(0, 200)));
  const t0 = Date.now();
  await page.goto(`chrome-extension://${id}/extension/index.html`);
  await page.getByRole('link', { name: 'Work offline', exact: true }).click();
  await page.getByRole('textbox', { name: 'New local project name', exact: true }).fill('Absent tools ' + name);
  await page.getByRole('button', { name: 'Create local project', exact: true }).click();
  await editorOf(page).waitFor({ timeout: 60000 }); measures[name + 'OpenMs'] = Date.now() - t0;
  const atOpen = requests.filter(url => /\/extension\/(cells-ui|research-ui|this-computer)\.mjs|\/research\//.test(url)).map(url => url.split('/extension/')[1]);
  measures[name + 'ResearchModulesOnOpen'] = atOpen; assert.deepEqual(atOpen.filter(n => n !== 'this-computer.mjs'), [], 'no research module is loaded on open');   // this-computer.mjs (Settings tab scaffold) comes with lan-compile-ui.mjs
  assert.equal(ops.length, 0, 'no helper contact on open'); assert.equal(helpers(), 0, 'no helper process on open');
  assert.equal(await upload(page, 'cell.py', code), 200); assert.equal(await upload(page, 'data.csv', 'x,y\n1,2\n2,4\n3,7\n'), 200);
  await setDoc(page, manuscript); await until(async () => (await files(page))['main.tex'] === manuscript, 'manuscript saved');
  note(`${name}: project opens offline and saves; helper not contacted`, `${measures[name + 'OpenMs']} ms; research modules loaded on open: ${atOpen.join(', ') || 'none'}`);
  return { context, page, requests, ops };
}

const contexts = [];
try {
  assert.equal(helpers(), 0, 'no research helper is running before the check');
  // ---------------------------------------------------------------- helper not installed
  { const { context, page, requests, ops } = await profileRun('absent', { installed: false }); contexts.push(context);
    const t = Date.now(); await page.getByRole('button', { name: 'Recompile', exact: true }).click();
    await until(async () => (await pdfText(page)).includes('ABSENTMARK'), 'in-browser compile', 120000); measures.absentCompileMs = Date.now() - t;
    note('absent: stage-1 compile in the browser works without any research tool', `${measures.absentCompileMs} ms`);
    let text = await act(page, 'Control+Alt+KeyM', '\\frac{u^2}', /not installed on this computer/, 'math check without helper'); note('absent: Check equation says the helper is not installed');
    text = await act(page, 'Control+Alt+KeyR', 'analysis wages', /not installed on this computer/, 'analysis without helper'); note('absent: Run analysis says the helper is not installed');
    await open(page, 'cell.py', '# %% one'); text = await act(page, 'Control+Enter', 'print', /not installed on this computer/, 'run cell without helper'); note('absent: Run cell says the helper is not installed');
    const close = await thisComputer(page); await until(async () => /not installed on this computer/.test(await page.locator('#setting-computer-research').innerText()), 'settings row'); await close();
    note('absent: Settings › This computer says how to install the helper');
    assert.equal(helpers(), 0, 'no helper process'); assert.equal(await page.locator('dialog.olx-consent').count(), 0, 'no consent asked');
    const outside = requests.filter(url => !/^(chrome-extension|blob|data):/.test(url)); assert.deepEqual(outside, [], 'requests outside the extension'); measures.absentRequests = requests.length;
    note('absent: no request left the extension', `${requests.length} extension requests`); await context.close(); contexts.pop(); }

  // ---------------------------------------------------------------- helper installed, nothing chosen, then Python chosen with features off
  { const { context, page, requests, ops } = await profileRun('off', { installed: true }); contexts.push(context);
    let text = await act(page, 'Control+Alt+KeyM', '\\frac{u^2}', /Math check is unavailable: No Python environment is selected/, 'math check, nothing chosen'); note('off: Check equation asks for a Python first');
    text = await act(page, 'Control+Alt+KeyR', 'analysis wages', /Python analysis is unavailable: No Python environment is selected/, 'analysis, nothing chosen'); note('off: Run analysis asks for a Python first');
    await open(page, 'cell.py', '# %% one'); text = await act(page, 'Control+Enter', 'print', /Run cells is unavailable: No Python environment is selected/, 'run cell, nothing chosen'); note('off: Run cell asks for a Python first');
    const close = await thisComputer(page); await until(async () => (await page.locator(`#computer-python option[value="${python}"]`).count()) > 0, 'Python listed');
    const s0 = Date.now(); await page.selectOption('#computer-python', python); await until(async () => /Ready for the tools below|not installed/.test(await page.locator('#setting-computer-python .ide-setting-description').textContent()), 'Python chosen'); measures.selectMs = Date.now() - s0;
    for (const row of ['computer-run-cells', 'computer-math-check', 'computer-python-analysis']) assert.equal(await page.locator(`#${row} input`).isChecked(), false, row + ' stays off');
    await close();
    await open(page, 'main.tex', '\\documentclass');
    text = await act(page, 'Control+Alt+KeyM', '\\frac{u^2}', /Math check is off\. Turn it on in Settings › This computer/, 'math check, feature off'); note('off: a chosen Python with Math check off is refused, not run');
    await open(page, 'cell.py', '# %% one'); text = await act(page, 'Control+Enter', 'print', /Run cells is (off|unavailable)/, 'run cell, feature off'); note('off: Run cells off is refused, not run');
    const started = ops.filter(op => ['script', 'start', 'run', 'consent'].includes(op)); assert.deepEqual(started, [], 'nothing started: ' + ops.join(','));
    assert.equal(await page.locator('dialog.olx-consent').count(), 0, 'no consent asked while features are off');
    // helper round trip for the readiness status (one native-messaging launch + discovery)
    measures.statusMs = await page.evaluate(() => new Promise((resolve, reject) => { const t = performance.now(), port = chrome.runtime.connectNative('com.cenker.latex_research');
      port.onMessage.addListener(m => { if (m.id === 9) { port.disconnect(); resolve(Math.round(performance.now() - t)); } }); port.onDisconnect.addListener(() => reject(Error('helper closed'))); port.postMessage({ id: 9, op: 'status' }); }));
    const outside = requests.filter(url => !/^(chrome-extension|blob|data):/.test(url)); assert.deepEqual(outside, [], 'requests outside the extension');
    note('off: only status/select reached the helper; no request left the extension', `ops ${[...new Set(ops)].join(',')}; status round trip ${measures.statusMs} ms`);
    await context.close(); contexts.pop(); }
  assert.deepEqual(errors, [], 'no page errors');
  await until(() => helpers() === 0, 'helper exits when its browser closes', 10000);
  console.log(JSON.stringify({ absentBrowser: { passed: results.length, measures } }));
} catch (error) { console.log('page errors:', errors); throw error; } finally {
  for (const context of contexts) await context.close().catch(() => {});
  rmSync(work, { recursive: true, force: true });
}
