// SPDX-License-Identifier: AGPL-3.0-only
// ANALYSIS-01 dependency invalidation: which outputs went stale, in what order to recompute, cycle refusal,
// and a coalescer that never overlaps runs. Pure logic: it executes nothing and reads no project.
const hash = text => { // cyrb53: staleness comparison only, not a security digest
  let a = 0xdeadbeef, b = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 2654435761); b = Math.imul(b ^ c, 1597334677); }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36);
};
export const MAX_NODES = 2000;

export class DependencyGraph {
  #nodes = new Map(); #done = new Map(); #keys = new Map();
  /** inputs: ids this node reads (data files, code cells, earlier results); digest: its own content/code digest. */
  set(id, { inputs = [], digest = '' } = {}) {
    if (typeof id !== 'string' || !id || (!this.#nodes.has(id) && this.#nodes.size >= MAX_NODES)) throw Error('Invalid or excessive node');
    if (!Array.isArray(inputs) || inputs.some(input => typeof input !== 'string')) throw Error('Invalid inputs');
    this.#nodes.set(id, { inputs: [...new Set(inputs)], digest: String(digest) }); this.#keys.clear();
  }
  remove(id) { this.#nodes.delete(id); this.#done.delete(id); this.#keys.clear(); }
  /** The first dependency cycle as an id path, or null. Iterative: a 2000-node chain must not overflow the stack. */
  cycle() {
    const state = new Map();
    for (const start of this.#nodes.keys()) {
      if (state.has(start)) continue;
      const stack = [[start, 0]], path = [start]; state.set(start, 1);
      while (stack.length) {
        const top = stack.at(-1), inputs = this.#nodes.get(top[0])?.inputs ?? [];
        if (top[1] === inputs.length) { state.set(top[0], 2); stack.pop(); path.pop(); continue; }
        const next = inputs[top[1]++];
        if (!this.#nodes.has(next)) continue;               // an input outside the graph is a missing dependency, not a cycle
        if (state.get(next) === 1) return [...path.slice(path.indexOf(next)), next];
        if (!state.has(next)) { state.set(next, 1); stack.push([next, 0]); path.push(next); }
      }
    }
    return null;
  }
  missing() { return [...this.#nodes].flatMap(([id, node]) => node.inputs.filter(input => !this.#nodes.has(input)).map(input => ({ id, input }))); }
  #key(id, seen = new Set()) {
    if (this.#keys.has(id)) return this.#keys.get(id);
    const node = this.#nodes.get(id); if (!node) return 'missing';
    if (seen.has(id)) throw Error('Dependency cycle');
    seen.add(id);
    const key = hash(`${node.digest}|${node.inputs.map(input => `${input}:${this.#key(input, seen)}`).join(',')}`);
    seen.delete(id); this.#keys.set(id, key); return key;
  }
  /** Record that `id` was computed from the current inputs and digest. */
  markFresh(id) { if (this.cycle()) throw Error('Dependency cycle'); this.#done.set(id, this.#key(id)); }
  isStale(id) { return this.#done.get(id) !== this.#key(id); }
  /** The input key of `id` (its digest and, recursively, its inputs'): stored beside an inserted result so staleness survives reload. */
  key(id) { if (this.cycle()) throw Error('Dependency cycle'); return this.#key(id); }
  /** Recompute order for everything stale (or only what `targets` need), dependencies first; refuses cycles and missing inputs. */
  plan(targets = [...this.#nodes.keys()]) {
    const cycle = this.cycle(); if (cycle) return { ok: false, reason: 'cycle', cycle };
    const missing = this.missing(); if (missing.length) return { ok: false, reason: 'missing', missing };
    const order = [], visited = new Set();
    const visit = id => {
      if (visited.has(id)) return; visited.add(id);
      for (const input of this.#nodes.get(id).inputs) visit(input);
      if (this.isStale(id)) order.push(id);
    };
    for (const id of targets) if (this.#nodes.has(id)) visit(id);
    return { ok: true, order };
  }
}

/**
 * Debounced, non-overlapping recompute: touches inside the window collapse into one run; a touch during a run
 * schedules exactly one follow-up after it. `run(ids)` receives the union of touched ids.
 */
export function coalescer(run, delayMs = 300, timers = { set: (fn, ms) => setTimeout(fn, ms), clear: id => clearTimeout(id) }) {   // bound: a browser's setTimeout throws when called as a method of another object
  let pending = new Set(), timer = null, running = null;
  const fire = async () => {
    timer = null;
    if (running) return;                       // the finishing run re-arms the timer
    const ids = [...pending]; pending = new Set();
    running = Promise.resolve().then(() => run(ids)).catch(() => {}).finally(() => { running = null; if (pending.size) arm(); });
    await running;
  };
  const arm = () => { if (!timer) timer = timers.set(fire, delayMs); };
  return {
    touch(...ids) { for (const id of ids) pending.add(id); arm(); },
    cancel() { pending.clear(); if (timer) timers.clear(timer); timer = null; },
    get busy() { return running !== null; },
    idle: async () => { while (timer || running) { await (running ?? new Promise(resolve => setTimeout(resolve, delayMs + 5))); } },
  };
}
