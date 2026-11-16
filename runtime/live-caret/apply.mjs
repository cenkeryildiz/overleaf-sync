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
export function patchTypingCaret(source) {
  const before = 'a.Z9.define(()=>{let e=null;return{update(t){(t.selectionSet||t.docChanged)&&(e&&window.cancelAnimationFrame(e),e=window.requestAnimationFrame(()=>{e=null,L(t.state)}))}}})';
  // Queue after this transaction's text-flush timers, without waiting for another display frame.
  const after = 'a.Z9.define(()=>{let e=null,t=null,o=!1,n=!1;return{update(r){(r.selectionSet||r.docChanged)&&(t=r.state,o||(o=!0,queueMicrotask(()=>{n||(e=window.setTimeout(()=>{e=null,o=!1;const r=t;t=null,n||L(r)},0))})))},destroy(){n=!0,t=null,null!==e&&window.clearTimeout(e)}}})';
  assert.equal(source.split(before).length - 1, 1, 'Unexpected or already-patched typing caret scheduling');
  return source.replace(before, after);
}
export function patchCaretProjection(source) {
  const before = 'class $ extends i.FB{mapMode=(()=>i.iR.Simple)();constructor(e){super(),this.highlight=e}eq(e){return e.highlight===this.highlight}}const U=i.sU.define({create:()=>i.om.empty,update(e,t){for(const e of t.effects)if(e.is(H)){const o=[];for(const n of e.value)if("cursor"in n)try{const{row:e,column:r}=n.cursor,s=C(t.state.doc,e+1,r);o.push(new $(n).range(s))}catch(e){j.$.debug("invalid highlight position",e)}return i.om.of(o,!0)}return t.docChanged&&!t.annotation(i.ZX.remote)&&(e=e.map(t.changes)),e}})';
  // Keep the announced coordinates, including positions that were clamped before their text arrived.
  const after = 'class $ extends i.FB{mapMode=(()=>i.iR.Simple)();constructor(e,t,o,n){super(),this.highlight=e,this.caret=t,this.basisRow=o,this.basisColumn=n}eq(e){return e.highlight===this.highlight&&e.caret.row===this.caret.row&&e.caret.column===this.caret.column&&e.basisRow===this.basisRow&&e.basisColumn===this.basisColumn}static at(e,t,o){const n=C(e,o.row+1,o.column),r=e.lineAt(n);return new $(t,o,r.number-1,n-r.from).range(n)}static reconcile(e,t){const o=!!t.annotation(i.ZX.remote),n=o?e:e.map(t.changes),r=[];return n.between(0,Math.max(t.startState.doc.length,t.state.doc.length),(e,n,s)=>{let a=s.caret;if(!o){const o=t.state.doc.lineAt(e);a={row:o.number-1+s.caret.row-s.basisRow,column:s.caret.row===s.basisRow?e-o.from+s.caret.column-s.basisColumn:s.caret.column}}r.push($.at(t.state.doc,s.highlight,a))}),i.om.of(r,!0)}}const U=i.sU.define({create:()=>i.om.empty,update(e,t){for(const e of t.effects)if(e.is(H)){const o=[];for(const n of e.value)if("cursor"in n)try{o.push($.at(t.state.doc,n,n.cursor))}catch(e){j.$.debug("invalid highlight position",e)}return i.om.of(o,!0)}return t.docChanged?$.reconcile(e,t):e}})';
  assert.equal(source.split(before).length - 1, 1, 'Unexpected or already-patched caret projection');
  return source.replace(before, after);
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
