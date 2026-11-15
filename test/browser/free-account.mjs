import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Opt-in live test: existing synthetic accounts, a running loopback CE+, and Playwright.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = 'http://127.0.0.1:8080';
const alice = process.env.OVERLEAF_TEST_ALICE_PASSWORD;
const bob = process.env.OVERLEAF_TEST_BOB_PASSWORD;
assert(alice && bob, 'Provide passwords for alice@example.test and bob@example.test via the test environment');
const work = mkdtempSync(join(tmpdir(), 'overleaf-free-browser-'));
const files = new Map([
  ['main.tex', Buffer.from('\\documentclass{article}\n\\begin{document}\n\\input{sections/content}\n\\bibliographystyle{plain}\n\\bibliography{references}\n\\end{document}\n')],
  ['sections/content.tex', Buffer.from('Offline project with a reference \\cite{example2026}.\n')],
  ['references.bib', Buffer.from('% Keep this comment and citation key.\n@article{example2026,author={Example, Alice},title={Synthetic Reference},journal={Test Journal},year={2026}}\n')],
  ['assets/data.bin', Buffer.from([0, 255, 1, 128, 13, 10, 0, 42])],
]);
for (const [name, bytes] of files) {
  mkdirSync(join(work, name, '..'), { recursive: true });
  writeFileSync(join(work, name), bytes);
}
const projectName = 'Offline-demo-' + Date.now();
const zip = join(work, projectName + '.zip');
execFileSync('/usr/bin/zip', ['-q', zip, ...files.keys()], { cwd: work });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
});
let projectUrl;
const metrics = { externalRequestsBlocked: 0 };
async function account(email, password) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === base) return route.continue();
    metrics.externalRequestsBlocked++;
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(base + '/login');
  await page.locator('input[name=email]').fill(email);
  await page.locator('input[name=password]').fill(password);
  await page.getByRole('button', { name: /^Login/ }).click();
  await page.waitForURL(base + '/project');
  return { page, context };
}
async function buffer(page) {
  // DOM text contains layout newlines; compare exports to the exact CodeMirror buffer.
  return page.locator('.cm-content').evaluate(el => el.cmView.view.state.doc.toString());
}
async function download(page, name, target) {
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: /Download/ }).first().hover();
  const [result] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name, exact: true }).click(),
  ]);
  await result.saveAs(target);
  return result.url();
}
async function verifyExport(page, expectedMain) {
  const target = join(work, 'exported.zip');
  const start = performance.now();
  const url = await download(page, 'Download as source (.zip)', target);
  metrics.exportMs = Math.round(performance.now() - start);
  metrics.exportBytes = statSync(target).size;
  const names = execFileSync('/usr/bin/unzip', ['-Z1', target], { encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(names, [...files.keys()].sort(), 'Unexpected archive entries');
  for (const [name, original] of files) {
    const bytes = execFileSync('/usr/bin/unzip', ['-p', target, name]);
    assert.deepEqual(bytes, name === 'main.tex' ? Buffer.from(expectedMain) : original, `Changed bytes: ${name}`);
  }
  return url;
}
try {
  const a = await account('alice@example.test', alice);
  await a.page.getByRole('button', { name: 'New project', exact: true }).click();
  await a.page.getByText('Existing project (.zip)', { exact: true }).click();
  await a.page.locator('input[type=file]').first().setInputFiles(zip);
  await a.page.waitForURL(/\/project\/[a-f0-9]+/);
  projectUrl = a.page.url();
  await a.page.locator('.cm-content').waitFor();
  assert.equal(await buffer(a.page), files.get('main.tex').toString(), 'Import changed source');
  await a.page.locator('.cm-content').click();
  await a.page.keyboard.press('Meta+ArrowDown');
  await a.page.keyboard.insertText('% Local offline edit.');
  const expectedMain = files.get('main.tex').toString() + '% Local offline edit.';
  assert.equal(await buffer(a.page), expectedMain, 'Keyboard edit changed unexpected text');
  const sourceUrl = await verifyExport(a.page, expectedMain);
  await a.page.waitForFunction(() => ![...document.querySelectorAll('button')].some(b => b.textContent.includes('Compiling')), {}, { timeout: 60000 });
  // The installed server rejects compiles less than one second apart.
  await new Promise(resolve => setTimeout(resolve, 1200));
  const compileStart = performance.now();
  const pending = a.page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/compile') && r.request().method() === 'POST', { timeout: 60000 });
  await a.page.getByRole('button', { name: /Recompile/ }).first().click();
  const response = await pending;
  assert.equal(response.status(), 200);
  assert.equal((await response.json()).status, 'success');
  metrics.compileMs = Math.round(performance.now() - compileStart);
  await a.page.waitForFunction(() => ![...document.querySelectorAll('button')].some(b => b.textContent.includes('Compiling')), {}, { timeout: 60000 });
  const pdf = join(work, 'compiled.pdf');
  await download(a.page, 'Download as PDF', pdf);
  assert.equal(readFileSync(pdf).subarray(0, 5).toString(), '%PDF-');
  const anonymous = await browser.newContext();
  const anonPage = await anonymous.newPage();
  await anonPage.goto(projectUrl);
  assert.equal(new URL(anonPage.url()).pathname, '/login');
  const deniedDownload = await anonymous.request.get(sourceUrl, { maxRedirects: 0 });
  assert([302, 401, 403].includes(deniedDownload.status()), 'Anonymous source download was not denied');
  await anonymous.close();
  await a.page.getByRole('button', { name: /Share/ }).click();
  const dialog = a.page.getByRole('dialog');
  await dialog.locator('input[type=email]').fill('bob@example.test');
  await dialog.getByRole('button', { name: 'Invite', exact: true }).click();
  await dialog.getByText('bob@example.test', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
  const b = await account('bob@example.test', bob);
  await b.page.getByRole('alert').filter({ hasText: projectName }).getByRole('button', { name: 'Join Project', exact: true }).click();
  await b.page.getByRole('alert').filter({ hasText: projectName }).getByText('Open Project', { exact: true }).click();
  await b.page.waitForURL(projectUrl);
  await b.page.locator('.cm-content').waitFor();
  assert.equal(await buffer(b.page), expectedMain, 'Shared collaborator received different source');
  await b.page.locator('.cm-content').click();
  await b.page.keyboard.press('Meta+ArrowDown');
  await b.page.keyboard.insertText(' Collaborator edit.');
  const sharedMain = expectedMain + ' Collaborator edit.';
  await a.page.waitForFunction(expected => document.querySelector('.cm-content')?.cmView?.view?.state.doc.toString() === expected, sharedMain);
  await a.page.reload();
  await a.page.locator('.cm-content').waitFor();
  assert.equal(await buffer(a.page), sharedMain, 'Reload lost the shared edit');
  await verifyExport(a.page, sharedMain);
  console.log(JSON.stringify({ result: 'passed', browser: browser.version(), projectUrl, ...metrics, scope: 'Loopback browser traffic only; container internet access is unchanged; synthetic projects only' }));
} finally {
  await browser.close();
  rmSync(work, { recursive: true, force: true });
  // Keep the synthetic project ID in stdout so its owner can remove it through the UI.
  if (projectUrl) console.log('Synthetic project created: ' + projectUrl);
}
