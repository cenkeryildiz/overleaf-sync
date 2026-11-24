import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {patchSynctex,patchPdfViewer,refreshSynctex} from '../runtime/synctex-selection/apply.mjs';
const context=vm.createContext({});vm.runInContext(readFileSync(new URL('../runtime/synctex-selection/refine.js',import.meta.url),'utf8'),context);
function run(text,leaves,selected,{size=text.length,limit=leaves.length,position=0}={}){
 let at=0;const cursor={get type(){return{is:name=>leaves[at].type===name}},get from(){return leaves[at].from},get to(){return leaves[at].to},next(){at++;return at<limit}};
 const content={from:0,to:size,cursor:()=>cursor};const mathAncestor=()=>leaves.length?({getChild:()=>content}):null;const view={state:{doc:{sliceString:(from,to)=>text.slice(from,to),lineAt:p=>{const from=text.lastIndexOf("\n",p-1)+1,to=text.indexOf("\n",p);return{from,text:text.slice(from,to<0?text.length:to)}}}}};
 return context.overleafSynctexSelection.refine(view,position,selected,mathAncestor);
}
test('a unique literal in native math content resolves its exact source range',()=>{const r=run('RowOne c',[{type:'Normal',from:0,to:6},{type:'MathChar',from:7,to:8}],'c');assert.equal(r.from,7);assert.equal(r.to,8)});
test('packaging refreshes the existing selection core and rejects unknown input',()=>{
 const old=readFileSync(new URL('../runtime/synctex-selection/refine.js',import.meta.url),'utf8').trimEnd();
 assert.equal(refreshSynctex(old+'\nBUNDLE','replacement'),'replacement\nBUNDLE');
 for(const source of ['',old+old])assert.throws(()=>refreshSynctex(source,'replacement'),/Unknown/);
});
test('a coarse line before an equation opener still finds its math literal',()=>{
 const text='\\begin{equation} a+9=b \\end{equation}',from=text.indexOf('a+9'),to=text.indexOf(' \\end');
 const content={from,to,cursor:()=>({type:{is:t=>t==='MathChar'},from,to,next:()=>false})};
 const view={state:{doc:{sliceString:(a,b)=>text.slice(a,b),lineAt:()=>({from:0,text})}}};
 const r=context.overleafSynctexSelection.refine(view,0,'b',(_,p)=>p>=from&&p<to?{getChild:()=>content}:null);
 assert.equal(r.from,text.indexOf('=b')+1);assert.equal(r.to,r.from+1);
 const number=context.overleafSynctexSelection.refine(view,0,'(1)',(_,p)=>p>=from&&p<to?{getChild:()=>content}:null);
 assert.equal(number.from,from);assert.equal(number.to,to);
});
test('PDF ligatures and composed Unicode resolve source text without matching commands or comments',()=>{
 for(const [source,pdf] of [['office','oﬃce'],['café','cafe\u0301']]){const r=run(source,[],pdf);assert.equal(r.from,0);assert.equal(r.to,source.length);}
 assert.equal(run('% office',[],'oﬃce'),null);assert.equal(run('\\office',[],'oﬃce'),null);
});
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

test('PDF glyph clicks fall back to their text span without replacing a real selection',()=>{const source='selectText:window.getSelection()?.toString()';const result=patchPdfViewer(source);assert(result.includes('toString()||span?.textContent?.trim()'));for(const text of ['',source+source,result])assert.throws(()=>patchPdfViewer(text),/Unknown/)});

test('pinned asset validation refuses overwriting a destination from unknown input',async()=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {spawnSync}=await import('node:child_process');const {fileURLToPath}=await import('node:url');const dir=mkdtempSync(join(tmpdir(),'synctex-guard-'));
 try{const input=join(dir,'input.js'),output=join(dir,'pdf-js-viewer-108321e8423f4015bf44.js');writeFileSync(input,'untrusted');writeFileSync(output,'retained');const r=spawnSync(process.execPath,[fileURLToPath(new URL('../runtime/synctex-selection/apply.mjs',import.meta.url)),input,output],{encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/hash mismatch/);assert.equal(readFileSync(output,'utf8'),'retained')}finally{rmSync(dir,{recursive:true,force:true})}
});

test('imported figure title selects its inclusion, and comments stay untouched',()=>{const text='  \\includegraphics[width=4cm]{figure.pdf}';const r=run(text,[],'Errors');assert.equal(text.slice(r.from,r.to),'\\includegraphics[width=4cm]{figure.pdf}');assert.equal(run('% '+text,[],'Errors'),null)});
test('generated exam labels use the native hinted questions block and reject wrong counters',()=>{const text='\\begin{questions}\n\\question First\n\\question Second\ncontinued\n\\question Third\n\\end{questions}';for(const [number,anchor]of [[2,'continued'],[3,'Third']]){const r=run(text,[],'\0question:'+number,{position:text.indexOf(anchor)});assert.equal(text.slice(r.from,r.to),'\\question');assert.equal(r.from,text.indexOf('\\question '+(number===2?'Second':'Third')))}assert.equal(run(text,[],'\0question:3',{position:text.indexOf('continued')}),null);assert.equal(run(text+'\nTail',[],'\0question:3',{position:text.length+1}),null)});
test('only a click on the numeric prefix carries a generated-label hint',()=>{const code=patchPdfViewer('selectText:window.getSelection()?.toString()');const span={textContent:'2. Explain this',getBoundingClientRect:()=>({left:0})};const sandbox={window:{getSelection:()=>({toString:()=> '2'})},n:{clientX:3,target:{closest:()=>span}},getComputedStyle:()=>({fontSize:'10px'})};assert.equal(vm.runInNewContext('('+code.replace('selectText:','{selectText:')+'})',sandbox).selectText,'\0question:2');sandbox.n.clientX=40;assert.equal(vm.runInNewContext('('+code.replace('selectText:','{selectText:')+'})',sandbox).selectText,'2')});

test('a graph heading mapped to the end of its float selects the sole inclusion',()=>{const text='\\begin{figure}\n\\includegraphics{plot.pdf}\n\\caption{Caption}\n\\end{figure}';const r=run(text,[],'Errors',{position:text.indexOf('\\end{figure}')});assert.equal(text.slice(r.from,r.to),'\\includegraphics{plot.pdf}');const multiple=text.replace('\\caption{Caption}','\\includegraphics{second.pdf}');assert.equal(run(multiple,[],'Errors',{position:multiple.indexOf('\\end{figure}')}),null)});
