// SPDX-License-Identifier: AGPL-3.0-only
// Actual standalone package, no server or native registration; synthetic projects only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const extension = resolve(process.env.LATEX_EXTENSION_PATH || '/Users/macc/Downloads/LaTeX_Local_Chrome_Extension');
const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json')));
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
const root = `chrome-extension://${id}`, work = mkdtempSync(join(tmpdir(), 'latex-extension-compile-'));
const marker = '--user-data-dir=' + join(work, 'profile');
// Reuse the long-session fixture's process-tree RSS accounting (shared pages may be counted in multiple processes).
function residentMiB() {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' }).trim().split('\n')
    .map(line => { const [pid, ppid, rss, ...command] = line.trim().split(/\s+/); return [Number(pid), Number(ppid), Number(rss), command.join(' ')]; });
  const root = rows.find(([, ppid, , command]) => command.includes(marker) && !rows.some(([pid, , , parent]) => pid === ppid && parent.includes(marker)));
  assert(root, 'Launched browser process not found');
  const tree = new Set([root[0]]); let grew = true;
  while (grew) { grew = false; for (const [pid, ppid] of rows) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); grew = true; } }
  return Math.round(rows.filter(([pid]) => tree.has(pid)).reduce((sum, [, , rss]) => sum + rss, 0) / 1024);
}

const context = await chromium.launchPersistentContext(join(work, 'profile'), { channel: 'chromium', headless: true,
  executablePath: process.env.EXTENSION_CHROME_PATH, ignoreDefaultArgs: ['--disable-extensions'],
  viewport: { width: 1600, height: 1000 }, acceptDownloads: true, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
const faultCheck = process.env.EXTENSION_FAULT_CHECK === '1';
const external = [], errors = [], missing = [], metrics = {};
const pageError = error => { if (!faultCheck || error.message !== 'Synthetic quota failure') errors.push(error.message.slice(0, 200)); };
const deadline = setTimeout(() => context.close(), 240000);
let stage = 'startup';
try {
  await context.addInitScript(faultCheck => {
    globalThis.fixtureWorkers = []; globalThis.fixtureStartupFailed = false;
    const NativeWorker = Worker;
    globalThis.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options); fixtureWorkers.push({ url: String(url), worker: this });
        if (faultCheck && !fixtureStartupFailed && String(url).includes('/busytex/busytex_worker.js')) {
          globalThis.fixtureStartupFailed = true;
          setTimeout(() => { this.terminate(); this.dispatchEvent(new ErrorEvent('error', { cancelable: true, message: 'Synthetic initialization fault' })); }, 0);
        }
      }
    };
    globalThis.nativeCalls = 0;
    chrome.runtime.connectNative = () => { globalThis.nativeCalls++; throw Error('A native compiler must not be required'); };
  }, faultCheck);
  await context.route('**/*', route => {
    const url = route.request().url();
    if (/^(https?|wss?):/.test(url)) { external.push(new URL(url).origin); return route.abort(); }
    return route.continue();
  });
  await context.setOffline(true);
  let page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', pageError);
  page.on('requestfailed', request => { missing.push(new URL(request.url()).pathname); if (missing.length > 12) missing.shift(); });
  await page.goto(root + '/extension/index.html');
  await page.getByRole('link', { name: 'Work offline', exact: true }).click();
  await page.getByRole('textbox', { name: 'New local project name', exact: true }).fill('Offline compilation fixture');
  const initial = performance.now();
  await page.getByRole('button', { name: 'Create local project', exact: true }).click();
  let editor = page.getByRole('textbox', { name: /^Source Editor/ }); await editor.waitFor({ timeout: 45000 });
  metrics.editorVisibleMs = Math.round(performance.now() - initial);
  const visible = text => page.locator('.textLayer span').filter({ hasText: text }).first().waitFor({ timeout: 120000 });
  await visible('Hello world.'); metrics.firstPdfMs = Math.round(performance.now() - initial);
  const read = () => page.evaluate(() => overleafLocalProjects.read(location.hash.slice(1)));
  const replace = text => editor.evaluate((node, text) => node.cmView.view.dispatch({ changes: { from: 0, to: node.cmView.view.state.doc.length, insert: text } }), text);
  const automatic = async enabled => {
    await page.locator('button.compile-dropdown-toggle').click();
    await page.getByRole('menuitem', { name: enabled ? 'On' : 'Off', exact: true }).click();
  };
  await automatic(true);
  stage = 'autocompile';
  const original = (await read()).files.find(file => file.path === 'main.tex').content;
  const changed = original.replace('Hello world.', 'Updated offline formula: $x^2 + y^2 = z^2$. % Türkçe 😀');
  const warm = performance.now(); await replace(changed); await visible('Updated offline formula:');
  metrics.warmVisibleMs = Math.round(performance.now() - warm);
  let state = await read();
  assert.equal(state.files.find(file => file.path === 'main.tex').content, changed);
  assert(state.project.outputDigest && state.project.synctex && !state.project.pdfImported);
  stage = 'stored-off';
  await automatic(false);
  const disabled = changed.replace('Updated offline formula:', 'Manual compilation marker:');
  const previous = state.project.outputDigest;
  await replace(disabled);
  await page.waitForFunction(async expected => (await overleafLocalProjects.read(location.hash.slice(1))).files.find(file => file.path === 'main.tex').content === expected, disabled);
  await page.reload(); await editor.waitFor();
  await page.getByRole('button', { name: 'Recompile', exact: true }).waitFor();
  await page.waitForTimeout(2000);
  assert.equal((await read()).project.outputDigest, previous, 'Autocompile Off must survive reload');
  await page.getByRole('button', { name: 'Recompile', exact: true }).click();
  await visible('Manual compilation marker:');
  stage = 'failure-retention';
  state = await read(); const good = state.project.outputDigest;
  const invalid = disabled.replace('\\begin{document}', '\\usepackage{not-a-real-offline-package}\n\\begin{document}');
  await replace(invalid);
  await page.getByRole('button', { name: 'Recompile', exact: true }).click();
  await page.locator('#local-status[data-error=true]').waitFor({ timeout: 120000 });
  assert.equal((await read()).project.outputDigest, good);
  assert.equal((await read()).files.find(file => file.path === 'main.tex').content, invalid);
  stage = 'retry'; await replace(disabled);
  await page.getByRole('button', { name: 'Recompile', exact: true }).click();
  await page.locator('#local-status').filter({ hasText: 'Compiled and saved in this browser.' }).waitFor({ timeout: 120000 });
  stage = 'stop-retry';
  state = await read(); const stoppedDigest = state.project.outputDigest;
  await replace(disabled.replace('Manual compilation marker:', 'Canceled marker:').replace('\\begin{document}', '\\begin{document}\n\\newcount\\fixturecount\\fixturecount=0\\loop\\advance\\fixturecount by1\\ifnum\\fixturecount<100000000\\repeat\n'));
  await page.getByRole('button', { name: 'Recompile', exact: true }).click();
  await page.locator('button.compile-dropdown-toggle').click();
  await page.getByRole('menuitem', { name: /Stop compil/ }).click();
  await page.locator('#local-status[data-error=true]').filter({ hasText: /canceled/i }).waitFor();
  assert.equal((await read()).project.outputDigest, stoppedDigest);
  await replace(disabled);
  await page.getByRole('button', { name: 'Recompile', exact: true }).click();
  await page.locator('#local-status').filter({ hasText: 'Compiled and saved in this browser.' }).waitFor({ timeout: 120000 });
  stage = 'imported-to-generated';
  await page.evaluate(async () => { const api = overleafLocalProjects, state = await api.read(location.hash.slice(1)); await api.viewPdf(state.project, state.project.pdf); });
  await page.reload(); await editor.waitFor(); await visible('Manual compilation marker:');
  assert.equal((await read()).project.pdfImported, true);
  await page.getByRole('button', { name: 'Recompile', exact: true }).click();
  await page.waitForFunction(async () => { const { project } = await overleafLocalProjects.read(location.hash.slice(1)); return project.pdfImported === false && !!project.outputDigest && !!project.synctex && !project.pdfDigest; }, null, { timeout: 120000 });
  stage = 'export-restart';
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
  await (await download).saveAs(join(work, 'output.pdf'));
  const exported = readFileSync(join(work, 'output.pdf'));
  assert.equal(exported.subarray(0, 5).toString(), '%PDF-');
  execFileSync('pdftotext', [join(work, 'output.pdf'), join(work, 'output.txt')]);
  assert(readFileSync(join(work, 'output.txt'), 'utf8').includes('Manual compilation marker:'));
  const info = execFileSync('pdfinfo', [join(work, 'output.pdf')], { encoding: 'utf8' });
  const paper = info.match(/Page size:\s+([\d.]+) x ([\d.]+) pts/);
  assert(paper && Number(paper[1]) > 0 && Number(paper[2]) > 0, 'Independent reader must report the compiled page dimensions');
  metrics.pdfPagePoints = { width: Number(paper[1]), height: Number(paper[2]) };
  const layer = await page.locator('.textLayer').first().evaluate(node => { const r = node.getBoundingClientRect(); return { width: r.width, height: r.height }; });
  assert(Math.abs(layer.width / layer.height - Number(paper[1]) / Number(paper[2])) < .01, 'Native PDF display must preserve page geometry');

  const zip = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download project (.zip)', exact: true }).click();
  await (await zip).saveAs(join(work, 'export.zip'));
  assert.equal(execFileSync('/usr/bin/unzip', ['-p', join(work, 'export.zip'), 'main.tex'], { encoding: 'utf8' }), disabled);
  await page.reload(); await editor.waitFor(); await visible('Manual compilation marker:');
  stage = 'multifile-bibliography';
  const figure = Buffer.from(await page.evaluate(async () => [...new Uint8Array(await (await overleafLocalProjects.read(location.hash.slice(1))).project.pdf.arrayBuffer())])).toString('base64');
  const resources = [
    { path: 'main.tex', content: String.raw`\documentclass{article}
\usepackage{graphicx}
\begin{document}
\input{sections/child}
\includegraphics[width=1in]{figure.pdf}
\cite{fixture}
\bibliographystyle{plain}
\bibliography{refs}
\end{document}
` },
    { path: 'sections/child.tex', content: String.raw`Multi-file navigation marker.
\[ x^2 + y^2 = z^2 \]
` },
    { path: 'figure.pdf', data: figure },
    { path: 'refs.bib', content: '@book{fixture,author={Fixture Author},title={Offline Bibliography},year={2026}}\n' },
  ];
  const workspace = await page.evaluate(async resources => {
    const api = overleafLocalProjects, current = await api.read(location.hash.slice(1));
    return api.local(current.project.native, 'Multi-file compilation', resources, 'main.tex');
  }, resources);
  await page.goto(root + '/recovery/native-workspace.html#' + workspace); await page.reload(); await editor.waitFor();
  await visible('Multi-file navigation marker.'); await visible('Offline Bibliography');
  state = await read();
  const mapping = await page.evaluate(async () => {
    const state = await overleafLocalProjects.read(location.hash.slice(1)), compile = await import('/recovery/project-compile.mjs');
    const nav = await compile.navigation(state.project.synctex, state.project, state.files);
    const forward = compile.forward(nav, 'sections/child.tex', 1);
    const backward = compile.backward(nav, forward.page, forward.x + forward.width / 2, forward.y + forward.height / 2);
    return { forward: forward.path, backward: backward.path, page: forward.page };
  });
  assert.equal(mapping.forward, 'sections/child.tex'); assert.equal(mapping.backward, 'sections/child.tex');
  stage = 'native-navigation-controls';
  await page.locator('.textLayer span').filter({ hasText: 'Multi-file navigation marker.' }).first().dblclick();
  await page.waitForFunction(expected => document.querySelector('[aria-label^="Source Editor"]')?.cmView.view.state.doc.toString() === expected, resources.find(file => file.path === 'sections/child.tex').content);
  await page.getByRole('button', { name: 'Go to code location in PDF', exact: true }).click();
  await page.getByRole('treeitem', { name: 'main.tex', exact: true }).click();
  await page.waitForFunction(expected => document.querySelector('[aria-label^="Source Editor"]')?.cmView.view.state.doc.toString() === expected, resources[0].content);

  stage = 'typing-during-compile';
  await automatic(true);
  const latest = resources[0].content.replace('\\end{document}', 'Latest settled input.\n\\end{document}');
  const busy = resources[0].content.replace('\\begin{document}', '\\begin{document}\n\\newcount\\fixturecount\\fixturecount=0\\loop\\advance\\fixturecount by1\\ifnum\\fixturecount<10000000\\repeat\n');
  await replace(busy);
  await page.locator('#local-status').filter({ hasText: 'Compiling on this device' }).waitFor();
  await replace(latest);
  await visible('Latest settled input.');
  assert.equal((await read()).files.find(file => file.path === 'main.tex').content, latest);
  stage = 'stale-output';
  await automatic(false);
  const stale = await page.evaluate(async () => {
    const api = overleafLocalProjects, old = await api.read(location.hash.slice(1));
    await api.save(old.files.find(file => file.path === 'sections/child.tex'), 'Newer chapter.\n');
    try { await api.output(old.project, old.files, old.project.pdf, old.project.synctex, old.project.outputDigest); }
    catch (error) { return { refused: error.message.includes('Source changed'), digest: (await api.read(old.project.id)).project.outputDigest === old.project.outputDigest }; }
    return { refused: false };
  });
  assert.equal(stale.refused, true); assert.equal(stale.digest, true);
  if (faultCheck) {
    await page.reload(); await editor.waitFor(); // Reconcile the intentional out-of-tab edit used by the stale-output check.
    stage = 'compiler-worker-loss';
    await replace(busy);
    await page.getByRole('button', { name: 'Recompile', exact: true }).click();
    await page.locator('#local-status').filter({ hasText: 'Compiling on this device' }).waitFor();
    await page.evaluate(() => {
      const worker = fixtureWorkers.findLast(item => item.url.includes('/busytex/busytex_worker.js')).worker;
      worker.terminate(); worker.dispatchEvent(new ErrorEvent('error', { cancelable: true, message: 'Synthetic terminated-worker fault' }));
    });
    await page.locator('#local-status[data-error=true]').waitFor();
    await replace(latest);
    await page.getByRole('button', { name: 'Recompile', exact: true }).click();
    await visible('Latest settled input.');
    stage = 'quota-and-unsaved-export';
    const accepted = await read(), heldText = latest + '% Unsaved quota text 😀\n';
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, ...args) {
        if (this.name === 'files') throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
        return put.call(this, value, ...args);
      };
    });
    await replace(heldText);
    await page.locator('#local-status[data-error=true]').filter({ hasText: /quota|storage|saving/i }).waitFor();
    assert.equal((await read()).files.find(file => file.path === 'main.tex').content, accepted.files.find(file => file.path === 'main.tex').content);
    assert.equal((await read()).project.outputDigest, accepted.project.outputDigest);
    const held = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download project (.zip)', exact: true }).click();
    await (await held).saveAs(join(work, 'quota-recovery.zip'));
    assert.equal(execFileSync('/usr/bin/unzip', ['-p', join(work, 'quota-recovery.zip'), 'main.tex'], { encoding: 'utf8' }), heldText);
    stage = 'crash-reopen';
    const reopen = page.url(), crashed = page.waitForEvent('crash');
    const crashCdp = await context.newCDPSession(page);
    crashCdp.send('Page.crash').catch(() => {}); await crashed; await page.close();
    page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', pageError);
    await page.goto(reopen);
    editor = page.getByRole('textbox', { name: /^Source Editor/ }); await editor.waitFor();
    assert.equal(await editor.evaluate(node => node.cmView.view.state.doc.toString()), latest);
    await visible('Latest settled input.');
    stage = 'review-and-restore-recovery-copy';
    await page.getByRole('button', { name: 'Local only options', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Recovery copies', exact: true }).click();
    const recovery = page.getByRole('dialog', { name: 'Review offline recovery copy', exact: true });
    await recovery.waitFor();
    assert.equal(await recovery.getByRole('textbox', { name: 'Recovered text', exact: true }).inputValue(), heldText);
    assert.equal(await editor.evaluate(node => node.cmView.view.state.doc.toString()), latest, 'Recovery must require explicit application');
    await recovery.getByRole('button', { name: 'Save recovered text locally', exact: true }).click();
    await page.waitForFunction(async expected => (await overleafLocalProjects.read(location.hash.slice(1))).files.find(file => file.path === 'main.tex').content === expected, heldText);
    stage = 'theme-keyboard-and-repeat';
    const colors = [];
    for (const overallTheme of ['light-', '']) {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const settings = page.getByRole('dialog');
      await settings.getByRole('tab', { name: 'Appearance', exact: true }).click();
      await settings.locator('#overallTheme').selectOption(overallTheme);
      await page.waitForFunction(async theme => JSON.parse((await overleafLocalProjects.read(location.hash.slice(1))).project.native.meta.find(meta => meta.name === 'ol-userSettings').content).overallTheme === theme, overallTheme);
      const editorTheme = overallTheme === '' ? 'overleaf_dark' : 'textmate';
      await settings.locator('#editorTheme').selectOption(editorTheme);
      await page.waitForFunction(async theme => JSON.parse((await overleafLocalProjects.read(location.hash.slice(1))).project.native.meta.find(meta => meta.name === 'ol-userSettings').content).editorTheme === theme, editorTheme);
      await page.keyboard.press('Escape');
      await page.reload(); await editor.waitFor();
      const trigger = page.getByRole('button', { name: 'Local only options', exact: true });
      await trigger.focus(); await page.keyboard.press('ArrowDown');
      assert(await page.getByRole('menuitem', { name: 'Saved projects', exact: true }).evaluate(node => node === document.activeElement));
      await page.keyboard.press('Escape'); assert(await trigger.evaluate(node => node === document.activeElement));
      await editor.press('Control+Home');
      colors.push(await editor.evaluate(node => ({ background: getComputedStyle(node.closest('.cm-editor')).backgroundColor, color: getComputedStyle(node).color, syntax: [...new Set([...node.querySelectorAll('.cm-line span')].map(span => getComputedStyle(span).color))] })));
    }
    assert.notEqual(colors[0].background, colors[1].background, 'Native dark editor must differ from light');
    assert(colors.every(theme => theme.syntax.length > 1), 'Native syntax highlighting must remain visible in both themes');
    metrics.repeatedHeap = []; metrics.repeatedResidentMiB = [];
    for (let n = 0; n < 6; n++) {
      await replace(latest.replace('Latest settled input.', `Repeated compile ${n}.`));
      await page.getByRole('button', { name: 'Recompile', exact: true }).click();
      await visible(`Repeated compile ${n}.`);
      metrics.repeatedHeap.push(await page.evaluate(() => performance.memory?.usedJSHeapSize));
      metrics.repeatedResidentMiB.push(residentMiB());
    }
    metrics.robustness = { startupFailureRecovered: await page.evaluate(() => fixtureStartupFailed), workerLossRetry: true, quotaRetainsAcceptedDataAndExportsUnsavedText: true, crashReopen: true, explicitUnicodeRecoveryRestore: true, nativeLightDarkKeyboard: colors };
  }
  assert.equal(await page.evaluate(() => nativeCalls), 0);
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
  const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
  metrics.resources = (await cdp.send('Performance.getMetrics')).metrics.filter(item => ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes'].includes(item.name));
  console.log(JSON.stringify({ ...metrics, actualPdf: true, autoCompile: true, storedOff: true, missingPackageRetainsSourceAndPdf: true, retry: true, exactExportAndReload: true, stopRetry: true, importedToGenerated: true, multifileBibliographyAndNavigation: mapping, typingDuringCompile: true, staleOutputRefused: true, noHelper: true, noExternal: true }));
} catch (error) {
  const page = context.pages().at(-1);
  console.error(JSON.stringify({ stage, compileButtons: await page?.getByRole('button').evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label') || n.textContent.trim()).filter(text => /compile|stop/i.test(text))).catch(() => []), status: await page?.locator('#status, #local-status').allTextContents().catch(() => []), errors, missing }));
  throw error;
} finally { clearTimeout(deadline); await context.close(); rmSync(work, { recursive: true, force: true }); }
