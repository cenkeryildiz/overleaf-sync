// SPDX-License-Identifier: AGPL-3.0-only
// Stage 5 TEX-PKG browser check (PKG-T01/T02/T03/T05/T06) on the real TeX Live mirror network: a failed compile offers
// Install; Settings › Packages downloads the signed list, shows what the project needs, installs a package with its
// dependencies, and the project compiles, also offline after a reload. Refusals: wrong archive bytes, bad signature,
// offline, cancel, concurrent install, closed tab mid-install, decompression bomb. Nothing downloads without a click.
//   PLAYWRIGHT_MODULE=<playwright> EXTENSION_CHROME_PATH=<Chromium that honours --load-extension> LATEX_EXTENSION_BASE=<built extension dir> node test/browser/packages.browser.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repository = resolve(import.meta.dirname, '../..'), base = resolve(process.env.LATEX_EXTENSION_BASE);
const work = mkdtempSync(join(tmpdir(), 'latex-packages-check-')), extension = join(work, 'extension');
cpSync(base, extension, { recursive: true });
cpSync(join(repository, 'runtime/browser-recovery/native-workspace.mjs'), join(extension, 'recovery/native-workspace.mjs'));
cpSync(join(repository, 'runtime/participant-compile/worker.js'), join(extension, 'recovery/busytex/busytex_worker.js'));
for (const name of readdirSync(join(repository, 'runtime/chrome-extension'))) if (/^(lan-.*|research-ui|cells-ui|this-computer|packages-ui)\.mjs$/.test(name)) cpSync(join(repository, 'runtime/chrome-extension', name), join(extension, 'extension', name));
mkdirSync(join(extension, 'extension/research'), { recursive: true }); for (const name of ['manuscript.mjs', 'deps.mjs', 'outputs.mjs', 'notebook.mjs']) cpSync(join(repository, 'runtime/research', name), join(extension, 'extension/research', name));
mkdirSync(join(extension, 'extension/packages'), { recursive: true }); for (const name of ['store.mjs', 'tlpdb.mjs', 'tar.mjs', 'openpgp.mjs', 'detect.mjs', 'xzwasm.min.js', 'XZWASM-LICENSE.txt', 'texlive.asc']) cpSync(join(repository, 'runtime/packages', name), join(extension, 'extension/packages', name));
{ const sw = join(extension, 'recovery/recovery-sw.js'), assets = readFileSync(sw, 'utf8').match(/const manifest = (.+);/)[1]; writeFileSync(sw, readFileSync(join(repository, 'runtime/browser-recovery/recovery-sw.template.js'), 'utf8').replace('__RECOVERY_MANIFEST__', assets)); }   // as package.mjs does
const manifest = JSON.parse(readFileSync(join(repository, 'runtime/chrome-extension/manifest.json'), 'utf8')); writeFileSync(join(extension, 'manifest.json'), JSON.stringify(manifest));   // the CSP that allows HTTPS mirrors
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
const results = [], measures = {}, errors = [], requests = [], note = (name, detail = '') => { results.push(name); console.log('ok -', name, detail); };
const until = async (check, what, ms = 30000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await check(); if (last) return last; } catch (error) { last = error; } await new Promise(r => setTimeout(r, 100)); } throw Error('Timed out: ' + what + (last instanceof Error ? ' (' + last.message + ')' : last ? ' (last: ' + String(last).slice(0, 400) + ')' : '')); };
const sample = async page => { measures.peakHeapBytes = Math.max(measures.peakHeapBytes ?? 0, await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0)); };
const idbBytes = page => page.evaluate(async () => (await navigator.storage.estimate()).usageDetails?.indexedDB ?? null);
const mirrorRequests = () => requests.filter(r => /^https:/.test(r.url));

const editorOf = page => page.getByRole('textbox', { name: /^Source Editor/ });
const setDoc = (page, text) => editorOf(page).evaluate((node, value) => { const view = node.cmView.view; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }); }, text);
const files = page => page.evaluate(async () => { const id = document.querySelector('meta[name="ol-project_id"]').content; return Object.fromEntries(Object.entries((await (await fetch(`/project/${id}/latest/history`)).json()).chunk.history.snapshot.files).map(([p, f]) => [p, f.content ?? 'hash:' + f.hash])); });
const status = page => page.locator('#local-status').textContent();
const pdfText = page => page.locator('.textLayer').allTextContents().then(list => list.join(' '));
async function compile(page, expect, what) {
  await page.locator('#local-status').evaluate(node => { node.textContent = ''; });   // so a warm compile is timed to its own result
  const t = Date.now(); await page.getByRole('button', { name: 'Recompile', exact: true }).click();
  await until(async () => { const now = await status(page); if (expect === 'fail' ? /Previous PDF retained/.test(now) : (await pdfText(page)).includes(expect) && /Compiled and saved/.test(now)) return true; throw Error(now); }, what, 180000);
  return Date.now() - t;
}
const packagesTab = async page => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: 'Packages' }).click();
  await page.locator('#ide-settings-tabs-tabpane-packages #setting-packages-catalog').waitFor(); return () => page.getByRole('button', { name: 'Close dialog' }).click();
};
const pane = page => page.locator('#ide-settings-tabs-tabpane-packages'), note_ = page => pane(page).locator('#olx-packages-status');
const requirement = (page, file) => pane(page).locator('li', { has: page.locator('code', { hasText: new RegExp('^' + file.replace('.', '\\.') + '$') }) });
const installed = page => pane(page).locator('ul[aria-label="Installed packages"] li code').allTextContents();
async function newProject(page, name, text) {
  await page.goto(`chrome-extension://${id}/extension/index.html`); await page.getByRole('link', { name: 'Work offline', exact: true }).click();
  await page.getByRole('textbox', { name: 'New local project name', exact: true }).fill(name); await page.getByRole('button', { name: 'Create local project', exact: true }).click();
  await editorOf(page).waitFor({ timeout: 60000 }); await setDoc(page, text); await until(async () => (await files(page))['main.tex'] === text, 'saved');
}

const doc = String.raw`\documentclass{article}
\usepackage{accents}
\usepackage{algxpar}
\usepackage{rsfso}
\usepackage{nosuchpackagexyz}
\begin{document}
PKGMARK $\accentset{\star}{x}$
\end{document}
`;
const works = doc.replace('\\usepackage{rsfso}\n', '').replace('\\usepackage{nosuchpackagexyz}\n', '');
const plain = '\\documentclass{article}\n\\begin{document}\nPLAINMARK\n\\end{document}\n';

let context;
try {
  context = await chromium.launchPersistentContext(join(work, 'profile'), { channel: 'chromium', headless: true, executablePath: process.env.EXTENSION_CHROME_PATH, ignoreDefaultArgs: ['--disable-extensions'],
    viewport: { width: 1400, height: 900 }, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
  context.setDefaultTimeout(30000); context.on('request', r => requests.push({ url: r.url(), at: Date.now() })); context.on('requestfinished', async r => { if (/^https:/.test(r.url())) { const s = await r.sizes().catch(() => null); if (s) measures.downloadedBytes = (measures.downloadedBytes ?? 0) + s.responseBodySize; } });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message.slice(0, 200))); page.on('dialog', d => d.accept());

  // ---- baseline warm compile without packages (same machine, for the ≤10% budget)
  await newProject(page, 'Plain', plain); await compile(page, 'PLAINMARK', 'plain cold'); const plainWarm = []; for (let i = 0; i < 3; i++) plainWarm.push(await compile(page, 'PLAINMARK', 'plain warm'));
  // ---- PKG-T01: a failed compile offers Install; nothing has contacted a mirror
  await newProject(page, 'Packages', doc); await compile(page, 'fail', 'missing packages fail');
  await page.locator('#olx-package-hint').waitFor(); assert.equal(mirrorRequests().length, 0, 'no mirror contact before a click'); note('PKG-T01: the failed compile shows "Install missing packages"; no download yet');
  await page.locator('#olx-package-hint').click(); await pane(page).locator('#setting-packages-catalog').waitFor();
  assert.match(await requirement(page, 'accents.sty').innerText(), /unknown: Refresh the package list/); note('the button opens Settings › Packages; without the list, requirements stay unknown');

  // bad signature first: the list is refused and nothing is stored
  await context.route('**/texlive.tlpdb.sha512.asc', async route => { const r = await route.fetch(); const t = await r.text(); const lines = t.split('\n'), at = lines.indexOf('') + 3; lines[at] = lines[at].slice(0, 20) + (lines[at][20] === 'A' ? 'B' : 'A') + lines[at].slice(21); await route.fulfill({ response: r, body: lines.join('\n') }); });   // inside the RSA value
  await pane(page).getByRole('button', { name: 'Download list' }).click();
  await until(async () => { const t = await note_(page).innerText(); if (!/signature is not valid for the TeX Live key/.test(t)) throw Error(t || '(empty)'); return true; }, 'bad signature refused', 60000); await context.unroute('**/texlive.tlpdb.sha512.asc');
  assert.ok(await pane(page).getByRole('button', { name: 'Download list' }).isVisible(), 'still no list'); note('PKG-T03: a list with a broken signature is refused and not stored');

  measures.indexedDbBytesBefore = await idbBytes(page); const t0 = Date.now(), bytes0 = measures.downloadedBytes ?? 0; await pane(page).getByRole('button', { name: 'Retry' }).click();
  await until(async () => { await sample(page); if (/signature checked with the TeX Live key/.test(await pane(page).locator('#setting-packages-catalog').innerText())) return true; throw Error(await note_(page).innerText()); }, 'catalog downloaded', 180000);
  measures.catalogMs = Date.now() - t0; measures.catalogBytes = (measures.downloadedBytes ?? 0) - bytes0;
  const row = async file => until(async () => { const t = await requirement(page, file).innerText(); return !/unknown: Refresh/.test(t) && t; }, file + ' resolved');
  assert.match(await row('accents.sty'), /missing — package accents, \d+ KB, licence mit/); assert.match(await row('algxpar.sty'), /missing — package algxpar with \d+ dependenc/);
  assert.match(await row('rsfso.sty'), /not available here.*font map/); assert.match(await row('nosuchpackagexyz.sty'), /unknown: not found in TeX Live/); assert.match(await row('article.cls'), /included with the compiler/);
  note('signed list downloaded; accents and algxpar (with dependencies) missing, rsfso unsupported (font map), an unknown name stays unknown', `${measures.catalogMs} ms, ${measures.catalogBytes} B`);

  // ---- PKG-T03 refusals before a good install
  await context.route('**/archive/accents.tar.xz', async route => { const r = await route.fetch(), b = Buffer.from(await r.body()); b[100] ^= 1; await route.fulfill({ response: r, body: b }); });
  await requirement(page, 'accents.sty').getByRole('button', { name: 'Install' }).click(); await requirement(page, 'accents.sty').getByRole('button', { name: 'Confirm install' }).click();
  await until(async () => /not the version in the package list/.test(await note_(page).innerText()), 'tampered archive refused', 60000); await context.unroute('**/archive/accents.tar.xz');
  assert.deepEqual(await installed(page), []); assert.match(await pane(page).locator('ul[aria-label="Installed packages"]').innerText(), /Nothing installed yet/); note('PKG-T03: altered archive bytes are refused; nothing installed');
  await context.setOffline(true); await requirement(page, 'accents.sty').getByRole('button', { name: 'Install' }).click(); await requirement(page, 'accents.sty').getByRole('button', { name: 'Confirm install' }).click();
  await until(async () => /Could not reach a TeX Live mirror/.test(await note_(page).innerText()), 'offline refused'); await context.setOffline(false); note('PKG-T03: offline install is refused with the reason');
  let release; await context.route('**/archive/accents.tar.xz', async route => { await new Promise(r => { release = r; }); await route.continue().catch(() => {}); });
  await requirement(page, 'accents.sty').getByRole('button', { name: 'Install' }).click(); await requirement(page, 'accents.sty').getByRole('button', { name: 'Confirm install' }).click();
  await until(async () => /Downloading accents/.test(await note_(page).innerText()), 'download started');
  const second = await page.evaluate(() => import('/extension/packages/store.mjs').then(m => m.install(['algxpar'])).then(() => 'installed', e => e.message)); assert.match(second, /Another installation is running/);
  await note_(page).getByRole('button', { name: 'Cancel' }).click(); release?.(); await until(async () => /Canceled; nothing was changed/.test(await note_(page).innerText()), 'cancel');
  await context.unroute('**/archive/accents.tar.xz'); assert.deepEqual(await installed(page), []); assert.match(await pane(page).locator('ul[aria-label="Installed packages"]').innerText(), /Nothing installed yet/); note('PKG-T03: a second install is refused while one runs; Cancel leaves nothing installed');
  { const other = await context.newPage(); await other.goto(page.url()); await editorOf(other).waitFor({ timeout: 60000 });
    await context.route('**/archive/algxpar.tar.xz', () => {});   // never answers: the tab closes mid-install
    other.evaluate(() => import('/extension/packages/store.mjs').then(m => m.install(['algxpar']))).catch(() => {});
    await until(() => requests.some(r => /algxpar\.tar\.xz$/.test(r.url)), 'install in the other tab started'); await other.close(); await context.unroute('**/archive/algxpar.tar.xz');
    assert.deepEqual(await page.evaluate(() => import('/extension/packages/store.mjs').then(m => m.installed()).then(l => l.map(p => p.name))), []); note('PKG-T03: closing a tab mid-install leaves nothing half-installed'); }
  { const bomb = execFileSync('/usr/bin/python3', ['-I', '-c', 'import lzma,sys; sys.stdout.buffer.write(lzma.compress(bytes(300*1024*1024), format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC32))'], { maxBuffer: 1 << 26 });
    const out = await page.evaluate(async b64 => import('/extension/packages/store.mjs').then(m => m.unxz(Uint8Array.from(atob(b64), c => c.charCodeAt(0)), 256 << 20)).then(() => 'expanded', e => e.message), bomb.toString('base64'));
    assert.match(out, /expands beyond the size limit/); note('PKG-T03: a 300 MB xz bomb stops at the 256 MB limit', `${bomb.length} B compressed`); }

  // ---- PKG-T02: install with dependencies, compile, offline reload, compile
  const t1 = Date.now(), b1 = measures.downloadedBytes ?? 0;
  await pane(page).locator('#setting-packages-needed').getByRole('button', { name: 'Install all missing' }).click();
  const plan = await pane(page).locator('#setting-packages-needed').innerText(); assert.match(plan, /Install accents, algxpar, .*download\)\?/);
  await pane(page).locator('#setting-packages-needed').getByRole('button', { name: 'Confirm install' }).click();
  await until(async () => { await sample(page); if ((await installed(page)).includes('algxpar') && !(await note_(page).innerText())) return true; throw Error(await note_(page).innerText()); }, 'installed', 180000);
  measures.installMs = Date.now() - t1; measures.installBytes = (measures.downloadedBytes ?? 0) - b1; const list = await installed(page);
  assert.ok(list.includes('accents') && list.includes('algxpar') && list.length >= 3, list.join(',')); note('PKG-T02: Install all missing installs accents, algxpar and its missing dependencies as one set', `${list.join(', ')}; ${measures.installMs} ms, ${measures.installBytes} B`);
  assert.match(await requirement(page, 'accents.sty').innerText(), /installed \(accents r\d+\)/);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await setDoc(page, works); await until(async () => (await files(page))['main.tex'] === works, 'saved');
  measures.firstPackagedCompileMs = await compile(page, 'PKGMARK', 'compile with installed packages');
  assert.equal(await page.locator('#olx-package-hint').count(), 0, 'hint cleared after success'); note('the project compiles with the installed packages', `${measures.firstPackagedCompileMs} ms`);
  measures.warmPackagedMs = [await compile(page, 'PKGMARK', 'warm packaged'), await compile(page, 'PKGMARK', 'warm packaged')];
  measures.indexedDbBytesAfter = await idbBytes(page); measures.storedBytes = await page.evaluate(() => import('/extension/packages/store.mjs').then(m => m.installed()).then(l => l.reduce((s, p) => s + p.size, 0)));
  { const stamp = () => page.evaluate(() => new Promise(r => { const o = indexedDB.open('olx-packages'); o.onsuccess = () => { const q = o.result.transaction('packages').objectStore('packages').getAll(); q.onsuccess = () => { r(q.result.map(p => p.name + ':' + p.current.installedAt).sort().join()); o.result.close(); }; }; }));
    const before = mirrorRequests().length, was = await stamp();
    const again = await page.evaluate(() => import('/extension/packages/store.mjs').then(m => m.install(['accents', 'algxpar'])));
    assert.deepEqual(again, []); assert.equal(mirrorRequests().length, before, 'repeat install downloads nothing'); assert.equal(await stamp(), was, 'repeat install writes nothing');
    note('PKG-T06: installing the same packages again makes no request and no storage write'); }
  const before = mirrorRequests().length; await context.setOffline(true); await page.reload(); await editorOf(page).waitFor({ timeout: 60000 });
  await compile(page, 'PKGMARK', 'offline compile after reload'); assert.equal(mirrorRequests().length, before, 'nothing fetched offline'); note('PKG-T02: offline, after a reload, the project still compiles');
  { const close = await packagesTab(page); await pane(page).getByRole('button', { name: 'Refresh' }).click();
    await until(async () => /Could not reach a TeX Live mirror \(offline\?\); nothing was changed/.test(await note_(page).innerText()), 'offline refresh refused');
    assert.match(await pane(page).locator('#setting-packages-catalog').innerText(), /signature checked/, 'the saved list stays'); await close();
    assert.ok((await pdfText(page)).includes('PKGMARK'), 'previous PDF still shown'); assert.equal((await files(page))['main.tex'], works, 'source unchanged');
    note('PKG-T03: an offline Refresh is refused with the reason; list, source and PDF stay'); }
  await context.setOffline(false);

  // ---- PKG-T05/T06: another project reuses the stored packages; nothing downloads; warm compile cost
  const reqBefore = mirrorRequests().length; await newProject(page, 'Second', works); await compile(page, 'PKGMARK', 'second project');
  assert.equal(mirrorRequests().length, reqBefore, 'no download for a second project'); note('PKG-T05: a second project uses the same stored packages without downloading');
  await newProject(page, 'Plain again', plain); await compile(page, 'PLAINMARK', 'plain cold with packages'); const packagedWarm = []; for (let i = 0; i < 3; i++) packagedWarm.push(await compile(page, 'PLAINMARK', 'plain warm with packages'));
  const median = l => [...l].sort((a, b) => a - b)[1]; measures.plainWarmMs = plainWarm; measures.plainWarmWithPackagesMs = packagedWarm;
  measures.warmRegression = +(median(packagedWarm) / median(plainWarm) - 1).toFixed(3); note('warm compile of the same plain document with packages installed', `median ${median(plainWarm)} → ${median(packagedWarm)} ms (${(measures.warmRegression * 100).toFixed(1)}%, 3 samples each)`);
  { const close = await packagesTab(page); const count = (await installed(page)).length; await pane(page).locator('li', { has: page.locator('code', { hasText: /^accents$/ }) }).getByRole('button', { name: 'Remove' }).click();
    await until(async () => !(await installed(page)).includes('accents'), 'removed'); assert.equal((await installed(page)).length, count - 1); await close(); note('Remove deletes one package; the others stay'); }
  assert.deepEqual(errors, [], 'no page errors');
  console.log(JSON.stringify({ packagesBrowser: { passed: results.length, measures } }));
} catch (error) { console.log('page errors:', errors); throw error; } finally {
  await context?.close().catch(() => {});
  rmSync(work, { recursive: true, force: true });
}
