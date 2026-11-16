// SPDX-License-Identifier: AGPL-3.0-only
// Modification to TeXlyre BusyTeX1.4.1: terminating a worker must settle its pending compile immediately.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
export function patchSdk(source) {
  assert.equal(createHash('sha256').update(source).digest('hex'), '765465562107443abb3f4c2ee88fd88a90443ec9faa8e0eded099410b70d8442');
  function once(from, to) { assert.equal(source.split(from).length - 1, 1); source = source.replace(from, to); }
  once("            const timeout = setTimeout(() => {\n                reject(new Error('Compilation timeout'));\n            }, 180000);", "            const timeout = setTimeout(() => {\n                this.cancelCompilation = null;\n                reject(new Error('Compilation timeout'));\n            }, 180000);\n            this.cancelCompilation = () => { clearTimeout(timeout); reject(new Error('Compilation canceled')); };\n            this.worker.onerror = event => { event.preventDefault(); this.terminate(); };");
  once("                else if (data.pdf !== undefined) {\n                    clearTimeout(timeout);", "                else if (data.pdf !== undefined) {\n                    this.cancelCompilation = null;\n                    clearTimeout(timeout);");
  // Other SDK operations also handle exceptions; patch only the compile handler that follows the PDF branch.
  const start = source.indexOf('    async compileWithWorker('), end = source.indexOf('    async compileDirect(', start);
  assert(start > 0 && end > start);
  let section = source.slice(start, end);
  const before = "                else if (data.exception) {\n                    clearTimeout(timeout);";
  assert.equal(section.split(before).length - 1, 1);
  section = section.replace(before, "                else if (data.exception) {\n                    this.cancelCompilation = null;\n                    clearTimeout(timeout);");
  source = source.slice(0, start) + section + source.slice(end);
  once('    terminate() {\n        if (this.worker)', '    terminate() {\n        this.cancelCompilation?.();\n        this.cancelCompilation = null;\n        if (this.worker)');
  return source;
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [input, output] = process.argv.slice(2); assert(input && output && input !== output);
  writeFileSync(output, patchSdk(readFileSync(input, 'utf8')), { flag: 'wx' });
}
