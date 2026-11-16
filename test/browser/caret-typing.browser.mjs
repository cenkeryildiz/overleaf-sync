import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const typingRole=process.env.CARET_TYPING_ROLE||'collaborator';
const aliceEmail=process.env.OVERLEAF_TEST_ALICE_EMAIL||'alice@example.test',bobEmail=process.env.OVERLEAF_TEST_BOB_EMAIL||'bob@example.test';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.OVERLEAF_TEST_BASE||'http://10.192.253.104:8080', work=fs.mkdtempSync(join(tmpdir(),'caret-typing-'));
const source='\\documentclass{article}\n\\begin{document}\nAlice line for simultaneous edits.\nBob line for continuous typing.\n\\end{document}\n';
const name='Caret typing '+Date.now();fs.writeFileSync(join(work,'main.tex'),source);execFileSync('/usr/bin/zip',['-q',join(work,name+'.zip'),'main.tex'],{cwd:work});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
const deadline=setTimeout(()=>browser.close(),110000);
const editor=p=>p.getByRole('textbox',{name:/^Source Editor/}), text=p=>editor(p).evaluate(e=>e.cmView.view.state.doc.toString());
let projectUrl;
try {
 for(const profile of (process.env.PREVIOUS_CARET_BUNDLE||process.env.PREVIOUS_CARET_EDITOR)?['previous','candidate']:['candidate']) {
  const pages=[], sentFrames=[];
  for(const [email,password]of [[aliceEmail,process.env.OVERLEAF_TEST_ALICE_PASSWORD],[bobEmail,process.env.OVERLEAF_TEST_BOB_PASSWORD]]) {
   const context=await browser.newContext({viewport:{width:1600,height:1000},serviceWorkers:'block'});
   await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
   if(profile==='previous'&&process.env.PREVIOUS_CARET_BUNDLE)await context.route('**/js/8607-0a5113f4c48f158e90d6.js*',r=>r.fulfill({contentType:'application/javascript',body:fs.readFileSync(process.env.PREVIOUS_CARET_BUNDLE,'utf8')}));
   const editorOverride=profile==='previous'?process.env.PREVIOUS_CARET_EDITOR:process.env.CANDIDATE_CARET_EDITOR;
   if(editorOverride)await context.route('**/js/codemirror-editor-57ce7aa576296ae31fad.js*',r=>r.fulfill({contentType:'application/javascript',body:fs.readFileSync(editorOverride,'utf8')}));
   const page=await context.newPage();
   if(email===(typingRole==='owner'?aliceEmail:bobEmail))page.on('websocket',ws=>ws.on('framesent',event=>{const payload=event.payload;if(typeof payload!=='string'||!payload.includes('clientTracking.updatePosition'))return;let position;try{const m=JSON.parse(payload.slice(payload.indexOf('{')));position=m.args?.[0];}catch{try{position=JSON.parse(payload.slice(payload.indexOf('[')))[1];}catch{}}if(position)sentFrames.push({...position,at:Date.now()});}));
   page.setDefaultTimeout(20000);await page.goto(base+'/login');await page.locator('input[name=email]').fill(email);await page.locator('input[name=password]').fill(password);await page.getByRole('button',{name:/^Login/}).click();await page.waitForURL(base+'/project');pages.push(page);
  }
  const[a,b]=pages;console.log(JSON.stringify({profile,stage:'accounts-ready'}));
  if(!projectUrl){await a.getByRole('button',{name:/^(New project|Create a new project)$/}).click();await a.getByText('Existing project (.zip)',{exact:true}).click();await a.locator('input[type=file]').first().setInputFiles(join(work,name+'.zip'));await a.waitForURL(/\/project\/[a-f0-9]+/);projectUrl=a.url();console.log(JSON.stringify({disposableProject:projectUrl}));await editor(a).waitFor();await a.getByRole('button',{name:/Share/}).click();const dialog=a.getByRole('dialog');await dialog.locator('input[type=email]').fill(bobEmail);await dialog.getByRole('button',{name:'Invite',exact:true}).click();await dialog.getByText(bobEmail,{exact:true}).waitFor();await dialog.getByRole('button',{name:'Close',exact:true}).first().click();await b.reload();const invite=b.getByRole('alert').filter({hasText:name});await invite.getByRole('button',{name:'Join Project',exact:true}).click();await invite.getByText('Open Project',{exact:true}).click();}else{await a.goto(projectUrl);await b.goto(projectUrl);}
  if(process.env.PARTICIPANT_COMPILATION==='1'){await Promise.all(pages.map(p=>p.goto(projectUrl+'?participant-compile=1')));await Promise.all(pages.map(p=>p.waitForFunction(()=>[...document.querySelectorAll('.textLayer span')].some(e=>e.textContent.includes('Alice line')),{},{timeout:120000})));}
  await Promise.all(pages.map(p=>editor(p).waitFor()));console.log(JSON.stringify({profile,stage:'editors-ready'}));
  await editor(a).evaluate((e,s)=>{const v=e.cmView.view;v.dispatch({changes:{from:0,to:v.state.doc.length,insert:s}});},source);await b.waitForFunction(s=>document.querySelector('[aria-label^="Source Editor"]')?.cmView.view.state.doc.toString()===s,source);
  for(const[p,word]of [[a,'Alice'],[b,'Bob']])await editor(p).evaluate((e,w)=>{const v=e.cmView.view;v.dispatch({selection:{anchor:v.state.doc.toString().indexOf(w)}});v.focus();},word);
  await a.locator('.ol-cm-cursorHighlight').first().waitFor();
  const typingPage=typingRole==='owner'?a:b,watchingPage=typingRole==='owner'?b:a;
  await typingPage.evaluate(()=>{globalThis.caretKeys=[];window.addEventListener('keydown',event=>{if(event.ctrlKey||event.metaKey||event.altKey)return;const v=document.querySelector('[aria-label^="Source Editor"]')?.cmView.view;if(!v)return;const head=v.state.selection.main.head,line=v.state.doc.lineAt(head);let row=line.number-1,column=head-line.from;if(event.key.length===1)column+=event.key.length;else if(event.key==='Enter'){row++;column=0;}else if(event.key==='Backspace'){if(column>0)column--;else if(row>0){row--;column=v.state.doc.line(row+1).length;}else return;}else return;caretKeys.push({row,column,at:Date.now()});},true);globalThis.caretEvents=[];window.addEventListener('cursor:editor:update',event=>caretEvents.push({...event.detail,at:Date.now()}));});
  await watchingPage.evaluate(()=>{globalThis.caretPaints=[];globalThis.caretBegin=performance.now();let last='';globalThis.caretWatch=new MutationObserver(()=>{const r=document.querySelector('.ol-cm-cursorHighlight')?.getBoundingClientRect(),key=r&&r.x+':'+r.y;if(key&&key!==last){const v=document.querySelector('[aria-label^="Source Editor"]')?.cmView.view,p=v?.posAtCoords({x:r.x+0.5,y:r.y+r.height/2});if(p!=null){const line=v.state.doc.lineAt(p);caretPaints.push({at:performance.now(),absolute:Date.now(),row:line.number-1,column:p-line.from,x:r.x,y:r.y});}last=key;}});caretWatch.observe(document.querySelector('.ol-cm-cursorHighlightsLayer'),{subtree:true,attributes:true,childList:true});});
  const began=performance.now();await typingPage.keyboard.type('continuous abcdefghijklmnopqrstuvwxyz',{delay:15});const typed=performance.now()-began;
  await typingPage.keyboard.press('Enter');await typingPage.keyboard.type('new line',{delay:15});await typingPage.keyboard.press('Backspace');
  const expected=await text(typingPage);await watchingPage.waitForFunction(t=>document.querySelector('[aria-label^="Source Editor"]')?.cmView.view.state.doc.toString()===t,expected);
  console.log(JSON.stringify({profile,stage:'typing-converged'}));const head=await editor(typingPage).evaluate(e=>e.cmView.view.state.selection.main.head);
  await watchingPage.waitForFunction(pos=>{const v=document.querySelector('[aria-label^="Source Editor"]')?.cmView.view,mark=document.querySelector('.ol-cm-cursorHighlight')?.getBoundingClientRect(),expected=v?.coordsAtPos(pos);return mark&&expected&&Math.abs(mark.left-expected.left)<3&&Math.abs(mark.top-expected.top)<5;},head);
  const keys=await typingPage.evaluate(()=>caretKeys),events=await typingPage.evaluate(()=>caretEvents), paints=await watchingPage.evaluate(()=>caretPaints);
  const eventToSend=[],eventToPaint=[],keyToPaint=[];for(const key of keys){const paint=paints.find(p=>p.row===key.row&&p.column===key.column&&p.absolute>=key.at);if(paint)keyToPaint.push(paint.absolute-key.at);}
  for(const event of events){const sent=sentFrames.find(p=>p.row===event.row&&p.column===event.column&&p.at>=event.at);if(sent)eventToSend.push(sent.at-event.at);const painted=paints.find(p=>p.row===event.row&&p.column===event.column&&p.absolute>=event.at);if(painted)eventToPaint.push(painted.absolute-event.at);}
  const summarize=values=>{const sorted=values.slice().sort((a,b)=>a-b);return{count:sorted.length,median:sorted[Math.floor(sorted.length/2)],p95:sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*.95)-1)]}};
  const stats=await watchingPage.evaluate(()=>{caretWatch.disconnect();return{updates:caretPaints.length,firstMs:caretPaints[0]?.at-caretBegin}});stats.keyToPaintMs=summarize(keyToPaint);stats.eventToSendMs=summarize(eventToSend);stats.eventToPaintMs=summarize(eventToPaint);assert(stats.updates>3&&stats.firstMs<typed,'Caret must update during typing');
  const versioned=await watchingPage.locator('script[src*="8607-"]').getAttribute('src');if(profile==='candidate')assert(versioned.includes('?v='),'Normal page load must bypass the cached old asset');
  console.log(JSON.stringify({profile,typingRole,...stats,typingMs:typed,finalCaretExact:true,sourceConverged:true,assetVersioned:versioned.includes('?v=')}));
  if(profile==='candidate'){await typingPage.reload();await editor(typingPage).waitFor();await typingPage.waitForFunction(t=>document.querySelector('[aria-label^="Source Editor"]')?.cmView.view.state.doc.toString()===t,expected);}
  await Promise.all(pages.map(p=>p.context().close()));
 }
}finally{clearTimeout(deadline);await browser.close();fs.rmSync(work,{recursive:true,force:true});if(projectUrl)console.log('Scoped cleanup: '+projectUrl);}
