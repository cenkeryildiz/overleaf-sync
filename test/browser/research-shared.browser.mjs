// SPDX-License-Identifier: AGPL-3.0-only
// S3-07 / RESEARCH-RUNTIME-01 loopback check: code never runs while a project is shared. The owner runs a cell, shares on
// loopback, participant Ana joins; Run cell, Check equation and Run analysis (and the owner's trusted refresh) are refused on
// both sides with a plain message, no consent is asked and the page sends nothing to the research helper (a spy around
// chrome.runtime.connectNative records every op). After Stop sharing the owner is asked for consent again and runs code.
// Real native editor, LAN relay helper and research helper; synthetic project; loopback only, not a two-device result.
//   PLAYWRIGHT_MODULE=<playwright> EXTENSION_CHROME_PATH=<Chromium that honours --load-extension> LATEX_EXTENSION_BASE=<LAN test package> \
//   LATEX_LAN_HELPER=<latex-local-lan> LATEX_RESEARCH_HELPER=<latex-local-research> RESEARCH_PYTHON=<python with ipykernel+SymPy> \
//   node test/browser/research-shared.browser.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assetName, patchEditorUnicode } from '../../runtime/browser-recovery/apply.mjs';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repository = resolve(import.meta.dirname, '../..'), base = resolve(process.env.LATEX_EXTENSION_BASE);
const lanHelper = resolve(process.env.LATEX_LAN_HELPER), researchHelper = resolve(process.env.LATEX_RESEARCH_HELPER), python = realpathSync(process.env.RESEARCH_PYTHON);
const work = mkdtempSync(join(tmpdir(), 'latex-shared-research-')), extension = join(work, 'extension');
cpSync(base, extension, { recursive: true });   // same overlay as lan-compile.browser.mjs, plus the research modules
for (const name of readdirSync(join(repository, 'runtime/browser-recovery'))) if (/\.(?:js|mjs|html|css)$/.test(name) && !['apply.mjs', 'provision-offline.mjs', 'recovery-sw.template.js'].includes(name)) cpSync(join(repository, 'runtime/browser-recovery', name), join(extension, 'recovery', name));
for (const name of readdirSync(join(repository, 'runtime/chrome-extension'))) if (/^(lan-.*\.mjs|this-computer\.mjs|cells-ui\.mjs|research-ui\.mjs|join\.js|index\.html)$/.test(name)) cpSync(join(repository, 'runtime/chrome-extension', name), join(extension, 'extension', name));
mkdirSync(join(extension, 'extension/research'), { recursive: true }); for (const name of ['manuscript.mjs', 'deps.mjs', 'outputs.mjs', 'notebook.mjs']) cpSync(join(repository, 'runtime/research', name), join(extension, 'extension/research', name));
for (const name of ['native-workspace.html', 'project-workspace.html']) { const path = join(extension, 'recovery', name); writeFileSync(path, readFileSync(path, 'utf8').replace('<head>', '<head><script src="/extension/bootstrap.js"></script>')); }
{ const editorPath = join(extension, 'js', assetName), raw = readFileSync(editorPath, 'utf8'), editor = raw.includes(String.raw`/[\0\uD800-\uDFFF]/gu`) ? raw : patchEditorUnicode(raw);
  const header = 'function extension(State, Transaction, container, name) {\n    return State.transactionFilter.of(';
  assert.equal(editor.split(header).length - 1, 1, 'base editor asset has an unexpected recovery extension');
  writeFileSync(editorPath, editor.replace(header, 'function extension(State, Transaction, container, name) {\n    if (globalThis.overleafLanGate) return [];\n    return State.transactionFilter.of(')); }
const manifest = JSON.parse(readFileSync(join(repository, 'runtime/chrome-extension/manifest.json'), 'utf8'));
writeFileSync(join(extension, 'manifest.json'), JSON.stringify(manifest));
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
const root = `chrome-extension://${id}`, results = [], errors = [], ops = { owner: [], ana: [] }, note = (name, detail = '') => { results.push(name); console.log('ok -', name, detail); };
const until = async (check, what, ms = 30000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await check(); if (last) return last; } catch (error) { last = error; } await new Promise(r => setTimeout(r, 50)); } throw Error('Timed out: ' + what + (last instanceof Error ? ' (' + last.message + ')' : last ? ' (last: ' + String(last).slice(0, 300) + ')' : '')); };

async function profile(name) {
  const dir = join(work, name), hosts = join(dir, 'NativeMessagingHosts'); mkdirSync(hosts, { recursive: true });
  for (const [host, path] of [['com.cenker.latex_lan', lanHelper], ['com.cenker.latex_research', researchHelper]]) writeFileSync(join(hosts, host + '.json'), JSON.stringify({ name: host, description: 'test', path, type: 'stdio', allowed_origins: [root + '/'] }));
  const context = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true, executablePath: process.env.EXTENSION_CHROME_PATH, ignoreDefaultArgs: ['--disable-extensions'],
    env: { ...process.env, LATEX_LOCAL_RESEARCH_SETTINGS: join(work, name + '-research.json') }, viewport: { width: 1400, height: 900 }, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
  await context.exposeBinding('__hostOp', (_, host, op) => { if (host === 'com.cenker.latex_research') ops[name].push(op); });
  await context.addInitScript(() => { globalThis.LATEX_LAN_LOOPBACK = true; const rt = globalThis.chrome?.runtime; if (!rt?.connectNative) return; const connect = rt.connectNative.bind(rt);
    rt.connectNative = host => { const port = connect(host), post = port.postMessage.bind(port); port.postMessage = message => { globalThis.__hostOp(host, message?.op); return post(message); }; return port; }; });
  context.setDefaultTimeout(30000); return context;
}
const helperCall = (page, op, args = {}) => page.evaluate(([op, args]) => new Promise((resolve, reject) => {
  const port = chrome.runtime.connectNative('com.cenker.latex_research');
  port.onMessage.addListener(m => { if (m.id !== 1) return; port.disconnect(); m.error ? reject(Error(m.error)) : resolve(m.result); });
  port.onDisconnect.addListener(() => reject(Error(chrome.runtime.lastError?.message ?? 'helper closed'))); port.postMessage({ id: 1, op, ...args });
}), [op, args]);
const editorOf = page => page.getByRole('textbox', { name: /^Source Editor/ });
const docOf = page => editorOf(page).evaluate(node => node.cmView.view.state.doc.toString());
const select = (page, text, cursor = false) => editorOf(page).evaluate((node, [text, cursor]) => { const view = node.cmView.view, from = view.state.doc.toString().indexOf(text); if (from < 0) throw Error('not found: ' + text);
  view.dispatch({ selection: cursor ? { anchor: from } : { anchor: from, head: from + text.length }, scrollIntoView: true }); view.focus(); }, [text, cursor]);
const open = (page, name, start) => until(async () => { if ((await docOf(page)).startsWith(start)) return true; await page.locator(`li[role=treeitem][aria-label="${name}"]`).click(); await page.waitForTimeout(300); return (await docOf(page)).startsWith(start); }, name + ' open');
const panel = page => page.locator('#research-results'), state = page => panel(page).locator('header [role=status]').textContent(), body = page => panel(page).locator('#rr-body').innerText();
const lastEntry = page => panel(page).locator('li').last();
const consentDialog = page => page.getByRole('dialog', { name: 'Allow this project to run code' });
async function thisComputer(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'This computer' }).click();
  await page.locator('#ide-settings-tabs-tabpane-this-computer').waitFor();
  return () => page.getByRole('button', { name: 'Close dialog' }).click();
}
const describe = (page, row) => page.locator(`#setting-${row} .ide-setting-description`).textContent();
const REFUSED = /Not run: code never runs while this project is shared on the network or opened from a shared session/;
const EXEC = ['start', 'run', 'script', 'restart', 'interrupt', 'consent'];

const cell = '# %% answer\nprint(6 * 7)\n';
const manuscript = String.raw`\documentclass{article}
\begin{document}
Wrong: $(a+b)^2 = a^2 + b^2$.
% analysis wages python ols data=data/wages.csv y=wage x=educ caption="Wages"
\end{document}
`;
const wages = 'educ,wage\n' + Array.from({ length: 12 }, (_, i) => `${i},${3 + 0.5 * i + (i % 2 ? 0.2 : -0.2)}`).join('\n') + '\n';
/** Run cell, Check equation and Run analysis on `page`; each must be refused visibly with no consent dialog. */
async function refusedEverywhere(page, who) {
  await open(page, 'analysis.py', '# %% answer'); await select(page, 'print', true); await page.keyboard.press('Control+Enter');
  await until(async () => REFUSED.test(await lastEntry(page).innerText()), who + ' Run cell refused');
  assert.match(await lastEntry(page).innerText(), /Run cell · refused/);
  await open(page, 'main.tex', '\\documentclass'); await select(page, '(a+b)^2 = a^2 + b^2'); await page.keyboard.press('Control+Alt+KeyM');
  await until(async () => (await state(page)) === 'Refused' && REFUSED.test(await body(page)), who + ' Check equation refused');
  await select(page, '% analysis wages', true); await page.keyboard.press('Control+Alt+KeyR');
  await until(async () => (await state(page)) === 'Refused' && REFUSED.test(await body(page)), who + ' Run analysis refused');
  assert.equal(await consentDialog(page).count(), 0, 'no consent dialog while shared');
}

const contexts = [];
try {
  const [ownerContext, anaContext] = [await profile('owner'), await profile('ana')]; contexts.push(ownerContext, anaContext);
  const owner = await ownerContext.newPage(); owner.on('pageerror', e => errors.push('owner: ' + e.message.slice(0, 200)));
  await owner.goto(root + '/extension/index.html');
  // device-local choices through the helper's own ops (what Settings › This computer sends)
  const status = await helperCall(owner, 'status');
  const py = status.python.find(r => { try { return realpathSync(r.path) === python; } catch { return false; } }); assert(py, 'RESEARCH_PYTHON is not discovered by the helper');
  await helperCall(owner, 'select', { kind: 'python', path: py.path }); await helperCall(owner, 'kernel', { name: 'python3' });
  for (const name of ['jupyter', 'math-check', 'python-analysis']) await helperCall(owner, 'feature', { name, on: true });
  await owner.getByRole('link', { name: 'Work offline', exact: true }).click();
  await owner.getByRole('textbox', { name: 'New local project name', exact: true }).fill('Synthetic shared research');
  await owner.getByRole('button', { name: 'Create local project', exact: true }).click();
  await editorOf(owner).waitFor({ timeout: 60000 });
  for (const [path, text] of [['analysis.py', cell], ['data/wages.csv', wages]]) assert.equal(await owner.evaluate(async ([path, text]) => { const pid = document.querySelector('meta[name="ol-project_id"]').content, name = path.split('/').pop(), form = new FormData();
    form.append('qqfile', new File([text], name)); form.append('relativePath', path); form.append('name', name); return (await fetch(`/project/${pid}/upload`, { method: 'POST', body: form })).status; }, [path, text]), 200, path);
  await editorOf(owner).evaluate((node, text) => { const view = node.cmView.view; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }); }, manuscript);
  // before sharing: a cell runs after consent
  await open(owner, 'analysis.py', '# %% answer'); await select(owner, 'print', true); await owner.keyboard.press('Control+Enter');
  await consentDialog(owner).getByRole('button', { name: 'Allow on this computer' }).click();
  await until(async () => /cell 1 · ok/.test(await lastEntry(owner).innerText()), 'cell ran before sharing', 90000); assert.match(await lastEntry(owner).innerText(), /^42$/m);
  note('before sharing the owner runs a cell after consent');

  // share on loopback; Ana joins
  await owner.getByRole('button', { name: 'Share on this network' }).click();
  const share = owner.getByRole('dialog', { name: 'Share on this network' });
  await until(async () => (await share.locator('code').nth(0).textContent()).trim(), 'share link');
  const link = (await share.locator('code').nth(0).textContent()).trim(), passcode = (await share.locator('code').nth(1).textContent()).trim();
  await until(() => ops.owner.includes('consent'), 'sharing withdraws run consent'); await owner.keyboard.press('Escape');
  const ana = await anaContext.newPage(); ana.on('pageerror', e => errors.push('ana: ' + e.message.slice(0, 200))); await ana.goto(link);
  await ana.getByLabel('Passcode').fill(passcode); await ana.getByLabel('Your name for this session').fill('Ana'); await ana.getByRole('button', { name: 'Join' }).click();
  await editorOf(ana).waitFor({ timeout: 60000 });
  note('owner shares on loopback (run consent withdrawn); Ana joins');
  ops.owner.length = 0; ops.ana.length = 0;

  await refusedEverywhere(ana, 'Ana');
  assert.deepEqual(ops.ana, [], 'Ana sent nothing to the research helper'); note('participant: Run cell, Check equation and Run analysis refused visibly; nothing sent to the helper');
  await refusedEverywhere(owner, 'owner');
  // trusted refresh: a changed analysis input would rerun it for a trusted project; while shared it must not
  await owner.evaluate(() => { globalThis.overleafResearchTrusted = () => true; });
  await select(owner, '% analysis wages', true);
  await editorOf(owner).evaluate(node => { const view = node.cmView.view, doc = view.state.doc.toString(), at = doc.indexOf('caption="Wages"'); view.dispatch({ changes: { from: at, to: at + 15, insert: 'caption="Pay"' } }); });
  await owner.waitForTimeout(6000);   // research-ui polls every 4 s while its panel is open
  assert.notEqual(await state(owner), 'Running…');
  assert.deepEqual(ops.owner, [], 'the owner sent nothing to the research helper while sharing'); note('owner while sharing: the same three refused, trusted refresh does not run; nothing sent to the helper');
  let close = await thisComputer(ana);
  await until(async () => /Code never runs while this project is shared/.test(await describe(ana, 'computer-project-consent')), 'Ana consent row');
  assert(await ana.locator('#computer-project-consent input').isDisabled(), 'consent cannot be granted while shared'); await close();
  assert(!ops.ana.some(op => EXEC.includes(op)), 'settings ran nothing: ' + ops.ana.join(','));
  note('participant settings: consent shown as never while shared and cannot be switched on', ops.ana.join(','));

  // stop sharing: execution comes back for the owner, consent is asked again
  await owner.locator('#local-share').click(); await share.getByRole('button', { name: 'Stop sharing' }).click();
  await until(async () => /Sharing stopped/.test(await owner.locator('#local-status').textContent()), 'sharing stopped');
  await owner.evaluate(() => { globalThis.overleafResearchTrusted = () => false; });
  await open(owner, 'analysis.py', '# %% answer'); await select(owner, 'print', true); await owner.keyboard.press('Control+Enter');
  await consentDialog(owner).getByRole('button', { name: 'Allow on this computer' }).click();
  await until(async () => /cell 1 · ok/.test(await lastEntry(owner).innerText()), 'cell runs after sharing stops', 90000); assert.match(await lastEntry(owner).innerText(), /^42$/m);
  await open(owner, 'main.tex', '\\documentclass'); await select(owner, '(a+b)^2 = a^2 + b^2'); await owner.keyboard.press('Control+Alt+KeyM');
  await until(async () => (await state(owner)) === 'Issue found', 'equation checked after sharing stops', 60000);
  note('after Stop sharing the owner is asked for consent again, then Run cell and Check equation run', ops.owner.filter(op => EXEC.includes(op)).join(','));
  assert.deepEqual(errors, [], 'page errors');
  console.log(`PASS ${results.length} checks (loopback only; no second device)`);
} finally { for (const context of contexts) await context.close().catch(() => {}); rmSync(work, { recursive: true, force: true }); }
