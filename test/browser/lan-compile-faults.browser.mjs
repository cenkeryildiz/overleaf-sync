// SPDX-License-Identifier: AGPL-3.0-only
// LAN-COMPILE-01 S3-05/S3-02 loopback fault check: an owner without TeX, two contributors (Ana, Cy) with the TeX installation
// they chose, requester Bea without a copy grant. Real native editor, relay helper and TeX helper over native messaging, as in
// lan-compile.browser.mjs (same environment variables). Covers: forged/stale/foreign results and work from a participant without
// the copy grant are refused; invalid or oversized PDFs are refused and retried; requester cancel and a new revision mid-job;
// opt-out, frozen page (lease expiry), killed TeX helper and closed tab mid-job retry on the other contributor without
// duplicate publication; a revoked grant with nobody else helping fails visibly and the browser compiles again.
// Test-only changes live in the fixture copy, never in the runtime: shorter lease/heartbeat (6 s / 1.5 s instead of 30 s / 8 s)
// and a hook exposing the participant's sealed send plus the owner's 'work' messages; a native-port wrapper corrupts one PDF.
// Loopback only; synthetic project; not a two-device result.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repository = resolve(import.meta.dirname, '../..'), base = resolve(process.env.LATEX_EXTENSION_BASE), helper = resolve(process.env.LATEX_LAN_HELPER);
const texHelper = resolve(process.env.LATEX_TEX_HELPER), texDir = resolve(process.env.LATEX_TEX_DIR);
const work = mkdtempSync(join(tmpdir(), 'latex-group-faults-')), extension = join(work, 'extension');
cpSync(base, extension, { recursive: true });
for (const name of readdirSync(join(repository, 'runtime/browser-recovery'))) if (/\.(?:js|mjs|html|css)$/.test(name) && !['apply.mjs', 'provision-offline.mjs', 'recovery-sw.template.js'].includes(name)) cpSync(join(repository, 'runtime/browser-recovery', name), join(extension, 'recovery', name));
for (const name of readdirSync(join(repository, 'runtime/chrome-extension'))) if (/^((?:lan-|p2p-).*\.mjs|this-computer\.mjs|cells-ui\.mjs|join\.js|index\.html)$/.test(name)) cpSync(join(repository, 'runtime/chrome-extension', name), join(extension, 'extension', name));
mkdirSync(join(extension, 'extension/research'), { recursive: true }); for (const name of ['outputs.mjs', 'notebook.mjs']) cpSync(join(repository, 'runtime/research', name), join(extension, 'extension/research', name));
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
/** Test-only edits of the fixture copy; each must apply exactly once. */
const patch = (name, pairs) => { const path = join(extension, 'extension', name); let text = readFileSync(path, 'utf8');
  for (const [from, to] of pairs) { assert.equal(text.split(from).length - 1, 1, `${name}: patch target changed: ${from.slice(0, 60)}`); text = text.replace(from, to); } writeFileSync(path, text); };
const LEASE_MS = 6000;
patch('lan-compile.mjs', [['LEASE = 30000, BEAT = 8000', `LEASE = ${LEASE_MS}, BEAT = 1500`]]);
patch('lan-compile-ui.mjs', [
  ["participant = participantGroup({ send: m => lan().session.send(m), tex, onChange: () => refresh() });", "participant = participantGroup({ send: m => lan().session.send(m), tex, onChange: () => refresh() }); globalThis.overleafGroupTest = { send: m => lan().session.send(m), seen: [] };"],
  ['events.onGroup = m => { participant.handle(m)', "events.onGroup = m => { if ((m.t === 'work' && m.k !== 'in') || m.t === 'denied') globalThis.overleafGroupTest.seen.push(m); participant.handle(m)"]]);
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
const root = `chrome-extension://${id}`, results = [], measure = {}, note = (name, detail = '') => { results.push(name); console.log('ok -', name, detail); };

async function profile(name, { tex = false } = {}) {
  const dir = join(work, name), hosts = join(dir, 'NativeMessagingHosts'); mkdirSync(hosts, { recursive: true });
  writeFileSync(join(hosts, 'com.cenker.latex_lan.json'), JSON.stringify({ name: 'com.cenker.latex_lan', description: 'LAN sharing helper (test)', path: helper, type: 'stdio', allowed_origins: [root + '/'] }));
  if (tex) writeFileSync(join(hosts, 'com.cenker.latex_local.json'), JSON.stringify({ name: 'com.cenker.latex_local', description: 'TeX helper (test)', path: texHelper, type: 'stdio', allowed_origins: [root + '/'] }));
  const context = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true, executablePath: process.env.EXTENSION_CHROME_PATH, ignoreDefaultArgs: ['--disable-extensions'],
    env: { ...process.env, LATEX_LOCAL_SETTINGS: join(work, name + '-tex-settings.json') }, viewport: { width: 1400, height: 900 }, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
  await context.addInitScript(() => {
    globalThis.LATEX_LAN_LOOPBACK = true;
    // globalThis.overleafTamper = base64 text: the next compile's PDF parts from the TeX helper are replaced by it (one compile)
    const runtime = globalThis.chrome?.runtime; if (!runtime?.connectNative) return;
    const connect = runtime.connectNative.bind(runtime);
    runtime.connectNative = name => { const port = connect(name); if (name !== 'com.cenker.latex_local') return port;
      return { postMessage: m => port.postMessage(m), disconnect: () => port.disconnect(), onDisconnect: port.onDisconnect,
        onMessage: { addListener: f => port.onMessage.addListener(m => { const t = globalThis.overleafTamper;
          if (t && m?.part === 'pdf') m = { ...m, data: t }; if (t && m?.done) globalThis.overleafTamper = null; f(m); }) } }; };
  });
  context.setDefaultTimeout(20000); return context;
}
const editorOf = page => page.getByRole('textbox', { name: /^Source Editor/ });
const docOf = page => editorOf(page).evaluate(node => node.cmView.view.state.doc.toString());
const setDoc = (page, text) => editorOf(page).evaluate((node, value) => { const view = node.cmView.view; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }); }, text);
const until = async (check, what, ms = 15000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await check(); if (last) return last; } catch (error) { last = error; } await new Promise(r => setTimeout(r, 50)); } throw Error('Timed out: ' + what + (last instanceof Error ? ' (' + last.message + ')' : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pdfText = page => page.locator('.textLayer').allTextContents().then(list => list.join(' '));
async function thisComputer(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'This computer' }).click();
  await page.locator('#ide-settings-tabs-tabpane-this-computer').waitFor();
  return () => page.getByRole('button', { name: 'Close dialog' }).click();
}
const describe = (page, row) => page.locator(`#setting-${row} .ide-setting-description`).textContent();
const source = marker => `\\documentclass{article}\n\\begin{document}\nShared ${marker} text.\n\\end{document}\n`;
// about 3 s of pdfTeX per run on this Mac: long enough to act while a contributor compiles
const slow = marker => `\\documentclass{article}\n\\newcount\\n\n\\begin{document}\n\\n=0 \\loop\\advance\\n 1 \\ifnum\\n<25000000 \\repeat\nShared ${marker} text.\n\\end{document}\n`;
/** Every TeX-helper process of one profile and their descendants (latexmk, pdflatex). */
function texProcesses(name) {
  const rows = execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(([, pid, ppid, command]) => ({ pid: +pid, ppid: +ppid, command }));
  const browser = rows.filter(r => r.command.includes(`--user-data-dir=${join(work, name)} `) || r.command.endsWith(`--user-data-dir=${join(work, name)}`)).map(r => r.pid); // the native host's parent is the profile's browser
  const helpers = rows.filter(r => r.command.startsWith(texHelper + ' ') && browser.includes(r.ppid)).map(r => r.pid);
  const children = []; for (let frontier = helpers; frontier.length;) { frontier = rows.filter(r => frontier.includes(r.ppid)).map(r => r.pid); children.push(...frontier); }
  return { helpers, children };
}
const alive = pids => pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
const orphans = [];
const contexts = [], errors = [];
try {
  assert(existsSync(join(texDir, 'pdflatex')), 'LATEX_TEX_DIR must be a TeX bin folder');
  const ctx = { owner: await profile('owner'), Ana: await profile('Ana', { tex: true }), Cy: await profile('Cy', { tex: true }), Bea: await profile('Bea') }; contexts.push(...Object.values(ctx));
  const owner = await ctx.owner.newPage(); owner.on('pageerror', e => errors.push('owner: ' + e.message.slice(0, 200)));
  await owner.goto(root + '/extension/index.html');
  await owner.getByRole('link', { name: 'Work offline', exact: true }).click();
  await owner.getByRole('textbox', { name: 'New local project name', exact: true }).fill('Synthetic group faults');
  await owner.getByRole('button', { name: 'Create local project', exact: true }).click();
  await editorOf(owner).waitFor({ timeout: 60000 });
  await setDoc(owner, source('BASEMARK'));
  await owner.getByRole('button', { name: 'Share on this network' }).click(); await owner.getByRole('dialog', { name: 'Share', exact: true }).getByRole('button', { name: /^On this network/ }).click();
  const panel = owner.getByRole('dialog', { name: 'Share on this network' });
  await until(async () => (await panel.locator('code').nth(0).textContent()).trim(), 'share link');
  const link = (await panel.locator('code').nth(0).textContent()).trim(), passcode = (await panel.locator('code').nth(1).textContent()).trim();
  const pages = {};
  const joinAs = async name => { const page = await ctx[name].newPage(); page.on('pageerror', e => errors.push(name + ': ' + e.message.slice(0, 200))); await page.goto(link);
    await page.getByLabel('Passcode').fill(passcode); await page.getByLabel('Your name for this session').fill(name); await page.getByRole('button', { name: 'Join' }).click();
    await editorOf(page).waitFor({ timeout: 60000 }); const text = await docOf(owner); await until(async () => (await docOf(page)) === text, name + ' has the source'); return (pages[name] = page); };
  const grant = async (name, value) => { if (!(await panel.isVisible())) await owner.locator('#local-share').click(); await panel.getByLabel('Permission for ' + name).selectOption(value); };
  const helpStatus = async name => { const close = await thisComputer(pages[name]); const text = await describe(pages[name], 'olx-help-status'); await close(); return text; };
  async function optIn(name) {
    const page = pages[name], close = await thisComputer(page);
    await until(async () => (await page.locator('#olx-tex-choice option').allTextContents()).includes(texDir), name + ': installations listed');
    if (!/^Ready: pdflatex/.test(await describe(page, 'olx-tex-choice'))) await page.locator('#olx-tex-choice').selectOption(texDir);
    await until(async () => /^Ready: pdflatex/.test(await describe(page, 'olx-tex-choice')), name + ': TeX ready');
    await page.locator('#olx-help-compile').check();
    await until(async () => /Waiting for compile jobs/.test(await describe(page, 'olx-help-status')), name + ' helping').catch(async error => { console.log(name, 'help:', await describe(page, 'olx-help-status'), '|', await describe(page, 'olx-tex-choice'), '| checked', await page.locator('#olx-help-compile').isChecked(), JSON.stringify((await page.evaluate(() => globalThis.overleafGroupTest.seen)).slice(-12).map(m => [m.t, m.k, m.job?.slice?.(0, 6), m.lease, m.reason]))); throw error; }); await close();
  }
  for (const name of ['Ana', 'Cy', 'Bea']) await joinAs(name);
  await grant('Ana', 'copy'); await grant('Cy', 'copy'); await optIn('Ana'); await optIn('Cy');
  const bea = pages.Bea;
  { const close = await thisComputer(bea); await until(async () => /available, 2 computers helping/.test(await describe(bea, 'olx-group-compile')), 'Bea sees two contributors'); await bea.locator('#olx-group-compile').check(); await close(); }
  await bea.evaluate(() => localStorage.setItem(`autocompile_enabled:${document.querySelector('meta[name="ol-project_id"]').content}`, 'false')); // only explicit recompiles
  await bea.evaluate(() => { const node = document.querySelector('#local-status'); globalThis.statusLog = []; new MutationObserver(() => globalThis.statusLog.push(node.textContent)).observe(node, { childList: true, characterData: true, subtree: true }); });
  const log = () => bea.evaluate(() => globalThis.statusLog.join('\n'));
  const clearLog = () => bea.evaluate(() => { globalThis.statusLog.length = 0; });
  const stats = () => bea.evaluate(() => globalThis.overleafGroupStats ?? null);
  const seen = name => pages[name].evaluate(() => globalThis.overleafGroupTest.seen);
  /** Bea edits, the owner has the edit, Bea recompiles; resolves the name of the contributor whose computer runs it. */
  async function start(text) {
    await setDoc(bea, text); await until(async () => (await docOf(owner)) === text, 'Bea edit reaches the owner');
    await clearLog(); await bea.getByRole('button', { name: 'Recompile', exact: true }).click();
    return (await until(async () => (await log()).match(/Compiling on (\w+)’s computer/), 'job started', 30000))[1];
  }
  const shown = (marker, what, ms = 90000) => until(async () => (await pdfText(bea)).includes(marker), what, ms).catch(async error => { console.log(what, 'log:', await log()); throw error; });
  const other = name => (name === 'Ana' ? 'Cy' : 'Ana');
  const running = async name => until(() => texProcesses(name).children.length > 0, name + ' TeX running', 20000);
  const stopped = async name => until(() => texProcesses(name).children.length === 0, name + ' TeX processes ended', 10000);
  console.log('setup ready; owner has no TeX, Ana and Cy help, Bea has the view grant only');

  // 0. a previous PDF to keep
  let by = await start(source('FIRSTMARK')); await shown('FIRSTMARK', 'first shared PDF'); let last = await stats(); assert.equal(last.by, by, await log());
  note('baseline: Bea\'s PDF compiled by a contributor', by);

  // 1. forged results (unknown job, wrong lease, digest, engine) and work messages without the copy grant are refused
  by = await start(slow('FORGEMARK')); const holder = by;
  const job = await until(async () => (await seen(holder)).filter(m => m.k === 'job').at(-1), 'job message');
  const forged = [{ job: 'ab'.repeat(12) }, { lease: job.lease + 1000 }, { digest: 'f'.repeat(64) }, { compiler: 'xelatex' }].map(change => ({ t: 'work', k: 'done', job: job.job, lease: job.lease, digest: job.digest, compiler: job.compiler, xfer: '0'.repeat(32), ...change }));
  await pages[holder].evaluate(list => Promise.all(list.map(m => globalThis.overleafGroupTest.send(m))), forged);
  await until(async () => (await seen(holder)).filter(m => m.k === 'refused' && /Stale, foreign or repeated/.test(m.reason)).length === 4, 'four forged results refused');
  await bea.evaluate(m => Promise.all([globalThis.overleafGroupTest.send(m), globalThis.overleafGroupTest.send({ t: 'work', k: 'ready', engines: ['pdflatex'] })]), { ...forged[0], job: job.job });
  await until(async () => (await seen('Bea')).filter(m => m.t === 'denied' && m.request === 'work').length === 2, 'Bea\'s work messages denied');
  await shown('FORGEMARK', 'genuine result after forgeries'); last = await stats(); assert.equal(last.by, holder, 'the genuine result is the one published');
  { const close = await thisComputer(bea); assert.match(await describe(bea, 'olx-group-compile'), /2 computers helping/, 'Bea did not become a worker'); await close(); }
  note('forged results (unknown job, wrong lease, digest, engine) refused; Bea without the copy grant cannot submit results or become a worker; the genuine PDF is published once', holder);

  // 2. invalid and oversized PDFs from a contributor are refused and the job retries on the other one
  for (const [kind, marker] of [['garbage', 'GARBAGEMARK'], ['oversized', 'HUGEMARK']]) {
    const next = other(last.by);
    await pages[next].evaluate(kind => { globalThis.overleafTamper = kind === 'garbage' ? btoa('this is not a PDF') : btoa('%PDF-1.5\n' + 'A'.repeat(17 * 1024 * 1024)); }, kind);
    by = await start(source(marker)); assert.equal(by, next);
    await shown(marker, kind + ' output retried'); last = await stats();
    assert.equal(last.by, other(next)); assert.match(await log(), /Retrying on another computer \(its output was invalid\)/);
    assert((await seen(next)).some(m => m.k === 'refused' && m.reason === 'Invalid compiler output'));
    assert(!(await pdfText(bea)).includes('not a PDF'));
    note(`${kind} PDF refused by the owner and retried on the other contributor`, `${next} -> ${last.by}`);
  }

  // 3a. requester cancel: the worker stops, nothing is published, the previous PDF stays
  let before = await pdfText(bea);
  by = await start(slow('CANCELMARK')); await running(by);
  const pid = await bea.evaluate(() => document.querySelector('meta[name="ol-project_id"]').content);
  await bea.evaluate(pid => fetch(`/project/${pid}/compile/stop`, { method: 'POST' }), pid);
  await until(async () => /canceled.*Previous PDF retained/i.test(await log()), 'Bea sees the cancel');
  await stopped(by);
  await sleep(8000); // longer than the slow compile would have taken
  assert.equal(await pdfText(bea), before); assert.deepEqual(await stats(), last, 'no result published after cancel');
  assert((await seen(by)).some(m => m.k === 'stop'));
  note('requester cancel mid-job: worker told to stop and its TeX ends; nothing published; previous PDF kept', by);

  // 3b. a new revision while the old one compiles: only the current revision's PDF is shown
  by = await start(slow('REVONEMARK')); await running(by);
  await setDoc(bea, source('REVTWOMARK')); await until(async () => (await docOf(owner)).includes('REVTWOMARK'), 'new revision reaches the owner');
  await shown('REVTWOMARK', 'current revision PDF'); assert(!(await pdfText(bea)).includes('REVONEMARK'));
  assert.match(await log(), /Source changed; compiling the latest version/); last = await stats();
  note('edit during a shared compile: the old revision\'s PDF is discarded, the current one shown', `${by} then ${last.by}`);

  // 4. opt-out mid-job: the job moves to the other contributor; the opted-out computer claims nothing more
  by = await start(slow('OPTOUTMARK')); await running(by);
  let t0 = Date.now();
  { const close = await thisComputer(pages[by]); await pages[by].locator('#olx-help-compile').uncheck(); await close(); }
  await stopped(by);
  await shown('OPTOUTMARK', 'PDF after opt-out'); measure.optOutToPdfMs = Date.now() - t0; last = await stats();
  assert.equal(last.by, other(by)); assert.match(await log(), /Retrying on another computer \(the helping computer stopped helping\)/);
  const optedOut = by, claims = (await seen(optedOut)).filter(m => m.k === 'job').length;
  by = await start(source('AFTEROPTOUTMARK')); await shown('AFTEROPTOUTMARK', 'next job after opt-out'); last = await stats();
  assert.equal(by, other(optedOut)); assert.equal(last.by, other(optedOut), 'no new claim by the opted-out computer');
  assert.equal((await seen(optedOut)).filter(m => m.k === 'job').length, claims, 'no job offered to the opted-out computer');
  assert.match(await helpStatus(optedOut), /^Off/);
  await optIn(optedOut);
  note('opt-out mid-job: its TeX stops, the job retries on the other contributor, no new claims while off', `${measure.optOutToPdfMs} ms opt-out -> PDF`);

  // 5. frozen page (no heartbeats): the lease expires, the job retries; the frozen worker's late result is never published
  by = await start(slow('FREEZEMARK')); await running(by);
  const frozen = by, cdp = await ctx[frozen].newCDPSession(pages[frozen]); await cdp.send('Debugger.enable'); await cdp.send('Debugger.pause');
  t0 = Date.now();
  await shown('FREEZEMARK', 'PDF after lease expiry'); measure.freezeToPdfMs = Date.now() - t0; last = await stats();
  assert.equal(last.by, other(frozen)); assert.match(await log(), /Retrying on another computer \(the helping computer stopped answering\)/);
  await cdp.send('Debugger.resume'); await cdp.detach();
  await sleep(4000); await stopped(frozen);
  assert.deepEqual(await stats(), last, 'the late result was not published');
  const late = await seen(frozen), lateRefused = late.some(m => m.k === 'refused' && /Stale/.test(m.reason));
  { const close = await thisComputer(pages[frozen]); const on = await pages[frozen].locator('#olx-help-compile').isChecked(); await close(); if (!on) await optIn(frozen); } // still opted in unless its connection dropped
  note('frozen worker: lease expiry retries on the other contributor; its late result is refused/stopped, not published', `${measure.freezeToPdfMs} ms freeze -> PDF (lease ${LEASE_MS} ms); late result ${lateRefused ? 'sent and refused' : 'stopped before sending'}`);

  // 6. the TeX helper process is killed mid-job: treated as a lost worker, retried; the helper restarts on the next job
  by = await start(slow('KILLMARK')); await running(by);
  const victim = by, procs = texProcesses(victim);
  t0 = Date.now(); for (const helperPid of procs.helpers) process.kill(helperPid, 'SIGKILL');
  await shown('KILLMARK', 'PDF after helper kill'); measure.killToPdfMs = Date.now() - t0; last = await stats();
  assert.equal(last.by, other(victim)); assert.match(await log(), /Retrying on another computer \(its TeX helper stopped\)/);
  const leftover = alive(procs.children); orphans.push(...leftover);
  by = await start(source('RESTARTMARK')); await shown('RESTARTMARK', 'helper restarted'); last = await stats();
  assert.equal(last.by, victim, 'the killed helper is started again for the next job');
  note('TeX helper killed mid-job: job retried on the other contributor; the next job restarts the helper', `${measure.killToPdfMs} ms kill -> PDF; ${leftover.length} orphaned TeX processes left running after SIGKILL`);

  // 7. the contributor's tab closes mid-job: retried on the other contributor; its TeX ends with the tab
  by = await start(slow('CLOSEMARK')); await running(by);
  const closed = by; t0 = Date.now(); await pages[closed].close();
  await shown('CLOSEMARK', 'PDF after tab close'); measure.closeToPdfMs = Date.now() - t0; last = await stats();
  assert.equal(last.by, other(closed)); assert.match(await log(), /Retrying on another computer \(the helping computer left\)/);
  await stopped(closed);
  note('contributor tab closed mid-job: job retried on the other contributor; its TeX processes end', `${measure.closeToPdfMs} ms close -> PDF`);

  // 8. the last contributor loses the copy grant mid-job: visible failure, previous PDF kept; its later result is denied
  const lastOne = other(closed); before = await pdfText(bea);
  by = await start(slow('GRANTMARK')); assert.equal(by, lastOne); await running(lastOne);
  const grantJob = (await seen(lastOne)).filter(m => m.k === 'job').at(-1);
  await grant(lastOne, 'online');
  await until(async () => /Shared compilation is unavailable: no computer is helping.*Previous PDF retained/s.test(await log()), 'visible failure without contributors');
  await stopped(lastOne);
  assert.equal(await pdfText(bea), before); assert.deepEqual(await stats(), last);
  await pages[lastOne].evaluate(m => globalThis.overleafGroupTest.send(m), { t: 'work', k: 'done', job: grantJob.job, lease: grantJob.lease, digest: grantJob.digest, compiler: grantJob.compiler, xfer: '0'.repeat(32) });
  await until(async () => (await seen(lastOne)).some(m => m.t === 'denied' && m.request === 'work'), 'result after revoked grant denied');
  assert.match(await helpStatus(lastOne), /no longer allows|must allow “Can keep a copy”/); // the denied late result rewrites the status
  { const close = await thisComputer(bea); await until(async () => /unavailable/.test(await describe(bea, 'olx-group-compile')), 'Bea sees no contributor'); await close(); }
  await setDoc(bea, source('LOCALMARK')); await until(async () => (await docOf(owner)).includes('LOCALMARK'), 'edit reaches the owner');
  await bea.getByRole('button', { name: 'Recompile', exact: true }).click(); await shown('LOCALMARK', 'browser compile', 120000);
  assert.deepEqual(await stats(), last, 'compiled in the browser, not shared');
  note('grant revoked mid-job with no other contributor: visible failure, previous PDF kept, late result denied; Bea compiles in her browser', lastOne);

  assert.deepEqual(errors, [], 'page errors');
  console.log(`PASS ${results.length} checks (loopback only; no second device)`);
  console.log('MEASURE', JSON.stringify(measure));
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  for (const pid of alive(orphans)) try { process.kill(pid, 'SIGKILL'); } catch {} // TeX children orphaned by the SIGKILL case
  if (process.env.LAN_KEEP_EXTENSION) console.log('kept', extension); else rmSync(work, { recursive: true, force: true });
}
