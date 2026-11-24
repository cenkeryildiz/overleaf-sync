// SPDX-License-Identifier: AGPL-3.0-only
// TEX-PKG pure modules: TeX Live signature check (real key and a real signed checksum), tlpdb parsing/closure/support,
// the bounded tar reader against hostile archives, ls-R and requirement detection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rsaKeys, verifyDetached, dearmor } from '../runtime/packages/openpgp.mjs';
import { parseTlpdb, closure, unsupported, fileIndex } from '../runtime/packages/tlpdb.mjs';
import { readTar } from '../runtime/packages/tar.mjs';
import { lsR, MIRRORS } from '../runtime/packages/store.mjs';
import { fromSources, fromLog } from '../runtime/packages/detect.mjs';

const fixture = name => readFileSync(new URL('fixtures/packages/' + name, import.meta.url), 'utf8');
const key = readFileSync(new URL('../runtime/packages/texlive.asc', import.meta.url), 'utf8');

test('the shipped key is TeX Live\'s published primary key and verifies the real signed checksum', async () => {
  const keys = await rsaKeys(key);
  assert.equal(keys[0].fingerprint, 'c78b82d8c79512f79cc0d7c80d5e5d9106bab6bc', 'published at tug.org/texlive/gpg.html');
  const message = fixture('texlive.tlpdb.sha512'), signature = fixture('texlive.tlpdb.sha512.asc');
  assert.equal(await verifyDetached(message, signature, keys), true);
  assert.equal(await verifyDetached((message[0] === '0' ? '1' : '0') + message.slice(1), signature, keys), false, 'one changed character');
  assert.equal(await verifyDetached(message, signature, keys.slice(0, 1)), false, 'signed by a subkey we do not hold');
  assert.equal(await verifyDetached(message.replace(/\n/g, '\r\n'), signature, keys), true, 'canonical-text signature: line endings normalised');
  assert.throws(() => dearmor('not armored'), /Not an armored/);
});

const sha = 'a'.repeat(128), entry = (name, extra = '') => `name ${name}\ncategory Package\nrevision 7\ncontainersize 100\ncontainerchecksum ${sha}\ncatalogue-license lppl1.3c\n${extra}runfiles size=1\n RELOC/tex/latex/${name}/${name}.sty\n`;
const db = parseTlpdb([entry('a', 'depend b\ndepend a.ARCH\n'), entry('b', 'depend c\ndepend a\n'), entry('c'), entry('font', 'execute addMap font.map\n'), entry('fmt', 'execute AddFormat name=x\n'),
  entry('nonfree', '').replace('lppl1.3c', 'nosell'), entry('nosum').replace(/containerchecksum .*\n/, ''), 'name coll\ncategory Collection\nrevision 1\n', ''].join('\n'));

test('tlpdb records, transitive closure with a cycle, and what the browser compiler cannot take', () => {
  assert.deepEqual(db.get('a').runfiles, ['tex/latex/a/a.sty']); assert.deepEqual(db.get('a').depends, ['b', 'a.ARCH']); assert.equal(db.get('a').revision, 7);
  const plan = closure(db, ['a'], name => name === 'c');
  assert.deepEqual(plan.install.map(p => p.name), ['a', 'b'], 'c is present, a↔b cycle visited once, .ARCH skipped'); assert.equal(plan.bytes, 200);
  assert.match(unsupported(db.get('font')), /font map/); assert.match(unsupported(db.get('fmt')), /format/); assert.match(unsupported(db.get('nonfree')), /licence nosell/);
  assert.match(unsupported(db.get('nosum')), /checksum/); assert.match(unsupported(db.get('coll')), /Collection/); assert.match(unsupported(undefined), /not in TeX Live/);
  assert.deepEqual(closure(db, ['font', 'missing'], () => false).blocked.map(b => b.name), ['font', 'missing']);
  assert.equal(fileIndex(db).get('b.sty'), 'b');
});

// ---- tar: a minimal ustar writer for well-formed and hostile entries
function tarEntry(name, data = '', type = '0', { checksum = true } = {}) {
  const header = new Uint8Array(512), put = (s, at) => header.set(new TextEncoder().encode(s), at), body = new TextEncoder().encode(data);
  put(name, 0); put('0000644\0', 100); put('0000000\0', 108); put('0000000\0', 116); put(body.length.toString(8).padStart(11, '0') + '\0', 124); put('00000000000\0', 136); put('        ', 148); put(type, 156); put('ustar\0', 257); put('00', 263);
  if (checksum) put(header.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  const padded = new Uint8Array(512 + Math.ceil(body.length / 512) * 512); padded.set(header); padded.set(body, 512); return padded;
}
const archive = (...parts) => { const all = [...parts, new Uint8Array(1024)], out = new Uint8Array(all.reduce((s, p) => s + p.length, 0)); let at = 0; for (const p of all) { out.set(p, at); at += p.length; } return out; };

test('tar reader returns regular files and refuses hostile or corrupt archives', () => {
  assert.deepEqual(readTar(archive(tarEntry('texmf-dist/', '', '5'), tarEntry('texmf-dist/tex/latex/a/a.sty', '\\ProvidesPackage{a}'))).map(f => [f.path, new TextDecoder().decode(f.data)]), [['texmf-dist/tex/latex/a/a.sty', '\\ProvidesPackage{a}']]);
  assert.equal(readTar(archive(tarEntry('././@LongLink', 'texmf-dist/' + 'x'.repeat(150) + '.sty', 'L'), tarEntry('short', 'y'))).at(0).path, 'texmf-dist/' + 'x'.repeat(150) + '.sty', 'GNU long names');
  for (const [entry, pattern] of [[tarEntry('../evil.sty', 'x'), /not allowed/], [tarEntry('/etc/evil', 'x'), /not allowed/], [tarEntry('texmf-dist/a/../../b', 'x'), /not allowed/],
    [tarEntry('texmf-dist/link', '', '2'), /not a regular file/], [tarEntry('texmf-dist/hard', '', '1'), /not a regular file/], [tarEntry('texmf-dist/dev', '', '3'), /not a regular file/],
    [tarEntry('texmf-dist/a.sty', 'x', '0', { checksum: false }), /Corrupt archive header/]]) assert.throws(() => readTar(archive(entry)), pattern);
  const big = tarEntry('texmf-dist/big', 'z'.repeat(2000)); assert.throws(() => readTar(archive(big), { maxBytes: 1000 }), /size limit/);
  assert.throws(() => readTar(archive(tarEntry('a', '1'), tarEntry('b', '2')), { maxFiles: 1 }), /size limit/);
  assert.throws(() => readTar(big.subarray(0, 700)), /Truncated/);
});

test('ls-R lists every directory of the injected tree', () => {
  assert.equal(lsR(['tex/latex/a/a.sty', 'tex/latex/b/b.sty', 'fonts/tfm/x/x.tfm']),
    '% ls-R -- filename database for kpathsea; do not change this line.\n.:\nfonts\ntex\n\n./tex:\nlatex\n\n./tex/latex:\na\nb\n\n./tex/latex/a:\na.sty\n\n./tex/latex/b:\nb.sty\n\n./fonts:\ntfm\n\n./fonts/tfm:\nx\n\n./fonts/tfm/x:\nx.tfm\n');
});

test('requirements from sources are hints; the log names what TeX could not find', () => {
  const sources = [{ path: 'main.tex', content: '\\documentclass[11pt]{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage{accents, algxpar}\n% \\usepackage{commented}\n\\usetheme{Madrid}\\usecolortheme{beaver}\n\\bibliographystyle{abbrvnat}\n\\usepackage{\\csname x\\endcsname}\n' },
    { path: 'data.csv', content: '\\usepackage{ignored}' }, { path: 'fig.png', content: undefined }];
  assert.deepEqual(fromSources(sources).sort(), ['abbrvnat.bst', 'accents.sty', 'algxpar.sty', 'article.cls', 'beamercolorthemebeaver.sty', 'beamerthemeMadrid.sty', 'inputenc.sty']);
  assert.deepEqual(fromLog("! LaTeX Error: File `accents.sty' not found.\n! I can't find file `chapter1'.\n! LaTeX Error: File `../../etc/x' not found."), ['accents.sty', 'chapter1.tex']);
});

test('every mirror the store may contact is named in the manifest, and nothing else over HTTPS', () => {
  const manifest = JSON.parse(readFileSync(new URL('../runtime/chrome-extension/manifest.json', import.meta.url), 'utf8')), origins = [...new Set(MIRRORS.map(m => new URL(m).origin))];
  assert.deepEqual(manifest.host_permissions.filter(h => h.startsWith('https:')), origins.map(o => o + '/*'));
  assert.deepEqual(manifest.content_security_policy.extension_pages.match(/connect-src ([^;]*)/)[1].split(' ').filter(s => s.startsWith('https:')), origins);
  assert.ok(MIRRORS.every(m => m.startsWith('https://') && m.endsWith('/systems/texlive/tlnet')));
  const sw = readFileSync(new URL('../runtime/browser-recovery/recovery-sw.template.js', import.meta.url), 'utf8');
  assert.deepEqual(JSON.parse(sw.match(/const MIRROR_ORIGINS = new Set\((\[[^\]]*\])\)/)[1]), origins, 'the service worker passes exactly these origins through');
});
