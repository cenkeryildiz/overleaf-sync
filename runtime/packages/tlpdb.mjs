// SPDX-License-Identifier: AGPL-3.0-only
// TEX-PKG-01: TeX Live package database (texlive.tlpdb) -> package records, dependency closure and what the in-browser
// compiler can activate. Pure; the caller verifies the tlpdb's signature first (openpgp.mjs).
const NONFREE = new Set(['', 'noinfo', 'nosell', 'nocommercial', 'other-nonfree', 'unknown']);
const NEEDS = [[/^addKanjiMap\b/, 'Kanji font map'], [/^AddFormat\b/, 'format file'], [/^AddHyphen\b/, 'hyphenation patterns']];

/** Only declared, package-owned maps are activated; no updmap command is executed. */
export function fontMaps(pkg) {
  return pkg.executes.filter(e => /^add(?:Mixed)?Map\b/.test(e)).map(e => {
    const name = e.match(/^add(?:Mixed)?Map\s+([A-Za-z0-9][A-Za-z0-9._+-]*\.map)$/)?.[1];
    const paths = name ? pkg.runfiles.filter(p => p.startsWith('fonts/map/') && p.endsWith('/' + name)) : [];
    if (paths.length !== 1) throw Error('font map must name exactly one file in this package');
    return paths[0];
  });
}

/** One entry per package: {name, revision, category, depends, runfiles (texmf-dist relative), size, sha512, license, shortdesc, executes}. */
export function parseTlpdb(text) {
  const db = new Map(); let cur = null, section = null;
  for (const line of text.split('\n')) {
    if (!line) { cur = section = null; continue; }
    if (line.startsWith('name ')) { cur = { name: line.slice(5), revision: 0, category: '', depends: [], runfiles: [], size: 0, sha512: '', license: '', shortdesc: '', executes: [] }; db.set(cur.name, cur); section = null; continue; }
    if (!cur) continue;
    if (line[0] === ' ') { if (section === 'run') cur.runfiles.push(line.trim().split(' ')[0].replace(/^(?:RELOC|texmf-dist)\//, '')); continue; }
    const space = line.indexOf(' '), key = space < 0 ? line : line.slice(0, space), value = space < 0 ? '' : line.slice(space + 1);
    section = key === 'runfiles' ? 'run' : null;
    if (key === 'revision') cur.revision = Number(value);
    else if (key === 'category') cur.category = value;
    else if (key === 'depend') cur.depends.push(value);
    else if (key === 'containersize') cur.size = Number(value);
    else if (key === 'containerchecksum') cur.sha512 = value;
    else if (key === 'catalogue-license') cur.license = value;
    else if (key === 'shortdesc') cur.shortdesc = value;
    else if (key === 'execute') cur.executes.push(value);
  }
  return db;
}

/** Why the in-browser compiler cannot use this package, or null when it can. */
export function unsupported(pkg) {
  if (!pkg) return 'not in TeX Live';
  if (pkg.category !== 'Package') return `a TeX Live ${pkg.category || 'entry'}, not a single package`;
  for (const exec of pkg.executes) for (const [pattern, what] of NEEDS) if (pattern.test(exec)) return `needs a ${what}, which the in-browser compiler cannot add`;
  try { fontMaps(pkg); } catch (error) { return error.message; }
  if (!/^[0-9a-f]{128}$/.test(pkg.sha512) || !(pkg.size > 0)) return 'has no checksum in the catalog';
  const licenses = pkg.license.split(/\s+/).filter(Boolean);
  if (!licenses.length || licenses.some(l => NONFREE.has(l))) return `licence ${pkg.license || 'not stated'} does not allow redistribution here`;
  return null;
}

/** Packages to install for `names`: transitive dependencies not already present; cycles are visited once. */
export function closure(db, names, present) {
  const install = [], blocked = [], seen = new Set(), queue = [...names];
  while (queue.length) {
    const name = queue.shift(); if (seen.has(name) || name.endsWith('.ARCH')) continue; seen.add(name);   // .ARCH: platform binaries, not TeX input
    if (present(name)) continue;
    const pkg = db.get(name), why = unsupported(pkg);
    if (why) { blocked.push({ name, reason: why }); continue; }
    install.push(pkg); queue.push(...pkg.depends);
  }
  return { install, blocked, bytes: install.reduce((sum, p) => sum + p.size, 0) };
}

const INPUT = /\.(?:sty|cls|clo|def|cfg|fd|ldf|tex|bst|bbx|cbx|lbx|dbx|tfm|vf|pfb|otf|ttf|enc|map|ist)$/i;
/** Basename -> package for TeX input files, to resolve "File `x.sty' not found" and \usepackage names. */
export function fileIndex(db) {
  const index = new Map();
  for (const pkg of db.values()) for (const path of pkg.runfiles) if (INPUT.test(path)) { const base = path.slice(path.lastIndexOf('/') + 1); if (!index.has(base)) index.set(base, pkg.name); }
  return index;
}
