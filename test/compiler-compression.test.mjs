// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { compilerAssets, compressCompilerAssets } from '../runtime/chrome-extension/compress-compiler.mjs';

test('compiler packaging preserves exact bytes and refuses to overwrite existing compressed assets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'latex-gzip-check-'));
  try {
    const input = Buffer.from('Synthetic package\0Türkçe\n'.repeat(100));
    for (const name of compilerAssets) await writeFile(join(directory, name), input);
    const sizes = await compressCompilerAssets(directory);
    assert(sizes.compressedBytes < sizes.originalBytes);
    assert.equal(sizes.originalBytes, input.length * compilerAssets.length);
    for (const name of compilerAssets) assert.deepEqual(gunzipSync(await readFile(join(directory, name + '.gz'))), input);
    assert.deepEqual((await readdir(directory)).sort(), compilerAssets.map(name => name + '.gz').sort());
    await writeFile(join(directory, compilerAssets[0]), input);
    await assert.rejects(compressCompilerAssets(directory), /already exists/);
    assert.deepEqual(await readFile(join(directory, compilerAssets[0])), input);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('standalone compiler streams gzip with WASM MIME, retains fetch guards and reports bad assets', async () => {
  const calls = [], input = Buffer.from('Synthetic compiler asset'), source = readFileSync(new URL('../runtime/participant-compile/worker.js', import.meta.url), 'utf8');
  let response = () => new Response(gzipSync(input));
  const location = new URL('chrome-extension://fixture/recovery/busytex/busytex_worker.js');
  const context = { URL, location, Response, DecompressionStream, console: { error() {} }, performance: { mark() {} },
    XMLHttpRequest: class { open() {} }, WebAssembly: { instantiate: async () => {} }, postMessage() {}, importScripts() {},
    fetch: async (url, options) => { calls.push([url, options]); return response(); } };
  context.self = context; vm.runInNewContext(source, context);
  for (const name of compilerAssets) {
    const decoded = await context.fetch(name, { credentials: 'include' });
    assert.deepEqual(Buffer.from(await decoded.arrayBuffer()), input);
    assert.equal(calls.at(-1)[0], new URL(name + '.gz', location).href);
    assert.equal(calls.at(-1)[1].credentials, 'omit');
    assert.equal(decoded.headers.get('Content-Type'), name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
  }
  for (const name of ['texlive-basic.data', 'texlive-recommended.data', 'texlive-extra.data']) {
    await context.fetch(name); assert.equal(calls.at(-1)[0], new URL(name, location).href);
  }
  const count = calls.length;
  for (const path of ['https://outside.test/source', 'texlive-basic.data?source=private', '../secret', 'invented.data', 'texlive-basic.data.gz'])
    assert.throws(() => context.fetch(path), /refused/);
  assert.equal(calls.length, count);
  response = () => new Response('corrupt gzip');
  await assert.rejects((await context.fetch('busytex.wasm')).arrayBuffer());
  response = () => new Response('not found', { status: 404 });
  assert.equal((await context.fetch('texlive-basic.data')).status, 404);
  response = () => { throw Error('Interrupted asset read'); };
  await assert.rejects(context.fetch('texlive-basic.data'), /Interrupted/);
});

