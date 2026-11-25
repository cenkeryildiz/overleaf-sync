// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const router = readFileSync(new URL('../runtime/chrome-extension/join.js', import.meta.url), 'utf8');
test('launch opens projects and preserves only valid invitation routes', () => {
  for (const [hash, expected] of [
    ['', '/recovery/project-workspace.html'],
    ['#room=' + 'a'.repeat(22), '/recovery/native-workspace.html#room=' + 'a'.repeat(22)],
    ['#join=192.168.1.2:12345/' + 'b'.repeat(22), '/recovery/native-workspace.html#join=192.168.1.2:12345/' + 'b'.repeat(22)],
    ['#room=bad', '/recovery/project-workspace.html'],
    ['#https://example.com', '/recovery/project-workspace.html'],
  ]) {
    let actual;
    runInNewContext(router, { location: { hash, replace: target => { actual = target; } } });
    assert.equal(actual, expected);
  }
});
