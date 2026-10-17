import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export function parseGateIndex(plan) {
  const start = '<!-- gate-index:start -->';
  const end = '<!-- gate-index:end -->';
  if (plan.split(start).length !== 2 || plan.split(end).length !== 2 || plan.indexOf(end) < plan.indexOf(start)) throw new Error('Missing or duplicate ranked gate index');
  const rows = plan.slice(plan.indexOf(start) + start.length, plan.indexOf(end)).split('\n').filter(line => /^\| \d+ \|/.test(line));
  if (rows.length !== 50) throw new Error('Ranked gate index requires 50 gates');
  const seen = new Set();
  return rows.map((line, index) => {
    const parts = line.split('|').map(part => part.trim());
    const [empty, rank, tier, wrappedId, assigned, criterion, tail] = parts;
    if (parts.length !== 7 || empty !== '' || tail !== '' || Number(rank) !== index + 1 || !criterion) throw new Error('Invalid gate index row');
    const id = /^`([A-Z][A-Z0-9-]+)`$/.exec(wrappedId)?.[1];
    if (!id || seen.has(id)) throw new Error('Invalid or duplicate gate ID');
    seen.add(id);
    const expectedTier = index < 12 ? 'A' : index < 28 ? 'B' : index < 46 ? 'C' : 'D';
    if (tier !== expectedTier) throw new Error('Invalid gate tier');
    const phases = assigned.split(', ');
    const expected = /^R[0-7]-/.test(id) ? [id.slice(0, 2)]
      : id === 'INDEPENDENT-REVIEW' ? ['R1', 'R4', 'R7']
      : ['SEC-REGRESSION', 'PERF-REGRESSION'].includes(id) ? Array.from({ length: 8 }, (_, i) => 'R' + i) : [];
    if (!expected.length || JSON.stringify(phases) !== JSON.stringify(expected)) throw new Error('Invalid gate phase assignment');
    return { rank: Number(rank), tier, id, phases, criterion };
  });
}
const gatesByPhase = index => Array.from({ length: 8 }, (_, i) => index.filter(gate => gate.phases.includes('R' + i)).map(gate => gate.id));
export const gateIds = gatesByPhase(parseGateIndex(readFileSync(new URL('../docs/COLLABORATIVE_LATEX_PLAN.md', import.meta.url), 'utf8')));
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
const text = value => typeof value === 'string' && value.trim().length > 0;

export function validateState(state, read = () => { throw new Error('Evidence is unavailable'); }, requiredGates = gateIds) {
  requireThat(state.schemaVersion === 2, 'Unsupported phase schema');
  requireThat(['planning', 'development', 'candidate', 'production'].includes(state.releaseStage), 'Invalid release stage');
  requireThat(Array.isArray(state.phases) && state.phases.length === 8, 'Exactly eight phases required');
  let priorPassed = true;
  for (const [index, phase] of state.phases.entries()) {
    requireThat(phase.id === `R${index}` && text(phase.name), 'Invalid phase identity/order');
    requireThat(['not_started', 'in_progress', 'blocked', 'passed'].includes(phase.status), 'Invalid phase status');
    requireThat(priorPassed || phase.status === 'not_started', `Phase ${phase.id} started before its predecessor passed`);
    if (phase.status !== 'passed') {
      requireThat(phase.evidence === null, 'Unpassed phase cannot claim passing evidence');
      priorPassed = false;
      continue;
    }
    const directory = `docs/validation/phase-${phase.id}/`;
    requireThat(phase.evidence === `${directory}report.json`, 'Invalid evidence report path');
    const report = JSON.parse(read(phase.evidence).toString());
    requireThat(report.phase === phase.id && report.result === 'passed', 'Evidence phase/result mismatch');
    requireThat(/^[a-f0-9]{40}$/.test(report.sourceCommit ?? ''), 'Missing tested commit');
    requireThat(text(report.testedAt) && Number.isFinite(Date.parse(report.testedAt)), 'Missing test timestamp');
    requireThat(report.blockingDefects === 0, 'Unresolved blocking defects');
    requireThat(Array.isArray(report.checks) && report.checks.length > 0, 'Missing check results');
    for (const id of requiredGates[index]) {
      requireThat(report.checks.some(check => check.id === id), `Missing gate ${id}`);
    }
    for (const check of report.checks) {
      requireThat(requiredGates[index].includes(check.id), 'Unknown required check');
      requireThat(check.result === 'passed' && check.skipped === false, 'Failed/skipped required check');
      requireThat(text(check.command) && text(check.environment), 'Missing command/environment');
      requireThat(typeof check.log === 'string' && check.log.startsWith(directory)
        && !check.log.includes('..') && !check.log.includes('\\'), 'Invalid evidence log path');
      const log = read(check.log);
      requireThat(log.length > 0 && sha256(log) === check.sha256, 'Evidence log missing or hash mismatch');
    }
  }
  if (state.releaseStage === 'production') requireThat(priorPassed, 'Production requires all eight phases passed');
  if (state.releaseStage === 'candidate') requireThat(state.phases.slice(0, 5).every(phase => phase.status === 'passed'), 'Candidates require R0 through R4 passed');
  if (state.releaseStage === 'planning') requireThat(state.phases.every(phase => phase.status !== 'passed'), 'Planning release cannot claim completed application phases');
  return state;
}

export function validateRepository(root = process.cwd()) {
  const base = realpathSync(root);
  const read = name => {
    const target = realpathSync(resolve(base, name));
    const rel = relative(base, target);
    requireThat(!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`), 'Path escapes repository');
    return readFileSync(target);
  };
  const plan = read('docs/COLLABORATIVE_LATEX_PLAN.md').toString();
  const requiredGates = gatesByPhase(parseGateIndex(plan));
  const state = validateState(JSON.parse(read('docs/phase-status.json')), read, requiredGates);
  const phases = [...plan.matchAll(/^### Phase (R\d+) —/gm)].map(match => match[1]);
  requireThat(phases.length === 8 && phases.every((id, i) => id === `R${i}`), 'Plan must define exactly eight ordered phases');
  requireThat(!/\bM\d+\b/.test(plan), 'Stale milestone IDs remain in plan');
  requireThat((plan.match(/^```/gm) ?? []).length % 2 === 0, 'Unclosed plan code fence');
  requireThat((plan.match(/^### S\d+ —/gm) ?? []).length === 12, 'Missing simulation scenarios');
  for (const id of requiredGates.flat()) requireThat(plan.includes(`\`${id}\``), `Plan missing ${id}`);
  const pkg = JSON.parse(read('package.json'));
  requireThat(pkg.license === 'SEE LICENSE IN LICENSE' && pkg.private === true, 'Incorrect package licensing/publication policy');
  requireThat(pkg.publisher === 'cenker-local', 'Unexpected extension publisher');
  requireThat(read('LICENSE').toString().includes('PROPRIETARY — ALL RIGHTS RESERVED'), 'Missing proprietary notice');
  requireThat(read('README.md').toString().includes('releases/tag/latest'), 'Missing rolling release link');
  return state;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const state = validateRepository();
  console.log(`Validated eight sequential phases R0–R7; release stage: ${state.releaseStage}.`);
}
