import { readFileSync } from 'node:fs';
import { checkPackage } from './check-package.mjs';

const { manifest, files } = checkPackage();
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
if (!token || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('Missing release credentials/repository');
if (process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_SHA !== manifest.sourceCommit) throw new Error('Only the checked main commit may publish');
const base = `https://api.github.com/repos/${repository}`;
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
async function api(path, method = 'GET', data, missingOK = false) {
  const result = await fetch(`${base}${path}`, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  if (missingOK && result.status === 404) return null;
  if (!result.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${result.status}`);
  return result.status === 204 ? null : result.json();
}
const currentMain = async () => (await api('/git/ref/heads/main')).object.sha;
if (await currentMain() !== manifest.sourceCommit) {
  console.log('Newer main commit exists; this run will not publish.');
  process.exit(0);
}
let release = await api('/releases/tags/latest', 'GET', undefined, true);
if (release && (!release.prerelease || !release.name.startsWith('Planning prerelease'))) {
  throw new Error('Planning publisher cannot replace a non-planning release');
}
if (!release) release = await api('/releases', 'POST', {
  tag_name: 'latest', target_commitish: manifest.sourceCommit,
  name: 'Planning prerelease — no extension yet', prerelease: true,
  body: `Repository setup only. Preparing verified assets from ${manifest.sourceCommit}.`,
});
let assets = await api(`/releases/${release.id}/assets?per_page=100`);
const uploadBase = release.upload_url.split('{')[0];
if (new URL(uploadBase).hostname !== 'uploads.github.com') throw new Error('Unexpected upload destination');
for (const name of files) {
  const old = assets.find(asset => asset.name === name);
  if (old) await api(`/releases/assets/${old.id}`, 'DELETE');
  const response = await fetch(`${uploadBase}?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: readFileSync(`dist/${name}`),
  });
  if (!response.ok) throw new Error(`Uploading ${name}: HTTP ${response.status}`);
  const uploaded = await response.json();
  const downloaded = await fetch(uploaded.browser_download_url);
  if (!downloaded.ok) throw new Error(`Downloading ${name}: HTTP ${downloaded.status}`);
  const bytes = Buffer.from(await downloaded.arrayBuffer());
  if (!bytes.equals(readFileSync(`dist/${name}`))) throw new Error(`Published asset mismatch: ${name}`);
}
if (await currentMain() !== manifest.sourceCommit) throw new Error('Main changed during upload; leave prior release metadata intact and rerun latest main');
const tag = await api('/git/ref/tags/latest', 'GET', undefined, true);
if (tag) await api('/git/refs/tags/latest', 'PATCH', { sha: manifest.sourceCommit, force: true });
else await api('/git/refs', 'POST', { ref: 'refs/tags/latest', sha: manifest.sourceCommit });
const runUrl = `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`;
const body = [
  '**Planning prerelease only — no installable extension or deployed server yet.**',
  '', `Auto-published after repository checks passed on Linux, macOS and Windows.`,
  `Source commit: ${manifest.sourceCommit}`, `CI: ${runUrl}`, '',
  'Contains the eight-phase risk-first implementation plan, proprietary license, initial phase status, exact source archive and SHA-256 checksums.',
  'All application implementation phases are still unpassed. These checks do not establish application readiness.',
  '', ...files.map(name => `- ${name}`),
].join('\n');
await api(`/releases/${release.id}`, 'PATCH', {
  name: `Planning prerelease (${manifest.sourceCommit.slice(0, 12)}) — no extension yet`,
  body, prerelease: true, draft: false, target_commitish: manifest.sourceCommit,
});
assets = await api(`/releases/${release.id}/assets?per_page=100`);
for (const asset of assets) if (!files.includes(asset.name)) await api(`/releases/assets/${asset.id}`, 'DELETE');
console.log(`Published and re-downloaded ${files.length} verified assets: https://github.com/${repository}/releases/tag/latest`);
