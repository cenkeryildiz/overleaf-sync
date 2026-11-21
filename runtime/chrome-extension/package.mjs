// SPDX-License-Identifier: AGPL-3.0-only
// Package public runtime assets only. No application data, environment, account, server configuration or credentials.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, cpSync, readdirSync, readFileSync, writeFileSync, unlinkSync, lstatSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetName, patchEditorUnicode } from '../browser-recovery/apply.mjs';
const source = dirname(fileURLToPath(import.meta.url)), repository = resolve(source, '../..');
const destination = resolve(process.argv[2] || '/Users/macc/Downloads/LaTeX_Local_Chrome_Extension');
const image = process.argv[3] || 'sha256:f2f69f3528aacbbd83c77093e1efec31f363e4447c4d2e87b76862b982d83a66';
assert(/^sha256:[a-f0-9]{64}$/.test(image), 'Use an immutable already-built image');
assert(!existsSync(destination), 'Output already exists; preserve it and choose a new output path');
mkdirSync(destination, { recursive: true });
const container = execFileSync('docker', ['create', '--entrypoint', '/bin/true', image], { encoding: 'utf8' }).trim();
try {
  for (const directory of ['js', 'stylesheets', 'fonts', 'images', 'recovery']) {
    // Docker's archive stream retains nested symlinks; copy the compiler's real directory separately below.
    const copy = spawn('docker', ['cp', '-L', `${container}:/overleaf/services/web/public/${directory}`, '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const extract = spawn('/usr/bin/tar', ['-xf', '-', '-C', destination,
      '--exclude=*.map', '--exclude=*.zip', '--exclude=js/libs/pyodide', '--exclude=js/dictionaries', '--exclude=recovery/busytex'], { stdio: ['pipe', 'ignore', 'pipe'] });
    copy.stdout.pipe(extract.stdin);
    const errors = []; for (const process of [copy, extract]) process.stderr.on('data', bytes => { if (errors.length < 4) errors.push(bytes.toString().slice(0, 500)); });
    const exits = await Promise.all([copy, extract].map(process => new Promise((resolve, reject) => { process.on('error', reject); process.on('close', resolve); })));
    assert(exits.every(code => code === 0), 'Public asset extraction failed: ' + errors.join(''));
  }
  execFileSync('docker', ['cp', `${container}:/overleaf/services/web/public/participant/busytex`, join(destination, 'recovery')], { stdio: 'pipe' });
  cpSync(resolve(repository, 'runtime/participant-compile/worker.js'), join(destination, 'recovery/busytex/busytex_worker.js'));   // current worker guards, not the image's copy
  const dictionaries = join(destination, 'js/dictionaries/0.0.3'); mkdirSync(dictionaries, { recursive: true });
  for (const language of ['en_US', 'en_GB']) for (const suffix of ['aff', 'dic']) execFileSync('docker', ['cp', `${container}:/overleaf/services/web/public/js/dictionaries/0.0.3/${language}.${suffix}`, join(dictionaries, `${language}.${suffix}`)], { stdio: 'pipe' });
  for (const name of ['favicon.svg', 'favicon-compiled.svg', 'favicon-compiling.svg', 'favicon-error.svg']) execFileSync('docker', ['cp', `${container}:/overleaf/services/web/public/${name}`, join(destination, name)], { stdio: 'pipe' });
} finally { execFileSync('docker', ['rm', container], { stdio: 'pipe' }); }
for (const name of readdirSync(resolve(repository, 'runtime/browser-recovery'))) {
  if (/\.(?:js|mjs|html|css|png|svg|webmanifest|txt)$/.test(name) && !['apply.mjs', 'provision-offline.mjs', 'recovery-sw.template.js'].includes(name))
    cpSync(resolve(repository, 'runtime/browser-recovery', name), join(destination, 'recovery', name));
}
const extension = join(destination, 'extension'); mkdirSync(extension);
for (const name of ['background.js', 'bootstrap.js', 'index.html', 'join.js', 'imports.mjs', 'zip-worker.mjs', 'native-template.json', 'ZIPJS-LICENSE.txt', 'lan-room.mjs', 'lan-sync.mjs', 'lan-transfer.mjs', 'lan-session-store.mjs', 'lan-grants.mjs', 'lan-ot.mjs', 'lan-host.mjs', 'lan-guest.mjs', 'lan-ui.mjs']) cpSync(join(source, name), join(extension, name));
const templatePath = join(extension, 'native-template.json'), template = JSON.parse(readFileSync(templatePath, 'utf8'));
const languages = template.meta.find(item => item.name === 'ol-languages');
if (languages) languages.content = JSON.stringify(JSON.parse(languages.content).filter(item => ['en', 'en_US', 'en_GB'].includes(item.code)));
writeFileSync(templatePath, JSON.stringify(template));
cpSync(join(source, 'zipjs'), join(extension, 'zipjs'), { recursive: true });
cpSync(join(source, 'manifest.json'), join(destination, 'manifest.json'));
const editorPath = join(destination, 'js', assetName);
writeFileSync(editorPath, patchEditorUnicode(readFileSync(editorPath, 'utf8')));
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) cpSync(join(repository, name), join(destination, name));
for (const name of ['native-workspace.html', 'project-workspace.html']) {
  const path = join(destination, 'recovery', name);
  writeFileSync(path, readFileSync(path, 'utf8').replace('<head>', '<head><script src="/extension/bootstrap.js"></script>'));
}
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
writeFileSync(join(destination, 'SOURCE.txt'), `LaTeX Local corresponding-source references\n\nApplication source and modifications: https://github.com/cenkeryildiz/overleaf-sync/tree/${sourceCommit}\nPackaging and SDK/editor patches: runtime/chrome-extension/package.mjs, runtime/browser-recovery/apply.mjs, runtime/participant-compile/sdk-patch.mjs at that revision.\nAsset extraction image: ${image}\nBase CE+ image and compiler build recipes: runtime/participant-compile/hosting/Dockerfile and fetch-busytex.mjs at that revision.\nCE+ upstream: https://github.com/yu-i-i/overleaf-cep\nOverleaf core revision from asset image metadata: https://github.com/overleaf/overleaf/tree/738bebb743e6ea8f579a1860e1de1fbfc292f505\nBusyTeX SDK 1.4.1: https://github.com/TeXlyre/texlyre-busytex/tree/f3c8780e85939ced63133501d66b6386d89f69e4\nPinned compiler asset checksums and rebuild inputs are in fetch-busytex.mjs. TeX Live package manifests/profiles are in recovery/busytex/.\n\nThird-party terms remain applicable; see THIRD_PARTY_NOTICES.md, recovery/LICENSE, recovery/BUSYTEX-LICENSE.txt, recovery/PDFJS-LICENSE.txt, recovery/CODEMIRROR-LICENSES.txt, extension/ZIPJS-LICENSE.txt and the individual bundled .LICENSE.txt files. The root proprietary notice does not restrict these components.\n`);
for (const required of ['LICENSE', 'BUSYTEX-LICENSE.txt', 'PDFJS-LICENSE.txt', 'CODEMIRROR-LICENSES.txt']) assert(existsSync(join(destination, 'recovery', required)), 'Required dependency license missing: ' + required);
let bytes = 0, files = 0;
function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    assert(!entry.isSymbolicLink(), 'Packaged assets must not link outside the extension');
    if (entry.isDirectory()) inspect(path);
    else if (/\.map$/.test(entry.name)) unlinkSync(path);
    else {
      assert(!/^\.env|\.(?:pem|key|bak|old|tgz|zip)$|^kc\.lic$|credential/i.test(entry.name), 'Unexpected private, backup or archive file');
      bytes += lstatSync(path).size; files++;
    }
  }
}
inspect(destination);
writeFileSync(join(destination, 'INSTALL.txt'), 'LaTeX Local — private Chrome extension\n\n1. Open chrome://extensions in Chrome, turn on Developer mode, and choose Load unpacked for this folder.\n2. Click LaTeX Local and choose Work offline.\n3. Create a project or import source files/a ZIP. Write LaTeX and the local compiler updates the PDF automatically. Use Recompile or Stop in the native toolbar; Open PDF also displays supplied PDFs.\n\nNo account, server, native helper or separate TeX installation is needed. The bundled compiler works offline; packages not included in it are reported as unsupported. Compilation errors retain your source and previous PDF.\n\nKeep this folder in place. Local projects belong to this Chrome profile and extension ID. Export ZIPs before removing the extension or clearing its data. The bundled offline spellcheck dictionaries are US and UK English.\n');
console.log(JSON.stringify({ destination, files, bytes, image }));
