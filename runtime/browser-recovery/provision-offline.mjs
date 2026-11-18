// SPDX-License-Identifier: AGPL-3.0-only
// Build-time reuse of the installation's pinned PDF.js and BusyTeX public assets.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, symlinkSync, existsSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
export async function provisionOffline(publicRoot, pdfArchive) {
  const root = join(publicRoot, 'recovery'), participant = join(publicRoot, 'participant');
  assert(pdfArchive.endsWith('pdfjs-dist-npm-5.1.91-da7976c225-65ff148d09.zip'));
  for (const [source, target] of [['build/pdf.mjs', 'pdf.mjs'], ['build/pdf.worker.mjs', 'pdf.worker.mjs'], ['LICENSE', 'PDFJS-LICENSE.txt']]) {
    writeFileSync(join(root, target), execFileSync('unzip', ['-p', pdfArchive, 'node_modules/pdfjs-dist/' + source], { maxBuffer: 4 * 1024 * 1024 }));
  }
  // Extract the pinned resource directories once; hundreds of child processes stall under Rosetta.
  const extracted = mkdtempSync(join(tmpdir(), 'latex-pdfjs-'));
  try {
    const directories = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];
    execFileSync('unzip', ['-q', pdfArchive, ...directories.map(name => 'node_modules/pdfjs-dist/' + name + '/*'), '-d', extracted], { timeout: 60000 });
    for (const name of directories) cpSync(join(extracted, 'node_modules/pdfjs-dist', name), join(root, 'pdfjs', name), { recursive: true });
  } finally { rmSync(extracted, { recursive: true, force: true }); }
  copyFileSync(join(participant, 'busytex-sdk.mjs'), join(root, 'busytex-sdk.mjs'));
  copyFileSync(join(participant, 'BUSYTEX-LICENSE'), join(root, 'BUSYTEX-LICENSE.txt'));
  if (!existsSync(join(root, 'busytex'))) symlinkSync('../participant/busytex', join(root, 'busytex'));
  const swPath = join(root, 'recovery-sw.js'), sw = readFileSync(swPath, 'utf8'), match = sw.match(/const manifest = (.+);/);
  assert(match); const manifest = JSON.parse(match[1]);
  async function asset(path) {
    const sha = createHash('sha256'), parts = []; let size = 0;
    for await (const chunk of createReadStream(join(publicRoot, path), { highWaterMark: 16 * 1024 * 1024 })) {
      sha.update(chunk); size += chunk.length; parts.push(createHash('sha256').update(chunk).digest('hex'));
    }
    const type = path.endsWith('.wasm') ? 'application/wasm' : /\.m?js$/.test(path) ? 'application/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.txt') ? 'text/plain;charset=utf-8' : path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.png') ? 'image/png' : 'application/octet-stream';
    return { path: '/' + path, sha256: sha.digest('hex'), size, type, ...(parts.length > 1 ? { parts } : {}) };
  }
  const ui = ['pdf.mjs', 'pdf.worker.mjs', 'PDFJS-LICENSE.txt', 'busytex-sdk.mjs', 'BUSYTEX-LICENSE.txt'];
  function walk(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix + '/' + entry.name;
      if (entry.isDirectory()) walk(join(directory, entry.name), path); else ui.push(path);
    }
  }
  walk(join(root, 'pdfjs'), 'pdfjs');
  for (const path of ui) manifest.assets.push(await asset('recovery/' + path));
  const compilerFiles = ['busytex_worker.js', 'busytex_worker.original.js', 'busytex_biber.js', 'busytex_pipeline.js', 'busytex.js', 'busytex.wasm', 'biber.js', 'biber.wasm', 'biber.data',
    'texlive-basic.js', 'texlive-basic.data', 'texlive-basic.js.providespackage.txt', 'texlive-recommended.js', 'texlive-recommended.data', 'texlive-recommended.js.providespackage.txt',
    'texlive-extra.js', 'texlive-extra.data', 'texlive-extra.js.providespackage.txt'];
  manifest.compilerAssets = [];
  for (const file of compilerFiles) manifest.compilerAssets.push(await asset('recovery/busytex/' + file));
  async function native(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix + '/' + entry.name;
      if (entry.isDirectory()) { if (prefix !== 'js' || entry.name !== 'pdfjs-dist') await native(join(directory, entry.name), path); }
      else if (!entry.name.endsWith('.map')) {
        if (!manifest.assets.some(item => item.path === '/' + path)) manifest.compilerAssets.push({ ...await asset(path),
          ...(/^js\/(?:dictionaries|libs\/pyodide)\//.test(path) ? { optional: true } : {}) });
        manifest.nativePaths.push('/' + path);
      }
    }
  }
  for (const directory of ['js', 'stylesheets', 'fonts']) await native(join(publicRoot, directory), directory);
  for (const name of readdirSync(join(publicRoot, 'images')).filter(name => /^overleaf-o-.*\.svg$/.test(name))) {
    const path = 'images/' + name; manifest.compilerAssets.push(await asset(path)); manifest.nativePaths.push('/' + path);
  }
  for (const name of readdirSync(publicRoot).filter(name => /^favicon(?:-[\w]+)?\.svg$/.test(name))) {
    manifest.compilerAssets.push(await asset(name)); manifest.nativePaths.push('/' + name);
  }
  manifest.compilerVersion = createHash('sha256').update(JSON.stringify(manifest.compilerAssets)).digest('hex').slice(0, 20);
  writeFileSync(swPath, sw.replace(match[0], 'const manifest = ' + JSON.stringify(manifest) + ';'));
}
