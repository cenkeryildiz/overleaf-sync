// SPDX-License-Identifier: AGPL-3.0-only
// Native packaged editor on two isolated profiles, real WebRTC, in-process finder. No external service or listener.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { memorySignaling } from '../../runtime/chrome-extension/p2p-signal.mjs';
import { BROKERS } from '../../runtime/chrome-extension/p2p-providers.mjs';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const extension = resolve(process.env.LATEX_EXTENSION_PATH), manifest = JSON.parse(readFileSync(join(extension, 'manifest.json')));
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].map(b => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('');
const root = `chrome-extension://${id}`, work = mkdtempSync(join(tmpdir(), 'latex-p2p-native-')), hub = memorySignaling(), contexts = [], external = [];
const errors = [];
const realServices = process.env.P2P_EXTERNAL === '1', approved = new Set(BROKERS.map(url => new URL(url).origin)), signalingFrames = [], services = new Set();
const editor = page => page.getByRole('textbox', { name: /^Source Editor/ });
const text = page => editor(page).evaluate(node => node.cmView.view.state.doc.toString());
const append = (page, value) => editor(page).evaluate((node, value) => { const view = node.cmView.view; view.dispatch({ changes: { from: view.state.doc.length, insert: value } }); }, value);
let stage = 'owner startup';
async function profile(name) {
  const context = await chromium.launchPersistentContext(join(work, name), { headless: true, executablePath: process.env.EXTENSION_CHROME_PATH,
    viewport: { width: 1600, height: 1000 }, ignoreDefaultArgs: ['--disable-extensions'], args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
  contexts.push(context);
  await context.route(/^(https?|wss?):/, route => { const origin = new URL(route.request().url()).origin; if (realServices && approved.has(origin)) return route.continue(); external.push(origin); return route.abort(); });
  if (!realServices) await context.addInitScript(() => { globalThis.LATEX_P2P_TEST_SIGNAL = true; const NativeRTC = RTCPeerConnection; globalThis.RTCPeerConnection = class extends NativeRTC { constructor(config) { super({ ...config, iceServers: [] }); } }; });
  const page = await context.newPage(), open = new Map(); page.setDefaultTimeout(45000);
  context.on('close', () => { for (const endpoint of open.values()) endpoint.close(); open.clear(); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => { services.add(new URL(socket.url()).origin); socket.on('framesent', frame => signalingFrames.push(Buffer.from(frame.payload))); });
  const deliver = (handle, kind, from, message) => page.evaluate(([h, k, f, m]) => globalThis.__p2pDeliver?.(h, k, f, m), [handle, kind, from, message]).catch(() => {});
  await page.exposeBinding('__p2pSignal', async (_, op, args) => {
    if (op === 'open') { open.set(args.handle, await hub.open({ roomId: args.roomId, role: args.role, onSignal: (from, m) => deliver(args.handle, 'signal', from, m), onState: up => deliver(args.handle, 'state', null, up) })); return true; }
    if (op === 'send') return open.get(args.handle)?.send(args.to, args.message);
    if (op === 'close') { open.get(args.handle)?.close(); open.delete(args.handle); }
  });
  return { context, page };
}
try {
  const { context: ownerContext, page: owner } = await profile('owner'), { page: guest } = await profile('guest');
  await owner.goto(root + '/extension/index.html'); await owner.getByRole('link', { name: 'Work offline', exact: true }).click();
  await owner.getByRole('textbox', { name: 'New local project name', exact: true }).fill('Synthetic internet room');
  await owner.getByRole('button', { name: 'Create local project', exact: true }).click(); await editor(owner).waitFor();
  await owner.locator('.textLayer span').filter({ hasText: 'Hello world.' }).first().waitFor();
  const original = await text(owner);
  stage = 'share';
  await owner.locator('#local-share').click(); await owner.getByRole('button', { name: /^Over the internet/ }).click();
  const panel = owner.getByRole('dialog', { name: 'Internet room' }); await panel.waitFor();
  const link = await panel.locator('code').first().getAttribute('title'), passcode = await panel.locator('.lan-pass').textContent();
  const start = performance.now();
  stage = 'join';
  await guest.goto(link); await guest.getByRole('textbox', { name: 'Passcode', exact: true }).fill(passcode);
  await guest.getByRole('textbox', { name: 'Your name for this session', exact: true }).fill('Guest');
  await guest.getByRole('button', { name: 'Join', exact: true }).click();
  try { await editor(guest).waitFor(); } catch (error) { console.error(JSON.stringify({ joinStatus: await guest.getByRole('status').allTextContents() })); throw error; }
  assert.equal(await text(guest), original);
  await guest.locator('.textLayer span').filter({ hasText: 'Hello world.' }).first().waitFor();
  const joinMs = Math.round(performance.now() - start);
  stage = 'edit';
  await append(guest, '\n% guest edit');
  try { await owner.waitForFunction(expected => document.querySelector('[aria-label^="Source Editor"]')?.cmView.view.state.doc.toString() === expected, original + '\n% guest edit'); }
  catch (error) { console.error(JSON.stringify({ errors, ownerStatus: await owner.getByRole('status').allTextContents(), guestStatus: await guest.getByRole('status').allTextContents(), lengths: [(await text(owner)).length, (await text(guest)).length, original.length] })); throw error; }
  await append(owner, '\n% owner edit');
  const expected = original + '\n% guest edit\n% owner edit';
  await guest.waitForFunction(expected => document.querySelector('[aria-label^="Source Editor"]')?.cmView.view.state.doc.toString() === expected, expected);
  if (!await panel.isVisible()) await owner.locator('#local-share').click();
  stage = 'transfer';
  await panel.getByLabel('Permission for Guest').selectOption('copy');
  await panel.getByRole('button', { name: 'More for Guest', exact: true }).click();
  await panel.getByRole('button', { name: 'Offer ownership', exact: true }).click();
  await guest.getByRole('button', { name: 'Accept ownership', exact: true }).click();
  await guest.locator('#local-share').click();
  const memberPanel = guest.getByRole('dialog', { name: 'Internet room' });
  await memberPanel.locator('.lan-person').filter({ hasText: 'Guest' }).locator('.lan-badge').filter({ hasText: /^Owner$/ }).waitFor();
  assert.equal(await guest.evaluate(() => typeof globalThis.overleafGroupCompile), 'undefined');
  const handover = performance.now(); await ownerContext.close();
  stage = 'handover';
  await memberPanel.getByText('This computer coordinates the room now.', { exact: false }).waitFor();
  await append(guest, '\n% after handover');
  assert.equal(await text(guest), expected + '\n% after handover');
  assert.deepEqual(external, []);
  for (const service of services) assert(approved.has(service));
  for (const frame of signalingFrames) for (const secret of [passcode, passcode.replaceAll('-', ''), original, 'Guest']) assert.equal(frame.includes(Buffer.from(secret)), false, 'Plaintext in signaling frame');
  console.log(JSON.stringify({ nativeJoin: true, exactSource: true, editsBothWays: true, ownershipTransfer: true, coordinatorHandover: true,
    noGroupCompile: true, noUnapprovedNetwork: true, realServices, services: [...services], signalingFrames: signalingFrames.length,
    signalingBytes: signalingFrames.reduce((n, frame) => n + frame.length, 0), plaintextAbsent: true, joinMs, handoverMs: Math.round(performance.now() - handover) }));
} catch (error) { console.error('Failed stage:', stage); throw error; }
finally { for (const context of contexts) await context.close().catch(() => {}); rmSync(work, { recursive: true, force: true }); }
