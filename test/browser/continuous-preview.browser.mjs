import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
const base='http://127.0.0.1:8080',work=mkdtempSync(join(tmpdir(),'continuous-preview-'));
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});const results=[];
try{for(const profile of (process.env.CONTINUOUS_PROFILE?[process.env.CONTINUOUS_PROFILE]:['previous','leading'])){
 const name='Continuous-'+profile+'-'+Date.now(),tex='\\documentclass{article}\n\\begin{document}\nProbeBase \n\\end{document}\n';writeFileSync(join(work,'main.tex'),tex);execFileSync('/usr/bin/zip',['-q',join(work,name+'.zip'),'main.tex'],{cwd:work});
 const context=await browser.newContext({viewport:{width:1600,height:1000},serviceWorkers:'block'});await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
 if(profile==='leading')await context.route('**/js/8607-0a5113f4c48f158e90d6.js',r=>r.fulfill({contentType:'application/javascript',body:readFileSync(process.env.CANDIDATE_BUNDLE,'utf8')}));
 const page=await context.newPage();page.setDefaultTimeout(20000);await page.goto(base+'/login');await page.locator('input[name=email]').fill('alice@example.test');await page.locator('input[name=password]').fill(process.env.OVERLEAF_TEST_ALICE_PASSWORD);await page.getByRole('button',{name:/^Login/}).click();await page.waitForURL(base+'/project');
 await page.getByRole('button',{name:'New project',exact:true}).click();await page.getByText('Existing project (.zip)',{exact:true}).click();await page.locator('input[type=file]').first().setInputFiles(join(work,name+'.zip'));await page.waitForURL(/\/project\/[a-f0-9]+/);const projectUrl=page.url();console.log('Synthetic project: '+projectUrl);
 await page.waitForFunction(()=>[...document.querySelectorAll('.textLayer')].some(e=>e.textContent.includes('ProbeBase')));
 const editor=page.getByRole('textbox',{name:/^Source Editor/});await editor.evaluate(e=>{const v=e.cmView.view,p=v.state.doc.toString().indexOf('ProbeBase ')+'ProbeBase '.length;v.dispatch({selection:{anchor:p}});v.focus()});
 await page.evaluate(()=>{globalThis.firstChangedPdf=null;globalThis.firstInput=null;document.addEventListener('beforeinput',()=>{firstInput??=performance.now()},{once:true,capture:true});const observer=new MutationObserver(()=>{if([...document.querySelectorAll('.textLayer')].some(e=>e.textContent.replace(/\s/g,'').includes('ProbeBasec'))){firstChangedPdf=performance.now();observer.disconnect()}});observer.observe(document.body,{subtree:true,childList:true,characterData:true})});
 const stages=[];page.on('response',async response=>{if(response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/compile')){try{const data=await response.json();await response.finished();stages.push({status:data.status,timings:data.timings,httpMs:response.request().timing().responseEnd})}catch{}}});
 let started=0,firstRequest;const request=r=>{if(r.method()==='POST'&&new URL(r.url()).pathname.endsWith('/compile')){started++;firstRequest??=performance.now()}};page.on('request',request);
 const start=performance.now();await page.keyboard.type('cat '.repeat(35),{delay:10});const typingMs=performance.now()-start;
 await page.waitForFunction(()=>[...document.querySelectorAll('.textLayer')].some(e=>e.textContent.replace(/\s/g,'').includes('ProbeBase'+'cat'.repeat(35))),null,{timeout:20000});
 const durationMs=performance.now()-start,stamps=await page.evaluate(()=>({firstChangedPdfMs:firstChangedPdf-firstInput}));
 console.log(JSON.stringify({profile,firstCompileRequestMs:firstRequest-start,...stamps,typingMs,durationMs,started,stages}));
 if(profile!=='previous')assert(stamps.firstChangedPdfMs>0&&stamps.firstChangedPdfMs<typingMs,'PDF must visibly update before continuous typing ends');
 const exact=await editor.evaluate(e=>e.cmView.view.state.doc.toString());assert(exact.includes('ProbeBase '+'cat '.repeat(35)));await page.reload();await editor.waitFor();assert.equal(await editor.evaluate(e=>e.cmView.view.state.doc.toString()),exact);
 results.push({profile,projectUrl,firstCompileRequestMs:firstRequest-start,firstChangedPdfMs:stamps.firstChangedPdfMs,lastCharacterPdfMs:durationMs,typingMs,started,stages});console.log(JSON.stringify(results.at(-1)));await context.close();
}console.log(JSON.stringify({continuousTyping:true,characters:140,delayMs:10,results}));}finally{await browser.close();rmSync(work,{recursive:true,force:true})}
