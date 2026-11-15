// SPDX-License-Identifier: AGPL-3.0-only
// Cenker YILDIZ, 2026-11-15; timing overlay for the pinned CE+ frontend.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function patchBundle(source) {
  for (const [from, to] of [
    ['.setFlushDelay(2e3)', '.setFlushDelay(16)'],
    ['.setFlushDelay(500)', '.setFlushDelay(16)'],
    ['},2500,{maxWait:5e3})', '},50,{maxWait:500})'],
    ['`autocompile_enabled:${b}`,!1,{listen:!0}', '`autocompile_enabled:${b}`,!0,{listen:!0}'],
  ]) {
    assert.equal(source.split(from).length - 1, 1, 'Unexpected or already-patched frontend');
    source = source.replace(from, to);
  }
  return source;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  assert(input && output && resolve(input) !== resolve(output), 'Use separate original and output paths');
  assert.equal(basename(output), '8607-0a5113f4c48f158e90d6.js', 'Unexpected output asset');
  const source = readFileSync(input, 'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'), '47dce31db1e1e52214e207bb334a0659837b9ded425d0b22ec042c49ea4d04ad', 'Pinned upstream asset hash mismatch');
  const result = patchBundle(source);
  const temp = output + '.tmp-' + process.pid;
  writeFileSync(temp, result, { flag: 'wx' });
  try {
    renameSync(temp, output);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
  console.log('Generated pinned frontend timing overlay; recreate the service to remount this asset.');
}
