// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cenker YILDIZ.
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
// Synthetic keys/profile only; no server, signaling service or user project.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const extension = process.env.LATEX_EXTENSION_PATH;
const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json')));
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].map(b => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('');
const work = mkdtempSync(join(tmpdir(), 'latex-p4-identity-'));
const launch = () => chromium.launchPersistentContext(join(work, 'profile'), {
  headless: true, executablePath: process.env.EXTENSION_CHROME_PATH,
  ignoreDefaultArgs: ['--disable-extensions'], args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
});
let context;
const deadline = setTimeout(() => context?.close(), 60000);
try {
  context = await launch(); await context.setOffline(true);
  let arrived = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  await context.exposeFunction('identityGenerationBarrier', async () => { if (++arrived === 2) release(); await barrier; });
  const pages = await Promise.all([context.newPage(), context.newPage()]);
  await Promise.all(pages.map(page => page.goto(`chrome-extension://${id}/extension/index.html`)));
  const results = await Promise.all(pages.map(page => page.evaluate(async () => {
    const { identityStore } = await import('/extension/p2p-identity.mjs');
    const generate = crypto.subtle.generateKey.bind(crypto.subtle);
    crypto.subtle.generateKey = async (...args) => { await identityGenerationBarrier(); return generate(...args); };
    try {
      const store = identityStore(), identities = await Promise.all(Array.from({ length: 8 }, () => store.forRoom('I'.repeat(22))));
      if (!identities.every(identity => identity === identities[0])) throw Error('Concurrent local identities differ');
      return identities[0].key;
    } finally { crypto.subtle.generateKey = generate; }
  })));
  assert(arrived === 2 && results[0] === results[1], 'Concurrent tabs must keep the same winning identity');
  const expected = results[0], page = pages[0];
  await page.reload();
  const restored = await page.evaluate(async expected => {
    const { identityStore, verify } = await import('/extension/p2p-identity.mjs');
    const identity = await identityStore().forRoom('I'.repeat(22)), message = new TextEncoder().encode('synthetic identity proof');
    if (identity.key !== expected || !await verify(expected, await identity.sign(message), message)) return false;
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('latex-p2p-identity', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const pair = await new Promise((resolve, reject) => { const r = db.transaction('pairs').objectStore('pairs').get('I'.repeat(22)); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); db.close();
    if (pair.privateKey.extractable || Object.keys(pair).sort().join(',') !== 'privateKey,publicKey') return false;
    try { await crypto.subtle.exportKey('jwk', pair.privateKey); return false; } catch { /* Non-extractable private key must stay in CryptoKey storage. */ }
    let fail = true;
    const store = identityStore({ db: { open(...args) {
      if (!fail) return indexedDB.open(...args);
      fail = false; const r = { error: new DOMException('Synthetic storage failure', 'UnknownError') }; queueMicrotask(() => r.onerror?.()); return r;
    } } });
    let rejected = false; try { await store.forRoom('I'.repeat(22)); } catch { rejected = true; }
    return rejected && (await store.forRoom('I'.repeat(22))).key === expected;
  }, expected);
  assert(restored, 'Reload, private-key protection and storage-error preservation must pass');
  await context.close(); context = await launch(); await context.setOffline(true);
  const reopened = await context.newPage(); await reopened.goto(`chrome-extension://${id}/extension/index.html`);
  assert(await reopened.evaluate(async expected => {
    const { identityStore, verify } = await import('/extension/p2p-identity.mjs');
    const identity = await identityStore().forRoom('I'.repeat(22)), bytes = new TextEncoder().encode('reopen proof');
    return identity.key === expected && await verify(expected, await identity.sign(bytes), bytes);
  }, expected), 'Browser reopen must retain the same usable identity');
  console.log(JSON.stringify({ sameStoreConcurrency: true, concurrentTabs: true, pageReload: true, browserReopen: true, nonExtractablePrivateKey: true, failedReadPreservesIdentity: true }));
} finally { clearTimeout(deadline); await context?.close(); rmSync(work, { recursive: true, force: true }); }
