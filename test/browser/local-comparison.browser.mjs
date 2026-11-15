import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = 'http://127.0.0.1:8080';
const previous = process.env.PREVIOUS_RECOVERY_DIR, candidate = process.env.CANDIDATE_RECOVERY_DIR;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
const work = mkdtempSync(join(tmpdir(), 'overleaf-comparison-'));
const account = '111111111111111111111111', project = '222222222222222222222222';
const record = (doc, text, original = text, extra = {}) => ({ schema: 1, account, project, doc,
  writer: '11111111-1111-1111-1111-111111111111', revision: 0, name: 'main.tex',
  base: { version: 7, text: original }, candidate: text, updatedAt: 1, ...extra });
const key = r => 'overleaf.recovery.v1.' + [r.account, r.project, r.doc, r.writer].join('.');
const first = record('333333333333333333333333', 'title\nnew\n\n<script>globalThis.sourceExecuted=true</script>\n', 'title\nold\n');
const second = record('444444444444444444444444', 'other\n', 'other\n', { name: 'part.tex' });
const foreign = record('555555555555555555555555', 'PRIVATE-SCOPE-MARKER', '', { account: '999999999999999999999999' });
const exact = page => page.getByRole('textbox', { name: 'Local source editor', exact: true }).evaluate(e => e.cmView.view.state.doc.toString());
const results = [];
try {
  for (const profile of previous ? ['previous', 'candidate'] : ['installed']) {
    const context = await browser.newContext({ serviceWorkers: profile === 'installed' ? 'allow' : 'block', viewport: { width: 1200, height: 900 } });
    const unexpected = [], writes = [];
    context.on('request', request => { if (request.method() !== 'GET') writes.push(request.method() + ' ' + request.url()); });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) { unexpected.push(url.origin); return route.abort(); }
      const directory = profile === 'previous' ? previous : profile === 'candidate' ? candidate : null;
      const name = url.pathname.replace('/recovery/', '');
      if (directory && url.pathname.startsWith('/recovery/') && readdirSync(directory).includes(name)) {
        return route.fulfill({ body: readFileSync(join(directory, name)), contentType: name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : name.endsWith('.txt') ? 'text/plain' : 'application/javascript' });
      }
      return route.continue();
    });
    await context.addInitScript(({ records }) => {
      if (location.origin !== 'http://127.0.0.1:8080') return;
      for (const [name, value] of records) if (!localStorage.getItem(name)) localStorage.setItem(name, JSON.stringify(value));
    }, { records: [first, second, foreign].map(r => [key(r), r]) });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    await page.goto(base + '/recovery/local-workspace.html#' + encodeURIComponent(key(first)));
    const editor = page.getByRole('textbox', { name: 'Local source editor', exact: true }); await editor.waitFor();
    assert.equal(await exact(page), first.candidate);
    const copiesBefore = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    const samples = await editor.evaluate(e => { const v = e.cmView.view, times = []; for (let i = 0; i < 20; i++) { const start = performance.now(); v.dispatch({ changes: { from: v.state.doc.length, insert: 'x' } }); times.push(performance.now() - start); } return times; });
    for (let i = 0; i < 20; i++) await page.locator('#undo').click();
    assert.equal(await exact(page), first.candidate);
    const startStorage = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    const metrics = { profile, editDispatchMs: samples, comparisonAvailable: await page.locator('#compare').count() === 1 };
    if (profile === 'previous') {
      assert.equal(metrics.comparisonAvailable, false); results.push(metrics); await context.close(); continue;
    }
    await page.getByRole('button', { name: 'Compare changes', exact: true }).click();
    assert.match(await page.locator('#comparison-summary').textContent(), /3 added, 1 removed/);
    assert.match(await page.locator('#changes').textContent(), /- old\n\+ new/);
    assert.match(await page.locator('#changes').textContent(), /<script>/);
    assert.equal(await page.locator('#changes script').count(), 0);
    assert.equal(await page.evaluate(() => !!globalThis.sourceExecuted), false);
    assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage })), startStorage);
    assert.equal(await page.locator('#copies option').count(), 3); // Two original documents and this tab's retained edit.
    assert(!((await page.locator('#copies').textContent()).includes('PRIVATE-SCOPE-MARKER')));
    await page.locator('#copies').selectOption(key(second));
    assert.equal(await page.locator('#comparison').isVisible(), false);
    await page.locator('#compare').click();
    assert.match(await page.locator('#comparison-summary').textContent(), /No changes/);
    const cases = [
      ['line\r\n', 'line\n'], ['last', 'last\n'], ['a\n\nb\n', 'a\nb\n'], ['', 'new'], ['remove', ''], ['old\nkeep\nold\n', 'new\nkeep\nnew\n'],
    ];
    for (const [original, current] of cases) {
      const fixture = record('666666666666666666666666', current, original);
      await page.evaluate(({ fixture }) => overleafRecovery.save(fixture), { fixture });
      await page.goto(base + '/recovery/local-workspace.html#' + encodeURIComponent(key(fixture))); await page.reload(); await editor.waitFor();
      await page.locator('#compare').click();
      const restored = await page.locator('#changes').evaluate(element => {
        const chunks = [...element.children].map(span => ({ kind: span.dataset.change, value: span.textContent.replace(/^[+ -] /gm, '') }));
        return { original: chunks.filter(x => x.kind !== 'added').map(x => x.value).join(''), current: chunks.filter(x => x.kind !== 'removed').map(x => x.value).join('') };
      });
      assert.deepEqual(restored, { original, current });
    }
    await page.goto(base + '/recovery/local-workspace.html#' + encodeURIComponent(key(first))); await page.reload(); await editor.waitFor();
    const comparisonMs = await page.evaluate(() => { const times = []; for (let i = 0; i < 20; i++) { const start = performance.now(); document.querySelector('#compare').click(); times.push(performance.now() - start); } return times; });
    metrics.comparisonMs = comparisonMs;
    await editor.evaluate(e => { const v = e.cmView.view; v.dispatch({ changes: { from: v.state.doc.length, insert: '\nLOCAL-ONLY' } }); });
    await page.waitForFunction(() => document.querySelector('#comparison').hidden);
    await page.locator('#undo').click(); assert.equal(await exact(page), first.candidate);
    await page.evaluate(() => { globalThis.savedDiff = Diff; globalThis.Diff = undefined; });
    await page.locator('#compare').click(); assert.match(await page.locator('#comparison-summary').textContent(), /unavailable/);
    assert.equal(await exact(page), first.candidate);
    await page.evaluate(() => { globalThis.Diff = globalThis.savedDiff; });
    const large = record('777777777777777777777777', 'x'.repeat(500001), 'base');
    await page.evaluate(fixture => overleafRecovery.save(fixture), large);
    await page.goto(base + '/recovery/local-workspace.html#' + encodeURIComponent(key(large))); await page.reload(); await editor.waitFor();
    await page.locator('#compare').click(); assert.match(await page.locator('#comparison-summary').textContent(), /unavailable/);
    assert.equal(await exact(page), large.candidate);
    await page.goto(base + '/recovery/local-workspace.html#' + encodeURIComponent(key(first))); await page.reload(); await editor.waitFor();
    if (profile === 'installed') {
      await page.evaluate(() => overleafRecovery.offlineReady()); await page.reload(); await editor.waitFor();
      await context.setOffline(true); await page.reload(); await editor.waitFor();
      await page.locator('#compare').click(); assert.match(await page.locator('#comparison-summary').textContent(), /3 added, 1 removed/);
      assert.equal(await page.evaluate(async () => (await fetch('/project/' + '222222222222222222222222')).status), 503);
      metrics.offlineRefresh = true;
    }
    const download = page.waitForEvent('download'); await page.locator('#export').click();
    const exported = await download; await exported.saveAs(join(work, 'main.tex'));
    assert.equal(readFileSync(join(work, 'main.tex'), 'utf8'), first.candidate);
    assert.equal(await page.evaluate(name => JSON.parse(localStorage.getItem(name)).candidate, key(foreign)), foreign.candidate);
    assert.deepEqual(unexpected, []); assert.deepEqual(writes, []);
    assert.equal(await exact(page), first.candidate);
    assert(copiesBefore.includes('old'));
    metrics.boundaryCases = cases.length; metrics.noServerWrites = true; results.push(metrics); await context.close();
  }
  console.log(JSON.stringify({ result: 'passed', browser: browser.version(), results }));
} finally { await browser.close(); rmSync(work, { recursive: true, force: true }); }
