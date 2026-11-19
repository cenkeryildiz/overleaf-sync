// Actual native offline UI regression. Synthetic account and project only; screenshots are disposable.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { withSyntheticAccounts } from './synthetic-accounts.mjs';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const container = process.env.HOSTING_APP_CONTAINER;
assert(container, 'Explicit synthetic-account target required');
const base = process.env.HOSTING_TEST_BASE || 'http://127.0.0.1:8081';
assert.equal(new URL(base).hostname, '127.0.0.1');
const work = mkdtempSync(join(tmpdir(), 'latex-ui-')), output = process.env.OFFLINE_UI_OUTPUT || work;
const theme = process.argv[2] === 'dark' ? '' : 'light-', label = theme ? 'light' : 'dark';
writeFileSync(join(work, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nNative UI fixture.\\input{chapter}\n\\end{document}\n');
writeFileSync(join(work, 'chapter.tex'), 'Shared chapter.\n');
execFileSync('/usr/bin/zip', ['-q', join(work, 'fixture.zip'), 'main.tex', 'chapter.tex'], { cwd: work });
try {
  await withSyntheticAccounts(async ([user]) => {
    const context = await chromium.launchPersistentContext(join(work, 'browser'), { headless: true, executablePath: process.env.CHROME_PATH, viewport: { width: 1600, height: 1000 }, serviceWorkers: 'allow' });
    const deadline = setTimeout(() => context.close(), 240000);
    try {
      await context.route('**/*', r => new URL(r.request().url()).origin === base ? r.continue() : r.abort());
      const page = context.pages()[0]; page.setDefaultTimeout(30000);
      page.on('console', m => { if (m.type() === 'error') console.error(m.text().slice(0, 250)); });
      await page.goto(base + '/login'); await page.locator('input[name=email]').fill(user.email); await page.locator('input[name=password]').fill(user.password);
      await page.getByRole('button', { name: /^Login/ }).click(); await page.waitForURL(base + '/project');
      async function keyboardMenu(name) {
        const trigger = page.getByRole('button', { name, exact: true });
        const menu = trigger.locator('..').getByRole('menu', { includeHidden: true });
        await trigger.focus(); await trigger.press('ArrowDown');
        const downOpens = await trigger.getAttribute('aria-expanded') === 'true';
        if (!downOpens) await trigger.press('Enter');
        const items = menu.getByRole('menuitem');
        assert(await items.first().evaluate(node => node === document.activeElement));
        await page.keyboard.press('End'); assert(await items.last().evaluate(node => node === document.activeElement));
        await page.keyboard.press('Home'); assert(await items.first().evaluate(node => node === document.activeElement));
        await page.keyboard.press('ArrowUp'); assert(await items.last().evaluate(node => node === document.activeElement));
        await page.keyboard.press('Escape'); assert(await trigger.evaluate(node => node === document.activeElement));
        await trigger.press('ArrowUp');
        const upOpens = await trigger.getAttribute('aria-expanded') === 'true';
        if (!upOpens) { await trigger.press('Enter'); await page.keyboard.press('End'); }
        assert(await items.last().evaluate(node => node === document.activeElement));
        await page.keyboard.press('Tab');
        const tabCloses = await menu.isHidden();
        if (!tabCloses) await trigger.click();
        const controls = await trigger.getAttribute('aria-controls');
        const relationship = !!controls && controls === await menu.getAttribute('id') && await menu.getAttribute('aria-labelledby') === await trigger.getAttribute('id') && await menu.evaluate(node => document.querySelectorAll('#' + CSS.escape(node.id)).length === 1);
        console.log(JSON.stringify({ keyboardMenu: name, theme: label, downOpens, upOpens, tabCloses, relationship }));
        if (process.env.TOOLBAR_KEYBOARD_BASELINE !== '1') assert(downOpens && upOpens && tabCloses && relationship);
      }
      const token = await page.locator('meta[name="ol-csrfToken"]').getAttribute('content');
      const settings = await page.request.post(base + '/user/settings', { headers: { 'X-CSRF-Token': token }, data: { overallTheme: theme } }); assert(settings.ok());
      await page.getByRole('button', { name: /^(New project|Create a new project)$/i }).click(); await page.getByText('Existing project (.zip)', { exact: true }).click();
      await page.locator('input[type=file]').first().setInputFiles(join(work, 'fixture.zip')); await page.waitForURL(/\/project\/[a-f0-9]{24}/);
      await page.getByRole('textbox', { name: /^Source Editor/ }).waitFor();
      await keyboardMenu('Offline and recovery options');
      await page.getByRole('button', { name: 'Offline and recovery options' }).focus(); await page.keyboard.press('Enter');
      await page.screenshot({ path: join(output, 'connected-' + label + '.png') });
      assert(await page.getByRole('menuitem', { name: 'Work offline', exact: true }).evaluate(node => node === document.activeElement));
      await page.keyboard.press('Enter'); await page.waitForURL(/native-workspace/, { timeout: 120000 });
      const editor = page.getByRole('textbox', { name: /^Source Editor/ }); await editor.waitFor();
      await keyboardMenu('Local only options');
      await context.setOffline(true);
      console.log('Native compile controls', await page.getByRole('button').evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label') || n.textContent.trim()).filter(s => /compile|stop/i.test(s))));
      await page.screenshot({ path: join(output, 'native-' + label + '.png') });
      console.log('Initial:', await page.locator('#local-status').textContent());
      if ((await page.locator('#local-status').textContent()).startsWith('Native editor')) await page.getByRole('button', { name: /^Recompile/ }).first().click();
      await page.waitForFunction(() => { const n = document.querySelector('#local-status'); return n.dataset.error === 'true' || n.textContent === 'Compiled and saved in this browser.'; }, null, { timeout: 120000 });
      console.log('Compile:', await page.locator('#local-status').textContent());
      // OPT-02: first native compile marks in ms since the native workspace navigation started.
      console.log(JSON.stringify({ nativeFirstCompile: theme || 'dark', marks: await page.evaluate(() => Object.fromEntries(performance.getEntriesByType('mark').filter(e => e.name.startsWith('compile:')).map(e => [e.name, Math.round(e.startTime)]))) }));
      await page.locator('.textLayer span').filter({ hasText: 'Native UI fixture.' }).first().waitFor();
      await page.screenshot({ path: join(output, 'compiled-' + label + '.png') });
      await page.getByRole('treeitem', { name: 'main.tex', exact: true }).click();
      await page.evaluate(() => { globalThis.uiClicks = []; document.addEventListener('dblclick', e => uiClicks.push({ target: e.target.className, text: e.target.textContent.slice(0, 80) })); window.addEventListener('synctex:sync-to-position', e => uiClicks.push(e.detail)); });
      const word = page.locator('.textLayer span').filter({ hasText: /Shared chapter/ }).first();
      const position = await word.evaluate(span => { const text = span.firstChild, range = document.createRange(), start = text.textContent.indexOf('chapter'); range.setStart(text, start); range.setEnd(text, start + 7); const a = span.getBoundingClientRect(), b = range.getBoundingClientRect(); return { x: b.x + b.width / 2 - a.x, y: b.y + b.height / 2 - a.y }; });
      await word.dblclick({ position });
      console.log('Inverse click:', await page.evaluate(() => uiClicks));
      await page.waitForFunction(() => document.querySelector('[role="textbox"][aria-label^="Source Editor"]')?.cmView.view.state.doc.toString().startsWith('Shared chapter.'));
      await page.getByRole('treeitem', { name: 'main.tex', exact: true }).click();

      await page.evaluate(async () => {
        const { project, files } = await overleafLocalProjects.read(location.hash.slice(1)), file = files.find(f => f.path === 'main.tex');
        overleafRecovery.save({ schema: 1, account: project.account, project: project.project, workspace: project.id, doc: file.doc, writer: crypto.randomUUID(), revision: file.revision, base: file.base, candidate: file.content + '% Recovery candidate\n', name: file.path, updatedAt: Date.now() });
      });
      await page.getByRole('button', { name: 'Local only options' }).focus(); await page.keyboard.press('Enter'); await page.keyboard.press('ArrowDown');
      assert(await page.getByRole('menuitem', { name: 'Recovery copies', exact: true }).evaluate(node => node === document.activeElement)); await page.keyboard.press('Enter');
      const review = page.getByRole('dialog', { name: 'Review offline recovery copy' }); await review.waitFor();
      assert.equal(await review.locator('h2').evaluate(n => getComputedStyle(n).color), await review.evaluate(n => getComputedStyle(n).color), 'Recovery heading must inherit the readable dialog theme');
      await page.screenshot({ path: join(output, 'recovery-' + label + '.png') }); await review.getByRole('button', { name: 'Close', exact: true }).click();
      const chooser = await context.newPage(); await chooser.goto(base + '/recovery/project-workspace.html'); await chooser.getByRole('heading', { name: 'Saved projects', exact: true }).waitFor();
      await chooser.screenshot({ path: join(output, 'chooser-' + label + '.png') }); await chooser.close();
      await page.evaluate(() => { const original = IDBDatabase.prototype.transaction; IDBDatabase.prototype.transaction = function(...args) { const tx = original.apply(this, args); if (this.name === 'overleaf-local-projects' && args[1] === 'readwrite') queueMicrotask(() => tx.abort()); return tx; }; });
      await editor.evaluate(e => e.cmView.view.dispatch({ changes: { from: 0, insert: '% Unsaved recovery text\n' } }));
      await page.locator('#local-status[data-error=true]').waitFor();
      const unsaved = await editor.evaluate(e => e.cmView.view.state.doc.toString());
      await editor.evaluate(e => e.cmView.view.dispatch({ changes: { from: 0, insert: '% Must be refused\n' } }));
      assert.equal(await editor.evaluate(e => e.cmView.view.state.doc.toString()), unsaved, 'Saving failure pauses further edits');
      assert.equal(await page.getByRole('dialog').count(), 0, 'Export must remain accessible after a failed save');
      assert(!(await page.evaluate(async () => (await overleafLocalProjects.read(location.hash.slice(1))).files.find(f => f.path === 'main.tex').content)).startsWith('% Unsaved recovery text'));
      await page.screenshot({ path: join(output, 'interrupted-' + label + '.png') });
      console.log('Interrupted:', await page.locator('#local-status').textContent(), 'Dialogs:', await page.getByRole('dialog').allTextContents());
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download project (.zip)', exact: true }).click()]);
      await download.saveAs(join(work, 'unsaved.zip'));
      assert(execFileSync('/usr/bin/unzip', ['-p', join(work, 'unsaved.zip'), 'main.tex'], { encoding: 'utf8' }).startsWith('% Unsaved recovery text'));
      console.log('Native UI, disconnected compile and unsaved ZIP export passed:', label);
    } finally { clearTimeout(deadline); await context.close(); }
  }, 2, container);
} finally { rmSync(work, { recursive: true, force: true }); }
