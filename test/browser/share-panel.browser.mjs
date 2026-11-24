// SPDX-License-Identifier: AGPL-3.0-only
// Packaged UI only; no room, helper, listener, or external provider is started.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const extension = resolve(process.env.LATEX_EXTENSION_PATH);
const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json')));
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].map(b => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('');
const work = mkdtempSync(join(tmpdir(), 'latex-panel-'));
const context = await chromium.launchPersistentContext(join(work, 'profile'), { headless: true, executablePath: process.env.EXTENSION_CHROME_PATH,
  ignoreDefaultArgs: ['--disable-extensions'], args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
try {
  const page = await context.newPage();
  await context.route(/^(https?|wss?):/, route => route.abort());
  await page.goto(`chrome-extension://${id}/extension/index.html`);
  const metrics = [];
  for (const width of [360, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const internet of [false, true]) {
      const result = await page.evaluate(async internet => {
        const { el, style, copyButton } = await import('/extension/lan-ui.mjs');
        const { roomPanel } = await import('/extension/p2p-ui.mjs');
        document.querySelectorAll('.lan-panel').forEach(p => p.remove()); document.head.append(style);
        const link = 'chrome-extension://' + 'a'.repeat(32) + '/extension/index.html#' + (internet ? 'room=' : 'join=') + 'a'.repeat(600);
        let copied; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { copied = text; } } });
        let panel;
        if (internet) panel = roomPanel({ link, passcode: '', me: 'guest', owner: false, ownerKey: 'owner', role: 'participant', members: [{ key: 'owner', name: 'Owner', role: 'copy' }, { key: 'guest', name: 'Guest', role: 'online' }] }).panel;
        else {
          panel = el('section', { className: 'lan-panel' }, el('div', { className: 'lan-step' }, el('span', { className: 'lan-num', textContent: '1' }),
            el('div', {}, el('div', { className: 'lan-row' }, el('code', { title: link, textContent: link }), copyButton('Copy link', () => link)))));
          document.body.append(panel);
        }
        const code = panel.querySelector('code'), row = code.parentElement;
        const width = panel.getBoundingClientRect().width, overflow = panel.scrollWidth > panel.clientWidth || row.scrollWidth > row.clientWidth;
        const truncated = code.scrollWidth > code.clientWidth;
        panel.querySelector('button')?.blur();
        [...panel.querySelectorAll('button')].find(b => b.textContent === 'Copy link').click();
        await Promise.resolve();
        code.textContent = 'Short link';
        return { width, shortWidth: panel.getBoundingClientRect().width, overflow, truncated, copyExact: copied === link, titleExact: code.title === link,
          ownerLabels: panel.querySelectorAll('.lan-badge').length ? [...panel.querySelectorAll('.lan-badge')].filter(b => b.textContent === 'Owner').length : 0 };
      }, internet);
      assert.equal(result.overflow, false); assert.equal(result.truncated, true);
      assert.equal(result.copyExact, true); assert.equal(result.titleExact, true);
      assert.equal(result.width, result.shortWidth); assert(result.width <= Math.min(392, width - 28));
      if (internet) assert.equal(result.ownerLabels, 1);
      metrics.push({ viewport: width, internet, ...result });
    }
  }
  console.log(JSON.stringify({ passed: metrics.length, metrics }));
} finally { await context.close(); rmSync(work, { recursive: true, force: true }); }
