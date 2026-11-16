// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { resolve, basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const assetName = 'codemirror-editor-57ce7aa576296ae31fad.js';
export function patchEditor(source, core, config) {
  const patches = [
    ['let{currentDoc:o}=e;const s=r.Z9.define', 'let{currentDoc:o,recoveryDocName:recoveryName}=e;const s=r.Z9.define'],
    ['(0,y.WU)(e.currentDoc,e.handleError)', '(0,y.WU)({...e.currentDoc,recoveryDocName:e.docName},e.handleError)'],
    ['return o.attachToCM6(t),{update(e){', 'return o.attachToCM6(t),globalThis.overleafRecovery.attach(t,o,recoveryName),{update(e){'],
    ['return n.Nb.highest([s,i])};class u extends s.EventEmitter', 'return n.Nb.highest([s,i,globalThis.overleafRecovery.extension(n.$t,n.ZX,o,recoveryName)])};class u extends s.EventEmitter'],
  ];
  for (const [from, to] of patches) {
    assert.equal(source.split(from).length - 1, 1, 'Unexpected or already patched editor'); source = source.replace(from, to);
  }
  return config + '\n' + core + '\n' + source;
}
export function patchLanUuid(source, core) {
  const start = core.indexOf('  function randomUUID()'), end = core.indexOf('  const entries =');
  assert(start >= 0 && end > start, 'UUID fallback source missing');
  const patches = [
    ['  const writer = globalThis.crypto.randomUUID();', core.slice(start, end).trimEnd()],
    ['writer: globalThis.crypto.randomUUID(),', 'writer: randomUUID(),'],
  ];
  for (const [from, to] of patches) {
    assert.equal(source.split(from).length - 1, 1, 'Installed recovery UUID anchors differ'); source = source.replace(from, to);
  }
  return source;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  assert(input && output && basename(resolve(output)) === 'browser-recovery', 'Use an original editor bundle and a dedicated browser-recovery output directory');
  const original = readFileSync(input, 'utf8');
  assert.equal(hash(original), '9a78a0a8b867dec0d7e54357f4d78343fd9311e9fadc791950f25e263adedd24', 'Pinned native editor hash mismatch');
  const files = new Map();
  for (const name of ['recovery-core.js', 'review.js', 'review.css', 'local-workspace.html', 'local-workspace.js', 'workspace.css', 'LICENSE', 'CODEMIRROR-LICENSES.txt', 'diff.min.js', 'DIFF-LICENSE.txt']) files.set(name, readFileSync(join(directory, name)));
  const native = [
    { path: '/js/runtime-0239170c7f0b0a6c5b25.js', sha256: 'd5a88ef72332d8a2facfe62fb20980771e1c987b73d77468dd2c9616b5df81b3', type: 'application/javascript' },
    { path: '/js/2313-773b8816086b1956f53c.js', sha256: 'a5d6a292a1ee6356aa77fd3979a913c51b9756b8fab3eef3ee28bc13af1d09b7', type: 'application/javascript' },
  ];
  const template = readFileSync(join(directory, 'recovery-sw.template.js'), 'utf8');
  const version = hash(Buffer.concat([...files.values(), Buffer.from(template), Buffer.from(JSON.stringify(native))])).slice(0, 20);
  const config = 'globalThis.overleafRecoveryBuild=' + JSON.stringify({ version }) + ';'; files.set('config.js', Buffer.from(config));
  const assets = [...files].filter(([name]) => name !== 'LICENSE').map(([name, bytes]) => ({ path: '/recovery/' + name, sha256: hash(bytes), type: name.endsWith('.html') ? 'text/html;charset=utf-8' : name.endsWith('.css') ? 'text/css' : name.endsWith('.txt') ? 'text/plain;charset=utf-8' : 'application/javascript' }));
  const manifest = { version, nativePaths: native.map(a => a.path), assets: [...assets, ...native] };
  files.set('recovery-sw.js', Buffer.from(template.replace('__RECOVERY_MANIFEST__', JSON.stringify(manifest))));
  files.set(assetName, Buffer.from(patchEditor(original, files.get('recovery-core.js').toString(), config)));
  // Validate every input before any destination is touched.
  if (existsSync(output)) {
    assert(lstatSync(output).isDirectory() && !lstatSync(output).isSymbolicLink(), 'Output must be a real directory');
    assert(readdirSync(output).every(name => files.has(name)), 'Output contains unrelated files');
    for (const name of files.keys()) if (existsSync(join(output, name))) assert(lstatSync(join(output, name)).isFile() && !lstatSync(join(output, name)).isSymbolicLink(), 'Unexpected output file');
  } else mkdirSync(output, { recursive: false });
  for (const [name, bytes] of files) {
    const path = join(output, name), temporary = path + '.tmp-' + process.pid;
    writeFileSync(temporary, bytes, { flag: 'wx' }); renameSync(temporary, path);
  }
  console.log('Generated digest-pinned recovery workspace ' + version + '; recreate sharelatex to remount the editor bundle.');
}
