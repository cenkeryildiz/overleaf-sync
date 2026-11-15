import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {patchSynctex,patchPdfViewer} from '../../runtime/synctex-selection/apply.mjs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const base='http://127.0.0.1:8080',work=mkdtempSync(join(tmpdir(),'overleaf-synctex-')),name='SyncTeX-'+Date.now();
const tex=String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
\begin{align}
\text{RowOne}\quad x_1 &= \frac{a+1}{b+2} \\
\text{RowTwo}\quad x_2 &= \frac{c+3}{d+4} \\
\text{RowThree}\quad x_3 &= \frac{e+5}{f+6}
\end{align}
\end{document}
`;
writeFileSync(join(work,'main.tex'),tex);execFileSync('/usr/bin/zip',['-q',join(work,name+'.zip'),'main.tex'],{cwd:work});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});let projectUrl;
try{
 const c=await browser.newContext({viewport:{width:1600,height:1000},serviceWorkers:'block'});await c.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
 if(process.env.SYNC_PROFILE==='refined')await c.route('**/js/codemirror-editor-57ce7aa576296ae31fad.js',async route=>{const response=await route.fetch();await route.fulfill({response,body:patchSynctex(await response.text(),readFileSync(new URL('../../runtime/synctex-selection/refine.js',import.meta.url),'utf8'))})});
 if(process.env.SYNC_PROFILE==='refined')await c.route('**/js/pdf-js-viewer-108321e8423f4015bf44.js',async route=>{const response=await route.fetch();await route.fulfill({response,body:patchPdfViewer(await response.text())})});
 const p=await c.newPage();p.setDefaultTimeout(15000);
 await p.goto(base+'/login');await p.locator('input[name=email]').fill('alice@example.test');await p.locator('input[name=password]').fill(process.env.OVERLEAF_TEST_ALICE_PASSWORD);await p.getByRole('button',{name:/^Login/}).click();await p.waitForURL(base+'/project');
 await p.getByRole('button',{name:'New project',exact:true}).click();await p.getByText('Existing project (.zip)',{exact:true}).click();await p.locator('input[type=file]').first().setInputFiles(join(work,name+'.zip'));await p.waitForURL(/\/project\/[a-f0-9]+/);projectUrl=p.url();console.log('Synthetic project: '+projectUrl);
 await p.waitForFunction(()=>[...document.querySelectorAll('.textLayer')].some(e=>e.textContent.includes('RowThree')));
 await p.evaluate(()=>document.addEventListener('dblclick',()=>{globalThis.pdfSelected=window.getSelection()?.toString()},true));
 const samples=[];
 for(const [word,line]of [['RowOne',5],['RowTwo',6],['RowThree',7],['c',6],['d',6],['f',7],['x',8]]){
  const target=p.locator('.textLayer span').filter({hasText:new RegExp('^'+word+'$')}).first();await target.scrollIntoViewIfNeeded();
  const response=p.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/sync/pdf'));
  await target.dblclick();const r=await response;const data=await r.json();
  await p.waitForTimeout(150);
  const cursor=await p.getByRole('textbox',{name:/^Source Editor/}).evaluate(e=>{const v=e.cmView.view;return{line:v.state.doc.lineAt(v.state.selection.main.head).number,selected:v.state.sliceDoc(v.state.selection.main.from,v.state.selection.main.to)}});
  samples.push({word,expectedLine:line,url:r.url(),code:data.code,cursor,pdfSelected:await p.evaluate(()=>globalThis.pdfSelected)}); console.log(JSON.stringify(samples.at(-1)));
  if(['refined','installed'].includes(process.env.SYNC_PROFILE)){assert.equal(cursor.line,line);if(line===8)assert.equal(cursor.selected,'');else assert(cursor.selected.includes(word));}
 }
 console.log(JSON.stringify({samples,browser:browser.version(),projectUrl}));
}finally{await browser.close();rmSync(work,{recursive:true,force:true});if(projectUrl)console.log('Retain for scoped cleanup: '+projectUrl)}
