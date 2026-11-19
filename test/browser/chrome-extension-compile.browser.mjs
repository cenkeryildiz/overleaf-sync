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
const extension = resolve(process.env.LATEX_EXTENSION_PATH || '/Users/macc/overleaf-extension-compile-candidate-20261119');
const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json')));
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
const root = `chrome-extension://${id}`, work = mkdtempSync(join(tmpdir(), 'latex-extension-compile-'));
const context = await chromium.launchPersistentContext(join(work, 'profile'), { channel: 'chromium', headless: true,
  executablePath: process.env.EXTENSION_CHROME_PATH, ignoreDefaultArgs: ['--disable-extensions'],
  viewport: { width: 1600, height: 1000 }, acceptDownloads: true, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
const external = [], errors = [], missing = [], metrics = {};
const deadline = setTimeout(() => context.close(), 240000);
let stage = 'startup';
try {
  await context.addInitScript(() => {
    globalThis.nativeCalls = 0;
    chrome.runtime.connectNative = () => { globalThis.nativeCalls++; throw Error('A native compiler must not be required'); };
  });
  await context.route('**/*', route => {
    const url = route.request().url();
    if (/^(https?|wss?):/.test(url)) { external.push(new URL(url).origin); return route.abort(); }
    return route.continue();
  });
  await context.setOffline(true);
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message.slice(0, 200)));
  page.on('requestfailed', request => { missing.push(new URL(request.url()).pathname); if (missing.length > 12) missing.shift(); });
  await page.goto(root + '/extension/index.html');
  await page.getByRole('link', { name: 'Work offline', exact: true }).click();
  await page.getByRole('textbox', { name: 'New local project name', exact: true }).fill('Offline compilation fixture');
  const initial = performance.now();
  await page.getByRole('button', { name: 'Create local project', exact: true }).click();
  const editor = page.getByRole('textbox', { name: /^Source Editor/ }); await editor.waitFor({ timeout: 45000 });
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
  const stale = await page.evaluate(async () => {
    const api = overleafLocalProjects, old = await api.read(location.hash.slice(1));
    await api.save(old.files.find(file => file.path === 'sections/child.tex'), 'Newer chapter.\n');
    try { await api.output(old.project, old.files, old.project.pdf, old.project.synctex, old.project.outputDigest); }
    catch (error) { return { refused: error.message.includes('Source changed'), digest: (await api.read(old.project.id)).project.outputDigest === old.project.outputDigest }; }
    return { refused: false };
  });
  assert.equal(stale.refused, true); assert.equal(stale.digest, true);
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
