// SPDX-License-Identifier: AGPL-3.0-only
// CEX-LAN-01 loopback check: two isolated Chrome profiles, the real native editor, the real relay helper over native messaging.
// Listener: 127.0.0.1 only. Synthetic project only. Not a physical-LAN or two-device result.
//   cargo build --offline --release --manifest-path runtime/chrome-extension/lan/Cargo.toml   (CARGO_TARGET_DIR outside the repo is fine)
//   PLAYWRIGHT_MODULE=<playwright> EXTENSION_CHROME_PATH=<Chrome for Testing> LATEX_EXTENSION_BASE=<built extension dir> \
//   LATEX_LAN_HELPER=<latex-local-lan binary> node test/browser/lan-native.browser.mjs
// LATEX_EXTENSION_BASE supplies the heavy editor assets; this repository's recovery/ and extension/ sources are overlaid on a copy.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repository = resolve(import.meta.dirname, '../..'), base = resolve(process.env.LATEX_EXTENSION_BASE), helper = resolve(process.env.LATEX_LAN_HELPER);
const work = mkdtempSync(join(tmpdir(), 'latex-lan-check-')), extension = join(work, 'extension');
cpSync(base, extension, { recursive: true });
for (const name of readdirSync(join(repository, 'runtime/browser-recovery'))) if (/\.(?:js|mjs|html|css)$/.test(name) && !['apply.mjs', 'provision-offline.mjs', 'recovery-sw.template.js'].includes(name)) cpSync(join(repository, 'runtime/browser-recovery', name), join(extension, 'recovery', name));
for (const name of readdirSync(join(repository, 'runtime/chrome-extension'))) if (/^(lan-.*\.mjs|join\.js|index\.html)$/.test(name)) cpSync(join(repository, 'runtime/chrome-extension', name), join(extension, 'extension', name));
for (const name of ['native-workspace.html', 'project-workspace.html']) { const path = join(extension, 'recovery', name); writeFileSync(path, readFileSync(path, 'utf8').replace('<head>', '<head><script src="/extension/bootstrap.js"></script>')); }
import { assetName, patchEditorUnicode } from '../../runtime/browser-recovery/apply.mjs';
const editorPath = join(extension, 'js', assetName); { // as package.mjs does; the base asset embeds an older recovery-core.js, so carry this repository's LAN guard into it as provisioning would
  const raw = readFileSync(editorPath, 'utf8'), patched = String.raw`/[\0\uD800-\uDFFF]/gu`;
  let editor = raw.includes(patched) ? raw : patchEditorUnicode(raw); // a packaged base (with the compiler) is already patched
  const header = 'function extension(State, Transaction, container, name) {\n    return State.transactionFilter.of(';
  assert.equal(editor.split(header).length - 1, 1, 'base editor asset has an unexpected recovery extension');
  assert(readFileSync(join(repository, 'runtime/browser-recovery/recovery-core.js'), 'utf8').includes('if (globalThis.overleafLanGate) return [];'));
  writeFileSync(editorPath, editor.replace(header, 'function extension(State, Transaction, container, name) {\n    if (globalThis.overleafLanGate) return [];\n    return State.transactionFilter.of('));
}
cpSync(join(repository, 'runtime/participant-compile/worker.js'), join(extension, 'recovery/busytex/busytex_worker.js')); // as package.mjs does
const manifest = JSON.parse(readFileSync(join(repository, 'runtime/chrome-extension/manifest.json'), 'utf8'));
writeFileSync(join(extension, 'manifest.json'), JSON.stringify(manifest));
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
const root = `chrome-extension://${id}`, results = [], note = (name, detail = '') => { results.push(name); console.log('ok -', name, detail); };

async function profile(name, { registerHelper = false } = {}) {
  const dir = join(work, name); mkdirSync(dir);
  if (registerHelper) {
    mkdirSync(join(dir, 'NativeMessagingHosts'));
    writeFileSync(join(dir, 'NativeMessagingHosts', 'com.cenker.latex_lan.json'), JSON.stringify({ name: 'com.cenker.latex_lan', description: 'LAN sharing helper (test)', path: helper, type: 'stdio', allowed_origins: [root + '/'] }));
  }
  const context = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true, executablePath: process.env.EXTENSION_CHROME_PATH, ignoreDefaultArgs: ['--disable-extensions'],
    viewport: { width: 1400, height: 900 }, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
  context.setDefaultTimeout(20000); return context;
}
const editorOf = page => page.getByRole('textbox', { name: /^Source Editor/ });
const docOf = page => editorOf(page).evaluate(node => node.cmView.view.state.doc.toString());
const until = async (check, what, ms = 15000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await check(); if (last) return last; } catch (error) { last = error; } await new Promise(r => setTimeout(r, 50)); } throw Error('Timed out: ' + what + (last instanceof Error ? ' (' + last.message + ')' : '')); };
const insert = (page, at, text) => editorOf(page).evaluate((node, [position, value]) => { const view = node.cmView.view; view.dispatch({ changes: { from: position === 'end' ? view.state.doc.length : position, insert: value }, selection: { anchor: (position === 'end' ? view.state.doc.length : position) + value.length } }); }, [at, text]);
const cleanup = async (...contexts) => { for (const context of contexts) await context?.close().catch(() => {}); if (process.env.LAN_KEEP_EXTENSION) console.log('kept', extension); else rmSync(work, { recursive: true, force: true }); };

let ownerContext, guestContext; const errors = [];
try {
  ownerContext = await profile('owner', { registerHelper: true }); guestContext = await profile('guest');
  const guestLogs = []; // every console line of the participant profile, pages and workers (the compiler runs in a worker)
  guestContext.on('console', m => guestLogs.push(m.text())); if (process.env.LAN_DEBUG) guestContext.on('requestfailed', r => guestLogs.push('failed ' + r.url().slice(0, 160))); if (process.env.LAN_DEBUG) guestContext.on('response', r => { if (r.status() >= 400) guestLogs.push(r.status() + ' ' + r.url().slice(0, 160)); }); guestContext.on('page', p => p.on('worker', w => w.on('console', m => guestLogs.push(m.text()))));
  const owner = await ownerContext.newPage(); owner.on('pageerror', error => errors.push('owner: ' + error.message.slice(0, 200)));
  if (process.env.LAN_DEBUG) { owner.on('console', m => console.log('[owner console]', m.text().slice(0, 300))); owner.on('requestfailed', r => console.log('[owner failed]', r.url().slice(0, 120))); }
  await owner.goto(root + '/extension/index.html');
  await owner.getByRole('link', { name: 'Work offline', exact: true }).click();
  await owner.getByRole('textbox', { name: 'New local project name', exact: true }).fill('Synthetic shared project');
  await owner.getByRole('button', { name: 'Create local project', exact: true }).click();
  await editorOf(owner).waitFor({ timeout: 60000 });
  const projectUrl = owner.url();
  assert((await docOf(owner)).includes('Hello world.'));
  // ---- Share on this network
  await owner.getByRole('button', { name: 'Share on this network' }).click();
  const panel = owner.getByRole('dialog', { name: 'Share on this network' });
  await until(async () => (await panel.locator('code').nth(0).textContent()).trim() || /./.test(await owner.locator('#local-status').textContent()), 'share link or error');
  assert.equal(await panel.count(), 1, await owner.locator('#local-status').textContent());
  const link = (await panel.locator('code').nth(0).textContent()).trim(), passcode = (await panel.locator('code').nth(1).textContent()).trim();
  assert.match(link, /^chrome-extension:\/\/[a-p]{32}\/extension\/index\.html#join=127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{22}$/); assert.doesNotMatch(link, new RegExp(passcode.replaceAll('-', '').slice(0, 8)));
  note('owner shares on loopback: link without passcode, separate passcode', link.replace(/\/[A-Za-z0-9_-]{22}$/, '/<room>'));
  // ---- wrong passcode is refused, in the participant's isolated profile
  const bad = await guestContext.newPage(); await bad.goto(link);
  await bad.getByLabel('Passcode').fill('AAAA-AAAA-AAAA-AAAA'); await bad.getByLabel('Your name for this session').fill('Mallory'); await bad.getByRole('button', { name: 'Join' }).click();
  await until(async () => /Room unavailable|passcode/i.test(await bad.locator('.lan-panel [role=status]').textContent()), 'wrong passcode refused');
  assert.equal(await editorOf(bad).count(), 0); await bad.close(); note('wrong passcode refused; no project reaches the page');
  // ---- join with the right code
  const guest = await guestContext.newPage(); guest.on('pageerror', error => { errors.push('guest: ' + error.message.slice(0, 200)); if (process.env.LAN_DEBUG) console.log('[guest pageerror]', error.stack.slice(0, 600)); });
  if (process.env.LAN_DEBUG) guest.on('console', m => { if (!/BusyTeX/.test(m.text())) console.log('[guest console]', m.text().slice(0, 300)); });
  await guest.goto(link);
  await guest.getByLabel('Passcode').fill(passcode); await guest.getByLabel('Your name for this session').fill('Zoë 😀'); await guest.getByRole('button', { name: 'Join' }).click();
  await editorOf(guest).waitFor({ timeout: 60000 });
  await until(async () => (await docOf(guest)).includes('Hello world.'), 'guest has the owner text');
  await until(async () => (await panel.textContent()).includes('Zoë 😀'), 'owner lists the participant by session name');
  note('guest joins with link+passcode+session name; owner sees the name');
  // ---- concurrent edits, supplementary Unicode, same position
  await Promise.all([insert(owner, 0, 'OWNER 😀 Türkçe\n'), insert(guest, 0, 'GUEST 𝔛 ж\n')]);
  await insert(owner, 'end', '% owner tail ß\n'); await insert(guest, 'end', '% guest tail 🎉\n');
  const converged = async () => { const [a, b] = [await docOf(owner), await docOf(guest)]; return a === b && /OWNER 😀 Türkçe/.test(a) && /GUEST 𝔛 ж/.test(a) && a.includes('% owner tail ß') && a.includes('% guest tail 🎉') ? a : false; };
  const merged = await until(converged, 'converged text').catch(async error => { console.log('OWNER:', JSON.stringify(await docOf(owner))); console.log('GUEST:', JSON.stringify(await docOf(guest)));  throw error; }); assert(merged.isWellFormed());
  // keyboard typing in both editors at once, then undo on the guest only removes the guest's own last change
  await Promise.all([editorOf(owner).click(), editorOf(guest).click()]);
  await Promise.all([owner.keyboard.insertText('O-typed 🙂'), guest.keyboard.insertText('G-typed 🙃')]);
  await until(async () => { const [a, b] = [await docOf(owner), await docOf(guest)]; return a === b && a.includes('O-typed 🙂') && a.includes('G-typed 🙃'); }, 'typed text converged');
  note('concurrent edits converge incl. supplementary characters (owner == guest)');
  await guest.keyboard.press('ControlOrMeta+z');
  await until(async () => { const [a, b] = [await docOf(owner), await docOf(guest)]; return a === b && !a.includes('G-typed 🙃') && a.includes('O-typed 🙂') && a.includes('OWNER 😀 Türkçe'); }, 'guest undo converged and kept the owner text');
  note('undo on one side converges on both, owner text kept');
  // ---- carets: each side shows the other's named caret
  // The peer's caret is drawn at the position the peer reported: select offset 10 on one side, find the highlight at that offset on the other,
  // then hover it for the label that carries the session name.
  const select = (page, pos) => editorOf(page).evaluate((node, at) => node.cmView.view.dispatch({ selection: { anchor: at } }), pos);
  const caretAt = (page, pos) => editorOf(page).evaluate((node, at) => { const c = node.cmView.view.coordsAtPos(at), h = [...document.querySelectorAll('.ol-cm-cursorHighlight')].map(e => e.getBoundingClientRect()); const hit = h.find(r => Math.abs(r.left - c.left) < 3 && r.top < c.bottom && r.bottom > c.top); return hit ? { x: hit.left + 1, y: (hit.top + hit.bottom) / 2 } : null; }, pos);
  for (const [from, to, name, pos] of [[owner, guest, 'Owner', 10], [guest, owner, 'Zoë 😀', 25]]) {
    await select(from, pos); const spot = await until(() => caretAt(to, pos), `${name} caret drawn at offset ${pos}`);
    await to.mouse.move(spot.x, spot.y); await until(async () => (await to.locator('.ol-cm-cursorHighlightLabel').allTextContents()).some(t => t.includes(name)), `caret label shows ${name}`);
  }
  note('carets: each side draws the other\'s caret at its offset, labelled with its session name');
  // ---- the owner's saved project already holds the merged text (reload from IndexedDB)
  await owner.waitForTimeout(500); const ownerText = await docOf(owner);
  const copy = await ownerContext.newPage(); await copy.goto(projectUrl); await editorOf(copy).waitFor({ timeout: 60000 });
  await until(async () => (await docOf(copy)) === ownerText, 'reloaded owner copy equals the shared text'); await copy.close();
  note('owner reload shows the exact merged text (persisted on the owner device)');
  // ---- host loss: closing the owner page stops the helper; the guest is locked; the owner's data stays
  await owner.close();
  await until(async () => /stopped|unreachable|failed|removed/i.test(await guest.locator('[role=alert]').textContent()), 'guest locked after host loss');
  note('host loss locks the participant with an explicit message');
  const again = await ownerContext.newPage(); await again.goto(projectUrl); await editorOf(again).waitFor({ timeout: 60000 });
  assert.equal(await docOf(again), ownerText); note('owner data intact after host loss');
  // ---- rejoin: new room, new passcode; the old code no longer works; the participant gets the owner's current text
  await again.getByRole('button', { name: 'Share on this network' }).click();
  const panel2 = again.getByRole('dialog', { name: 'Share on this network' });
  await until(async () => (await panel2.locator('code').nth(0).textContent()).trim(), 'second share link');
  const link2 = (await panel2.locator('code').nth(0).textContent()).trim(), passcode2 = (await panel2.locator('code').nth(1).textContent()).trim();
  assert.notEqual(passcode2, passcode); assert.notEqual(link2, link);
  const old = await guestContext.newPage(); await old.goto(link2); await old.getByLabel('Passcode').fill(passcode); await old.getByLabel('Your name for this session').fill('Zoë 😀'); await old.getByRole('button', { name: 'Join' }).click();
  await until(async () => /Room unavailable|passcode/i.test(await old.locator('.lan-panel [role=status]').textContent()), 'old passcode refused'); await old.close();
  const rejoin = await guestContext.newPage(); await rejoin.goto(link2); await rejoin.getByLabel('Passcode').fill(passcode2); await rejoin.getByLabel('Your name for this session').fill('Zoë 😀'); await rejoin.getByRole('button', { name: 'Join' }).click();
  await editorOf(rejoin).waitFor({ timeout: 60000 }); await until(async () => (await docOf(rejoin)) === ownerText, 'rejoined participant has the owner text');
  await insert(rejoin, 'end', '% after rejoin\n'); await until(async () => (await docOf(again)).includes('% after rejoin'), 'edit after rejoin reaches the owner');
  note('rejoin with a new room code: old code refused, shared text current, edits flow');
  // ---- S2-04 owner permissions: restricted by default, owner grants a copy, downgrade stops new copies, enforcement without the UI
  const copyIds = ['#local-zip', '#local-pdf', '#local-export', '#local-savecopy'], states = page => page.evaluate(ids => ids.map(id => document.querySelector(id).disabled), copyIds);
  const permission = panel2.getByLabel('Permission for Zoë 😀');
  assert.equal(await permission.inputValue(), 'online'); assert.deepEqual(await states(rejoin), [true, true, true, true]);
  note('owner lists the participant with "Edit while host is online" (default); participant copy/export/download/save controls are disabled');
  const scan = (page, markers) => page.evaluate(async markers => { // every browser store of the extension origin, searched for restricted text
    const hit = value => markers.some(marker => value.includes(marker)), text = value => JSON.stringify(value, (_, x) => ArrayBuffer.isView(x) ? new TextDecoder().decode(x) : x) ?? '';
    const out = { projects: 0, idbHits: 0, local: 0, session: 0, cacheEntries: 0, cacheHits: 0 };
    for (const { name } of await indexedDB.databases()) {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = reject; });
      for (const store of db.objectStoreNames) {
        const all = await new Promise(resolve => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => resolve(q.result); });
        if (name === 'overleaf-local-projects' && store === 'projects') out.projects = all.length;
        out.idbHits += all.filter(value => hit(text(value))).length;
      }
      db.close();
    }
    out.local = Object.entries(localStorage).filter(entry => hit(entry.join(' '))).length; out.session = Object.entries(sessionStorage).filter(entry => hit(entry.join(' '))).length;
    for (const name of await caches.keys()) { const cache = await caches.open(name); for (const request of await cache.keys()) { out.cacheEntries++; const body = await (await cache.match(request)).blob(); if (hit(request.url) || (body.size < 8e6 && hit(await body.text()))) out.cacheHits++; } }
    return out;
  }, markers);
  // restricted edit + in-memory compile; \typeout puts the marker on TeX's stdout, which must not reach the console
  const restricted = '\\documentclass{article}\n\\begin{document}\nRestricted RSECRETA text.\\typeout{RSECRETA-stdout}\n\\end{document}\n';
  await editorOf(rejoin).evaluate((node, text) => { const view = node.cmView.view; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }); }, restricted);
  await until(async () => (await docOf(again)) === restricted, 'restricted edit reaches the owner');
  await rejoin.getByRole('button', { name: 'Recompile', exact: true }).click();
  await rejoin.locator('.textLayer span').filter({ hasText: 'RSECRETA' }).first().waitFor({ timeout: 120000 })
    .catch(async error => { console.log('participant status:', await rejoin.locator('#local-status').textContent()); if (process.env.LAN_DEBUG) console.log('GUESTLOG', guestLogs.filter(l => !/RSECRET/.test(l)).slice(-15).join('\n')); throw error; });
  note('restricted participant compiles locally and sees the PDF (output kept in session memory)');
  const devtools = await rejoin.evaluate(async () => { const t = await (await fetch('/extension/native-template.json')).json(); return globalThis.overleafLocalProjects.local(t, 'Devtools copy', [{ path: 'main.tex', content: 'RSECRETA' }], 'main.tex').then(() => 'saved', e => e.message); });
  assert.match(devtools, /not allowed/); const downloads = []; rejoin.on('download', d => downloads.push(d.suggestedFilename()));
  await rejoin.evaluate(ids => { for (const id of ids) document.querySelector(id).disabled = false; }, copyIds); // a participant who re-enables the controls
  for (const id of ['#local-zip', '#local-pdf']) { await rejoin.locator(id).click(); await until(async () => /not allowed/.test(await rejoin.locator('#local-status').textContent()), id + ' refused'); await rejoin.locator('#local-status').evaluate(n => { n.textContent = ''; }); }
  for (const id of ['#local-export', '#local-savecopy']) { await rejoin.evaluate(sel => document.querySelector(sel).click(), id); await until(async () => /not allowed/.test(await rejoin.locator('#local-status').textContent()), id + ' refused'); await rejoin.locator('#local-status').evaluate(n => { n.textContent = ''; }); }
  await rejoin.waitForTimeout(300); assert.deepEqual(downloads, []);
  const fresh = await guestContext.newPage(); await fresh.goto(root + '/extension/index.html'); // a reload's view: a new page of the same profile
  const restrictedScan = await scan(fresh, ['RSECRETA']); await fresh.close();
  assert.deepEqual({ ...restrictedScan, cacheEntries: undefined }, { projects: 0, idbHits: 0, local: 0, session: 0, cacheEntries: undefined, cacheHits: 0 }, JSON.stringify(restrictedScan));
  assert(!guestLogs.some(line => line.includes('RSECRETA')), 'restricted text in the participant console');
  note('restricted: devtools save, re-enabled buttons and direct clicks are refused; no download; nothing in IndexedDB/localStorage/sessionStorage/CacheStorage/console, read from a freshly loaded page', JSON.stringify(restrictedScan));
  // grant: explicit copies work
  await permission.selectOption('copy'); await until(async () => (await states(rejoin)).every(disabled => !disabled), 'controls enabled after the copy grant');
  await rejoin.locator('#local-zip').click(); await until(() => downloads.some(name => name.endsWith('.zip')), 'ZIP download');
  await rejoin.locator('#local-pdf').click(); await until(() => downloads.includes('output.pdf'), 'PDF download');
  await rejoin.evaluate(() => document.querySelector('#local-savecopy').click()); await until(async () => /standalone copy was saved/.test(await rejoin.locator('#local-status').textContent()), 'standalone copy saved');
  assert.equal((await scan(rejoin, [])).projects, 1); note('owner grants "Keep a copy": ZIP, PDF download and a standalone saved copy work', downloads.join(','));
  // downgrade: new copies stop, the earlier copy is not recalled
  await permission.selectOption('online'); await until(async () => (await states(rejoin)).every(Boolean), 'controls disabled after the downgrade');
  await rejoin.evaluate(ids => { for (const id of ids) document.querySelector(id).disabled = false; }, copyIds);
  const before = downloads.length; await rejoin.locator('#local-zip').click(); await until(async () => /not allowed/.test(await rejoin.locator('#local-status').textContent()), 'zip refused after downgrade');
  await rejoin.evaluate(() => document.querySelector('#local-savecopy').click()); await rejoin.waitForTimeout(500); assert.equal(downloads.length, before);
  await insert(rejoin, 0, '% RSECRETB after downgrade\n'); await until(async () => (await docOf(again)).includes('RSECRETB'), 'post-downgrade edit reaches the owner');
  assert.equal((await scan(rejoin, [])).projects, 1); note('downgrade disables copies and the owner refuses them; the earlier copy remains');
  // ---- stop sharing revokes
  await panel2.getByRole('button', { name: 'Stop sharing' }).click();
  await until(async () => /stopped/i.test(await rejoin.locator('[role=alert]').textContent()), 'participant removed on stop'); note('stop sharing ends the participant session');
  for (const id of ['#local-savecopy', '#local-zip']) { await rejoin.evaluate(sel => { const node = document.querySelector(sel); node.disabled = false; node.click(); }, id); await until(async () => /ended|not allowed/.test(await rejoin.locator('#local-status').textContent()), id + ' refused after revoke'); await rejoin.locator('#local-status').evaluate(n => { n.textContent = ''; }); }
  note('revoked session: save-copy and export are refused');
  // ---- the participant device kept no project and no source text in browser storage
  const probe = await guestContext.newPage(); await probe.goto(root + '/extension/index.html');
  const stored = await probe.evaluate(async () => {
    const projects = await new Promise(resolve => { const r = indexedDB.open('overleaf-local-projects'); r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains('projects')) { db.close(); resolve(0); return; } const c = db.transaction('projects').objectStore('projects').count(); c.onsuccess = () => { db.close(); resolve(c.result); }; }; r.onerror = () => resolve(-1); });
    const local = Object.entries(localStorage).filter(([, v]) => /Hello world|OWNER|Türkçe|after rejoin|RSECRET/.test(v)).length;
    return { projects, local };
  });
  assert.deepEqual(stored, { projects: 1, local: 0 }); note('participant profile: only the explicitly permitted copy is saved, no source text in localStorage', JSON.stringify(stored));
  const final = await scan(probe, ['RSECRETB']); assert.deepEqual([final.idbHits, final.cacheHits], [0, 0], JSON.stringify(final));
  assert(!guestLogs.some(line => /RSECRET/.test(line)), 'restricted text in the participant console'); note('text typed after the downgrade is in no browser store or console');
  // the permitted copy is an independent project: it opens and saves with the network off and no session
  await guestContext.setOffline(true);
  const copyId = await probe.evaluate(() => new Promise(resolve => { const r = indexedDB.open('overleaf-local-projects'); r.onsuccess = () => { const q = r.result.transaction('projects').objectStore('projects').getAll(); q.onsuccess = () => { r.result.close(); resolve(q.result[0].id); }; }; }));
  await probe.goto(root + '/recovery/native-workspace.html#' + copyId); await editorOf(probe).waitFor({ timeout: 60000 });
  await until(async () => (await docOf(probe)).includes('Restricted RSECRETA text.'), 'saved copy holds the shared text');
  await insert(probe, 0, '% offline edit\n'); await until(async () => /Saved in this browser/.test(await probe.locator('#local-status').textContent()), 'offline edit saved');
  await probe.reload(); await editorOf(probe).waitFor({ timeout: 60000 }); await until(async () => (await docOf(probe)).startsWith('% offline edit\n'), 'offline edit kept after reload');
  note('permitted copy reopens offline, is edited and keeps the edit across a reload');
  assert.deepEqual(errors, [], 'page errors');
  console.log(`PASS ${results.length} checks (loopback only; no physical LAN)`);
} finally { await cleanup(ownerContext, guestContext); }
