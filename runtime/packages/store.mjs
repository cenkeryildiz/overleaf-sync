// SPDX-License-Identifier: AGPL-3.0-only
// TEX-PKG-01/02 in the browser: the signed TeX Live catalog, an app-owned package store (IndexedDB) and the install flow
// fetch -> SHA-512 from the signed catalog -> xz -> bounded tar -> exact runfiles -> one atomic activation. Nothing here
// runs TeX code or is called on open/import/join; every network request is a user's Refresh or Install.
import { parseTlpdb, closure, fileIndex, unsupported, fontMaps } from './tlpdb.mjs';
import { readTar } from './tar.mjs';
import { rsaKeys, verifyDetached } from './openpgp.mjs';

// CTAN mirrors, tried in order. Mirrors send no CORS headers, so each host is named in the manifest's host_permissions and
// CSP (mirror.ctan.org's redirects go to any host and would need access to every site). Keep this list and the manifest equal.
export const MIRRORS = ["https://ftp.fau.de/ctan", "https://mirror.init7.net/ctan", "https://ftp.snt.utwente.nl/pub/software/tex", "https://ctan.mirror.garr.it/mirrors/ctan", "https://mirrors.mit.edu/CTAN", "https://ctan.math.illinois.edu", "https://mirror.aarnet.edu.au/pub/CTAN", "https://mirrors.tuna.tsinghua.edu.cn/CTAN"].map(base => base + '/systems/texlive/tlnet');
const LIMIT = { catalogXz: 16 << 20, catalog: 64 << 20, archive: 64 << 20, unpacked: 256 << 20 };
const BUNDLES = ['basic', 'recommended', 'extra'].map(name => `/recovery/busytex/texlive-${name}.txt`);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;

// ---------------------------------------------------------------- IndexedDB: catalog (one record) and packages (active + previous)
let opened = null;
const db = () => opened ??= new Promise((resolve, reject) => { const r = indexedDB.open('olx-packages', 1);
  r.onupgradeneeded = () => { r.result.createObjectStore('catalog'); r.result.createObjectStore('packages', { keyPath: 'name' }); };
  r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error ?? Error('Package storage is unavailable')); });
const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const done = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error ?? Error('Package storage write failed; nothing was changed')); });
async function read(store, key) { return request((await db()).transaction(store).objectStore(store)[key === undefined ? 'getAll' : 'get'](key)); }

let catalogCache = null;
/** The verified catalog, or null before the first Refresh. {fetchedAt, mirror, revision, db: Map, index: Map, bundled: Set} */
export async function catalog() {
  if (catalogCache) return catalogCache;
  const saved = await read('catalog', 'current'); if (!saved) return null;
  const map = new Map(saved.packages.map(p => [p.name, p]));
  return catalogCache = { fetchedAt: saved.fetchedAt, mirror: saved.mirror, db: map, index: fileIndex(map), bundled: new Set(saved.bundled), bundledFiles: await bundledFiles() };
}
let bundledCache = null;
async function bundledFiles() {   // basenames shipped in the compiler bundles (from the bundles' own file lists)
  if (bundledCache) return bundledCache;
  const names = new Set(), paths = new Set();
  for (const url of BUNDLES) for (const line of (await (await fetch(url)).text()).split('\n')) { const i = line.indexOf('texmf-dist/'); if (i >= 0) { const p = line.slice(i + 11).trim(); paths.add(p); names.add(p.slice(p.lastIndexOf('/') + 1)); } }
  return bundledCache = { names, paths };
}

// ---------------------------------------------------------------- bounded network + xz
async function get(url, max, signal) {
  let response; try { response = await fetch(url, { signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error' }); }
  catch (error) { if (signal?.aborted) throw Error('Canceled; nothing was changed'); throw Error('Could not reach a TeX Live mirror (offline?); nothing was changed'); }
  if (!response.ok) throw Error(`The mirror answered ${response.status} for ${url.split('/').pop()}`);
  return { response, bytes: await bounded(response.body, max, 'The download is larger than expected; nothing was installed') };
}
async function bounded(stream, max, message, copy = false) {   // copy: xzwasm enqueues views of its reused wasm output buffer
  const reader = stream.getReader(), parts = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; if ((size += value.length) > max) throw Error(message); parts.push(copy ? value.slice() : value); } }
  finally { reader.releaseLock?.(); }
  const out = new Uint8Array(size); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out;
}
let xz = null;
export async function unxz(bytes, max) {   // exported for the decompression-bomb check
  xz ??= import('/extension/packages/xzwasm.min.js').then(() => globalThis.xzwasm);   // UMD: sets self.xzwasm
  const { XzReadableStream } = await xz;
  try { return await bounded(new XzReadableStream(new Blob([bytes]).stream()), max, 'The archive expands beyond the size limit; nothing was installed', true); }
  catch (error) { if (/size limit/.test(error.message)) throw error; throw Error('The archive is corrupt; nothing was installed'); }
}
/** The first mirror that answers: an unreachable or 5xx/404 mirror moves on to the next; other failures are final. */
async function anyMirror(bases, attempt, signal) {
  let last;
  for (const mirror of bases) { try { return { mirror, value: await attempt(mirror) }; } catch (error) { last = error; if (signal?.aborted || !/answered (?:5\d\d|404)|Could not reach/.test(error.message)) throw error; } }
  throw last;
}
const sha512 = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-512', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------- Refresh: one mirror for all three files, signature, checksum
export async function refreshCatalog({ signal, progress = () => {} } = {}) {
  progress('Contacting a TeX Live mirror…');
  const { mirror, value: first } = await anyMirror(MIRRORS, base => get(`${base}/tlpkg/texlive.tlpdb.sha512`, 4096, signal), signal);   // then every file from that one mirror (mirrors drift)
  const checksum = new TextDecoder().decode(first.bytes), signature = new TextDecoder().decode((await get(`${mirror}/tlpkg/texlive.tlpdb.sha512.asc`, 8192, signal)).bytes);
  const keys = await rsaKeys(await (await fetch('/extension/packages/texlive.asc')).text());
  if (!await verifyDetached(checksum, signature, keys)) throw Error('The package list signature is not valid for the TeX Live key; nothing was changed');
  const expected = checksum.match(/^([0-9a-f]{128})\s+\*?texlive\.tlpdb\s*$/)?.[1]; if (!expected) throw Error('Unexpected package list checksum file; nothing was changed');
  progress('Downloading the package list…');
  const text = await unxz((await get(`${mirror}/tlpkg/texlive.tlpdb.xz`, LIMIT.catalogXz, signal)).bytes, LIMIT.catalog);
  if (await sha512(text) !== expected) throw Error('The package list does not match its signed checksum (the mirror may be updating); nothing was changed');
  progress('Checking which packages the compiler already has…');
  const parsed = parseTlpdb(new TextDecoder().decode(text)), { paths } = await bundledFiles();
  const bundled = [...parsed.values()].filter(p => p.runfiles.some(f => paths.has(f))).map(p => p.name);
  const record = { fetchedAt: Date.now(), mirror, packages: [...parsed.values()], bundled };
  const tx = (await db()).transaction('catalog', 'readwrite'); tx.objectStore('catalog').put(record, 'current'); await done(tx);
  catalogCache = null; return catalog();
}

// ---------------------------------------------------------------- status of what a project needs
/** files: TeX file names a project needs (x.sty, y.cls, z.bst …). Returns one row per file with where it comes from. */
export async function resolve(files, projectPaths = new Set()) {
  const cat = await catalog(), installed = new Map((await read('packages')).map(p => [p.name, p])), bundled = cat?.bundledFiles ?? await bundledFiles();
  const installedFiles = new Map(); for (const p of installed.values()) for (const f of p.current.files) installedFiles.set(f.path.slice(f.path.lastIndexOf('/') + 1), p.name);
  return [...new Set(files)].sort().map(file => {
    if ([...projectPaths].some(p => p === file || p.endsWith('/' + file))) return { file, state: 'project' };
    if (bundled.names.has(file)) return { file, state: 'bundled' };
    if (installedFiles.has(file)) return { file, state: 'installed', package: installedFiles.get(file), revision: installed.get(installedFiles.get(file)).current.revision };
    if (!cat) return { file, state: 'unknown', reason: 'Refresh the package list to look it up' };
    const name = cat.index.get(file); if (!name) return { file, state: 'unknown', reason: 'not found in TeX Live; it may be defined by a macro or come from the project' };
    const plan = closure(cat.db, [name], n => cat.bundled.has(n) || installed.has(n));
    const why = unsupported(cat.db.get(name)); if (why) return { file, state: 'unsupported', package: name, reason: why };
    return { file, state: 'missing', package: name, install: plan.install.map(p => p.name), bytes: plan.bytes, blocked: plan.blocked, license: cat.db.get(name).license };
  });
}

// ---------------------------------------------------------------- install / uninstall
let installing = null;
/** Installs `names` and their missing dependencies as one set: all activate together or nothing changes. */
export async function install(names, { signal, progress = () => {} } = {}) {
  if (installing) throw Error('Another installation is running; wait for it or cancel it');
  const mine = installing = (async () => {
    const cat = await catalog(); if (!cat) throw Error('Refresh the package list first (needs a connection)');
    if (!names.every(n => NAME.test(n))) throw Error('Invalid package name');
    const installed = new Map((await read('packages')).map(p => [p.name, p]));
    const plan = closure(cat.db, names, n => cat.bundled.has(n) || installed.get(n)?.current.revision === cat.db.get(n)?.revision);
    if (!plan.install.length) return [];   // already installed at this revision: no download, no write
    if (plan.blocked.length) throw Error('Cannot install: ' + plan.blocked.map(b => `${b.name} (${b.reason})`).join('; '));
    const staged = [];
    for (const [i, pkg] of plan.install.entries()) {
      signal?.throwIfAborted();
      progress(`Downloading ${pkg.name} (${i + 1} of ${plan.install.length}, ${Math.ceil(pkg.size / 1024)} KB)…`);
      const path = `/archive/${pkg.name}.tar.xz`, max = Math.min(LIMIT.archive, pkg.size + 4096);
      const { value: { bytes } } = await anyMirror([cat.mirror, ...MIRRORS.filter(m => m !== cat.mirror)], base => get(base + path, max, signal), signal);   // the list's mirror first; the checksum decides either way
      if (bytes.length !== pkg.size || await sha512(bytes) !== pkg.sha512) throw Error(`${pkg.name} on the mirror is not the version in the package list (it may have been updated); refresh the package list and try again. Nothing was installed.`);
      const entries = readTar(await unxz(bytes, LIMIT.unpacked)), wanted = new Set(pkg.runfiles);
      const files = entries.map(e => ({ path: e.path.replace(/^texmf-dist\//, ''), data: e.data })).filter(f => wanted.has(f.path));   // relocated packages (most) omit texmf-dist/
      if (files.length !== wanted.size) throw Error(`${pkg.name}: the archive does not contain exactly the files the package list names; nothing was installed`);
      staged.push({ name: pkg.name, revision: pkg.revision, sha512: pkg.sha512, license: pkg.license, size: files.reduce((s, f) => s + f.data.length, 0), files, maps: fontMaps(pkg) });
    }
    signal?.throwIfAborted();
    progress('Activating…');
    const tx = (await db()).transaction('packages', 'readwrite'), store = tx.objectStore('packages');
    for (const next of staged) store.put({ name: next.name, current: { ...next, installedAt: Date.now() }, previous: installed.get(next.name)?.current ?? null });
    await done(tx); compileSetCache = null;
    return staged.map(({ name, revision, size }) => ({ name, revision, size }));
  })();
  try { return await mine; } finally { if (installing === mine) installing = null; }
}
/** Packages installed here and which installed packages depend on each. */
export async function installed() {
  const all = await read('packages'), cat = await catalog();
  return all.map(p => ({ name: p.name, revision: p.current.revision, size: p.current.size, license: p.current.license, hasPrevious: !!p.previous,
    neededBy: all.filter(q => q.name !== p.name && cat?.db.get(q.name)?.depends.includes(p.name)).map(q => q.name) })).sort((a, b) => a.name.localeCompare(b.name));
}
export async function uninstall(name, { compiling = false } = {}) {
  if (compiling) throw Error('A compile is running; try again when it finishes');
  if (installing) throw Error('An installation is running; try again when it finishes');
  const tx = (await db()).transaction('packages', 'readwrite'); tx.objectStore('packages').delete(name); await done(tx); compileSetCache = null;
}
/** Switch a package back to the verified revision it replaced. */
export async function rollback(name) {
  const tx = (await db()).transaction('packages', 'readwrite'), store = tx.objectStore('packages'), p = await request(store.get(name));
  if (!p?.previous) throw Error('There is no earlier version to go back to');
  store.put({ name, current: p.previous, previous: null }); await done(tx); compileSetCache = null;
}

// ---------------------------------------------------------------- what a compile receives
let compileSetCache = null;
/** Snapshot for one compile: every installed package's files under .texmf/texmf-dist plus its ls-R, and the exact manifest. */
export async function compileSet() {
  if (compileSetCache) return compileSetCache;
  const all = typeof indexedDB === 'undefined' ? [] : await read('packages').catch(() => []);
  const files = all.flatMap(p => p.current.files.map(f => ({ path: '.texmf/texmf-dist/' + f.path, content: f.data })));
  const maps = all.flatMap(p => (p.current.maps ?? []).map(path => new TextDecoder().decode(p.current.files.find(f => f.path === path).data)));
  const mapPath = 'fonts/map/pdftex/olx/olx-packages.map';
  if (maps.length) files.push({ path: '.texmf/texmf-dist/' + mapPath, content: new TextEncoder().encode(maps.join('\n') + '\n') });
  if (files.length) files.push({ path: '.texmf/texmf-dist/ls-R', content: lsR([...all.flatMap(p => p.current.files.map(f => f.path)), ...(maps.length ? [mapPath] : [])]) });
  return compileSetCache = { files, manifest: all.map(p => ({ name: p.name, revision: p.current.revision, sha512: p.current.sha512 })).sort((a, b) => a.name.localeCompare(b.name)) };
}
/** kpathsea filename database for a TDS tree (TEXMFDIST trees are searched only through ls-R). */
export function lsR(paths) {
  const dirs = new Map([['.', new Set()]]);
  for (const path of paths) { const parts = path.split('/'); for (let i = 0; i < parts.length; i++) { const dir = ['.', ...parts.slice(0, i)].join('/'); if (!dirs.has(dir)) dirs.set(dir, new Set()); dirs.get(dir).add(parts[i]); } }
  return '% ls-R -- filename database for kpathsea; do not change this line.\n' + [...dirs].map(([dir, names]) => `${dir}:\n${[...names].sort().join('\n')}\n`).join('\n');
}
