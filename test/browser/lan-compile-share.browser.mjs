// SPDX-License-Identifier: AGPL-3.0-only
// LAN-COMPILE-01 (S3-03/S3-04) loopback check: owner without TeX, two contributors Ana and Cem (each with the real TeX helper),
// requester Bea without TeX. Covers what lan-compile.browser.mjs does not: a second contributor joining distribution, four
// concurrent requesters over two workers, a multi-file project with a BibTeX bibliography and exact SyncTeX mapping both ways,
// and repeated shared compiles with per-run timing, bytes and native-helper memory. Loopback only; synthetic project.
//   PLAYWRIGHT_MODULE EXTENSION_CHROME_PATH LATEX_EXTENSION_BASE LATEX_LAN_HELPER LATEX_TEX_HELPER LATEX_TEX_DIR [LAN_RUNS=10]
//   node test/browser/lan-compile-share.browser.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assetName, patchEditorUnicode, pathnameAssets, patchPathnameUnicode } from '../../runtime/browser-recovery/apply.mjs';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const RUNS = Number(process.env.LAN_RUNS || 10);
const repository = resolve(import.meta.dirname, '../..'), base = resolve(process.env.LATEX_EXTENSION_BASE), helper = resolve(process.env.LATEX_LAN_HELPER);
const texHelper = resolve(process.env.LATEX_TEX_HELPER), texDir = resolve(process.env.LATEX_TEX_DIR);
const work = mkdtempSync(join(tmpdir(), 'latex-group-share-')), extension = join(work, 'extension');
// extension assembly: same as lan-compile.browser.mjs
cpSync(base, extension, { recursive: true });
for (const name of readdirSync(join(repository, 'runtime/browser-recovery'))) if (/\.(?:js|mjs|html|css)$/.test(name) && !['apply.mjs', 'provision-offline.mjs', 'recovery-sw.template.js'].includes(name)) cpSync(join(repository, 'runtime/browser-recovery', name), join(extension, 'recovery', name));
for (const name of readdirSync(join(repository, 'runtime/chrome-extension'))) if (/^(lan-.*\.mjs|this-computer\.mjs|cells-ui\.mjs|join\.js|index\.html)$/.test(name)) cpSync(join(repository, 'runtime/chrome-extension', name), join(extension, 'extension', name));
mkdirSync(join(extension, 'extension/research'), { recursive: true }); for (const name of ['outputs.mjs', 'notebook.mjs']) cpSync(join(repository, 'runtime/research', name), join(extension, 'extension/research', name));
for (const name of ['native-workspace.html', 'project-workspace.html']) { const path = join(extension, 'recovery', name); writeFileSync(path, readFileSync(path, 'utf8').replace('<head>', '<head><script src="/extension/bootstrap.js"></script>')); }
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
    env: { ...process.env, LATEX_LOCAL_SETTINGS: join(work, name + '-tex-settings.json') }, viewport: { width: 1400, height: 900 }, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
  await context.addInitScript(() => { globalThis.LATEX_LAN_LOOPBACK = true; });
  context.setDefaultTimeout(20000); return context;
}
const editorOf = page => page.getByRole('textbox', { name: /^Source Editor/ });
const docOf = page => editorOf(page).evaluate(node => node.cmView.view.state.doc.toString());
const setDoc = (page, text) => editorOf(page).evaluate((node, value) => { const view = node.cmView.view; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }); }, text);
const until = async (check, what, ms = 15000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await check(); if (last) return last; } catch (error) { last = error; } await new Promise(r => setTimeout(r, 50)); } throw Error('Timed out: ' + what + (last instanceof Error ? ' (' + last.message + ')' : '')); };
const status = page => page.locator('#local-status').textContent();
const pdfText = page => page.locator('.textLayer').allTextContents().then(list => list.join(' '));
const statsOf = page => page.evaluate(() => globalThis.overleafGroupStats ?? null);
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
/** Native TeX helper processes (one per contributor profile) and the TeX processes they start, sampled from ps. */
const run = promisify(execFile), memory = { helpers: new Map(), texPeak: 0, texTotalPeak: 0 };
async function sample() {
  const rows = (await run('/bin/ps', ['-axo', 'pid=,ppid=,rss=,command='], { maxBuffer: 16 << 20 })).stdout.split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, ppid, rss, command]) => ({ pid: +pid, ppid: +ppid, rss: +rss * 1024, command }));
  const byPid = new Map(rows.map(r => [r.pid, r])), owner = r => { for (let p = byPid.get(r.ppid), i = 0; p && i < 4; p = byPid.get(p.ppid), i++) { const m = p.command.match(/--user-data-dir=\S*\/(ana|cem)\b/); if (m) return m[1]; } return 'pid ' + r.pid; };
  for (const r of rows.filter(r => r.command.startsWith(texHelper))) { const h = memory.helpers.get(r.pid) ?? memory.helpers.set(r.pid, { who: owner(r), now: 0, peak: 0 }).get(r.pid); h.now = r.rss; h.peak = Math.max(h.peak, r.rss); }
  const under = (r, ancestor) => { for (let p = byPid.get(r.ppid), i = 0; p && i < 8; p = byPid.get(p.ppid), i++) if (p.pid === ancestor) return true; return false; };
  const tex = rows.filter(r => [...memory.helpers.keys()].some(pid => under(r, pid))); // sandbox-exec, latexmk, pdflatex, bibtex
  memory.texPeak = Math.max(memory.texPeak, ...tex.map(r => r.rss), 0); memory.texTotalPeak = Math.max(memory.texTotalPeak, tex.reduce((n, r) => n + r.rss, 0));
}
let sampling = null;
const scratch = () => new Set(readdirSync(tmpdir()).filter(name => /^latex-local-[0-9a-f]+$/.test(name)));
const MB = bytes => Math.round(bytes / 104857.6) / 10;

const contexts = [], errors = [];
try {
  assert(existsSync(join(texDir, 'bibtex')), 'LATEX_TEX_DIR must be a TeX bin folder with bibtex');
  const scratchBefore = scratch();
  const [ownerContext, anaContext, cemContext, beaContext] = [await profile('owner'), await profile('ana', { tex: true }), await profile('cem', { tex: true }), await profile('bea')]; contexts.push(ownerContext, anaContext, cemContext, beaContext);
  const owner = await ownerContext.newPage(); owner.on('pageerror', e => errors.push('owner: ' + e.message.slice(0, 200)));
  await owner.goto(root + '/extension/index.html');
  await owner.getByRole('link', { name: 'Work offline', exact: true }).click();
  await owner.getByRole('textbox', { name: 'New local project name', exact: true }).fill('Synthetic group bibliography');
  await owner.getByRole('button', { name: 'Create local project', exact: true }).click();
  await editorOf(owner).waitFor({ timeout: 60000 });
  // multi-file source with math and a BibTeX bibliography; the owner uploads the second file and the .bib
  const upload = (path, text) => owner.evaluate(async ([path, text]) => { const pid = document.querySelector('meta[name="ol-project_id"]').content, form = new FormData();
    form.append('qqfile', new File([text], path)); form.append('relativePath', path); form.append('name', path);
    return (await fetch(`/project/${pid}/upload`, { method: 'POST', body: form })).status; }, [path, text]);
  assert.equal(await upload('sec.tex', 'Section SECMARK from a second file.\n'), 200);
  assert.equal(await upload('refs.bib', '@book{knuth84, author = {Donald Knuth}, title = {The TeXbook}, publisher = {Addison-Wesley}, year = {1984}}\n'), 200);
  const source = '\\documentclass{article}\n\\begin{document}\nShared BASEMARK text.\n\\input{sec}\n\nCitation CITEMARK \\cite{knuth84}.\n$\\int_0^1 x\\,dx=\\frac{1}{2}$\n\\bibliographystyle{plain}\n\\bibliography{refs}\n\\end{document}\n';
  const version = mark => source.replace('BASEMARK', mark);
  await setDoc(owner, source);
  await owner.getByRole('button', { name: 'Share on this network' }).click();
  const panel = owner.getByRole('dialog', { name: 'Share on this network' });
  await until(async () => (await panel.locator('code').nth(0).textContent()).trim(), 'share link');
  const link = (await panel.locator('code').nth(0).textContent()).trim(), passcode = (await panel.locator('code').nth(1).textContent()).trim();
  const joinAs = async (context, name) => { const page = await context.newPage(); page.on('pageerror', e => errors.push(name + ': ' + e.message.slice(0, 200))); await page.goto(link);
    await page.getByLabel('Passcode').fill(passcode); await page.getByLabel('Your name for this session').fill(name); await page.getByRole('button', { name: 'Join' }).click();
    await editorOf(page).waitFor({ timeout: 60000 }); await until(async () => (await docOf(page)) === source, name + ' has the source'); return page; };
  const ana = await joinAs(anaContext, 'Ana'), cem = await joinAs(cemContext, 'Cem'), bea = await joinAs(beaContext, 'Bea');
  if (!(await panel.isVisible())) await owner.locator('#local-share').click();
  await panel.getByLabel('Permission for Ana').selectOption('copy'); await panel.getByLabel('Permission for Cem').selectOption('copy');
  /** Explicit TeX choice, then (optionally) opt in; every page here also sends its own compiles to the group. */
  async function setUp(page, { help = false, choose = false } = {}) {
    // autocompile off: each measured job is one Recompile click (with it on, every edit queues a job per requester)
    await page.evaluate(() => localStorage.setItem('autocompile_enabled:' + document.querySelector('meta[name="ol-project_id"]').content, 'false'));
    const close = await thisComputer(page);
    if (choose) { await until(async () => (await page.locator('#olx-tex-choice option').allTextContents()).includes(texDir), 'detected installations'); await page.locator('#olx-tex-choice').selectOption(texDir); await until(async () => /^Ready: pdflatex/.test(await describe(page, 'olx-tex-choice')), 'TeX ready'); }
    if (help) { await page.locator('#olx-help-compile').check(); await until(async () => /Waiting for compile jobs/.test(await describe(page, 'olx-help-status')), 'helping'); }
    await until(async () => !(await page.locator('#olx-group-compile').isDisabled()), 'group compile available');
    if (!(await page.locator('#olx-group-compile').isChecked())) await page.locator('#olx-group-compile').check();
    await close();
  }
  const counts = []; // contribution status text, kept for the failure message
  const done = async page => { const close = await thisComputer(page); const text = await describe(page, 'olx-help-status'); await close(); counts.push(text); return Number(text.match(/\((\d+) compiled\)/)?.[1] ?? 0); };
  await setUp(ana, { choose: true, help: true }); await setUp(bea); await setUp(owner);
  note('owner (no TeX), contributor Ana, requesters Bea and the owner join; Cem has not opted in yet');
  sampling = setInterval(() => sample().catch(() => {}), 100);

  // S3-04: bibliography + multi-file + math on a contributor's TeX, exact source mapping both ways
  await setDoc(bea, version('BIBMARK')); await until(async () => (await docOf(owner)).includes('BIBMARK'), 'Bea edit reaches the owner');
  const bibMs = await recompile(bea, 'BIBMARK', 'Bea bibliography compile'), bibStats = await statsOf(bea), text = await pdfText(bea);
  assert.equal(bibStats.by, 'Ana');
  assert.match(text, /SECMARK/); assert.match(text, /CITEMARK\s*\[1\]/, 'citation resolved by BibTeX: ' + text.slice(0, 300)); assert.match(text, /Donald Knuth/); assert.match(text, /The TeXbook/); assert.doesNotMatch(text, /\[\?\]/);
  const forward = await bea.evaluate(async () => { const pid = document.querySelector('meta[name="ol-project_id"]').content, out = {};
    for (const [file, line] of [['main.tex', 3], ['sec.tex', 1], ['main.tex', 6]]) { const r = await fetch(`/project/${pid}/sync/code?file=${file}&line=${line}&column=0`); out[`${file}:${line}`] = [r.status, (await r.json()).pdf?.[0]]; }
    return out; });
  for (const [where, [code, box]] of Object.entries(forward)) { assert.equal(code, 200, where); assert.equal(box?.page, 1, where + ' ' + JSON.stringify(box)); }
  const [a, s, c] = ['main.tex:3', 'sec.tex:1', 'main.tex:6'].map(k => forward[k][1]); // sec.tex continues line 3's paragraph
  assert(a.v === s.v && a.h + a.width <= s.h + 1 && s.v < c.v, 'source order is page order: ' + JSON.stringify(forward));
  // PDF -> source through the workspace's in-page sync route (the viewer's double-click target; no network event to wait on)
  const inverse = async (box, file, line) => { const body = await bea.evaluate(async ({ page, h, v }) => { const pid = document.querySelector('meta[name="ol-project_id"]').content;
    return (await fetch(`/project/${pid}/sync/pdf?page=${page}&h=${h + 2}&v=${v}`)).json(); }, box);
    assert(body.code?.some(p => p.file === file && p.line === line), `${JSON.stringify(box)} -> ${file}:${line}: ${JSON.stringify(body)}`); };
  await inverse(s, 'sec.tex', 1); await inverse(c, 'main.tex', 6);
  note('BibTeX bibliography + \\input + math compiled on Ana\'s TeX for Bea; SyncTeX maps main.tex and sec.tex both ways', `${bibMs} ms; wait ${bibStats.waitMs} ms; worker ${bibStats.runMs} ms; ${bibStats.inBytes} B in, ${bibStats.outBytes} B out`);

  // S3-03: Cem opts in later and takes the next job (least recently used worker first)
  await setUp(cem, { choose: true, help: true });
  await until(async () => { const close = await thisComputer(bea); const t = await describe(bea, 'olx-group-compile'); await close(); return /2 computers helping/.test(t); }, 'Bea sees two contributors');
  await setDoc(bea, version('JOINMARK')); await until(async () => (await docOf(owner)).includes('JOINMARK'), 'edit reaches the owner');
  const joinMs = await recompile(bea, 'JOINMARK', 'compile after Cem joins'); assert.equal((await statsOf(bea)).by, 'Cem', 'the newly joined contributor takes the next job');
  note('a second contributor (Cem) joins distribution and takes the next job', `${joinMs} ms`);

  // S3-03: four concurrent requesters over two workers
  const pages = { owner, ana, cem, bea };
  await setDoc(owner, version('CONCMARK'));
  for (const [name, page] of Object.entries(pages)) await until(async () => (await docOf(page)).includes('CONCMARK'), name + ' has the concurrent edit');
  const doneBefore = (await done(ana)) + (await done(cem));
  const concStart = performance.now();
  const concMs = await Promise.all(Object.entries(pages).map(([name, page]) => recompile(page, 'CONCMARK', name + ' concurrent compile')));
  const concWall = Math.round(performance.now() - concStart);
  const conc = Object.fromEntries(await Promise.all(Object.entries(pages).map(async ([name, page]) => [name, await statsOf(page)])));
  const by = Object.values(conc).map(s => s.by), spread = { Ana: by.filter(b => b === 'Ana').length, Cem: by.filter(b => b === 'Cem').length };
  assert.equal(spread.Ana + spread.Cem, 4, JSON.stringify(conc)); assert(spread.Ana >= 1 && spread.Cem >= 1, 'both workers used: ' + JSON.stringify(spread));
  const doneAfter = (await done(ana)) + (await done(cem));
  assert.equal(doneAfter - doneBefore, 4, 'each job accepted from exactly one worker: ' + JSON.stringify({ counts, conc }));
  const waits = Object.values(conc).map(s => s.waitMs).sort((a, b) => a - b);
  note('four concurrent requesters spread over both contributors; one accepted result per job', `spread ${JSON.stringify(spread)}; queue wait ms ${waits.join('/')}; request→PDF ms ${concMs.join('/')}; wall ${concWall} ms`);

  // repeated use: N shared compiles of the same fixture by Bea; timing, bytes and helper memory per run
  const rows = [];
  for (let i = 1; i <= RUNS; i++) {
    const mark = `REP${i}MARK`;
    await setDoc(bea, version(mark)); await until(async () => (await docOf(owner)).includes(mark), mark + ' reaches the owner');
    const ms = await recompile(bea, mark, 'repeat ' + i), s = await statsOf(bea); await sample();
    rows.push({ run: i, by: s.by, ms, waitMs: s.waitMs, runMs: s.runMs, inBytes: s.inBytes, outBytes: s.outBytes, rssMB: Object.fromEntries([...memory.helpers.values()].map(h => [h.who, MB(h.now)])) });
  }
  clearInterval(sampling); sampling = null;
  for (const r of rows) console.log('RUN', JSON.stringify(r));
  const helpers = [...memory.helpers.values()];
  assert.equal(helpers.length, 2, 'one long-lived TeX helper per contributor, never respawned: ' + JSON.stringify(helpers));
  for (const h of helpers) { const series = rows.map(r => r.rssMB[h.who]); assert(series.at(-1) <= series[1] + 8, `${h.who} helper RSS grows: ${series.join(',')}`); }
  const head = rows.slice(0, 3).reduce((n, r) => n + r.ms, 0) / 3, tail = rows.slice(-3).reduce((n, r) => n + r.ms, 0) / 3;
  assert(tail <= head * 2 + 500, `repeated compiles slow down: first ${head} ms, last ${tail} ms`);
  assert.equal(new Set(rows.map(r => r.inBytes)).size <= 2, true, 'same fixture, same input size');
  const leaked = [...scratch()].filter(name => !scratchBefore.has(name));
  assert.deepEqual(leaked, [], 'every job directory removed after its compile');
  note(`${RUNS} repeated shared compiles: no helper growth, no slowdown, scratch removed after every job`, `ms ${rows.map(r => r.ms).join('/')}`);
  assert.deepEqual(errors, [], 'page errors');
  console.log(`PASS ${results.length} checks (loopback only; no second device)`);
  console.log('MEASURE', JSON.stringify({ bibMs, bib: bibStats, joinMs, concWall, concMs, conc, spread,
    helpers: helpers.map(h => ({ who: h.who, peakMB: MB(h.peak), lastMB: MB(h.now) })), texPeakMB: MB(memory.texPeak), texTotalPeakMB: MB(memory.texTotalPeak),
    repeat: { min: Math.min(...rows.map(r => r.ms)), max: Math.max(...rows.map(r => r.ms)), mean: Math.round(rows.reduce((n, r) => n + r.ms, 0) / rows.length), inBytes: rows[0].inBytes, outBytes: rows.map(r => r.outBytes) } }));
} finally { if (sampling) clearInterval(sampling); for (const context of contexts) await context.close().catch(() => {}); if (process.env.LAN_KEEP_EXTENSION) console.log('kept', extension); else rmSync(work, { recursive: true, force: true }); }
