import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {patchSynctex,patchPdfViewer} from '../runtime/synctex-selection/apply.mjs';
const context=vm.createContext({});vm.runInContext(readFileSync(new URL('../runtime/synctex-selection/refine.js',import.meta.url),'utf8'),context);
function run(text,leaves,selected,{size=text.length,limit=leaves.length}={}){
 let at=0;const cursor={get type(){return{is:name=>leaves[at].type===name}},get from(){return leaves[at].from},get to(){return leaves[at].to},next(){at++;return at<limit}};
 const content={from:0,to:size,cursor:()=>cursor};const mathAncestor=()=>({getChild:()=>content});const view={state:{doc:{sliceString:(from,to)=>text.slice(from,to)}}};
 return context.overleafSynctexSelection.refine(view,0,selected,mathAncestor);
}
test('a unique literal in native math content resolves its exact source range',()=>{const r=run('RowOne c',[{type:'Normal',from:0,to:6},{type:'MathChar',from:7,to:8}],'c');assert.equal(r.from,7);assert.equal(r.to,8)});
test('repeated symbols, substrings, command names and comments stay coarse',()=>{
 assert.equal(run('x x',[{type:'MathChar',from:0,to:1},{type:'MathChar',from:2,to:3}],'x'),null);
 assert.equal(run('RowOne',[{type:'Normal',from:0,to:6}],'One'),null);
 for(const type of ['CtrlSeq','LineComment'])assert.equal(run('alpha',[{type,from:0,to:5}],'alpha'),null);
});
test('unsupported selections and excessive input are bounded',()=>{
 const leaf=[{type:'MathChar',from:0,to:1}];for(const selected of ['',undefined,'x\ny','x'.repeat(81)])assert.equal(run('x',leaf,selected),null);
 assert.equal(run('x',leaf,'x',{size:32769}),null);
 const many=Array.from({length:5001},()=>({type:'Whitespace',from:0,to:1}));assert.equal(run('x',many,'x'),null);
});
test('unknown or duplicate native hooks cannot be patched',()=>{const source='94115(e,t,o){o.r(t),const{doc:r}=e.state,s=C(r,t,o);if(n)if(void 0===o)';const patched=patchSynctex(source,'CORE');assert(patched.includes('synctexMathAncestor=o(41322).E'));for(const text of ['',source+source,patched])assert.throws(()=>patchSynctex(text,'CORE'),/Unknown/)});

test('a selected literal may span adjacent native math tokens',()=>{const r=run('c+3',[{type:'MathChar',from:0,to:1},{type:'MathSpecialChar',from:1,to:2},{type:'Number',from:2,to:3}],'c+3');assert.equal(r.from,0);assert.equal(r.to,3)});

test('PDF glyph clicks fall back to their text span without replacing a real selection',()=>{const source='selectText:window.getSelection()?.toString()';const result=patchPdfViewer(source);assert(result.includes('toString()||n.target?.closest?.'));for(const text of ['',source+source,result])assert.throws(()=>patchPdfViewer(text),/Unknown/)});

test('pinned asset validation refuses overwriting a destination from unknown input',async()=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {spawnSync}=await import('node:child_process');const {fileURLToPath}=await import('node:url');const dir=mkdtempSync(join(tmpdir(),'synctex-guard-'));
 try{const input=join(dir,'input.js'),output=join(dir,'pdf-js-viewer-108321e8423f4015bf44.js');writeFileSync(input,'untrusted');writeFileSync(output,'retained');const r=spawnSync(process.execPath,[fileURLToPath(new URL('../runtime/synctex-selection/apply.mjs',import.meta.url)),input,output],{encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/hash mismatch/);assert.equal(readFileSync(output,'utf8'),'retained')}finally{rmSync(dir,{recursive:true,force:true})}
});
