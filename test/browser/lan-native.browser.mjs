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
  let editor = readFileSync(editorPath, 'utf8'); if (!editor.includes(String.raw`/[\0\uD800-\uDFFF]/gu`)) editor = patchEditorUnicode(editor); // a packaged base is already patched
  const header = 'function extension(State, Transaction, container, name) {\n    return State.transactionFilter.of(';
  assert.equal(editor.split(header).length - 1, 1, 'base editor asset has an unexpected recovery extension');
  assert(readFileSync(join(repository, 'runtime/browser-recovery/recovery-core.js'), 'utf8').includes('if (globalThis.overleafLanGate) return [];'));
  writeFileSync(editorPath, editor.replace(header, 'function extension(State, Transaction, container, name) {\n    if (globalThis.overleafLanGate) return [];\n    return State.transactionFilter.of('));
}
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


// ---- S2-03 helpers: everything goes through the page's own project fetch (the same routes the native file tree uses)
const noise = (length, seed) => { const out = Buffer.alloc(length); let x = seed >>> 0; for (let i = 0; i < length; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; out[i] = x >>> 24; } return out; };
const sha = bytes => createHash('sha256').update(bytes).digest('hex') + ':' + bytes.length;
const call = (page, path, method = 'POST', body) => page.evaluate(async ([path, method, body]) => { const id = document.querySelector('meta[name="ol-project_id"]').content;
  const r = await fetch(`/project/${id}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return r.status + ' ' + await r.text(); }, [path, method, body]);
const upload = (page, path, bytes) => page.evaluate(async ([path, data]) => { const id = document.querySelector('meta[name="ol-project_id"]').content, name = path.split('/').pop();
  const form = new FormData(); form.append('qqfile', new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], name)); form.append('relativePath', path); form.append('name', name);
  const r = await fetch(`/project/${id}/upload`, { method: 'POST', body: form }); return r.status + ' ' + await r.text(); }, [path, bytes.toString('base64')]);
/** path -> sha256:length of every project file, read back through the page's history snapshot and blob routes. */
const digests = page => page.evaluate(async () => { const id = document.querySelector('meta[name="ol-project_id"]').content, out = {};
  const { chunk } = await (await fetch(`/project/${id}/latest/history`)).json();
  for (const [path, file] of Object.entries(chunk.history.snapshot.files)) {
    const bytes = typeof file.content === 'string' ? new TextEncoder().encode(file.content) : new Uint8Array(await (await fetch(`/project/${id}/blob/${file.hash}`)).arrayBuffer());
    out[path] = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('') + ':' + bytes.length;
  }
  return out; });
const entityId = (page, name) => page.evaluate(name => document.querySelector(`li[role=treeitem][aria-label="${CSS.escape(name)}"] [data-file-id]`)?.dataset.fileId, name);
const inTree = (page, name) => page.locator(`li[role=treeitem][aria-label="${name}"]`).count();
let ownerContext, guestContext; const errors = [];
try {
  ownerContext = await profile('owner', { registerHelper: true }); guestContext = await profile('guest');
  const owner = await ownerContext.newPage(); owner.on('pageerror', error => errors.push('owner: ' + error.message.slice(0, 200)));
  if (process.env.LAN_DEBUG) { owner.on('console', m => console.log('[owner console]', m.text().slice(0, 300))); owner.on('requestfailed', r => console.log('[owner failed]', r.url().slice(0, 120))); }
  await owner.goto(root + '/extension/index.html');
  await owner.getByRole('link', { name: 'Work offline', exact: true }).click();
  await owner.getByRole('textbox', { name: 'New local project name', exact: true }).fill('Synthetic shared project');
  await owner.getByRole('button', { name: 'Create local project', exact: true }).click();
  await editorOf(owner).waitFor({ timeout: 60000 });
  const projectUrl = owner.url();
  assert((await docOf(owner)).includes('Hello world.'));
  // Paths stay in the BMP: the native editor's history model refuses surrogates in path names (BadPathnameError); content carries supplementary characters.
  // ---- S2-03 fixture: nested Unicode folders, a CRLF/supplementary text file, a multi-chunk binary and a PDF (all synthetic)
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1'), noise(420_000, 9), Buffer.from('\n%%EOF\n')]);
  const fixture = { 'figures/Ünï ğ/plot.bin': noise(900_000, 3), 'out/paper.pdf': pdf, 'notes Ω.tex': Buffer.from('Bölüm 𝔛 😀\r\nikinci satır\r\n') };
  for (const [path, bytes] of Object.entries(fixture)) assert.match(await upload(owner, path, bytes), /^200 /, path);
  const ownerFiles = await digests(owner);
  for (const [path, bytes] of Object.entries(fixture)) assert.equal(ownerFiles[path], sha(bytes), path);
  const projectBytes = Object.values(ownerFiles).reduce((n, d) => n + Number(d.split(':')[1]), 0);
  // ---- Share on this network
  await owner.getByRole('button', { name: 'Share on this network' }).click();
  const panel = owner.getByRole('dialog', { name: 'Share on this network' });
  await until(async () => (await panel.locator('code').nth(0).textContent()).trim() || (await owner.locator('#local-status').getAttribute('data-error')) === 'true', 'share link or error');
  assert.equal(await panel.count(), 1, await owner.locator('#local-status').textContent());
  const link = (await panel.locator('code').nth(0).textContent()).trim(), passcode = (await panel.locator('code').nth(1).textContent()).trim();
  assert.match(link, /^chrome-extension:\/\/[a-p]{32}\/extension\/index\.html#join=127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{22}$/, await owner.locator('#local-status').textContent()); assert.doesNotMatch(link, new RegExp(passcode.replaceAll('-', '').slice(0, 8)));
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
  await guest.getByLabel('Passcode').fill(passcode); await guest.getByLabel('Your name for this session').fill('Zoë 😀');
  const joinStart = performance.now(); await guest.getByRole('button', { name: 'Join' }).click();
  await editorOf(guest).waitFor({ timeout: 60000 }); const joinMs = performance.now() - joinStart;
  await until(async () => (await docOf(guest)).includes('Hello world.'), 'guest has the owner text');
  await until(async () => (await panel.textContent()).includes('Zoë 😀'), 'owner lists the participant by session name');
  note('guest joins with link+passcode+session name; owner sees the name');
  assert.deepEqual(await digests(guest), ownerFiles, 'participant files equal the owner files byte for byte');
  note('S2-03 join transfers the project exactly (nested Unicode folders, CRLF text, multi-chunk binary, PDF)', `${Object.keys(ownerFiles).length} files, ${projectBytes} bytes, join->editor ${joinMs.toFixed(0)} ms`);
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
  // ---- S2-03 live file-tree changes in both directions, each one ordered by the owner
  const same = async what => { const want = await until(async () => { const [a, b] = [await digests(owner), await digests(guest)]; const differ = Object.keys({ ...a, ...b }).filter(k => a[k] !== b[k]); if (!differ.length) return a; throw Error(JSON.stringify(differ.map(k => [k, a[k], b[k]]))); }, what); return want; };
  const png = noise(700_000, 33);
  const treeStart = performance.now(); assert.match(await upload(guest, 'guest ж.png', png), /^200 /);
  let now = await same('participant upload reaches the owner'); assert.equal(now['guest ж.png'], sha(png));
  await until(() => inTree(owner, 'guest ж.png'), 'owner tree shows the upload'); const uploadMs = performance.now() - treeStart;
  await owner.getByRole('button', { name: 'New folder' }).click(); await owner.getByRole('dialog').getByRole('textbox').fill('chapters ß');
  await owner.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await until(() => inTree(guest, 'chapters ß'), 'owner folder reaches the participant tree');
  assert.match(await call(guest, `/file/${await entityId(guest, 'guest ж.png')}/move`, 'POST', { folder_id: await entityId(guest, 'chapters ß') }), /^204/);
  now = await same('participant move reaches the owner'); assert.equal(now['chapters ß/guest ж.png'], sha(png)); assert.equal(now['guest ж.png'], undefined);
  await until(async () => !(await inTree(owner, 'guest ж.png')), 'owner tree moved the file');
  assert.match(await call(owner, `/doc/${await entityId(owner, 'notes Ω.tex')}/rename`, 'POST', { name: 'notları Ω.tex' }), /^204/);
  now = await same('owner rename reaches the participant'); assert.equal(now['notları Ω.tex'], ownerFiles['notes Ω.tex']);
  await until(() => inTree(guest, 'notları Ω.tex'), 'participant tree shows the new name');
  assert.match(await call(guest, '/settings', 'POST', { rootDocId: await entityId(guest, 'notları Ω.tex') }), /^204/);   // set-main from the participant
  assert.match(await call(guest, `/doc/${await entityId(guest, 'notları Ω.tex')}`, 'DELETE'), /^409 .*main document/);   // the owner now guards the new main
  assert.match(await call(owner, '/settings', 'POST', { rootDocId: await entityId(owner, 'main.tex') }), /^204/);
  assert.match(await call(guest, `/folder/${await entityId(guest, 'out')}`, 'DELETE'), /^204/);
  now = await same('participant delete reaches the owner'); assert.equal(now['out/paper.pdf'], undefined); assert.equal(now['figures/Ünï ğ/plot.bin'], ownerFiles['figures/Ünï ğ/plot.bin']);
  await until(async () => !(await inTree(owner, 'out')), 'owner tree removed the folder');
  assert.match(await call(guest, `/doc/${await entityId(guest, 'main.tex')}/rename`, 'POST', { name: '../escape.tex' }), /^409/);   // refused by the owner
  assert.match(await call(guest, `/doc/${await entityId(guest, 'notları Ω.tex')}/rename`, 'POST', { name: 'MAIN.TEX' }), /^409 .*already exists/);
  await same('refusals change nothing');
  note('S2-03 live tree: participant upload/move/set-main/delete and owner folder/rename/set-main reach both sides exactly; escape and case duplicate refused', `upload ${png.length} bytes -> owner tree ${uploadMs.toFixed(0)} ms`);
  // ---- the owner's saved project already holds the merged text (reload from IndexedDB)
  await owner.waitForTimeout(500); const ownerText = await docOf(owner);
  const copy = await ownerContext.newPage(); await copy.goto(projectUrl); await editorOf(copy).waitFor({ timeout: 60000 });
  await until(async () => (await docOf(copy)) === ownerText, 'reloaded owner copy equals the shared text');
  assert.deepEqual(await digests(copy), await digests(owner), 'owner device saved every shared tree change exactly'); await copy.close();
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
  // ---- stop sharing revokes
  await panel2.getByRole('button', { name: 'Stop sharing' }).click();
  await until(async () => /stopped/i.test(await rejoin.locator('[role=alert]').textContent()), 'participant removed on stop'); note('stop sharing ends the participant session');
  // ---- the participant device kept no project and no source text in browser storage
  const probe = await guestContext.newPage(); await probe.goto(root + '/extension/index.html');
  const stored = await probe.evaluate(async () => {
    const projects = await new Promise(resolve => { const r = indexedDB.open('overleaf-local-projects'); r.onsuccess = () => { const db = r.result; if (!db.objectStoreNames.contains('projects')) { db.close(); resolve(0); return; } const c = db.transaction('projects').objectStore('projects').count(); c.onsuccess = () => { db.close(); resolve(c.result); }; }; r.onerror = () => resolve(-1); });
    const local = Object.entries(localStorage).filter(([, v]) => /Hello world|OWNER|Türkçe|after rejoin|Bölüm|%PDF/.test(v)).length;
    return { projects, local };
  });
  assert.deepEqual(stored, { projects: 0, local: 0 }); note('participant profile: no saved project, no source text in localStorage', JSON.stringify(stored));
  assert.deepEqual(errors, [], 'page errors');
  console.log(`PASS ${results.length} checks (loopback only; no physical LAN)`);
} finally { await cleanup(ownerContext, guestContext); }
