import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.OVERLEAF_TEST_BASE || 'http://127.0.0.1:8080';
const work = mkdtempSync(join(tmpdir(), 'live-cursor-'));
const name = 'Live collaboration demo ' + Date.now();
const source = '\\documentclass{article}\n\\begin{document}\nAlice can edit this line.\n\nBob can edit this line.\n\nBoth people can type together.\n\\end{document}\n';
writeFileSync(join(work, 'main.tex'), source); execFileSync('/usr/bin/zip', ['-q', join(work, name + '.zip'), 'main.tex'], { cwd: work });
const markers = { alice: 'AliceTest' + Date.now() + ' ', bob: 'BobTest' + Date.now() + ' ' };
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
const editor = p => p.getByRole('textbox', { name: /^Source Editor/ });
const text = p => editor(p).evaluate(e => e.cmView.view.state.doc.toString());
async function account(email, password) {
  const c = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
  await c.route('**/*', r => new URL(r.request().url()).origin === base ? r.continue() : r.abort());
  const p = await c.newPage(); p.setDefaultTimeout(20000); await p.goto(base + '/login');
  await p.locator('input[name=email]').fill(email); await p.locator('input[name=password]').fill(password);
  const start = performance.now(); await p.getByRole('button', { name: /^Login/ }).click(); await p.waitForURL(base + '/project');
  return { page: p, loginMs: performance.now() - start };
}
async function caret(p, word, offset = 0) {
  await editor(p).evaluate((e, { word, offset }) => { const v = e.cmView.view, at = v.state.doc.toString().indexOf(word); if (at < 0) throw Error('Anchor unavailable'); v.dispatch({ selection: { anchor: at + offset }, scrollIntoView: true }); v.focus(); }, { word, offset });
}
try {
  const alice = await account('alice@example.test', process.env.OVERLEAF_TEST_ALICE_PASSWORD);
  const bob = await account('bob@example.test', process.env.OVERLEAF_TEST_BOB_PASSWORD);
  const a = alice.page, b = bob.page;
  let projectUrl = process.env.OVERLEAF_TEST_PROJECT_URL;
  if (!projectUrl) {
    await a.getByRole('button', { name: 'New project', exact: true }).click(); await a.getByText('Existing project (.zip)', { exact: true }).click();
    await a.locator('input[type=file]').first().setInputFiles(join(work, name + '.zip')); await a.waitForURL(/\/project\/[a-f0-9]+/); projectUrl = a.url();
    console.log(JSON.stringify({ retainedDemoProject: projectUrl })); await editor(a).waitFor();
    await a.getByRole('button', { name: /Share/ }).click(); const dialog = a.getByRole('dialog');
    await dialog.locator('input[type=email]').fill('bob@example.test'); await dialog.getByRole('button', { name: 'Invite', exact: true }).click();
    await dialog.getByText('bob@example.test', { exact: true }).waitFor(); await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
    await b.reload(); const invite = b.getByRole('alert').filter({ hasText: name });
    await invite.getByRole('button', { name: 'Join Project', exact: true }).click(); await invite.getByText('Open Project', { exact: true }).click();
  } else { await a.goto(projectUrl); await b.goto(projectUrl); }
  await b.waitForURL(projectUrl); await editor(a).waitFor(); await editor(b).waitFor();
  await caret(a, 'Alice', 2); await caret(b, 'Bob', 2);
  await a.locator('.ol-cm-cursorHighlight').first().waitFor(); await b.locator('.ol-cm-cursorHighlight').first().waitFor();
  const before = await a.locator('.ol-cm-cursorHighlight').first().boundingBox();
  await caret(b, 'Bob', 12);
  await a.waitForFunction(old => { const box = document.querySelector('.ol-cm-cursorHighlight')?.getBoundingClientRect(); return box && Math.abs(box.x - old.x) > 3; }, before);
  const after = await a.locator('.ol-cm-cursorHighlight').first().boundingBox();
  await a.mouse.move(after.x + 1, after.y + after.height / 2); await a.waitForTimeout(300);
  const label = await a.locator('.ol-cm-cursorHighlightLabel').allTextContents();
  const caretMs = [];
  for (const offset of [13,14,15,16,17]) {
    const previous = await a.locator('.ol-cm-cursorHighlight').first().boundingBox(); const start = performance.now();
    await caret(b, 'Bob', offset);
    await a.waitForFunction(old => { const p = document.querySelector('.ol-cm-cursorHighlight')?.getBoundingClientRect(); return p && Math.abs(p.x-old.x)>3; }, previous);
    caretMs.push(performance.now()-start);
  }
  if (process.env.CARET_ONLY) {
    const beforeText = await text(a);
    await caret(b, 'Both people', 1); await a.waitForTimeout(100);
    await a.evaluate(() => {
      globalThis.caretChanges = []; globalThis.caretStart = performance.now();
      let previous = document.querySelector('.ol-cm-cursorHighlight')?.getBoundingClientRect().x;
      globalThis.caretObserver = new MutationObserver(() => { const x = document.querySelector('.ol-cm-cursorHighlight')?.getBoundingClientRect().x; if (x !== previous) { caretChanges.push(performance.now()); previous = x; } });
      caretObserver.observe(document.querySelector('.ol-cm-cursorHighlightsLayer'), { attributes: true, childList: true, subtree: true });
    });
    for (let i=0;i<12;i++) { await b.keyboard.press('ArrowRight'); await new Promise(resolve=>setTimeout(resolve,20)); }
    const stream = await a.evaluate(() => { caretObserver.disconnect(); return { updates: caretChanges.length, firstMs: caretChanges[0]-caretStart, durationMs: performance.now()-caretStart }; });
    assert(stream.updates >= 3 && stream.firstMs < stream.durationMs, 'Caret must arrive during continuous movement');
    const head = await editor(b).evaluate(e => e.cmView.view.state.selection.main.head);
    await a.waitForFunction(pos => { const v=document.querySelector('[aria-label^="Source Editor"]')?.cmView.view, mark=document.querySelector('.ol-cm-cursorHighlight')?.getBoundingClientRect(), expected=v?.coordsAtPos(pos);return mark&&expected&&Math.abs(mark.left-expected.left)<3; },head);
    assert.equal(await text(a), beforeText); assert.equal(await text(b), beforeText);
    console.log(JSON.stringify({passed:true,base,projectUrl,loginMs:{alice:alice.loginMs,bob:bob.loginMs},caretMs,stream,exactFinalCaret:true,sourceUnchanged:true}));
  } else {
  await caret(a, 'Alice', 0); await caret(b, 'Bob', 0);
  const started = performance.now(); await Promise.all([a.keyboard.type(markers.alice), b.keyboard.type(markers.bob)]);
  for (const p of [a,b]) await p.waitForFunction(m => { const t=document.querySelector('[aria-label^="Source Editor"]')?.cmView.view.state.doc.toString();return t?.includes(m.alice)&&t.includes(m.bob); }, markers);
  assert.equal(await text(a), await text(b)); const convergenceMs = performance.now() - started;
  const remoteHead = await editor(b).evaluate(e => e.cmView.view.state.selection.main.head);
  await a.waitForFunction(pos => { const v=document.querySelector('[aria-label^="Source Editor"]')?.cmView.view, b=document.querySelector('.ol-cm-cursorHighlight')?.getBoundingClientRect(), expected=v?.coordsAtPos(pos); return b && expected && Math.abs(b.left-expected.left)<3; }, remoteHead);
  await b.reload(); await editor(b).waitFor(); await b.waitForFunction(expected => document.querySelector('[aria-label^="Source Editor"]')?.cmView.view.state.doc.toString() === expected, await text(a));
  await editor(a).evaluate((e, clean) => { const v = e.cmView.view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: clean } }); }, source);
  await b.waitForFunction(expected => document.querySelector('[aria-label^="Source Editor"]')?.cmView.view.state.doc.toString() === expected, source);
  console.log(JSON.stringify({ passed: true, projectUrl, loginMs: { alice: alice.loginMs, bob: bob.loginMs }, visibleCaretsBothDirections: true, remoteCaretMoved: true, caretMs, labels: label, concurrentTextConverged: true, convergenceMs, reloadExact: true, base }));
  }
} finally { await browser.close(); rmSync(work, { recursive: true, force: true }); }
