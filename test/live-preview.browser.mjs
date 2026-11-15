import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert(process.env.OVERLEAF_TEST_ALICE_PASSWORD && process.env.OVERLEAF_TEST_BOB_PASSWORD, 'Synthetic test passwords are required');
const base = 'http://127.0.0.1:8080';
const work = mkdtempSync(join(tmpdir(), 'overleaf-latency-'));
const name = 'Live-preview-' + Date.now();
let marker = 'PreviewMarker0000';
const tex = String.raw`\documentclass{article}
\title{${name}}
\begin{document}
${marker}
\end{document}
`;
writeFileSync(join(work, 'main.tex'), tex);
execFileSync('/usr/bin/zip', ['-q', join(work, name + '.zip'), 'main.tex'], { cwd: work });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const sourceMs = [], plainPdfMs = [], mathPdfMs = [], statuses = [], compileMs = [];
let projectUrl;
async function account(email, password) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('response', async response => {
    if (new URL(response.url()).pathname.endsWith('/compile') && response.request().method() === 'POST') {
      try { statuses.push((await response.json()).status); const time = response.request().timing().responseEnd; if (time >= 0) compileMs.push(time) } catch {}
    }
  });
  await page.goto(base + '/login');
  await page.locator('input[name=email]').fill(email);
  await page.locator('input[name=password]').fill(password);
  await page.getByRole('button', { name: /^Login/ }).click();
  await page.waitForURL(base + '/project'); return page;
}
async function autoOn(page) {
  await page.getByRole('button', { name: /compile options/i }).click();
  const expected = process.env.PROFILE_LABEL === 'before' ? /^Off/ : /^On/;
  assert((await page.getByRole('menuitem', { name: expected }).textContent()).includes('check'), 'Unexpected new-project auto-compile default');
  await page.getByRole('menuitem', { name: /^On/ }).click();
}
async function select(page, text) {
  await page.locator('.cm-content').evaluate((el, text) => {
    const view = el.cmView.view, offset = view.state.doc.toString().indexOf(text);
    if (offset < 0) throw Error('Marker absent from exact editor source');
    view.dispatch({ selection: { anchor: offset, head: offset + text.length } }); view.focus();
  }, text);
}
async function rendered(page, text) {
  await page.waitForFunction(text => [...document.querySelectorAll('.textLayer')].some(el => el.textContent.includes(text)), text, { timeout: 15000 });
}
const percentile = xs => xs.length ? Math.round([...xs].sort((a,b)=>a-b)[Math.ceil(xs.length * .95)-1]) : null;
try {
  const a = await account('alice@example.test', process.env.OVERLEAF_TEST_ALICE_PASSWORD);
  await a.getByRole('button', { name: 'New project', exact: true }).click();
  await a.getByText('Existing project (.zip)', { exact: true }).click();
  await a.locator('input[type=file]').first().setInputFiles(join(work, name + '.zip'));
  await a.waitForURL(/\/project\/[a-f0-9]+/); projectUrl = a.url();
  await a.locator('.cm-content').waitFor(); await rendered(a, marker); await autoOn(a);
  await a.getByRole('button', { name: /Share/ }).click();
  const dialog = a.getByRole('dialog'); await dialog.locator('input[type=email]').fill('bob@example.test');
  await dialog.getByRole('button', { name: 'Invite', exact: true }).click();
  await dialog.getByText('bob@example.test', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
  const b = await account('bob@example.test', process.env.OVERLEAF_TEST_BOB_PASSWORD);
  const invite = b.getByRole('alert').filter({ hasText: name });
  await invite.getByRole('button', { name: 'Join Project', exact: true }).click();
  await invite.getByText('Open Project', { exact: true }).click();
  await b.waitForURL(projectUrl); await b.locator('.cm-content').waitFor();
  await rendered(b, marker); await autoOn(b);
  console.log('Ready: two independent editor sessions and visible PDF text. ' + projectUrl);
  await a.locator('.cm-content').click(); await a.keyboard.press('Meta+ArrowDown'); await a.keyboard.insertText('% sync:');
  let suffix = '% sync:';
  for (const char of 'abcdefghij') {
    const start = performance.now(); await a.keyboard.insertText(char); suffix += char;
    await b.waitForFunction(text => document.querySelector('.cm-content')?.cmView?.view?.state.doc.toString().includes(text), suffix);
    sourceMs.push(performance.now() - start);
  }
  await a.keyboard.insertText(' café 中文'); suffix += ' café 中文';
  await b.waitForFunction(text => document.querySelector('.cm-content')?.cmView?.view?.state.doc.toString().includes(text), suffix);
  for (let i = 1; i <= 8; i++) {
    // Match both profiles after the previous compile's one-second admission window.
    await new Promise(resolve => setTimeout(resolve, 1200));
    const next = 'PreviewMarker' + String(i).padStart(4, '0');
    await select(a, marker); const start = performance.now();
    await a.keyboard.insertText(i > 6 ? next + ' $x^2+y^2=z^2$' : next);
    await b.waitForFunction(text => document.querySelector('.cm-content')?.cmView?.view?.state.doc.toString().includes(text), next);
    sourceMs.push(performance.now() - start);
    try { await rendered(a, next); (i > 6 ? mathPdfMs : plainPdfMs).push(performance.now() - start); }
    catch (error) { console.log('Rendered marker timeout:', next, 'compile statuses:', JSON.stringify(statuses)); throw error }
    marker = next;
  }
  const exact = await a.locator('.cm-content').evaluate(el => el.cmView.view.state.doc.toString());
  assert.equal(await b.locator('.cm-content').evaluate(el => el.cmView.view.state.doc.toString()), exact);
  await a.reload(); await a.locator('.cm-content').waitFor();
  assert.equal(await a.locator('.cm-content').evaluate(el => el.cmView.view.state.doc.toString()), exact, 'Reload lost acknowledged edits');
  await a.getByRole('button', { name: /compile options/i }).click();
  await a.getByRole('menuitem', { name: /^Off/ }).click();
  await a.getByRole('button', { name: /compile options/i }).click();
  assert((await a.getByRole('menuitem', { name: /^Off/ }).textContent()).includes('check'));
  await a.keyboard.press('Escape'); await a.reload(); await a.locator('.cm-content').waitFor();
  await a.getByRole('button', { name: /compile options/i }).click();
  assert((await a.getByRole('menuitem', { name: /^Off/ }).textContent()).includes('check'), 'Explicit Off choice was not preserved');
  await a.getByRole('menuitem', { name: /^On/ }).click();
  console.log(JSON.stringify({ profile: process.env.PROFILE_LABEL || 'candidate', result: 'passed', browser: browser.version(), projectUrl, sourceSamples: sourceMs.length, sourceP95Ms: percentile(sourceMs), plainSamples: plainPdfMs.length, plainPdfP95Ms: percentile(plainPdfMs), mathSamples: mathPdfMs.length, mathPdfP95Ms: percentile(mathPdfMs), sourceMs: sourceMs.map(Math.round), plainPdfMs: plainPdfMs.map(Math.round), mathPdfMs: mathPdfMs.map(Math.round), compileStatuses: statuses, compileRequestP95Ms: percentile(compileMs), compileRequestMs: compileMs.map(Math.round), supportedTextOnly: true, savedOffChoicePreserved: true }));
} finally {
  if (projectUrl) console.log('Task-created synthetic project for scoped cleanup: ' + projectUrl);
  await browser.close(); rmSync(work, { recursive: true, force: true });
}
