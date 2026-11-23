// SPDX-License-Identifier: AGPL-3.0-only
// LAN-COMPILE-01 loopback check: an owner without TeX, participant Ana who chooses a local TeX installation and helps compile,
// participant Bea who does not. Real native editor, real relay helper and real TeX helper (native/) over native messaging.
// Loopback only; synthetic project; not a two-device result. Same setup as lan-native.browser.mjs, plus:
//   cargo build --offline --release --manifest-path runtime/chrome-extension/native/Cargo.toml   (CARGO_TARGET_DIR outside the repo)
//   LATEX_TEX_HELPER=<latex-local-host binary> LATEX_TEX_DIR=<TeX bin folder to select explicitly> node test/browser/lan-compile.browser.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repository = resolve(import.meta.dirname, '../..'), base = resolve(process.env.LATEX_EXTENSION_BASE), helper = resolve(process.env.LATEX_LAN_HELPER);
const texHelper = resolve(process.env.LATEX_TEX_HELPER), texDir = resolve(process.env.LATEX_TEX_DIR);
const work = mkdtempSync(join(tmpdir(), 'latex-group-check-')), extension = join(work, 'extension');
cpSync(base, extension, { recursive: true });
for (const name of readdirSync(join(repository, 'runtime/browser-recovery'))) if (/\.(?:js|mjs|html|css)$/.test(name) && !['apply.mjs', 'provision-offline.mjs', 'recovery-sw.template.js'].includes(name)) cpSync(join(repository, 'runtime/browser-recovery', name), join(extension, 'recovery', name));
for (const name of readdirSync(join(repository, 'runtime/chrome-extension'))) if (/^(lan-.*\.mjs|this-computer\.mjs|cells-ui\.mjs|join\.js|index\.html)$/.test(name)) cpSync(join(repository, 'runtime/chrome-extension', name), join(extension, 'extension', name));
mkdirSync(join(extension, 'extension/research'), { recursive: true }); for (const name of ['outputs.mjs', 'notebook.mjs']) cpSync(join(repository, 'runtime/research', name), join(extension, 'extension/research', name));   // cells-ui.mjs: sharing revokes run consent
for (const name of ['native-workspace.html', 'project-workspace.html']) { const path = join(extension, 'recovery', name); writeFileSync(path, readFileSync(path, 'utf8').replace('<head>', '<head><script src="/extension/bootstrap.js"></script>')); }
import { assetName, patchEditorUnicode, pathnameAssets, patchPathnameUnicode } from '../../runtime/browser-recovery/apply.mjs';
{ const editorPath = join(extension, 'js', assetName), raw = readFileSync(editorPath, 'utf8'), editor = raw.includes(String.raw`/[\0\uD800-\uDFFF]/gu`) ? raw : patchEditorUnicode(raw);
  const header = 'function extension(State, Transaction, container, name) {\n    return State.transactionFilter.of(';
  assert.equal(editor.split(header).length - 1, 1, 'base editor asset has an unexpected recovery extension');
  writeFileSync(editorPath, editor.replace(header, 'function extension(State, Transaction, container, name) {\n    if (globalThis.overleafLanGate) return [];\n    return State.transactionFilter.of(')); }
cpSync(join(repository, 'runtime/participant-compile/worker.js'), join(extension, 'recovery/busytex/busytex_worker.js'));
for (const name of Object.keys(pathnameAssets)) { const path = join(extension, 'js', name), raw = readFileSync(path, 'utf8'); if (!raw.includes(pathnameAssets[name][1])) writeFileSync(path, patchPathnameUnicode(name, raw)); }
const manifest = JSON.parse(readFileSync(join(repository, 'runtime/chrome-extension/manifest.json'), 'utf8'));
writeFileSync(join(extension, 'manifest.json'), JSON.stringify(manifest));
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
const root = `chrome-extension://${id}`, results = [], note = (name, detail = '') => { results.push(name); console.log('ok -', name, detail); };

async function profile(name, { tex = false } = {}) {
  const dir = join(work, name), hosts = join(dir, 'NativeMessagingHosts'); mkdirSync(hosts, { recursive: true });
  writeFileSync(join(hosts, 'com.cenker.latex_lan.json'), JSON.stringify({ name: 'com.cenker.latex_lan', description: 'LAN sharing helper (test)', path: helper, type: 'stdio', allowed_origins: [root + '/'] }));
  if (tex) writeFileSync(join(hosts, 'com.cenker.latex_local.json'), JSON.stringify({ name: 'com.cenker.latex_local', description: 'TeX helper (test)', path: texHelper, type: 'stdio', allowed_origins: [root + '/'] }));
  const context = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true, executablePath: process.env.EXTENSION_CHROME_PATH, ignoreDefaultArgs: ['--disable-extensions'],
    env: { ...process.env, LATEX_LOCAL_SETTINGS: join(work, name + '-tex-settings.json') }, // per-profile TeX choice, never the user's own settings
    viewport: { width: 1400, height: 900 }, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
  await context.addInitScript(() => { globalThis.LATEX_LAN_LOOPBACK = true; });
  context.setDefaultTimeout(20000); return context;
}
const editorOf = page => page.getByRole('textbox', { name: /^Source Editor/ });
const docOf = page => editorOf(page).evaluate(node => node.cmView.view.state.doc.toString());
const setDoc = (page, text) => editorOf(page).evaluate((node, value) => { const view = node.cmView.view; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }); }, text);
const until = async (check, what, ms = 15000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await check(); if (last) return last; } catch (error) { last = error; } await new Promise(r => setTimeout(r, 50)); } throw Error('Timed out: ' + what + (last instanceof Error ? ' (' + last.message + ')' : '')); };
const status = page => page.locator('#local-status').textContent();
const pdfText = page => page.locator('.textLayer').allTextContents().then(list => list.join(' '));
/** Settings (left rail) > This computer; returns a closer. */
async function thisComputer(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'This computer' }).click();
  await page.locator('#ide-settings-tabs-tabpane-this-computer').waitFor();
  return () => page.getByRole('button', { name: 'Close dialog' }).click();
}
const describe = (page, row) => page.locator(`#setting-${row} .ide-setting-description`).textContent();
async function recompile(page, marker, what) {
  const start = performance.now(); await page.getByRole('button', { name: 'Recompile', exact: true }).click();
  await until(async () => (await pdfText(page)).includes(marker), what, 120000).catch(async error => { console.log(what, 'status:', await status(page)); throw error; });
  return Math.round(performance.now() - start);
}
const contexts = [], errors = [];
try {
  assert(existsSync(join(texDir, 'pdflatex')), 'LATEX_TEX_DIR must be a TeX bin folder');
  const [ownerContext, anaContext, beaContext] = [await profile('owner'), await profile('ana', { tex: true }), await profile('bea')]; contexts.push(ownerContext, anaContext, beaContext);
  const owner = await ownerContext.newPage(); owner.on('pageerror', e => errors.push('owner: ' + e.message.slice(0, 200)));
  await owner.goto(root + '/extension/index.html');
  await owner.getByRole('link', { name: 'Work offline', exact: true }).click();
  await owner.getByRole('textbox', { name: 'New local project name', exact: true }).fill('Synthetic group compile');
  await owner.getByRole('button', { name: 'Create local project', exact: true }).click();
  await editorOf(owner).waitFor({ timeout: 60000 });
  const ownerTex = await owner.evaluate(() => new Promise(resolve => { try { const port = chrome.runtime.connectNative('com.cenker.latex_local'); port.onDisconnect.addListener(() => resolve('absent')); port.postMessage({ id: 1, op: 'status' }); port.onMessage.addListener(() => resolve('present')); } catch { resolve('absent'); } }));
  assert.equal(ownerTex, 'absent'); note('owner profile has no TeX helper and no TeX');
  // multi-file source with math; the owner uploads the second file
  const upload = (path, text) => owner.evaluate(async ([path, text]) => { const pid = document.querySelector('meta[name="ol-project_id"]').content, form = new FormData();
    form.append('qqfile', new File([text], path)); form.append('relativePath', path); form.append('name', path);
    return (await fetch(`/project/${pid}/upload`, { method: 'POST', body: form })).status; }, [path, text]);
  assert.equal(await upload('sec.tex', 'Section SECMARK from a second file.\n'), 200);
  const source = '\\documentclass{article}\n\\begin{document}\nShared GROUPMARK text.\n\\input{sec}\n$\\int_0^1 x\\,dx=\\frac{1}{2}$\n\\end{document}\n';
  await setDoc(owner, source);
  // share and join both participants
  await owner.getByRole('button', { name: 'Share on this network' }).click();
  const panel = owner.getByRole('dialog', { name: 'Share on this network' });
  await until(async () => (await panel.locator('code').nth(0).textContent()).trim(), 'share link');
  const link = (await panel.locator('code').nth(0).textContent()).trim(), passcode = (await panel.locator('code').nth(1).textContent()).trim();
  const joinAs = async (context, name) => { const page = await context.newPage(); page.on('pageerror', e => errors.push(name + ': ' + e.message.slice(0, 200))); await page.goto(link);
    await page.getByLabel('Passcode').fill(passcode); await page.getByLabel('Your name for this session').fill(name); await page.getByRole('button', { name: 'Join' }).click();
    await editorOf(page).waitFor({ timeout: 60000 }); await until(async () => (await docOf(page)) === source, name + ' has the source'); return page; };
  const ana = await joinAs(anaContext, "Ana"), bea = await joinAs(beaContext, "Bea");
  note('owner shares on loopback; Ana and Bea join');
  // no contributor: shared compilation is unavailable, Bea's own browser compile still works
  let close = await thisComputer(bea);
  assert.match(await describe(bea, 'olx-group-compile'), /unavailable, no computer is helping/); assert(await bea.locator('#olx-group-compile').isDisabled());
  await until(async () => /not installed|stopped/i.test(await describe(bea, 'olx-tex-choice')), 'Bea has no TeX helper'); await close();
  const localMs = await recompile(bea, 'GROUPMARK', 'Bea local compile');
  await until(async () => /Compiled and saved in this browser/.test(await status(bea)), 'Bea local compile status', 120000); assert.equal(await bea.evaluate(() => globalThis.overleafGroupStats ?? null), null);
  note('without a contributor: shared compilation shown unavailable; Bea compiles in her browser', `${localMs} ms`);
  // Ana: explicit TeX choice from the detected list, then opt in; the owner's grant is binding
  close = await thisComputer(ana);
  await until(async () => (await ana.locator('#olx-tex-choice option').allTextContents()).includes(texDir), 'detected installations listed');
  await until(async () => /Not chosen/.test(await describe(ana, 'olx-tex-choice')), 'Ana has not chosen'); assert(await ana.locator('#olx-help-compile').isDisabled(), 'no opt-in before a choice');
  await ana.locator('#olx-tex-choice').selectOption(texDir);
  await until(async () => /^Ready: pdflatex/.test(await describe(ana, 'olx-tex-choice')), 'TeX ready');
  await ana.locator('#olx-help-compile').check();
  await until(async () => /must allow “Can keep a copy”/.test(await describe(ana, 'olx-help-status')), 'opt-in refused without the copy grant');
  assert.equal(await ana.locator('#olx-help-compile').isChecked(), false);
  note('Ana selects the TeX installation explicitly; without the owner\'s copy grant her opt-in is refused by the owner');
  if (!(await panel.isVisible())) await owner.locator('#local-share').click();
  await panel.getByLabel('Permission for Ana').selectOption('copy');
  await ana.locator('#olx-help-compile').check();
  await until(async () => /Waiting for compile jobs/.test(await describe(ana, 'olx-help-status')), 'Ana helping');
  await close();
  note('after the copy grant Ana helps compile; Bea does not');
  // Bea compiles through Ana's TeX
  close = await thisComputer(bea);
  await until(async () => /available, 1 computer helping/.test(await describe(bea, 'olx-group-compile')), 'Bea sees the contributor');
  await bea.locator('#olx-group-compile').check(); await close();
  await setDoc(bea, source.replace('GROUPMARK', 'GROUPMARK2')); await until(async () => (await docOf(owner)).includes('GROUPMARK2'), 'Bea edit reaches the owner');
  const sharedMs = await recompile(bea, 'GROUPMARK2', 'Bea shared compile');
  const stats = await bea.evaluate(() => globalThis.overleafGroupStats);
  assert.equal(stats.by, 'Ana'); assert.match(await pdfText(bea), /SECMARK/);
  await until(async () => /Compiled and saved|Compiled on Ana/.test(await status(bea)), 'Bea shared compile status', 120000);
  const sync = await bea.evaluate(async () => { const pid = document.querySelector('meta[name="ol-project_id"]').content; const r = await fetch(`/project/${pid}/sync/code?file=main.tex&line=3&column=0`); return [r.status, await r.json()]; });
  assert.equal(sync[0], 200, JSON.stringify(sync)); assert(sync[1].pdf?.[0]?.page === 1, JSON.stringify(sync));
  note('Bea\'s PDF compiled on Ana\'s TeX: multi-file + math, source→PDF navigation maps main.tex line 3', `${sharedMs} ms request→visible PDF; queue wait ${stats.waitMs} ms; worker ${stats.runMs} ms; ${stats.inBytes} B in, ${stats.outBytes} B out`);
  // the owner, who has no TeX, also compiles through Ana
  close = await thisComputer(owner); await owner.locator('#olx-group-compile').check(); await close();
  await setDoc(owner, source.replace('GROUPMARK', 'OWNERMARK'));
  const ownerMs = await recompile(owner, 'OWNERMARK', 'owner shared compile');
  assert.equal((await owner.evaluate(() => globalThis.overleafGroupStats)).by, 'Ana');
  note('the owner without TeX gets a PDF from Ana\'s computer', `${ownerMs} ms`);
  // a missing package fails visibly on the worker; Bea keeps her previous PDF and source
  await until(async () => (await docOf(bea)).includes('OWNERMARK'), 'owner edit reaches Bea');
  const before = await pdfText(bea);
  await setDoc(bea, source.replace('\\begin{document}', '\\usepackage{nosuchpackagexyz}\n\\begin{document}'));
  await until(async () => (await docOf(owner)).includes('nosuchpackagexyz'), 'broken source reaches the owner');
  await bea.getByRole('button', { name: 'Recompile', exact: true }).click();
  await until(async () => /Previous PDF retained/.test(await status(bea)), 'visible failure', 120000);
  assert.match(await status(bea), /Ana/); assert.equal(await pdfText(bea), before); assert.match(await docOf(bea), /nosuchpackagexyz/);
  note('missing package on the worker: visible failure, previous PDF and source kept', (await status(bea)).slice(0, 120));
  // opt-out: no contributor again; Bea's compile runs in her browser
  await setDoc(bea, source.replace('GROUPMARK', 'AFTERMARK')); await until(async () => (await docOf(owner)).includes('AFTERMARK'), 'fixed source reaches the owner');
  close = await thisComputer(ana); await ana.locator('#olx-help-compile').uncheck(); await close();
  close = await thisComputer(bea); await until(async () => /unavailable/.test(await describe(bea, 'olx-group-compile')), 'Bea sees no contributor'); await close();
  const statsBefore = JSON.stringify(await bea.evaluate(() => globalThis.overleafGroupStats));
  const afterMs = await recompile(bea, 'AFTERMARK', 'Bea local compile after opt-out');
  assert.equal(JSON.stringify(await bea.evaluate(() => globalThis.overleafGroupStats)), statsBefore, 'no shared job after the opt-out');
  note('after Ana opts out shared compilation is unavailable and Bea compiles in her browser again', `${afterMs} ms`);
  assert.deepEqual(errors, [], 'page errors');
  console.log(`PASS ${results.length} checks (loopback only; no second device)`);
  console.log('MEASURE', JSON.stringify({ localMs, sharedMs, ownerMs, afterMs, ...stats }));
} finally { for (const context of contexts) await context.close().catch(() => {}); if (process.env.LAN_KEEP_EXTENSION) console.log('kept', extension); else rmSync(work, { recursive: true, force: true }); }
