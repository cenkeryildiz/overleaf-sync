// SPDX-License-Identifier: MIT
// Actual standalone editor/viewer; optional private input stays in a disposable profile.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const extension = resolve(process.env.LATEX_EXTENSION_PATH), work = mkdtempSync(join(tmpdir(), 'latex-word-navigation-'));
const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json')));
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].map(b => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('');
const template = process.env.LATEX_TEST_DOCUMENT;
const source = template ? readFileSync(template, 'utf8') : String.raw`\documentclass{article}
\begin{document}
Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu alpha bravo charlie.

Second paragraph here with a final
word ending.

The corporate rate rose.

\begin{itemize}
\item[1.] Estimation and solution appear as ordinary words.
\end{itemize}
% Alpha commented out.
\end{document}
`;
const context = await chromium.launchPersistentContext(join(work, 'profile'), { channel: 'chromium', headless: true,
  executablePath: process.env.EXTENSION_CHROME_PATH, ignoreDefaultArgs: ['--disable-extensions'],
  viewport: { width: 1400, height: 900 }, deviceScaleFactor: Number(process.env.DPR || 1), args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
const deadline = setTimeout(() => context.close(), 240000), errors = [];
try {
  if (!template) await context.route(/^https?:/, r => r.abort());
  const page = await context.newPage(); page.setDefaultTimeout(60000); page.on('pageerror', e => errors.push(e.name));
  await page.goto(`chrome-extension://${id}/extension/index.html`); await page.waitForURL(/project-workspace\.html$/);
  await page.getByRole('textbox', { name: 'New local project name', exact: true }).fill('word navigation');
  await page.getByRole('button', { name: 'Create local project', exact: true }).click();
  const editor = page.getByRole('textbox', { name: /^Source Editor/ }); await editor.waitFor();
  await editor.evaluate((n, text) => { const v = n.cmView.view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } }); }, source);
  await page.getByRole('button', { name: 'Recompile', exact: true }).click();
  if (template) {
    await page.locator('#olx-package-hint').waitFor(); await page.locator('#olx-package-hint').click();
    const pane = page.locator('#ide-settings-tabs-tabpane-packages');
    await pane.getByRole('button', { name: 'Download list' }).click();
    await page.waitForFunction(() => /signature checked/.test(document.querySelector('#setting-packages-catalog')?.textContent));
    await pane.locator('#setting-packages-needed').getByRole('button', { name: 'Install all missing' }).click();
    await pane.locator('#setting-packages-needed').getByRole('button', { name: 'Confirm install' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('ul[aria-label="Installed packages"] li code')].some(n => n.textContent === 'bbm-macros'));
    await page.getByRole('button', { name: 'Close dialog' }).click();
    await page.getByRole('button', { name: 'Recompile', exact: true }).click();
  }
  await page.waitForFunction(() => /Compiled and saved/.test(document.querySelector('#local-status')?.textContent), null, { timeout: 120000 });
  console.log('Compiled navigation fixture.');
  await page.locator('.textLayer span').first().waitFor();
  const jump = async offset => {
    await editor.evaluate((n, offset) => { const v = n.cmView.view; v.dispatch({ selection: { anchor: offset } }); v.focus(); }, offset);
    await page.getByRole('button', { name: 'Go to code location in PDF', exact: true }).click();
  };
  const check = async (word, offset, nth) => {
    const previous = (await page.locator('.olx-caret-word').elementHandles())[0] ?? null;
    await jump(offset);
    await page.waitForFunction(previous => { const mark = document.querySelector('.olx-caret-word'); return mark && mark !== previous; }, previous, { timeout: 5000 });
    await previous?.dispose();
    const result = await page.evaluate(({ word, nth }) => {
      const mark = document.querySelector('.olx-caret-word'), m = mark.getBoundingClientRect(), rects = [];
      for (const s of mark.parentElement.querySelectorAll('.textLayer span')) {
        const text = s.firstChild; if (text?.nodeType !== 3) continue;
        for (const match of text.textContent.matchAll(/[\p{L}\p{N}]+/gu)) if (match[0] === word) {
          const r = new Range(); r.setStart(text, match.index); r.setEnd(text, match.index + word.length); rects.push(r.getBoundingClientRect());
        }
      }
      rects.sort((a, b) => Math.abs(a.top - b.top) > 2 ? a.top - b.top : a.left - b.left);
      const covers = r => m.left <= r.left + 2 && m.right >= r.right - 2 && m.top <= r.top + 2 && m.bottom >= r.bottom - 2;
      return { correct: nth === undefined ? rects.some(covers) : !!rects[nth] && covers(rects[nth]), count: document.querySelectorAll('.olx-caret-word').length, marker: [m.x,m.y,m.width,m.height], candidates: rects.map(r => [r.x,r.y,r.width,r.height]) };
    }, { word, nth });
    if (!result.correct) console.log(JSON.stringify({ index: checked, ...result }));
    assert.equal(result.correct, true, 'marker must cover the exact word rectangle'); assert.equal(result.count, 1);
  };
  let checked = 0;
  if (template) {
    // Only literal, non-command words that exist in the rendered PDF; no source text in output.
    const text = (await page.locator('.textLayer').allTextContents()).join(' '), lines = source.split('\n'); let offset = 0;
    for (let line = 0; line < lines.length && checked < 40; line++) {
      const plain = lines[line].replace(/(?<!\\)%.*/, '').replace(/\\(?:begin|end)\s*\{[^}]*\}/g, m => ' '.repeat(m.length));
      if (line > source.slice(0, source.indexOf('\\begin{document}')).split('\n').length) {
        const words = [...plain.matchAll(/\\?[\p{L}\p{N}]+/gu)].filter(m => !m[0].startsWith('\\') && m[0].length >= 5 && text.includes(m[0]) && plain.split(m[0]).length === 2);
        const m = words[Math.floor(words.length / 2)]; if (m) { await check(m[0], offset + m.index + 1); checked++; }
      }
      offset += lines[line].length + 1;
    }
    assert(checked >= 20, 'enough literal template words checked');
  } else {
    for (const [word, nth] of [['mike', 0], ['bravo', 1], ['Second', 0], ['Alpha', 0], ['alpha', 0], ['ending', 0], ['Estimation', 0], ['solution', 0]]) {
      let offset = -1; for (let i = 0; i <= nth; i++) offset = source.indexOf(word, offset + 1);
      await check(word, offset + 1, nth); checked++;
    }
    // A jump onto an environment name or comment must clear the preceding marker.
    for (const offset of [source.indexOf('itemize') + 2, source.indexOf('% Alpha') + 4]) {
      await check('mike', source.indexOf('mike') + 1, 0); await jump(offset); await page.waitForFunction(() => !document.querySelector('.olx-caret-word'));
    }
    const ending = page.locator('.textLayer span').filter({ hasText: /ending/ }).first(); await ending.scrollIntoViewIfNeeded();
    const point = await ending.evaluate(n => { const t = n.firstChild, at = t.textContent.indexOf('ending'), r = new Range(); r.setStart(t, at); r.setEnd(t, at + 6); const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    await page.mouse.dblclick(point.x, point.y);
    await page.waitForFunction(line => { const v = document.querySelector('[aria-label^="Source Editor"]').cmView.view; return v.state.doc.lineAt(v.state.selection.main.from).number === line; }, source.slice(0, source.indexOf('ending')).split('\n').length);
    // "rate" is one word but a repeated substring ("corporate"); the editor must select it, not the line start.
    const rate = page.locator('.textLayer span').filter({ hasText: /corporate rate/ }).first(); await rate.scrollIntoViewIfNeeded();
    const at = await rate.evaluate(n => { const t = n.firstChild, i = t.textContent.indexOf(' rate') + 1, r = new Range(); r.setStart(t, i); r.setEnd(t, i + 4); const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    await page.mouse.dblclick(at.x, at.y);
    await page.waitForFunction(from => { const s = document.querySelector('[aria-label^="Source Editor"]').cmView.view.state.selection.main; return s.from === from && s.to === from + 4; }, source.indexOf(' rate ') + 1);
    checked++;
    await check('mike', source.indexOf('mike') + 1, 0); await page.waitForTimeout(2400); assert.equal(await page.locator('.olx-caret-word').count(), 0);
  }
  assert((await editor.evaluate(n => n.cmView.view.state.doc.toString())) === source, 'source unchanged'); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checked, dpr: Number(process.env.DPR || 1), sourceUnchanged: true, template: !!template }));
} finally { clearTimeout(deadline); await context.close(); rmSync(work, { recursive: true, force: true }); }
