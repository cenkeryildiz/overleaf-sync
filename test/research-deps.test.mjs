// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { DependencyGraph, coalescer, MAX_NODES } from '../runtime/research/deps.mjs';

const analysis = () => {
  const g = new DependencyGraph();
  g.set('data.csv', { digest: 'd1' }); g.set('clean', { inputs: ['data.csv'], digest: 'c1' });
  g.set('model', { inputs: ['clean'], digest: 'm1' }); g.set('table', { inputs: ['model'], digest: 't1' }); g.set('figure', { inputs: ['clean'], digest: 'f1' });
  g.set('other', { digest: 'o1' });
  for (const id of ['data.csv', 'clean', 'model', 'table', 'figure', 'other']) g.markFresh(id);
  return g;
};

test('a change makes only downstream outputs stale, and recompute order puts dependencies first', () => {
  const g = analysis();
  assert.deepEqual(g.plan(), { ok: true, order: [] });
  g.set('clean', { inputs: ['data.csv'], digest: 'c2' });
  assert.deepEqual(['data.csv', 'clean', 'model', 'table', 'figure', 'other'].filter(id => g.isStale(id)), ['clean', 'model', 'table', 'figure']);
  const { order } = g.plan();
  assert.deepEqual(new Set(order), new Set(['clean', 'model', 'table', 'figure']));
  assert.ok(order.indexOf('clean') < order.indexOf('model') && order.indexOf('model') < order.indexOf('table') && order.indexOf('clean') < order.indexOf('figure'));
  assert.deepEqual(g.plan(['figure']).order, ['clean', 'figure']);       // only what the target needs
  for (const id of order) g.markFresh(id);
  assert.deepEqual(g.plan().order, []);
});

test('reverting a change makes it fresh again, a changed input list is a change, and a failure leaves the old result stale', () => {
  const g = analysis();
  g.set('model', { inputs: ['clean'], digest: 'm2' }); assert.ok(g.isStale('model') && g.isStale('table'));
  g.set('model', { inputs: ['clean'], digest: 'm1' }); assert.ok(!g.isStale('model') && !g.isStale('table'));
  g.set('table', { inputs: ['model', 'other'], digest: 't1' }); assert.ok(g.isStale('table'));
  // model recompute "fails": not marked fresh, so the table cannot be published as current
  g.set('data.csv', { digest: 'd2' }); g.markFresh('data.csv'); g.markFresh('clean');
  assert.ok(g.isStale('model') && g.isStale('table'));
});

test('cycles and missing inputs are refused with the path, self-loops included, and never loop', () => {
  const g = analysis();
  g.set('clean', { inputs: ['table'], digest: 'c1' });
  const plan = g.plan();
  assert.equal(plan.reason, 'cycle'); assert.deepEqual(plan.cycle.slice(0, -1).sort(), ['clean', 'model', 'table']); assert.equal(plan.cycle[0], plan.cycle.at(-1));
  assert.throws(() => g.markFresh('model'), /cycle/);
  g.set('clean', { inputs: ['clean'] }); assert.deepEqual(g.cycle(), ['clean', 'clean']);
  g.set('clean', { inputs: ['data.csv'], digest: 'c1' }); g.set('model', { inputs: ['gone.csv'], digest: 'm1' });
  assert.deepEqual(g.plan(), { ok: false, reason: 'missing', missing: [{ id: 'model', input: 'gone.csv' }] });
});

test('bounded size: a 2000-node chain and a deep diamond lattice stay fast and do not overflow', () => {
  const g = new DependencyGraph(); g.set('n0', { digest: 'x' });
  for (let i = 1; i < MAX_NODES; i++) g.set(`n${i}`, { inputs: [`n${i - 1}`, ...(i > 1 ? [`n${i - 2}`] : [])], digest: String(i) });
  const started = performance.now(); assert.equal(g.cycle(), null); assert.equal(g.plan().order.length, MAX_NODES);
  assert.ok(performance.now() - started < 1500);
  assert.throws(() => g.set('extra', {}), /excessive/); assert.throws(() => g.set('', {}), /Invalid/);
});

test('coalescer collapses bursts, never overlaps runs and runs one follow-up for edits during a run', async () => {
  const runs = []; let release, active = 0, maxActive = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const c = coalescer(async ids => { active++; maxActive = Math.max(maxActive, active); runs.push(ids.sort()); if (runs.length === 1) await gate; active--; }, 20);
  c.touch('a'); c.touch('b', 'a'); c.touch('c');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(runs, [['a', 'b', 'c']]); assert.ok(c.busy);
  c.touch('d'); c.touch('e'); await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(runs.length, 1);                       // still running: nothing overlaps
  release(); await c.idle();
  assert.deepEqual(runs, [['a', 'b', 'c'], ['d', 'e']]); assert.equal(maxActive, 1);
  const failing = coalescer(async () => { throw Error('boom'); }, 5); failing.touch('x'); await failing.idle();
  c.touch('z'); c.cancel(); await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(runs.length, 2);
});
