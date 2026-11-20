// SPDX-License-Identifier: AGPL-3.0-only
// ShareJS text OT ({p,i} / {p,d} components) with the semantics of the native editor's sharejs-text-ot, so the owner's
// log and the editor's own client transform agree: in transformX(left, right) the left side stays first on equal-position
// inserts. The native client decodes joinDoc lines to ordinary JS strings, so positions are UTF-16 code units and a
// supplementary character is a surrogate pair that editors always insert/delete whole.
// Comment/track-change components are not supported here and are refused (local mode has neither).
const isInt = n => Number.isSafeInteger(n) && n >= 0;

function check(op) {
  if (!Array.isArray(op)) throw Error('Malformed operation');
  for (const c of op) {
    if (!c || typeof c !== 'object' || !isInt(c.p) || (typeof c.i === 'string') === (typeof c.d === 'string')) throw Error('Unsupported operation component');
  }
}
export function apply(text, op) {
  check(op);
  for (const c of op) {
    if (c.p > text.length) throw Error('Position out of range');
    if (c.i !== undefined) text = text.slice(0, c.p) + c.i + text.slice(c.p);
    else { if (text.slice(c.p, c.p + c.d.length) !== c.d) throw Error('Delete does not match the text'); text = text.slice(0, c.p) + text.slice(c.p + c.d.length); }
  }
  return text;
}
// c rewritten to apply after o (o happened first); side 'left' keeps c first on an equal-position insert.
function component(c, o, side) {
  if (c.i !== undefined) {
    if (o.i !== undefined) return [c.p < o.p || (c.p === o.p && side === 'left') ? c : { i: c.i, p: c.p + o.i.length }];
    if (c.p <= o.p) return [c];
    return [c.p >= o.p + o.d.length ? { i: c.i, p: c.p - o.d.length } : { i: c.i, p: o.p }];
  }
  if (o.i !== undefined) {
    if (c.p >= o.p) return [{ d: c.d, p: c.p + o.i.length }];
    if (c.p + c.d.length > o.p) { const k = o.p - c.p; return [{ d: c.d.slice(0, k), p: c.p }, { d: c.d.slice(k), p: c.p + o.i.length }]; }
    return [c];
  }
  if (c.p >= o.p + o.d.length) return [{ d: c.d, p: c.p - o.d.length }];
  if (c.p + c.d.length <= o.p) return [c];
  let d = c.p < o.p ? c.d.slice(0, o.p - c.p) : '';
  if (c.p + c.d.length > o.p + o.d.length) d += c.d.slice(o.p + o.d.length - c.p);
  return d ? [{ d, p: Math.min(c.p, o.p) }] : [];
}
function cross(left, right) {
  if (!left.length || !right.length) return [left, right];
  if (left.length > 1) { const [a, r1] = cross([left[0]], right), [rest, r2] = cross(left.slice(1), r1); return [[...a, ...rest], r2]; }
  if (right.length > 1) { const [l1, b] = cross(left, [right[0]]), [l2, rest] = cross(l1, right.slice(1)); return [l2, [...b, ...rest]]; }
  return [component(left[0], right[0], 'left'), component(right[0], left[0], 'right')];
}
export function transformX(left, right) { check(left); check(right); return cross(left, right); }
export const ot = Object.freeze({ apply, transformX });

