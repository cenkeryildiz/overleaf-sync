// Expected to fail on pinned upstream; this is an unresolved R2 support probe, not a passing gate.
const assert = require('node:assert/strict');
const manager = require('/overleaf/services/document-updater/app/js/UpdateManager.js');
const smile = String.fromCodePoint(0x1f642), math = String.fromCodePoint(0x1d538);
for (const [input, expected] of [
  ['plain café 中文', 'plain café 中文'],
  ['a' + smile + math + 'z', 'a' + smile + math + 'z'],
  ['\ud800', '\ufffd'], ['\udfff', '\ufffd'],
  ['x\ud800y\udfffz', 'x\ufffdy\ufffdz'],
  [smile + '\ud800', smile + '\ufffd'],
]) {
  const update = { v: 17, op: [{ p: 4, i: input }, { p: 11, d: 'unchanged' }] };
  assert.equal(manager._sanitizeUpdate(update), update);
  assert.equal(update.op[0].i, expected);
  assert.equal(update.op[0].i.length, input.length, 'OT UTF-16 positions must remain stable');
  assert.equal(update.op[0].p, 4); assert.equal(update.op[1].d, 'unchanged'); assert.equal(update.v, 17);
}
console.log('PASS: actual native updater preserves valid pairs/BMP, replaces only unpaired surrogates, and retains operation lengths/positions/metadata.');
process.exit(0);
