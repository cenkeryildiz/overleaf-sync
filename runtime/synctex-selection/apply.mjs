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
const viewerOriginal='selectText:window.getSelection()?.toString()';
// Earlier patch output: the label hit area was a fixed 2 em, which could swallow a short first word.
const viewerPrevious='selectText:(()=>{const span=n.target?.closest?.(".textLayer span"),label=span?.textContent?.trim().match(/^(\\d+)\\.\\s/);return label&&n.clientX-span.getBoundingClientRect().left<parseFloat(getComputedStyle(span).fontSize)*2?"\\0question:"+label[1]:window.getSelection()?.toString()||span?.textContent?.trim()})()';
// A numeric label counts only when the click lies on the rendered "N." glyphs. The neighbouring words of a selection
// go to the editor so a word repeated on its source line can be told apart; it is consumed by the next refine.
const viewerPatched='selectText:(()=>{const span=n.target?.closest?.(".textLayer span"),node=span?.firstChild,label=node?.nodeType===3&&node.textContent.match(/^(\\s*)(\\d+)\\.(?=\\s)/);let hit=false;if(label){const r=document.createRange();r.setStart(node,label[1].length);r.setEnd(node,label[0].length);const b=r.getBoundingClientRect();hit=n.clientX>=b.left-1&&n.clientX<=b.right+1}const s=window.getSelection(),text=s?.toString()||span?.textContent?.trim();let before,after;const g=s?.rangeCount?s.getRangeAt(0):null;if(g&&g.startContainer===g.endContainer&&g.startContainer.nodeType===3&&span?.contains(g.startContainer)){const t=g.startContainer.textContent;before=t.slice(0,g.startOffset).match(/([\\p{L}\\p{N}]+)[^\\p{L}\\p{N}]*$/u)?.[1];after=t.slice(g.endOffset).match(/^[^\\p{L}\\p{N}]*([\\p{L}\\p{N}]+)/u)?.[1]}globalThis.overleafSynctexContext=hit?undefined:{word:text,before,after};return hit?"\\0question:"+label[2]:text})()';
export function patchPdfViewer(source) {
  assert(!source.includes(viewerOriginal+'||'),'Unknown or already patched PDF viewer');
  assert.equal(source.split(viewerOriginal).length-1,1,'Unknown or already patched PDF viewer');
  return source.replace(viewerOriginal,viewerPatched);
}
export function refreshPdfViewer(source) {
  if (source.split(viewerPatched).length-1===1) return source;
  assert.equal(source.split(viewerPrevious).length-1,1,'Unknown PDF viewer patch');
  return source.replace(viewerPrevious,viewerPatched);
}
export function refreshSynctex(source, core) {
  const end = '  globalThis.overleafSynctexSelection = Object.freeze({ refine });\n})();';
  assert(source.startsWith('// SPDX-License-Identifier: AGPL-3.0-only\n// Cenker YILDIZ, 2026.'), 'Unknown SyncTeX prefix');
  assert.equal(source.split(end).length - 1, 1, 'Unknown SyncTeX selection core');
  return core.trimEnd() + source.slice(source.indexOf(end) + end.length);
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [input,output]=process.argv.slice(2);
  assert(input&&output&&resolve(input)!==resolve(output),'Use distinct original/recovery editor and output paths');
  const name=basename(output),pdf=name==='pdf-js-viewer-108321e8423f4015bf44.js';
  assert(pdf||name==='codemirror-editor-57ce7aa576296ae31fad.js','Unknown output asset');
  const source=readFileSync(input,'utf8');
  assert((pdf ? ['c6ae790224495d1244e34f260239199fa7b4f92f532c442a15610989ce5e5690']
    : ['17c9773745b094e321c81ef58db8aa1f5786d467de662b65cf619bc317ae00f5', '635ba25a54cbe7f2f2a62d945ac62b09672221a184bf3b638971d77cb7bfe80e']).includes(createHash('sha256').update(source).digest('hex')), 'Pinned source hash mismatch');
  const result=pdf?patchPdfViewer(source):patchSynctex(source,readFileSync(new URL('./refine.js',import.meta.url),'utf8'));
  const temp=output+'.tmp-'+process.pid;
  writeFileSync(temp,result,{flag:'wx'});renameSync(temp,output);
}
