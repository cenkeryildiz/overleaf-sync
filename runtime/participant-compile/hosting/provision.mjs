// SPDX-License-Identifier: AGPL-3.0-only
// Build only: assemble the qualified overlays from pinned public CE+ inputs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync, rmSync, createWriteStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { patchBundle } from '../../fast-preview/apply.mjs';
import { patchCaret, patchImmediateCaret, patchTypingCaret } from '../../live-caret/apply.mjs';
import { patchSynctex, patchPdfViewer } from '../../synctex-selection/apply.mjs';
import { patchSdk } from '../sdk-patch.mjs';

const root = '/overleaf/services/web', publicRoot = root + '/public';
const sha = value => createHash('sha256').update(value).digest('hex');
const file = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');
const editorName = 'codemirror-editor-57ce7aa576296ae31fad.js', mainName = '8607-0a5113f4c48f158e90d6.js';
const runtimeName = 'runtime-0239170c7f0b0a6c5b25.js', pdfName = 'pdf-js-viewer-108321e8423f4015bf44.js';
function pinned(path, digest) { const text = readFileSync(path, 'utf8'); assert.equal(sha(text), digest, path); return text; }
function apply(kind, path) {
  execFileSync(process.execPath, [new URL('../apply.mjs', import.meta.url).pathname, kind, path, path + '.participant']);
  renameSync(path + '.participant', path);
}
async function download(url, destination, algorithm, expected) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) }); assert(response.ok, 'Public asset unavailable');
  const hash = createHash(algorithm);
  await pipeline(response.body, new Transform({ transform(chunk, _, next) { hash.update(chunk); next(null, chunk); } }), createWriteStream(destination, { flags: 'wx' }));
  assert.equal(hash.digest(algorithm === 'sha512' ? 'base64' : 'hex'), expected, 'Public asset integrity mismatch');
}

const originalEditor = pinned(join(publicRoot, 'js', editorName), '9a78a0a8b867dec0d7e54357f4d78343fd9311e9fadc791950f25e263adedd24');
const originalMain = pinned(join(publicRoot, 'js', mainName), '47dce31db1e1e52214e207bb334a0659837b9ded425d0b22ec042c49ea4d04ad');
const originalRuntime = pinned(join(publicRoot, 'js', runtimeName), 'd5a88ef72332d8a2facfe62fb20980771e1c987b73d77468dd2c9616b5df81b3');
const originalPdf = pinned(join(publicRoot, 'js', pdfName), 'c6ae790224495d1244e34f260239199fa7b4f92f532c442a15610989ce5e5690');
const originalManifest = pinned(join(publicRoot, 'manifest.json'), '2bb42221a129b3e37a586f2b6c87245d4fc639b1d9a3a00623a9cf48047086b3');
const recovery = join(publicRoot, 'recovery');
execFileSync(process.execPath, [new URL('../../browser-recovery/apply.mjs', import.meta.url).pathname, join(publicRoot, 'js', editorName), '/tmp/browser-recovery']);
renameSync('/tmp/browser-recovery', recovery);
let editor = readFileSync(join(recovery, editorName), 'utf8');
editor = patchTypingCaret(patchSynctex(editor, file('../../synctex-selection/refine.js')));
const editorHook = file('../editor.js').replace(" || new URLSearchParams(location.search).get('participant-compile') !== '1'", '');
assert.notEqual(editorHook, file('../editor.js'), 'Default compilation hook anchor changed');
editor += '\n' + editorHook;
// This image has one compilation mode, so a special URL is unnecessary.
let bootstrap = file('../bootstrap.js').replace("new URLSearchParams(location.search).get('participant-compile') !== '1' || ", '');
assert.notEqual(bootstrap, file('../bootstrap.js'), 'Default compilation bootstrap anchor changed');
bootstrap = bootstrap.replace("'/participant/client.mjs'", "'/participant/client.mjs?v=" + sha(file('../client.mjs')) + "'");
const main = bootstrap + '\n' + patchImmediateCaret(patchCaret(patchBundle(originalMain)));
const configPath = join(recovery, 'config.js'), oldConfig = readFileSync(configPath, 'utf8');
const cacheVersion = sha(editor + main + originalRuntime + file('./provision.mjs')).slice(0, 20);
const config = 'globalThis.overleafRecoveryBuild=' + JSON.stringify({ version: cacheVersion }) + ';';
assert.equal(editor.split(oldConfig).length, 2); editor = editor.replace(oldConfig, config); writeFileSync(configPath, config);
const anchor = '+".js",b.miniCssF=';
assert.equal(originalRuntime.split(anchor).length, 2);
const runtime = originalRuntime.replace(anchor, '+".js"+(e===7565?"?v=' + sha(editor) + '":""),b.miniCssF=');
for (const [name, body] of [[editorName, editor], [mainName, main], [runtimeName, runtime], [pdfName, patchPdfViewer(originalPdf)]]) writeFileSync(join(publicRoot, 'js', name), body);
// The recovery cache must verify the runtime actually shipped in this image.
const serviceWorker = join(recovery, 'recovery-sw.js');
const oldSw = readFileSync(serviceWorker, 'utf8'), manifestMatch = oldSw.match(/const manifest = (.+);/);
assert(manifestMatch); const cacheManifest = JSON.parse(manifestMatch[1]); cacheManifest.version = cacheVersion;
for (const asset of cacheManifest.assets) {
  if (asset.path === '/js/' + runtimeName) asset.sha256 = sha(runtime);
  if (asset.path === '/recovery/config.js') asset.sha256 = sha(config);
}
writeFileSync(serviceWorker, oldSw.replace(manifestMatch[0], 'const manifest = ' + JSON.stringify(cacheManifest) + ';'));
rmSync(join(recovery, editorName));
const versions = new Map([editorName, mainName, runtimeName, pdfName].map(name => ['/js/' + name, sha(readFileSync(join(publicRoot, 'js', name)))]));
function version(value) {
  if (typeof value === 'string' && versions.has(value)) return value + '?v=' + versions.get(value);
  if (Array.isArray(value)) return value.map(version);
  return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, version(item)])) : value;
}
writeFileSync(join(publicRoot, 'manifest.json'), JSON.stringify(version(JSON.parse(originalManifest))));
apply('router', join(root, 'app/src/router.mjs'));
apply('email', join(root, 'app/src/Features/Email/EmailSender.mjs'));
apply('sync', '/overleaf/services/clsi/app/js/CompileManager.js');

const participant = join(publicRoot, 'participant'); mkdirSync(participant);
copyFileSync(new URL('../client.mjs', import.meta.url), join(participant, 'client.mjs'));
await download('https://registry.npmjs.org/texlyre-busytex/-/texlyre-busytex-1.4.1.tgz', '/tmp/busytex-sdk.tgz', 'sha512',
  '7PswiiuCIYc0HGK/HyQz0At/6Pc9pMk7Qy+DkzHk+BGVInWetXaeZq2px7V06pHscJG215YOU6as/0sgRmulNA==');
mkdirSync('/tmp/busytex-sdk'); execFileSync('tar', ['-xzf', '/tmp/busytex-sdk.tgz', '--no-same-owner', '-C', '/tmp/busytex-sdk', '--strip-components=1']);
writeFileSync(join(participant, 'busytex-sdk.mjs'), patchSdk(readFileSync('/tmp/busytex-sdk/dist/index.js', 'utf8')));
copyFileSync('/tmp/busytex-sdk/LICENSE', join(participant, 'BUSYTEX-LICENSE'));
await download('https://github.com/TeXlyre/texlyre-busytex/releases/download/assets-v1.4.1/busytex-assets.tar.gz', '/tmp/busytex-assets.tar.gz', 'sha256',
  '4f63731fe4ec9238d877846074ab424350add6f6e956944def389e6752d2c78b');
execFileSync('tar', ['-xzf', '/tmp/busytex-assets.tar.gz', '--no-same-owner', '-C', participant]);
renameSync(join(participant, 'busytex/busytex_worker.js'), join(participant, 'busytex/busytex_worker.original.js'));
copyFileSync(new URL('../worker.js', import.meta.url), join(participant, 'busytex/busytex_worker.js'));
for (const path of ['/tmp/busytex-sdk', '/tmp/busytex-sdk.tgz', '/tmp/busytex-assets.tar.gz']) rmSync(path, { recursive: true, force: true });
console.log('Provisioned pinned public assets, participant-only UI, recovery, carets and source navigation.');
