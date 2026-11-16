import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { patchSdk } from '../runtime/participant-compile/sdk-patch.mjs';
const source = readFileSync(process.argv[2], 'utf8');
assert.throws(() => patchSdk(source + '\n'));
const module = new vm.SourceTextModule(patchSdk(source), { context: vm.createContext({ console, setTimeout, clearTimeout, Uint8Array }) });
await module.link(() => { throw Error('Unexpected dependency'); }); await module.evaluate();
for (const operation of ['terminate', 'error', 'success']) {
  const runner = new module.namespace.BusyTexRunner(); let terminated = false;
  const worker = { postMessage() {}, terminate() { terminated = true; } }; runner.worker = worker;
  const pending = runner.compileWithWorker([], 'main.tex', null, null);
  if (operation === 'success') {
    worker.onmessage({ data: { pdf: new Uint8Array([1]), exit_code: 0 } }); assert((await pending).success);
    assert.equal(runner.cancelCompilation, null);
  } else {
    if (operation === 'error') worker.onerror({ preventDefault() {} }); else runner.terminate();
    await assert.rejects(pending, /Compilation canceled/); assert(terminated); assert.equal(runner.cancelCompilation, null);
  }
}
console.log('Pinned SDK cancellation, worker crash, successful completion and changed-input refusal passed');
