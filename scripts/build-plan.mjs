import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { validateRepository, sha256 } from './validate.mjs';

const state = validateRepository();
if (state.releaseStage !== 'planning') throw new Error('Planning builder cannot publish application candidates; implement the required native pipeline first.');
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (git(['status', '--porcelain'])) throw new Error('Commit intended inputs before building the exact source artifact.');
const sourceCommit = git(['rev-parse', 'HEAD']);
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sourceCommit) throw new Error('CI source commit mismatch');
const short = sourceCommit.slice(0, 12);
const prefix = `overleaf-sync-${short}`;
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
const assets = [];
function add(name, data, role) {
  writeFileSync(`dist/${name}`, data);
  assets.push({ name, role, size: Buffer.byteLength(data), sha256: sha256(data) });
}
add(`${prefix}-plan.md`, readFileSync('docs/COLLABORATIVE_LATEX_PLAN.md'), 'implementation-plan');
add(`${prefix}-LICENSE.txt`, readFileSync('LICENSE'), 'license');
add(`${prefix}-phases.json`, readFileSync('docs/phase-status.json'), 'phase-status');
const archive = `${prefix}-source.tar.gz`;
execFileSync('git', ['archive', '--format=tar.gz', `--output=${resolve('dist', archive)}`, sourceCommit]);
const archiveBytes = readFileSync(`dist/${archive}`);
assets.push({ name: archive, role: 'source-archive', size: archiveBytes.length, sha256: sha256(archiveBytes) });
const manifest = {
  schemaVersion: 1, kind: 'planning', version: JSON.parse(readFileSync('package.json')).version,
  sourceCommit, applicationReady: false, completedApplicationPhases: 0, assets,
};
const manifestName = `${prefix}-manifest.json`;
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(`dist/${manifestName}`, manifestBytes);
const checksums = [...assets, { name: manifestName, sha256: sha256(manifestBytes) }];
writeFileSync(`dist/SHA256SUMS-${short}.txt`, checksums.map(asset => `${asset.sha256}  ${asset.name}\n`).join(''));
console.log(`Built planning assets from ${sourceCommit}; no VSIX is produced.`);
