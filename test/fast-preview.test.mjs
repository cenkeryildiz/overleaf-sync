import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { patchBundle } from '../runtime/fast-preview/apply.mjs';
const fixture = 'a.setFlushDelay(2e3);b.setFlushDelay(500);debounce(()=>{x()},2500,{maxWait:5e3});const watchdog=4e3,retry=5e3;this.ideEventEmitter.emit("doc:changed",{doc_id:this.doc_id}))},50);this.ideEventEmitter.emit("doc:saved",{doc_id:this.doc_id})},50);prefs(`autocompile_enabled:${b}`,!1,{listen:!0});';
test('frontend patch changes only send/preview timings', () => {
  const actual = patchBundle(fixture);
  assert.equal(actual, 'a.setFlushDelay(0);b.setFlushDelay(0);debounce(()=>{x()},50,{leading:!0,maxWait:500});const watchdog=4e3,retry=5e3;this.ideEventEmitter.emit("doc:changed",{doc_id:this.doc_id}))},0);this.ideEventEmitter.emit("doc:saved",{doc_id:this.doc_id})},0);prefs(`autocompile_enabled:${b}`,!0,{listen:!0});');
  assert.equal(fixture.includes('setFlushDelay(2e3)'), true);
});
test('unknown, duplicate or already-patched frontend is refused', () => {
  for (const source of ['', fixture + ';b.setFlushDelay(500)', patchBundle(fixture)]) assert.throws(() => patchBundle(source), /Unexpected/);
});
test('untrusted asset hash cannot overwrite an existing destination', () => {
  const dir = mkdtempSync(join(tmpdir(), 'overleaf-asset-check-'));
  try {
    const input = join(dir, 'original.js'), output = join(dir, '8607-0a5113f4c48f158e90d6.js');
    writeFileSync(input, fixture); writeFileSync(output, 'retained');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../runtime/fast-preview/apply.mjs', import.meta.url)), input, output], { encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /hash mismatch/);
    assert.equal(readFileSync(input, 'utf8'), fixture); assert.equal(readFileSync(output, 'utf8'), 'retained');
  } finally { rmSync(dir, { recursive: true }); }
});
async function manager(set) {
  const context = vm.createContext({});
  const source = readFileSync(new URL('../runtime/fast-preview/CompileManager.mjs', import.meta.url), 'utf8');
  const imports = {
    'node:crypto': { default: {} }, '@overleaf/settings': { default: {} },
    '../../infrastructure/RedisWrapper.mjs': { default: { client: () => ({ set }) } },
    '../Project/ProjectGetter.mjs': { default: {} }, '../Project/ProjectRootDocManager.mjs': { default: {} },
    '../User/UserGetter.mjs': { default: {} }, './ClsiManager.mjs': { default: {} },
    '@overleaf/metrics': { default: {} }, '../../infrastructure/RateLimiter.mjs': { RateLimiter: class {} },
    '@overleaf/promise-utils': { callbackify: x => x, callbackifyMultiResult: x => x }, '../Errors/Errors.js': { default: {} },
  };
  const mod = new vm.SourceTextModule(source, { context });
  await mod.link(spec => { assert(Object.hasOwn(imports, spec)); const values = imports[spec]; return new vm.SyntheticModule(Object.keys(values), function () { for (const [k, v] of Object.entries(values)) this.setExport(k, v) }, { context }); });
  await mod.evaluate(); return mod.namespace.default;
}
test('compile admission uses atomic NX with a bounded millisecond expiry', async () => {
  let args; const m = await manager(async (...x) => { args = x; return 'OK' });
  assert.equal(await m._checkIfRecentlyCompiled('project', 'user'), false);
  assert.deepEqual(args, ['compile:project:user', true, 'PX', 100, 'NX']);
});
test('a duplicate compile is refused and Redis failure propagates', async () => {
  const m = await manager(async () => null); assert.equal(await m._checkIfRecentlyCompiled('project', 'user'), true);
  const failure = new Error('Redis unavailable'); const broken = await manager(async () => { throw failure });
  await assert.rejects(broken._checkIfRecentlyCompiled('project', 'user'), error => error === failure);
});
test('simultaneous submissions retain per-account/project admission isolation', async () => {
  const seen = new Set(); const m = await manager(async key => { if (seen.has(key)) return null; seen.add(key); return 'OK' });
  const results = await Promise.all(Array.from({ length: 8 }, () => m._checkIfRecentlyCompiled('project', 'alice')));
  assert.equal(results.filter(x => x === false).length, 1);
  assert.equal(await m._checkIfRecentlyCompiled('project', 'bob'), false);
  assert.equal(await m._checkIfRecentlyCompiled('other-project', 'alice'), false);
});
