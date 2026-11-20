// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, transformX } from '../runtime/chrome-extension/lan-ot.mjs';

const PIECES = ['a', 'Türkçe', '😀', '\n', '𝔛y'];
const mk = seed => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
function op(random, text) { // one or two components at code-point boundaries
  const out = []; let current = text;
  for (let k = 0; k < 1 + Math.floor(random() * 2); k++) {
    const chars = [...current], at = Math.floor(random() * (chars.length + 1)), p = chars.slice(0, at).join('').length;
    const c = random() < 0.55 || at === chars.length ? { p, i: PIECES[Math.floor(random() * PIECES.length)] } : { p, d: chars.slice(at, at + 1 + Math.floor(random() * 3)).join('') };
    out.push(c); current = apply(current, [c]);
  }
  return out;
}
test('transformX is TP1-correct for insert/delete sequences on Unicode text (left stays first on ties)', () => {
  const random = mk(11);
  for (let n = 0; n < 3000; n++) {
    const base = Array.from({ length: Math.floor(random() * 12) }, () => PIECES[Math.floor(random() * PIECES.length)]).join(''), a = op(random, base), b = op(random, base);
    const [a2, b2] = transformX(a, b);
    assert.equal(apply(apply(base, a), b2), apply(apply(base, b), a2));
  }
});
test('ShareJS tie rule and malformed components', () => {
  assert.deepEqual(transformX([{ p: 1, i: 'L' }], [{ p: 1, i: 'R' }]), [[{ p: 1, i: 'L' }], [{ p: 2, i: 'R' }]]);
  assert.throws(() => apply('abc', [{ p: 9, i: 'x' }]), /range/); assert.throws(() => apply('abc', [{ p: 0, d: 'z' }]), /match/);
  assert.throws(() => transformX([{ p: 0, c: 'comment', t: 'x' }], []), /Unsupported/); assert.throws(() => apply('a', [{ p: -1, i: 'x' }]), /Unsupported/);
});
