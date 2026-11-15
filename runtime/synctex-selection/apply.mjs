// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve,basename} from 'node:path';

export function patchSynctex(source, core) {
  for (const [from,to] of [
    ['94115(e,t,o){o.r(t),','94115(e,t,o){var synctexMathAncestor=o(41322).E;o.r(t),'],
    ['const{doc:r}=e.state,s=C(r,t,o);if(n)if(void 0===o)', 'const{doc:r}=e.state,s=C(r,t,o);const refined=void 0===o?globalThis.overleafSynctexSelection.refine(e,s,n,synctexMathAncestor):null;if(refined)return void T(e,refined.from,refined.to);if(n)if(void 0===o)'],
  ]) {
    assert.equal(source.split(from).length-1,1,'Unknown or already patched SyncTeX editor');
    source=source.replace(from,to);
  }
  return core+'\n'+source;
}
export function patchPdfViewer(source) {
  const from='selectText:window.getSelection()?.toString()';
  assert(!source.includes(from+'||'),'Unknown or already patched PDF viewer');
  assert.equal(source.split(from).length-1,1,'Unknown or already patched PDF viewer');
  return source.replace(from,'selectText:window.getSelection()?.toString()||n.target?.closest?.(".textLayer span")?.textContent?.trim()');
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [input,output]=process.argv.slice(2);
  assert(input&&output&&resolve(input)!==resolve(output),'Use distinct original/recovery editor and output paths');
  const name=basename(output),pdf=name==='pdf-js-viewer-108321e8423f4015bf44.js';
  assert(pdf||name==='codemirror-editor-57ce7aa576296ae31fad.js','Unknown output asset');
  const source=readFileSync(input,'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'),pdf
    ? 'c6ae790224495d1244e34f260239199fa7b4f92f532c442a15610989ce5e5690'
    : '635ba25a54cbe7f2f2a62d945ac62b09672221a184bf3b638971d77cb7bfe80e','Pinned source hash mismatch');
  const result=pdf?patchPdfViewer(source):patchSynctex(source,readFileSync(new URL('./refine.js',import.meta.url),'utf8'));
  const temp=output+'.tmp-'+process.pid;
  writeFileSync(temp,result,{flag:'wx'});renameSync(temp,output);
}
