import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Opt-in native browser checks. Only synthetic accounts/projects; no external transfers.
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = 'http://127.0.0.1:8080';
assert(process.env.OVERLEAF_TEST_ALICE_PASSWORD && process.env.OVERLEAF_TEST_BOB_PASSWORD);
const work = mkdtempSync(join(tmpdir(), 'overleaf-native-workflows-'));
const name = 'Recovery-' + Date.now();
const source = String.raw`\documentclass{article}
\title{${name}}
\begin{document}
\maketitle
\section{Introduction}
Alpha text for review and navigation. Equation $x^2+y^2=z^2$.
\input{content}
\bibliographystyle{plain}
\bibliography{references}
\end{document}
`;
const files = { 'main.tex': source, 'content.tex': 'Second file text. Reference \\cite{example2026}.\n', 'references.bib': '% Preserve this comment\n@article{example2026,author={Example, Alice},title={Synthetic Reference},journal={Test Journal},year={2026}}\n' };
for (const [path, text] of Object.entries(files)) writeFileSync(join(work, path), text);
execFileSync('/usr/bin/zip', ['-q', join(work, name + '.zip'), ...Object.keys(files)], { cwd: work });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
let projectUrl;
const metrics = { overlappingPairs: 0, peerMs: [], steps: [], sentEditFrames: 0 };
const editor = page => page.getByRole('textbox', { name: /^Source Editor/ });
const buffer = page => editor(page).evaluate(el => el.cmView.view.state.doc.toString());
async function account(email, password) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'allow' });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  await page.goto(base + '/login'); await page.locator('input[name=email]').fill(email); await page.locator('input[name=password]').fill(password);
  await page.getByRole('button', { name: /^Login/ }).click(); await page.waitForURL(base + '/project'); return page;
}
async function autoOff(page) { await page.getByRole('button', { name: /compile options/i }).click(); await page.getByRole('menuitem', { name: /^Off/ }).click(); }
async function waitText(page, text, present = true) {
  await page.waitForFunction(({ text, present }) => document.querySelector('[aria-label^="Source Editor"]')?.cmView.view.state.doc.toString().includes(text) === present, { text, present });
}
async function select(page, text, end = false) {
  await editor(page).evaluate((el, { text, end }) => {
    const view = el.cmView.view, pos = view.state.doc.toString().indexOf(text); if (pos < 0) throw Error('Missing test anchor');
    view.dispatch({ selection: { anchor: pos + (end ? text.length : 0), head: pos + text.length } }); view.focus();
  }, { text, end });
}
async function end(page) { await editor(page).click(); await page.keyboard.press('Meta+ArrowDown'); }
async function converged(a, b) {
  const exact = await buffer(a); await b.waitForFunction(text => document.querySelector('[aria-label^="Source Editor"]')?.cmView.view.state.doc.toString() === text, exact);
  assert.equal(await buffer(b), exact); return exact;
}
async function compile(page) {
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].some(e => e.textContent.includes('Compiling')));
  const response = page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/compile') && r.request().method() === 'POST', { timeout: 60000 });
  await page.getByRole('button', { name: 'Recompile', exact: true }).click(); return (await response).json();
}
function passed(step) { metrics.steps.push(step); console.log('Passed: ' + step); }
try {
  const a = await account('alice@example.test', process.env.OVERLEAF_TEST_ALICE_PASSWORD), b = await account('bob@example.test', process.env.OVERLEAF_TEST_BOB_PASSWORD);
  await a.getByRole('button', { name: 'New project', exact: true }).click(); await a.getByText('Existing project (.zip)', { exact: true }).click();
  await a.locator('input[type=file]').first().setInputFiles(join(work, name + '.zip')); await a.waitForURL(/\/project\/[a-f0-9]+/); projectUrl = a.url();
  console.log('Task-created synthetic project for scoped cleanup: ' + projectUrl);
  await editor(a).waitFor(); await autoOff(a); assert.equal(await buffer(a), source);
  await a.getByRole('button', { name: /Share/ }).click(); const dialog = a.getByRole('dialog');
  await dialog.locator('input[type=email]').fill('bob@example.test'); await dialog.getByRole('button', { name: 'Invite', exact: true }).click();
  await dialog.getByText('bob@example.test', { exact: true }).waitFor(); await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
  await b.reload(); const invite = b.getByRole('alert').filter({ hasText: name });
  await invite.getByRole('button', { name: 'Join Project', exact: true }).click(); await invite.getByText('Open Project', { exact: true }).click();
  await b.waitForURL(projectUrl); await editor(b).waitFor(); await autoOff(b); await converged(a, b); passed('native import/share/two identities');

  const errors = []; a.on('pageerror', error => errors.push(error.message));
  const scope = await a.evaluate(() => ({ account: document.querySelector('meta[name="ol-user_id"]').content, project: document.querySelector('meta[name="ol-project_id"]').content }));
  await end(a); await a.keyboard.insertText('\n% OnlineRecoveryMarker'); await waitText(b, 'OnlineRecoveryMarker');
  const records = await a.evaluate(({account,project}) => overleafRecovery.list(account,project), scope);
  assert.equal(records.length,1); assert(records[0].record.candidate.includes('OnlineRecoveryMarker')); assert.equal(records[0].record.base.text, source); passed('intent captured before native transmission');
  const tab = await a.context().newPage(); await tab.goto(projectUrl); await editor(tab).waitFor(); await autoOff(tab); await end(tab); await tab.keyboard.insertText('\n% SecondTabMarker'); await waitText(a,'SecondTabMarker');
  const copies = await a.evaluate(({account,project})=>overleafRecovery.list(account,project),scope); assert.equal(copies.length,2); assert.notEqual(copies[0].record.writer,copies[1].record.writer); passed('same-profile tabs keep distinct recovery candidates');
  await end(a); const beforeQuota = await buffer(a);
  await a.evaluate(() => { globalThis.originalStorageWrite = Storage.prototype.setItem; Storage.prototype.setItem = function(k,v){if(k.startsWith('overleaf.recovery.v1.'))throw new DOMException('Synthetic full storage','QuotaExceededError');return originalStorageWrite.call(this,k,v)} });
  await a.keyboard.insertText('QuotaRefusedMarker'); assert.equal(await buffer(a),beforeQuota); assert.equal(await buffer(b),beforeQuota); await a.getByRole('status').filter({hasText:'Edit paused'}).waitFor();
  await a.evaluate(()=>{Storage.prototype.setItem=originalStorageWrite;delete globalThis.originalStorageWrite}); passed('quota failure refuses editor and peer mutation');
  await tab.close();
  await a.getByText('content.tex',{exact:true}).first().click(); await waitText(a,'Second file text'); await end(a); await a.keyboard.insertText('\n% ContentRecoveryMarker'); const contentCopies=await a.evaluate(({account,project})=>overleafRecovery.list(account,project),scope); assert(contentCopies.some(r=>r.record.name==='content.tex'&&r.record.candidate.includes('ContentRecoveryMarker'))); await a.getByText('main.tex',{exact:true}).first().click(); await waitText(a,'OnlineRecoveryMarker'); assert.equal(await buffer(a),beforeQuota); passed('document switches preserve identity and filename');
  const timings = await a.evaluate(({account,project})=>{
    const base=overleafRecovery.list(account,project)[0].record, results={};
    for(const size of [200*1024,1024*1024]){const r=overleafRecovery.fork(base);r.candidate='x'.repeat(size);r.base={...r.base,text:r.candidate};const times=[];for(let i=0;i<10;i++){r.revision++;const t=performance.now();overleafRecovery.save(r);times.push(performance.now()-t)}localStorage.removeItem(overleafRecovery.key(r));times.sort((a,b)=>a-b);results[size]={p95Ms:times[Math.ceil(times.length*.95)-1],samples:times.length};}return results;
  },scope);
  await a.getByRole('button',{name:'Offline and recovery options',exact:true}).click(); await a.getByRole('menuitem',{name:'Recovery copies',exact:true}).click(); await a.waitForURL(/\/recovery\/local-workspace.html#/,{timeout:40000});
  const local = a.getByRole('textbox',{name:'Local source editor',exact:true}); await local.waitFor();
  assert.equal(await local.evaluate(e=>e.cmView.view.state.doc.toString()),beforeQuota); assert.equal(await a.evaluate(async()=> (await fetch('/project/'+location.hash.slice(1))).status),503); passed('Local only refuses uncached server requests'); const initialKey=decodeURIComponent(new URL(a.url()).hash.slice(1));
  await a.context().setOffline(true); await local.click(); await a.keyboard.press('Meta+ArrowDown'); await a.keyboard.insertText('\n% OfflineOnlyMarker');
  const offline = await local.evaluate(e=>e.cmView.view.state.doc.toString()); await a.locator('#undo').click(); assert.equal(await local.evaluate(e=>e.cmView.view.state.doc.toString()),beforeQuota); await a.locator('#redo').click(); assert.equal(await local.evaluate(e=>e.cmView.view.state.doc.toString()),offline); passed('offline native undo/redo'); assert(!((await buffer(b)).includes('OfflineOnlyMarker')));
  const offlineKey = await a.evaluate(()=>overleafRecovery.list(...[JSON.parse(localStorage.getItem(decodeURIComponent(location.hash.slice(1))))].flatMap(r=>[r.account,r.project]))[0].key);
  assert.notEqual(offlineKey, initialKey); await a.reload(); await local.waitFor();
  // The URL selects the preserved initial copy; explicitly select the newer offline candidate.
  await a.locator('#copies').selectOption(offlineKey); assert.equal(await local.evaluate(e=>e.cmView.view.state.doc.toString()),offline); passed('offline cold refresh retains distinct source candidate');
  const other=await a.context().newPage();await other.goto(a.url());await other.getByRole('textbox',{name:'Local source editor',exact:true}).waitFor();await other.getByRole('textbox',{name:'Local source editor',exact:true}).click();await other.keyboard.press('Meta+ArrowDown');await other.keyboard.insertText('\n% OtherOfflineTab');
  await a.getByRole('textbox',{name:'Local source editor',exact:true}).click();await a.keyboard.press('Meta+ArrowDown');await a.keyboard.insertText('\n% OriginalOfflineTab');
  const latest=await a.evaluate(()=>overleafRecovery.list(...[overleafRecovery.read(decodeURIComponent(location.hash.slice(1)))].flatMap(r=>[r.account,r.project])).map(r=>r.record.candidate));
  assert(latest.some(t=>t.includes('OtherOfflineTab')&&!t.includes('OriginalOfflineTab')));assert(latest.some(t=>t.includes('OriginalOfflineTab')&&!t.includes('OtherOfflineTab')));await other.close();passed('offline tabs never overwrite each other');
  const expectedExport=await local.evaluate(e=>e.cmView.view.state.doc.toString());const download=a.waitForEvent('download');await a.locator('#export').click();const exported=await download;await exported.saveAs(join(work,'recovered.tex'));assert.equal((await import('node:fs')).readFileSync(join(work,'recovered.tex'),'utf8'),expectedExport);passed('exact offline text export');
  await a.context().setOffline(false); await a.getByRole('button',{name:'Connect to server',exact:true}).click();await a.waitForURL(projectUrl);await editor(a).waitFor();assert.equal(await buffer(a),beforeQuota);assert(!((await buffer(b)).includes('OfflineOnlyMarker')));const retained=await a.evaluate(({account,project})=>overleafRecovery.list(account,project),scope);assert(retained.some(r=>r.record.candidate.includes('OfflineOnlyMarker')));passed('explicit reconnect preserves local candidates without remote replay');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({result:'passed',steps:metrics.steps,captureTimings:timings,projectUrl,browser:browser.version()}));
} finally { if(projectUrl)console.log('Retain for scoped cleanup: '+projectUrl);await browser.close();rmSync(work,{recursive:true,force:true}); }
