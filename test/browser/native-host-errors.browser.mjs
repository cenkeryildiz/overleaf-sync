// SPDX-License-Identifier: MIT
// Exercise actual Chrome native-host failures in a disposable extension profile.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, cpSync, copyFileSync, readFileSync, rmSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const work = mkdtempSync(join(tmpdir(), 'latex-native-host-errors-')), extension = join(work, 'extension');
cpSync(resolve(process.env.LATEX_EXTENSION_BASE), extension, { recursive: true, mode: constants.COPYFILE_FICLONE });
for (const file of ['lan-host.mjs', 'lan-compile.mjs']) copyFileSync(new URL('../../runtime/chrome-extension/' + file, import.meta.url), join(extension, 'extension', file));
const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json')));
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].map(b => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('');
const context = await chromium.launchPersistentContext(join(work, 'profile'), { channel: 'chromium', headless: true,
  executablePath: process.env.EXTENSION_CHROME_PATH, ignoreDefaultArgs: ['--disable-extensions'], args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
const deadline = setTimeout(() => context.close(), 60000), unchecked = [];
context.on('console', message => { if (/Unchecked runtime.lastError/.test(message.text())) unchecked.push(message.text()); });
try {
  await context.route(/^https?:/, r => r.abort());
  const page = await context.newPage(), cdp = await context.newCDPSession(page);
  await cdp.send('Log.enable'); cdp.on('Log.entryAdded', ({ entry }) => { if (/Unchecked runtime.lastError/.test(entry.text)) unchecked.push(entry.text); });
  await page.goto(`chrome-extension://${id}/extension/index.html`); await page.waitForURL(/project-workspace\.html$/);
  // Prove this browser/log observer detects an unacknowledged missing-host error.
  await page.evaluate(() => new Promise(resolve => { const port = chrome.runtime.connectNative('com.cenker.unregistered_test_fixture'); port.onDisconnect.addListener(() => resolve()); }));
  await page.waitForTimeout(100); assert(unchecked.length > 0, 'negative control must expose the unchecked error'); unchecked.length = 0;
  const result = await page.evaluate(async () => {
    const { nativeHelper, helperAvailable } = await import('/extension/lan-host.mjs'), { texHost } = await import('/extension/lan-compile.mjs');
    const connect = () => chrome.runtime.connectNative('com.cenker.unregistered_test_fixture');
    const sharing = nativeHelper(connect), tex = texHost(connect);
    const sharingRejected = await sharing.call('addresses').then(() => false, e => /sharing helper is not available/.test(e.message));
    const available = await helperAvailable(connect);
    const texRejected = await tex.status().then(() => false, e => e.lost === true);
    const texRetryRejected = await tex.status().then(() => false, e => e.lost === true);
    sharing.close(); tex.close(); return { sharingRejected, available, texRejected, texRetryRejected };
  });
  await page.waitForTimeout(100);
  assert.deepEqual(result, { sharingRejected: true, available: false, texRejected: true, texRetryRejected: true });
  assert.equal(unchecked.length, 0, 'handled missing hosts must not emit unchecked runtime.lastError');
  console.log(JSON.stringify({ passed: true, actualMissingHost: true, negativeControlDetected: true, ...result, uncheckedErrors: unchecked.length }));
} finally { clearTimeout(deadline); await context.close(); rmSync(work, { recursive: true, force: true }); }
