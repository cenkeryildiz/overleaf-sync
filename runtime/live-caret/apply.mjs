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
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2); assert(input && output && resolve(input) !== resolve(output), 'Use separate input/output paths');
  const source = readFileSync(input, 'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'), 'df9d2d0d9dc2ff4cd3fd8429e4f4642d26ec3df9df75f10215130baced66da01', 'Pinned existing timing-overlay identity differs');
  writeFileSync(output, patchCaret(source), { flag: 'wx' });
}
