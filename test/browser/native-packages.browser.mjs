// SPDX-License-Identifier: AGPL-3.0-only
// TEX-PKG-03 / PKG-T04 loopback check: a project needs a package absent from Ana's chosen TeX installation, so the shared
// compile on her computer fails visibly; the package then enters Ana's browser package store, Settings › Packages shows it is
// active for her TeX installation too, and the same compile succeeds on her TeX. Her installation is not changed. The store
// record is built from the real mirror archive, checked against the SHA-512 in the mirror's tlpdb (whose own SHA-512 file is
// checked too); the in-browser download/verify/unpack is packages.browser.mjs's (PKG-T02/T03), not repeated here.
// Same setup and environment as lan-compile.browser.mjs (LATEX_TEX_HELPER, LATEX_TEX_DIR, LATEX_LAN_HELPER, ...).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repository = resolve(import.meta.dirname, '../..'), base = resolve(process.env.LATEX_EXTENSION_BASE), helper = resolve(process.env.LATEX_LAN_HELPER);
const texHelper = resolve(process.env.LATEX_TEX_HELPER), texDir = resolve(process.env.LATEX_TEX_DIR), PACKAGE = 'accents';
const work = mkdtempSync(join(tmpdir(), 'latex-native-packages-')), extension = join(work, 'extension');
cpSync(base, extension, { recursive: true });
for (const name of readdirSync(join(repository, 'runtime/browser-recovery'))) if (/\.(?:js|mjs|html|css)$/.test(name) && !['apply.mjs', 'provision-offline.mjs', 'recovery-sw.template.js'].includes(name)) cpSync(join(repository, 'runtime/browser-recovery', name), join(extension, 'recovery', name));
for (const name of readdirSync(join(repository, 'runtime/chrome-extension'))) if (/^(lan-.*\.mjs|this-computer\.mjs|cells-ui\.mjs|packages-ui\.mjs|join\.js|index\.html)$/.test(name)) cpSync(join(repository, 'runtime/chrome-extension', name), join(extension, 'extension', name));
mkdirSync(join(extension, 'extension/research'), { recursive: true }); for (const name of ['outputs.mjs', 'notebook.mjs']) cpSync(join(repository, 'runtime/research', name), join(extension, 'extension/research', name));
mkdirSync(join(extension, 'extension/packages'), { recursive: true }); for (const name of ['store.mjs', 'tlpdb.mjs', 'tar.mjs', 'openpgp.mjs', 'detect.mjs', 'xzwasm.min.js', 'texlive.asc']) cpSync(join(repository, 'runtime/packages', name), join(extension, 'extension/packages', name));
{ const sw = join(extension, 'recovery/recovery-sw.js'), assets = readFileSync(sw, 'utf8').match(/const manifest = (.+);/)[1]; writeFileSync(sw, readFileSync(join(repository, 'runtime/browser-recovery/recovery-sw.template.js'), 'utf8').replace('__RECOVERY_MANIFEST__', assets)); }
for (const name of ['native-workspace.html', 'project-workspace.html']) { const path = join(extension, 'recovery', name); writeFileSync(path, readFileSync(path, 'utf8').replace('<head>', '<head><script src="/extension/bootstrap.js"></script>')); }
import { assetName, patchEditorUnicode, pathnameAssets, patchPathnameUnicode } from '../../runtime/browser-recovery/apply.mjs';
{ const editorPath = join(extension, 'js', assetName), raw = readFileSync(editorPath, 'utf8'), editor = raw.includes(String.raw`/[\0\uD800-\uDFFF]/gu`) ? raw : patchEditorUnicode(raw);
  const header = 'function extension(State, Transaction, container, name) {\n    return State.transactionFilter.of(';
  writeFileSync(editorPath, editor.replace(header, 'function extension(State, Transaction, container, name) {\n    if (globalThis.overleafLanGate) return [];\n    return State.transactionFilter.of(')); }
cpSync(join(repository, 'runtime/participant-compile/worker.js'), join(extension, 'recovery/busytex/busytex_worker.js'));
for (const name of Object.keys(pathnameAssets)) { const path = join(extension, 'js', name), raw = readFileSync(path, 'utf8'); if (!raw.includes(pathnameAssets[name][1])) writeFileSync(path, patchPathnameUnicode(name, raw)); }
const manifest = JSON.parse(readFileSync(join(repository, 'runtime/chrome-extension/manifest.json'), 'utf8')); writeFileSync(join(extension, 'manifest.json'), JSON.stringify(manifest));
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
const MIRROR = 'https://ftp.fau.de/ctan/systems/texlive/tlnet';   // store.mjs MIRRORS[0]
// stdout: the store's package record {name, revision, sha512, license, size, files: [{path, data: base64}]} for argv[2]
const FIXTURE = String.raw`
import sys, json, lzma, tarfile, io, hashlib, base64, itertools, urllib.request
mirror, name = sys.argv[1], sys.argv[2]
get = lambda path: urllib.request.urlopen(mirror + path, timeout=60).read()
db = lzma.decompress(get('/tlpkg/texlive.tlpdb.xz'))
assert hashlib.sha512(db).hexdigest() == get('/tlpkg/texlive.tlpdb.sha512').split()[0].decode(), 'tlpdb checksum'
block = next(b for b in db.decode().split(chr(10) * 2) if b.startswith('name ' + name + chr(10)))
field = lambda key: next(l.split(' ', 1)[1] for l in block.splitlines() if l.startswith(key + ' '))
runfiles = [l.strip() for l in itertools.takewhile(lambda l: l.startswith(' '), block.split(chr(10) + 'runfiles ', 1)[1].splitlines()[1:])]
assert runfiles and all(f.startswith('RELOC/') for f in runfiles) and not any(l.startswith('execute ') for l in block.splitlines()), 'plain runfiles only'
archive = get('/archive/' + name + '.tar.xz'); assert hashlib.sha512(archive).hexdigest() == field('containerchecksum'), 'archive checksum'
tar = tarfile.open(fileobj=io.BytesIO(lzma.decompress(archive)))
files = [{'path': f[6:], 'data': base64.b64encode(tar.extractfile(f[6:]).read()).decode()} for f in runfiles]   # relocated container: paths without RELOC/
print(json.dumps({'name': name, 'revision': field('revision'), 'sha512': field('containerchecksum'), 'license': field('catalogue-license'), 'size': sum(len(base64.b64decode(f['data'])) for f in files), 'files': files}))
`;
const root = `chrome-extension://${id}`, results = [], note = (name, detail = '') => { results.push(name); console.log('ok -', name, detail); };
const kpsewhich = file => { try { return execFileSync(join(texDir, 'kpsewhich'), [file], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const installation = () => execFileSync('/usr/bin/find', [resolve(texDir, '../..'), '-newer', join(work, 'stamp'), '-not', '-path', '*/texmf-var/*'], { encoding: 'utf8' }).trim();

async function profile(name, { tex = false } = {}) {
  const dir = join(work, name), hosts = join(dir, 'NativeMessagingHosts'); mkdirSync(hosts, { recursive: true });
  writeFileSync(join(hosts, 'com.cenker.latex_lan.json'), JSON.stringify({ name: 'com.cenker.latex_lan', description: 'LAN sharing helper (test)', path: helper, type: 'stdio', allowed_origins: [root + '/'] }));
  if (tex) writeFileSync(join(hosts, 'com.cenker.latex_local.json'), JSON.stringify({ name: 'com.cenker.latex_local', description: 'TeX helper (test)', path: texHelper, type: 'stdio', allowed_origins: [root + '/'] }));
  const context = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true, executablePath: process.env.EXTENSION_CHROME_PATH, ignoreDefaultArgs: ['--disable-extensions'],
    env: { ...process.env, LATEX_LOCAL_SETTINGS: join(work, name + '-tex-settings.json') }, viewport: { width: 1400, height: 900 }, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
  await context.addInitScript(() => { globalThis.LATEX_LAN_LOOPBACK = true; });
  context.setDefaultTimeout(20000); return context;
}
const editorOf = page => page.getByRole('textbox', { name: /^Source Editor/ });
const docOf = page => editorOf(page).evaluate(node => node.cmView.view.state.doc.toString());
const setDoc = (page, text) => editorOf(page).evaluate((node, value) => { const view = node.cmView.view; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }); }, text);
const until = async (check, what, ms = 15000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await check(); if (last) return last; } catch (error) { last = error; } await new Promise(r => setTimeout(r, 100)); } throw Error('Timed out: ' + what + (last instanceof Error ? ' (' + last.message + ')' : last ? ' (last: ' + String(last).slice(0, 300) + ')' : '')); };
const status = page => page.locator('#local-status').textContent();
const pdfText = page => page.locator('.textLayer').allTextContents().then(list => list.join(' '));
const settingsTab = async (page, tab) => { await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: tab }).click(); return () => page.getByRole('button', { name: 'Close dialog' }).click(); };
const describe = (page, row) => page.locator(`#setting-${row} .ide-setting-description`).textContent();
async function recompile(page, marker, what) {
  const start = performance.now(); await page.getByRole('button', { name: 'Recompile', exact: true }).click();
  await until(async () => marker ? (await pdfText(page)).includes(marker) && /Compiled/.test(await status(page)) : /Previous PDF retained/.test(await status(page)), what, 180000);
  return Math.round(performance.now() - start);
}
const contexts = [], errors = [];
try {
  assert(existsSync(join(texDir, 'pdflatex')), 'LATEX_TEX_DIR must be a TeX bin folder');
  assert.equal(kpsewhich(PACKAGE + '.sty'), '', `${PACKAGE}.sty must be absent from the chosen TeX installation`); writeFileSync(join(work, 'stamp'), '');
  const [ownerContext, anaContext] = [await profile('owner'), await profile('ana', { tex: true })]; contexts.push(ownerContext, anaContext);
  const owner = await ownerContext.newPage(); owner.on('pageerror', e => errors.push('owner: ' + e.message.slice(0, 200)));
  await owner.goto(root + '/extension/index.html'); await owner.waitForURL(/\/recovery\/project-workspace\.html$/);
  await owner.getByRole('textbox', { name: 'New local project name', exact: true }).fill('Synthetic native packages'); await owner.getByRole('button', { name: 'Create local project', exact: true }).click();
  await editorOf(owner).waitFor({ timeout: 60000 });
  const plain = '\\documentclass{article}\n\\begin{document}\nPLAINMARK\n\\end{document}\n';
  const needs = `\\documentclass{article}\n\\usepackage{${PACKAGE}}\n\\begin{document}\nPKGMARK $\\accentset{\\star}{x}$\n\\end{document}\n`;
  await setDoc(owner, plain);
  await owner.getByRole('button', { name: 'Share on this network' }).click();
  const panel = owner.getByRole('dialog', { name: 'Share on this network' });
  await until(async () => (await panel.locator('code').nth(0).textContent()).trim(), 'share link');
  const link = (await panel.locator('code').nth(0).textContent()).trim(), passcode = (await panel.locator('code').nth(1).textContent()).trim();
  const ana = await anaContext.newPage(); ana.on('pageerror', e => errors.push('ana: ' + e.message.slice(0, 200))); await ana.goto(link);
  await ana.getByLabel('Passcode').fill(passcode); await ana.getByLabel('Your name for this session').fill('Ana'); await ana.getByRole('button', { name: 'Join' }).click();
  await editorOf(ana).waitFor({ timeout: 60000 }); await until(async () => (await docOf(ana)) === plain, 'Ana has the source');
  await panel.getByLabel('Permission for Ana').selectOption('copy');
  let close = await settingsTab(ana, 'This computer');
  await until(async () => (await ana.locator('#olx-tex-choice option').allTextContents()).includes(texDir), 'detected installations listed');
  await ana.locator('#olx-tex-choice').selectOption(texDir); await until(async () => /^Ready: pdflatex/.test(await describe(ana, 'olx-tex-choice')), 'TeX ready');
  await ana.locator('#olx-help-compile').check(); await until(async () => /Waiting for compile jobs/.test(await describe(ana, 'olx-help-status')), 'Ana helping'); await close();
  close = await settingsTab(owner, 'This computer'); await until(async () => /available, 1 computer helping/.test(await describe(owner, 'olx-group-compile')), 'owner sees Ana'); await owner.locator('#olx-group-compile').check(); await close();
  const plainMs = []; for (let i = 0; i < 3; i++) plainMs.push(await recompile(owner, 'PLAINMARK', 'plain shared compile'));
  note('the owner compiles on Ana’s TeX (no packages installed)', `${plainMs.join(', ')} ms`);

  // before: the package is missing from Ana's TeX, so the shared compile fails visibly
  await setDoc(owner, needs); await until(async () => (await docOf(ana)) === needs, 'source reaches Ana');
  await recompile(owner, null, 'missing package fails'); const failed = await status(owner); assert.match(failed, /Ana/); assert.equal((await pdfText(owner)).includes('PKGMARK'), false);
  note('PKG-T04: before installation the compile on Ana’s TeX fails visibly; the previous PDF is kept', failed.slice(0, 160));

  // Settings › Packages says which compilers an installed package is active for; then the package enters Ana's store
  close = await settingsTab(ana, 'Packages'); const pane = ana.locator('#ide-settings-tabs-tabpane-packages');
  await until(async () => (await describe(ana, 'packages-installed')).includes(texDir), 'installed row names the TeX installation');
  assert.match(await describe(ana, 'packages-installed'), /Active for this browser’s compiler and for this computer’s TeX installation .* never into the installation/);
  note('Settings › Packages says installed packages are active for the browser compiler and for Ana’s chosen TeX installation');
  const t0 = Date.now(), fixture = JSON.parse(execFileSync('/usr/bin/python3', ['-I', '-c', FIXTURE, MIRROR, PACKAGE], { encoding: 'utf8', maxBuffer: 1 << 26 }));
  await ana.evaluate(async record => {   // the record store.install() writes, then the store's own invalidation of this tab's compile set
    record.current.files = record.current.files.map(f => ({ path: f.path, data: Uint8Array.from(atob(f.data), c => c.charCodeAt(0)) }));
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('olx-packages', 1); r.onupgradeneeded = () => { r.result.createObjectStore('catalog'); r.result.createObjectStore('packages', { keyPath: 'name' }); }; r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    await new Promise((resolve, reject) => { const tx = db.transaction('packages', 'readwrite'); tx.objectStore('packages').put(record); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
    await (await import('/extension/packages/store.mjs')).uninstall('olx-absent-name');
  }, { name: PACKAGE, current: { ...fixture, installedAt: Date.now() }, previous: null });
  const installMs = Date.now() - t0; await close(); close = await settingsTab(ana, 'Packages');
  await until(async () => (await ana.locator('#ide-settings-tabs-tabpane-packages ul[aria-label="Installed packages"] li code').allTextContents()).includes(PACKAGE), 'listed as installed'); await close();
  const tree = await ana.evaluate(() => import('/extension/packages/store.mjs').then(m => m.compileSet()).then(s => ({ files: s.files.length - 1, bytes: s.files.reduce((n, f) => n + (f.content instanceof Uint8Array ? f.content.length : 0), 0) })));
  note(`${PACKAGE} r${fixture.revision} (licence ${fixture.license}) from ${MIRROR.split('/')[2]}, SHA-512 matches the tlpdb, is installed in Ana’s browser store and listed`, `${installMs} ms; ${tree.files} files, ${tree.bytes} B injected per job`);

  // after: the same compile succeeds on Ana's TeX; her installation is unchanged
  const withMs = []; for (let i = 0; i < 3; i++) { await setDoc(owner, needs.replace('PKGMARK', 'PKGMARK' + i)); await until(async () => (await docOf(ana)).includes('PKGMARK' + i), 'edit reaches Ana'); withMs.push(await recompile(owner, 'PKGMARK' + i, 'compile with the installed package')); }
  const stats = await owner.evaluate(() => globalThis.overleafGroupStats); assert.equal(stats.by, 'Ana');
  note('PKG-T04: after installation the same project compiles on Ana’s TeX', `${withMs.join(', ')} ms request→visible PDF; worker ${stats.runMs} ms`);
  assert.equal(kpsewhich(PACKAGE + '.sty'), '', 'still absent from the installation'); assert.equal(installation(), '', 'nothing in the TeX installation changed');
  await until(() => !readdirSync(tmpdir()).some(name => /^latex-local-[0-9a-f]+$/.test(name) && existsSync(join(tmpdir(), name, '.latex-local-texmf'))), 'no job package tree left behind', 5000);   // removed when the job thread ends, just after its result
  note('the TeX installation is unchanged and no per-job package tree remains');
  assert.deepEqual(errors, [], 'page errors');
  const median = list => [...list].sort((a, b) => a - b)[1];
  console.log(`PASS ${results.length} checks (loopback only; real CTAN mirror)`);
  console.log('MEASURE', JSON.stringify({ plainMs, withMs, medianPlainMs: median(plainMs), medianWithMs: median(withMs), installMs, injectedFiles: tree.files, injectedBytes: tree.bytes, runMs: stats.runMs, inBytes: stats.inBytes }));
} finally { for (const context of contexts) await context.close().catch(() => {}); rmSync(work, { recursive: true, force: true }); }
