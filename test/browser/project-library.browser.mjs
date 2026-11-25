// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic disposable profile; no real projects, network or helper.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const extension = process.env.LATEX_EXTENSION_PATH;
const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json')));
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].map(b => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('');
const work = mkdtempSync(join(tmpdir(), 'latex-library-check-'));
const context = await chromium.launchPersistentContext(join(work, 'profile'), {
  headless: true, executablePath: process.env.EXTENSION_CHROME_PATH,
  ignoreDefaultArgs: ['--disable-extensions'], args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
});
try {
  await context.setOffline(true);
  const page = await context.newPage();
  const start = performance.now();
  await page.goto(`chrome-extension://${id}/extension/index.html`);
  await page.getByRole('heading', { name: 'Your projects.' }).waitFor();
  const readyMs = performance.now() - start;
  assert.equal(await page.getByRole('link', { name: 'Work offline', exact: true }).count(), 0);
  await page.getByText('Your next project starts here.', { exact: false }).waitFor();
  await page.getByRole('textbox', { name: 'New local project name', exact: true }).focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Create local project');
  await page.evaluate(async () => {
    const template = await (await fetch('/extension/native-template.json')).json();
    for (const name of ['Thesis · Monetary policy', 'Research notes', 'A long project title '.repeat(9)])
      await overleafLocalProjects.local(template, name, [{ path: 'main.tex', content: 'Synthetic source' }], 'main.tex', 'pdflatex');
  });
  await page.reload();
  await page.locator('.project-row').nth(2).waitFor();
  assert.equal(await page.locator('#project-count').textContent(), '3');
  for (const theme of ['light', 'dark']) for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    if (process.env.LIBRARY_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.LIBRARY_SCREENSHOT_DIR, `library-${theme}-${width}.png`), fullPage: true });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme}/${width} overflow: ${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('body *')].filter(n => n.getBoundingClientRect().right > innerWidth).map(n => [n.tagName,n.className,n.getBoundingClientRect().width]).slice(0,8)))}`);
    assert(await page.getByRole('button', { name: 'Create local project', exact: true }).isVisible());
  }
  await page.getByRole('link', { name: 'Research notes', exact: true }).click();
  await page.getByRole('textbox', { name: /^Source Editor/ }).waitFor({ timeout: 45000 });
  console.log(JSON.stringify({ readyMs: Math.round(readyMs), themes: 2, widths: [1280, 360], projects: 3, opened: true }));
} finally { await context.close(); rmSync(work, { recursive: true, force: true }); }
