import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
test('owned preamble state stays private and retained while source-owned paths remain ordinary files', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-output-'));
  try {
    const context = vm.createContext({});
    const source = fs.readFileSync(new URL('../runtime/native-tex/OutputFileFinder.js', import.meta.url), 'utf8');
    const mod = new vm.SourceTextModule(source, { context });
    await mod.link(name => {
      // The compiler runs in Linux; preserve its POSIX resource paths on Windows CI.
      const values = name === 'node:path' ? { default: path.posix } : name === 'node:fs' ? { default: fs } : { callbackifyMultiResult: fn => fn };
      return new vm.SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value); }, { context });
    });
    await mod.evaluate();
    const finder = mod.namespace.default.promises.findOutputFiles;
    fs.mkdirSync(path.join(directory, '.overleaf-preamble'));
    fs.writeFileSync(path.join(directory, '.overleaf-preamble', 'owner'), 'overleaf-native-preamble-v1');
    fs.writeFileSync(path.join(directory, '.overleaf-preamble', 'preamble.fmt'), 'retained');
    fs.writeFileSync(path.join(directory, 'main.tex'), 'original source');
    fs.writeFileSync(path.join(directory, 'output.pdf'), 'output');
    const result = await finder([{ path: 'main.tex' }], directory);
    assert.deepEqual(Array.from(result.outputFiles, file => file.path), ['output.pdf']);
    assert(!result.allEntries.some(file => file.startsWith('.overleaf-preamble')));
    assert.equal(fs.readFileSync(path.join(directory, '.overleaf-preamble', 'preamble.fmt'), 'utf8'), 'retained');
    const declared = await finder([{ path: 'main.tex' }, { path: '.overleaf-preamble/preamble.fmt' }], directory);
    assert(declared.allEntries.includes('.overleaf-preamble/preamble.fmt'));
    fs.writeFileSync(path.join(directory, '.overleaf-preamble', 'owner'), 'user output');
    const ordinary = await finder([{ path: 'main.tex' }], directory);
    assert(ordinary.outputFiles.some(file => file.path === '.overleaf-preamble/preamble.fmt'));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
