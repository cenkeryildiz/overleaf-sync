// Exercise the actual pinned pipeline/catalogs supplied by the installed image, without a compiler download.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { patchPackageCatalog } from '../runtime/participant-compile/sdk-patch.mjs';

const directory = process.argv[2]; assert(directory, 'Supply the pinned busytex asset directory');
const source = readFileSync(join(directory, 'busytex_pipeline.js'), 'utf8');
const patched = patchPackageCatalog(source);
assert.throws(() => patchPackageCatalog(patched));
assert.throws(() => patchPackageCatalog('changed upstream source'));
const catalogs = ['texlive-recommended.js', 'texlive-extra.js'];
const requests = [];
function resolver(code) {
  const context = vm.createContext({ console: { log() {} }, fetch: async path => {
    assert(catalogs.includes(path)); requests.push(path);
    return { text: async () => readFileSync(join(directory, path), 'utf8') };
  } });
  vm.runInContext(code + '\n;globalThis.Resolver = BusytexDataPackageResolver;', context);
  return new context.Resolver(catalogs, ['/texlive'], []);
}
const files = [{ path: 'main.tex', contents: String.raw`\usepackage{lmodern,amsmath,geometry,tikz}` }];
assert.equal((await resolver(source).resolve(files, 'main.tex')).tikz.source, null, 'Reproduce the pinned catalog omission');
const candidate = resolver(patched), resolved = await candidate.resolve(files, 'main.tex');
for (const name of ['lmodern', 'amsmath', 'geometry', 'tikz']) assert.equal(resolved[name].source, catalogs[0]);
assert.equal((await candidate.resolve(files, 'main.tex', [catalogs[1]])).tikz.source, catalogs[1], 'Respect the selected catalog');
const local = await candidate.resolve([...files, { path: 'tikz.sty', contents: new Uint8Array() }], 'main.tex');
assert.equal(local.tikz.source, 'local', 'Project styles retain precedence');
const missing = await candidate.resolve([{ path: 'main.tex', contents: String.raw`\usepackage{not-a-real-package-opt05}` }], 'main.tex');
assert.equal(missing['not-a-real-package-opt05'].source, null, 'Unknown packages retain the full compiler fallback');
const beforeAliases = await resolver(source).resolve_data_packages(), afterAliases = await candidate.resolve_data_packages();
for (let i = 0; i < beforeAliases.length; i++) for (const alias of beforeAliases[i][1]) assert(afterAliases[i][1].includes(alias));
assert(requests.every(path => catalogs.includes(path)), 'Only existing pinned catalog URLs are requested');
console.log('Pinned resolver: TikZ selects recommended; local styles, aliases, selected catalogs and unknown fallback preserved.');
