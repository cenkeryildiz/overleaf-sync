// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export function patchCaret(source) {
  for (const [before, after] of [
    ['(0,r.useState)(500)', '(0,r.useState)(0)'],
    ['cursorUpdateInterval:n.length>0?500:3e5', 'cursorUpdateInterval:n.length>0?0:3e5'],
  ]) {
    assert.equal(source.split(before).length - 1, 1, 'Unexpected or already-patched caret scheduling');
    source = source.replace(before, after);
  }
  return source;
}
export function patchImmediateCaret(source) {
  const patches = [
    ['[S,T]=(0,r.useState)(null),[q,E]=(0,r.useState)(0)', 'S=(0,r.useRef)(null),[q,E]=(0,r.useState)(0)'],
    ['(0,d.A)("cursor:editor:update",(0,r.useCallback)(e=>{const t=e.detail;t&&T(t)},[]))', '(0,d.A)("cursor:editor:update",(0,r.useCallback)(e=>{const t=e.detail;t&&(S.current=t,0===q&&O&&f.emit("clientTracking.updatePosition",{row:t.row,column:t.column,doc_id:O}))},[q,O,f]))'],
    ['row:S?.row,column:S?.column,doc_id:O', 'row:S.current?.row,column:S.current?.column,doc_id:O'],
    ['[S,q,O,f]);const j=', '[q,O,f]);const j='],
  ];
  for (const [before, after] of patches) {
    assert.equal(source.split(before).length - 1, 1, 'Unexpected or already-patched immediate caret path');
    source = source.replace(before, after);
  }
  return source;
}
export function versionCaretManifest(manifest, version) {
  assert(/^[a-f0-9]{64}$/.test(version), 'Invalid asset digest');
  const result = structuredClone(manifest), asset = '/js/8607-0a5113f4c48f158e90d6.js';
  assert(result.entrypoints && result[asset.slice(1)] === asset, 'Pinned manifest asset differs');
  let count = 0;
  for (const entry of Object.values(result.entrypoints)) {
    if (!Array.isArray(entry.assets?.js)) continue;
    entry.assets.js = entry.assets.js.map(path => { if (path !== asset) return path; count++; return path + '?v=' + version; });
  }
  assert(count > 0, 'IDE asset not present in entrypoints');
  result[asset.slice(1)] = asset + '?v=' + version;
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output, manifestInput, manifestOutput] = process.argv.slice(2); assert(input && output && resolve(input) !== resolve(output), 'Use separate input/output paths');
  const source = readFileSync(input, 'utf8');
  const digest = createHash('sha256').update(source).digest('hex');
  assert(['df9d2d0d9dc2ff4cd3fd8429e4f4642d26ec3df9df75f10215130baced66da01', '873de6a9d33dc0ed54fa19395e7b6c5f0a3e5003d9a37d871554cec842857132'].includes(digest), 'Pinned existing timing-overlay identity differs');
  const body = patchImmediateCaret(digest.startsWith('df9d') ? patchCaret(source) : source);
  const version = createHash('sha256').update(body).digest('hex');
  assert(Boolean(manifestInput) === Boolean(manifestOutput), 'Use both manifest paths');
  if (manifestInput) assert(new Set([input, output, manifestInput, manifestOutput].map(p => resolve(p))).size === 4, 'Use separate input/output paths');
  const manifest = manifestInput ? versionCaretManifest(JSON.parse(readFileSync(manifestInput, 'utf8')), version) : null;
  writeFileSync(output, body, { flag: 'wx' });
  if (manifest) writeFileSync(manifestOutput, JSON.stringify(manifest), { flag: 'wx' });
}
