import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateState, validateRepository, gateIds, sha256, parseGateIndex } from '../scripts/validate.mjs';
import { verifyAssets } from '../scripts/check-package.mjs';

const initial = () => ({ schemaVersion: 3, releaseStage: 'planning', releasePhase: null, phases: gateIds.map((_, i) => ({ id: `R${i}`, name: `Phase R${i}`, status: 'not_started', evidence: null })) });
const report = () => ({ phase: 'R0', result: 'passed', sourceCommit: 'a'.repeat(40), testedAt: '2026-10-09T12:00:00Z', blockingDefects: 0,
  checks: gateIds[0].map(id => ({ id, result: 'passed', skipped: false, command: 'synthetic validation fixture', environment: 'test fixture only', log: `docs/validation/phase-R0/${id}.log`, sha256: sha256('fixture output') })) });
const passedFirst = () => {
  const state = initial(); state.releaseStage = 'development';
  state.phases[0] = { ...state.phases[0], status: 'passed', evidence: 'docs/validation/phase-R0/report.json' };
  return state;
};
const reader = value => path => Buffer.from(path.endsWith('report.json') ? JSON.stringify(value) : 'fixture output');

test('repository plan and current state validate', () => assert.equal(validateRepository().phases.length, 8));
test('unstarted and first active phase are accepted', () => {
  validateState(initial()); const state = initial(); state.phases[0].status = 'in_progress'; validateState(state);
});
test('cannot skip an unfinished predecessor', () => {
  const state = initial(); state.phases[1].status = 'in_progress'; assert.throws(() => validateState(state), /predecessor/);
});
test('blocked phase prevents later work', () => {
  const state = initial(); state.phases[0].status = 'blocked'; state.phases[1].status = 'in_progress'; assert.throws(() => validateState(state), /predecessor/);
});
test('a ninth phase is rejected', () => {
  const state = initial(); state.phases.push({ id: 'R8' }); assert.throws(() => validateState(state), /eight/);
});
test('passing requires real readable evidence', () => assert.throws(() => validateState(passedFirst()), /unavailable/));
test('missing gate is rejected', () => {
  const evidence = report(); evidence.checks.pop(); assert.throws(() => validateState(passedFirst(), reader(evidence)), /Missing gate/);
});
test('skipped checks and blocking defects cannot pass', () => {
  const evidence = report(); evidence.checks[0].skipped = true;
  assert.throws(() => validateState(passedFirst(), reader(evidence)), /skipped/);
  evidence.checks[0].skipped = false; evidence.blockingDefects = 1;
  assert.throws(() => validateState(passedFirst(), reader(evidence)), /blocking/);
});
test('tampered logs cannot pass', () => {
  const evidence = report(); evidence.checks[0].sha256 = '0'.repeat(64);
  assert.throws(() => validateState(passedFirst(), reader(evidence)), /hash mismatch/);
});
test('valid synthetic evidence permits only the next phase', () => {
  const state = passedFirst(); state.phases[1].status = 'in_progress'; validateState(state, reader(report()));
  state.phases[2].status = 'in_progress'; assert.throws(() => validateState(state, reader(report())), /predecessor/);
});
test('package detects tampering, path traversal and duplicate roles', () => {
  const roles = ['implementation-plan', 'license', 'phase-status', 'source-archive'];
  const manifest = { schemaVersion: 1, kind: 'planning', applicationReady: false, completedApplicationPhases: 0, sourceCommit: 'a'.repeat(40),
    assets: roles.map((role,i) => ({ name: `file-${i}.txt`, role, size: 4, sha256: sha256('data') })) };
  verifyAssets(manifest, () => Buffer.from('data'));
  assert.throws(() => verifyAssets(manifest, () => Buffer.from('evil')), /integrity/);
  manifest.assets[0].name = '../secret'; assert.throws(() => verifyAssets(manifest, () => Buffer.from('data')), /Invalid/);
  manifest.assets[0].name = 'file-0.txt'; manifest.assets[0].role = roles[1];
  assert.throws(() => verifyAssets(manifest, () => Buffer.from('data')), /Duplicate asset role/);
});

test('old schema and reordered identities are rejected', () => {
  const state = initial(); state.schemaVersion = 1; assert.throws(() => validateState(state), /schema/);
  state.schemaVersion = 3; state.phases[0].id = 'R1'; assert.throws(() => validateState(state), /identity/);
});
test('early feasibility and actual release checks are mandatory', () => {
  for (const id of ['R0-FEASIBILITY', 'RELEASE-CHECK']) {
    const evidence = report(); evidence.checks = evidence.checks.filter(check => check.id !== id);
    assert.throws(() => validateState(passedFirst(), reader(evidence)), /Missing gate/);
  }
});
test('R0 can release independently but cannot claim R1 or planning completion', () => {
  const state = passedFirst(); state.releasePhase = 'R0';
  for (const stage of ['candidate', 'production']) {
    state.releaseStage = stage; validateState(state, reader(report()));
  }
  state.releasePhase = 'R1'; assert.throws(() => validateState(state, reader(report())), /prerequisite/);
  state.releaseStage = 'planning'; state.releasePhase = null;
  assert.throws(() => validateState(state, reader(report())), /Planning release/);
});

test('release targets are required only for candidate and production', () => {
  const state = initial(); state.releasePhase = 'R0'; assert.throws(() => validateState(state), /target/);
  state.releaseStage = 'candidate';
  for (const target of [null, 'R8', 'R0junk', ['R0'], 0]) {
    state.releasePhase = target; assert.throws(() => validateState(state), /target/);
  }
  state.releasePhase = 'R0'; assert.throws(() => validateState(state), /prerequisite/);
});

test('every increment can release while later phases remain unstarted', () => {
  const state = initial(); state.releaseStage = 'development';
  const evidenceFiles = new Map();
  const read = path => { assert.ok(evidenceFiles.has(path)); return evidenceFiles.get(path); };
  for (let i = 0; i < 8; i++) {
    const phase = state.phases[i]; const directory = `docs/validation/phase-${phase.id}/`;
    const evidence = { ...report(), phase: phase.id, checks: gateIds[i].map(id => {
      const log = `${directory}${id}.log`; const output = Buffer.from('synthetic validator fixture');
      evidenceFiles.set(log, output);
      return { id, result: 'passed', skipped: false, command: 'validator fixture only', environment: 'synthetic', log, sha256: sha256(output) };
    }) };
    phase.status = 'passed'; phase.evidence = `${directory}report.json`;
    evidenceFiles.set(phase.evidence, Buffer.from(JSON.stringify(evidence)));
    state.releasePhase = phase.id;
    for (const stage of ['candidate', 'production']) {
      state.releaseStage = stage; validateState(state, read);
    }
    if (i < 7) {
      state.releasePhase = `R${i + 1}`;
      assert.throws(() => validateState(state, read), /prerequisite/);
    }
  }
  state.phases[2].status = 'blocked'; state.phases[2].evidence = null;
  assert.throws(() => validateState(state, read), /predecessor/);
});

test('release gate table controls assignment without fixed quotas', () => {
  const plan = readFileSync(new URL('../docs/COLLABORATIVE_LATEX_PLAN.md', import.meta.url), 'utf8');
  const index = parseGateIndex(plan); assert.ok(index.some(gate => gate.id === 'R0-FEASIBILITY'));
  for (let i = 0; i < 8; i++) {
    assert.ok(gateIds[i].includes('RELEASE-CHECK'));
    assert.ok(!gateIds[i].includes('SEC-REGRESSION'));
    assert.ok(!gateIds[i].includes('PERF-REGRESSION'));
  }
  assert.throws(() => parseGateIndex(plan.replace('`R1-MIRROR` | R1 |', '`R1-MIRROR` | R0 |')), /assignment/);
  assert.throws(() => parseGateIndex(plan.replace('| 11 | release |', '| 10 | release |')), /row/);
  assert.throws(() => parseGateIndex(plan.replace('<!-- gate-index:end -->', '')), /index/);
  assert.throws(() => parseGateIndex(plan.replace('`R0-LOCAL`', '`R0-FEASIBILITY`')), /duplicate/);
  assert.throws(() => parseGateIndex('<!-- gate-index:start -->\n<!-- gate-index:end -->'), /empty/);
});
