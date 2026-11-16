import test from 'node:test';
import assert from 'node:assert/strict';
import { patchCaret } from '../runtime/live-caret/apply.mjs';
test('caret presence removes the resettable half-second wait while retaining solo idle behavior', () => {
  const input = 'let q=(0,r.useState)(500);return {cursorUpdateInterval:n.length>0?500:3e5};unrelated(500)';
  const output = patchCaret(input);
  assert.equal(output, 'let q=(0,r.useState)(0);return {cursorUpdateInterval:n.length>0?0:3e5};unrelated(500)');
  assert.throws(() => patchCaret(output)); assert.throws(() => patchCaret(input + input)); assert.throws(() => patchCaret('unknown'));
});

import { patchImmediateCaret, versionCaretManifest } from '../runtime/live-caret/apply.mjs';
test('movement sends immediately without React state writes; join/idle publication reads the latest position', () => {
  const fixture = 'return (r,d,f,O)=>{let [S,T]=(0,r.useState)(null),[q,E]=(0,r.useState)(0);(0,d.A)("cursor:editor:update",(0,r.useCallback)(e=>{const t=e.detail;t&&T(t)},[]));(0,r.useEffect)(()=>{const e=window.setTimeout(()=>{f.emit("clientTracking.updatePosition",{row:S?.row,column:S?.column,doc_id:O})},q);return()=>{window.clearTimeout(e)}},[S,q,O,f]);const j=()=>{};return j}';
  const patched = patchImmediateCaret(fixture);
  assert.throws(() => patchImmediateCaret(patched)); assert.throws(() => patchImmediateCaret(fixture + fixture));
  for (const interval of [0,300000]) {
    let listener, effect, writes = 0; const sent = [], timers = [];
    const component = Function('window', patched)({ setTimeout(fn, ms) { timers.push({fn,ms}); return 1; }, clearTimeout() {} });
    component({ useState: () => [interval, () => writes++], useRef: () => ({ current: null }), useCallback: fn => fn, useEffect: fn => { effect = fn; } }, { A: (_event, fn) => { listener = fn; } }, { emit: (event, value) => sent.push({event,value}) }, 'doc');
    listener({detail:{row:2,column:3}}); listener({detail:{row:2,column:4}});
    assert.equal(writes,0); assert.equal(timers.length,0); assert.equal(sent.length,interval===0?2:0);
    effect(); assert.equal(timers[0].ms,interval); timers[0].fn();
    assert.deepEqual(sent.at(-1),{event:'clientTracking.updatePosition',value:{row:2,column:4,doc_id:'doc'}});
  }
});
test('ordinary page refresh requests the content-versioned IDE asset without mutating other entries', () => {
  const asset='/js/8607-0a5113f4c48f158e90d6.js',hash='a'.repeat(64);
  const input={entrypoints:{ide:{assets:{js:['/js/runtime.js',asset]}},'ide-detached':{assets:{js:[asset]}}},[asset.slice(1)]:asset};
  const result=versionCaretManifest(input,hash);
  assert.equal(result.entrypoints.ide.assets.js[1],asset+'?v='+hash); assert.equal(result.entrypoints.ide.assets.js[0],'/js/runtime.js');
  assert.equal(input.entrypoints.ide.assets.js[1],asset); assert.throws(()=>versionCaretManifest(result,hash)); assert.throws(()=>versionCaretManifest(input,'bad'));
});
