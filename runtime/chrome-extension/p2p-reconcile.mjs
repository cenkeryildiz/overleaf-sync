// SPDX-License-Identifier: AGPL-3.0-only
// Stage 4 S4-06: explicit reconciliation of two separately edited copies of one room project (a copy edited offline, or two groups
// that edited apart). Compares both against the file digests of their last common point (saveForReopen's `digests`) and proposes
// a plan; nothing is applied until the user confirms, and no version is ever dropped: when both sides changed a file, or one side
// deleted what the other changed, both versions are kept. Live text conflicts of open files use lan-guest.mjs `reconcile`.
import { validPath } from './lan-transfer.mjs';
const sha256 = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const isText = bytes => { try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; } catch { return false; } };
const put = (path, bytes) => ({ kind: 'put', path, bytes, doc: isText(bytes) }); // the project tree refuses a put onto an existing path

/** A free name next to `path` for the other version: "main (my version).tex", then "(my version 2)", ... */
export function keepName(path, taken, label = 'my version') {
  const slash = path.lastIndexOf('/') + 1, dot = path.lastIndexOf('.');
  const [stem, ext] = dot > slash ? [path.slice(0, dot), path.slice(dot)] : [path, ''];
  for (let i = 1; ; i++) { const name = `${stem} (${label}${i > 1 ? ' ' + i : ''})${ext}`; if (!taken.has(name.normalize('NFC').toLowerCase())) return name; }
}

/**
 * base: {path: sha256 hex} at the last common point; mine, theirs: Map(path -> bytes). Returns
 * { unchanged, take: [{path, from:'mine'|'theirs'}], remove: [path], conflicts: [{path, kind:'both-changed'|'changed-deleted', keep:[...]}] }
 * plus `ops`: the file changes that turn `theirs` (the room) into the merged project, ready for fs() after confirmation.
 */
export async function planMerge(base, mine, theirs) {
  const digest = async map => new Map(await Promise.all([...map].map(async ([p, b]) => [p, await sha256(b)])));
  const [dm, dt] = await Promise.all([digest(mine), digest(theirs)]);
  const plan = { unchanged: [], take: [], remove: [], conflicts: [], ops: [] };
  const taken = new Set([...mine.keys(), ...theirs.keys()].map(p => p.normalize('NFC').toLowerCase()));
  for (const path of [...new Set([...Object.keys(base), ...mine.keys(), ...theirs.keys()])].sort()) {
    if (!validPath(path)) throw Error('Invalid project path');
    const b = base[path] ?? null, m = dm.get(path) ?? null, t = dt.get(path) ?? null;
    if (m === t) { plan.unchanged.push(path); continue; }                    // same on both sides (also: both deleted)
    if (m === b) { plan.take.push({ path, from: 'theirs' }); continue; }       // only the room changed it
    if (t === b) {                                                             // only this copy changed it
      if (m === null) { plan.remove.push(path); plan.ops.push({ kind: 'remove', from: path }); }
      // shortcut: replacing the main document this way is refused by the project tree (it cannot be deleted); apply that one as a text edit in the editor
      else { plan.take.push({ path, from: 'mine' }); if (t !== null) plan.ops.push({ kind: 'remove', from: path }); plan.ops.push(put(path, mine.get(path))); }
      continue;
    }
    // both changed differently, or one deleted what the other changed: keep every surviving version
    if (m === null) { plan.conflicts.push({ path, kind: 'changed-deleted', keep: ['theirs'] }); continue; }
    if (t === null) { plan.conflicts.push({ path, kind: 'changed-deleted', keep: ['mine'] }); plan.ops.push(put(path, mine.get(path))); continue; }
    if (equal(mine.get(path), theirs.get(path))) { plan.unchanged.push(path); continue; }
    const other = keepName(path, taken); taken.add(other.normalize('NFC').toLowerCase());
    plan.conflicts.push({ path, kind: 'both-changed', keep: ['theirs', 'mine'], mine: other });
    plan.ops.push(put(other, mine.get(path)));
  }
  return plan;
}
