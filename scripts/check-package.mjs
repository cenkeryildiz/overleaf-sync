import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './validate.mjs';

export function verifyAssets(manifest, read) {
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'planning' || manifest.applicationReady !== false
    || manifest.completedApplicationPhases !== 0 || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit ?? '')) {
    throw new Error('Invalid planning manifest');
  }
  const expectedRoles = ['implementation-plan', 'license', 'phase-status', 'source-archive'];
  if (!Array.isArray(manifest.assets) || manifest.assets.length !== expectedRoles.length) throw new Error('Missing assets');
  const names = new Set();
  for (const asset of manifest.assets) {
    if (!expectedRoles.includes(asset.role) || names.has(asset.name)
      || !/^[A-Za-z0-9.-]+$/.test(asset.name) || asset.name.includes('..')) throw new Error('Invalid/duplicate asset');
    names.add(asset.name);
    const bytes = read(asset.name);
    if (bytes.length !== asset.size || sha256(bytes) !== asset.sha256) throw new Error(`Asset integrity failure: ${asset.name}`);
  }
  if (new Set(manifest.assets.map(asset => asset.role)).size !== expectedRoles.length) throw new Error('Duplicate asset role');
}

export function checkPackage(directory = 'dist') {
  const files = readdirSync(directory);
  const manifests = files.filter(name => name.endsWith('-manifest.json'));
  if (manifests.length !== 1) throw new Error('Exactly one manifest required');
  const read = name => readFileSync(resolve(directory, name));
  const manifest = JSON.parse(read(manifests[0]));
  verifyAssets(manifest, read);
  const short = manifest.sourceCommit.slice(0, 12);
  const sumsName = `SHA256SUMS-${short}.txt`;
  const expected = new Set([...manifest.assets.map(asset => asset.name), manifests[0], sumsName]);
  if (files.length !== expected.size || files.some(name => !expected.has(name))) throw new Error('Unexpected package files');
  const sumLines = read(sumsName).toString().trim().split('\n');
  const seen = new Set();
  for (const line of sumLines) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9.-]+)$/.exec(line);
    if (!match || !expected.has(match[2]) || match[2] === sumsName || seen.has(match[2])
      || sha256(read(match[2])) !== match[1]) throw new Error('Invalid checksum file');
    seen.add(match[2]);
  }
  if (seen.size !== expected.size - 1) throw new Error('Incomplete checksum coverage');
  const archive = resolve(directory, manifest.assets.find(asset => asset.role === 'source-archive').name);
  for (const [path, role] of [['docs/COLLABORATIVE_LATEX_PLAN.md', 'implementation-plan'], ['LICENSE', 'license'], ['docs/phase-status.json', 'phase-status']]) {
    const unpacked = execFileSync('tar', ['-xOf', archive, path]);
    const asset = manifest.assets.find(item => item.role === role);
    if (sha256(unpacked) !== asset.sha256) throw new Error(`Archived file differs: ${path}`);
  }
  return { manifest, files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { manifest, files } = checkPackage(process.argv[2] ?? 'dist');
  console.log(`Verified ${files.length} planning assets and reopened source archive at ${manifest.sourceCommit}.`);
}
