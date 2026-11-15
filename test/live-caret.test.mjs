import test from 'node:test';
import assert from 'node:assert/strict';
import { patchCaret } from '../runtime/live-caret/apply.mjs';
test('caret presence removes the resettable half-second wait while retaining solo idle behavior', () => {
  const input = 'let q=(0,r.useState)(500);return {cursorUpdateInterval:n.length>0?500:3e5};unrelated(500)';
  const output = patchCaret(input);
  assert.equal(output, 'let q=(0,r.useState)(0);return {cursorUpdateInterval:n.length>0?0:3e5};unrelated(500)');
  assert.throws(() => patchCaret(output)); assert.throws(() => patchCaret(input + input)); assert.throws(() => patchCaret('unknown'));
});
