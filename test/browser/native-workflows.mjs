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
const name = 'WS2-' + Date.now();
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
const metrics = { overlappingPairs: 0, peerMs: [], steps: [], sentEditFrames: 0, compileEvents: [] };
const editor = page => page.getByRole('textbox', { name: /^Source Editor/ });
const buffer = page => editor(page).evaluate(el => el.cmView.view.state.doc.toString());
async function account(email, password) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('request', r => { if (new URL(r.url()).pathname.endsWith('/compile') && r.method() === 'POST') metrics.compileEvents.push({ event: 'start', at: Math.round(performance.now()) }); });
  page.on('response', r => { if (new URL(r.url()).pathname.endsWith('/compile') && r.request().method() === 'POST') metrics.compileEvents.push({ event: 'end', at: Math.round(performance.now()) }); });
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

  for (const page of [a,b]) await page.evaluate(() => {
    globalThis.storageTimes = []; globalThis.editStages = [];
    const clock = () => performance.timeOrigin + performance.now();
    const nativeSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) { if (typeof data === 'string' && data.includes('applyOtUpdate')) editStages.push({stage:'send',at:clock(),data}); return nativeSend.call(this,data); };
    const input = e => editStages.push({stage:'input',at:clock(),data:e.data});
    document.querySelector('[aria-label^="Source Editor"]').addEventListener('beforeinput', input, true);
    const view = document.querySelector('[aria-label^="Source Editor"]').cmView.view;
    const dispatch = view.dispatch;
    view.dispatch = (...args) => { const before=view.state.doc; const result=dispatch(...args); if(view.state.doc!==before)editStages.push({stage:'applied',at:clock(),data:view.state.doc.toString()}); return result; };
    for (const method of ['getItem','setItem']) { const original = Storage.prototype[method]; Storage.prototype[method] = function(...args) { const t=performance.now();try{return original.apply(this,args)}finally{if(String(args[0]).startsWith('overleaf.recovery.'))storageTimes.push({method,ms:performance.now()-t})} }; }
  });
  metrics.sourceStart = Math.round(performance.now());
  const channels = await Promise.all([a.context().newCDPSession(a), b.context().newCDPSession(b)]);
  for (const channel of channels) {
    await channel.send('Network.enable');
    channel.on('Network.webSocketFrameSent', e => { if (e.response.payloadData.includes('applyOtUpdate')) metrics.sentEditFrames++; });
  }
  const wireSamples = [];
  channels[0].on('Network.webSocketFrameSent', e => { if (e.response.payloadData.includes('WireProbe')) wireSamples.push({ kind: 'send', at: performance.now() }); });
  channels[1].on('Network.webSocketFrameReceived', e => { if (e.response.payloadData.includes('WireProbe')) wireSamples.push({ kind: 'receive', at: performance.now() }); });
  await end(a); const wireStart = performance.now(); await a.keyboard.insertText('\n% WireProbe' + name);
  await waitText(b, 'WireProbe' + name); metrics.wireMs = wireSamples.map(e => ({ kind: e.kind, ms: Math.round((e.at - wireStart) * 10) / 10 }));

  // Both people type into the same position. Every atomic token must survive exactly once.
  for (let i = 0; i < 32; i++) {
    await Promise.all([select(a, '\\end{document}', true), select(b, '\\end{document}', true)]);
    const aa = 'A' + i.toString().padStart(3, '0'), bb = 'B' + i.toString().padStart(3, '0');
    // Comment text is after the document, so latency checks cannot alter rendered content.
    if (i === 0) { await a.keyboard.insertText('\n% '); await waitText(b, '\n% '); await Promise.all([end(a), end(b)]); }
    const t = performance.now(); await Promise.all([a.keyboard.insertText(aa), b.keyboard.insertText(bb)]);
    await Promise.all([waitText(a, bb), waitText(b, aa)]); metrics.peerMs.push(performance.now() - t);
    const exact = await converged(a, b);
    assert.equal(exact.split(aa).length - 1, 1); assert.equal(exact.split(bb).length - 1, 1); metrics.overlappingPairs++;
  }
  metrics.browserStages = await Promise.all([a,b].map(page => page.evaluate(() => editStages)));
  const stages = metrics.browserStages;
  metrics.stagePairs = [];
  for (let i=0;i<32;i++) for (const [from,to,label] of [[0,1,'A'],[1,0,'B']]) {
    const token=label+i.toString().padStart(3,'0');
    const input=stages[from].find(e=>e.stage==='input'&&e.data===token);
    const sent=stages[from].find(e=>e.stage==='send'&&e.data.includes(token));
    const applied=stages[to].find(e=>e.stage==='applied'&&e.data.includes(token));
    if(input&&sent&&applied)metrics.stagePairs.push({token,inputToSendMs:sent.at-input.at,sendToPeerApplyMs:applied.at-sent.at,inputToPeerApplyMs:applied.at-input.at});
  }
  delete metrics.browserStages;
  assert.equal(metrics.stagePairs.length,64,'Every atomic token needs an actual input/send/peer-application timestamp');
  passed('32 overlapping insertion pairs, no dropped/duplicate tokens');

  // Two sustained independent typing streams, not sequential insert-and-wait operations.
  await end(a); await a.keyboard.insertText('\n% AliceBurst:'); await waitText(b, 'AliceBurst:');
  await end(a); await a.keyboard.insertText('\n% BobBurst:'); await waitText(b, 'BobBurst:');
  await Promise.all([select(a, 'AliceBurst:', true), select(b, 'BobBurst:', true)]);
  const aliceBurst = 'abcdefghijklmnopqrstuvwxyz'.repeat(4), bobBurst = '0123456789'.repeat(10);
  const start = performance.now(); await Promise.all([a.keyboard.type(aliceBurst, { delay: 10 }), b.keyboard.type(bobBurst, { delay: 10 })]);
  await Promise.all([waitText(a, 'BobBurst:' + bobBurst), waitText(b, 'AliceBurst:' + aliceBurst)]);
  metrics.burstMs = Math.round(performance.now() - start); metrics.burstCharacters = aliceBurst.length + bobBurst.length; await converged(a, b);
  passed('204 characters across two sustained typing streams');

  await Promise.all([end(a), end(b)]); await Promise.all([a.keyboard.insertText('\n% AliceUndoMarker'), b.keyboard.insertText('\n% BobKeepMarker')]);
  await Promise.all([waitText(a, 'BobKeepMarker'), waitText(b, 'AliceUndoMarker')]);
  const beforeUndo = await converged(a, b);
  await editor(a).focus(); await a.keyboard.press('Meta+z'); await waitText(b, 'AliceUndoMarker', false); assert((await buffer(a)).includes('BobKeepMarker'));
  await a.keyboard.press('Meta+Shift+z'); await waitText(b, 'AliceUndoMarker'); assert.equal(await converged(a, b), beforeUndo); passed('per-user undo/redo preserves peer edit');

  // Review actions are performed by the other account, not only rendered locally.
  await select(a, 'Alpha text'); await a.getByRole('button', { name: 'Insert', exact: true }).click(); await a.getByRole('menuitem', { name: 'Comment', exact: true }).click();
  await a.getByRole('textbox', { name: 'Add your comment here', exact: true }).fill('WS2 review comment from Alice'); await a.getByRole('button', { name: 'Comment', exact: true }).click();
  await b.getByText('Review panel', { exact: true }).click(); await b.getByText('WS2 review comment from Alice', { exact: true }).waitFor();
  await b.getByRole('button', { name: 'Resolve comment', exact: true }).click(); await a.getByText('WS2 review comment from Alice', { exact: true }).waitFor({ state: 'hidden' });
  // Keyboard activation avoids a native responsive mode-button layout oscillation.
  await a.getByRole('button', { name: 'Editing', exact: true }).focus(); await a.keyboard.press('Enter'); await a.getByRole('menuitem', { name: /^Reviewing/ }).click();
  await end(a); await a.keyboard.insertText('\n% WS2 accepted suggestion'); await b.getByRole('button', { name: 'Accept change', exact: true }).click();
  await end(a); await a.keyboard.insertText('\n% WS2 rejected suggestion'); await b.getByRole('button', { name: 'Reject change', exact: true }).click(); await waitText(a, 'WS2 rejected suggestion', false);
  await a.getByRole('button', { name: 'Reviewing', exact: true }).focus(); await a.keyboard.press('Enter'); await a.getByRole('menuitem', { name: /^Editing/ }).click(); passed('cross-user comment/resolve and tracked accept/reject');

  await Promise.all([a.getByText('Chat', { exact: true }).click(), b.getByText('Chat', { exact: true }).click()]);
  await a.getByPlaceholder('Send a message to your collaborators…').fill('WS2 Alice chat hello'); await a.getByPlaceholder('Send a message to your collaborators…').press('Enter'); await b.getByText('WS2 Alice chat hello', { exact: true }).waitFor();
  await b.getByPlaceholder('Send a message to your collaborators…').fill('WS2 Bob chat received'); await b.getByPlaceholder('Send a message to your collaborators…').press('Enter'); await a.getByText('WS2 Bob chat received', { exact: true }).waitFor(); passed('two-way collaborator chat');

  metrics.storageProfiles = await Promise.all([a,b].map(page=>page.evaluate(()=>{const times=storageTimes.map(x=>x.ms).sort((a,b)=>a-b);return {calls:times.length,p95:times[Math.ceil(times.length*.95)-1],max:times.at(-1)}})));
  const exact = await converged(a, b); const results = await Promise.all([compile(a), compile(b)]);
  assert(results.every(r => r.status === 'success' && r.outputFiles.some(f => f.type === 'pdf'))); passed('simultaneous two-user compiles with actual PDFs');
  await a.getByRole('button', { name: 'History', exact: true }).click(); await a.getByText('All history', { exact: true }).waitFor();
  assert((await a.locator('body').innerText()).includes('main.tex')); await a.getByRole('button', { name: /Back to editor/ }).click(); passed('native history opens');
  await a.reload(); await editor(a).waitFor(); assert.equal(await buffer(a), exact, 'Reload lost acknowledged source'); passed('exact reload/readback after concurrent edits');
  const projectId = new URL(projectUrl).pathname.split('/').pop();
  assert(/^[a-f0-9]{24}$/.test(projectId) && name.startsWith('WS2-'));
  const slowSource = '\\documentclass{article}\n\\begin{document}\nWorkerGroupFailure\n\\newcount\\busy\\busy=0\\loop\\advance\\busy by1\\ifnum\\busy<100000000\\repeat\n\\end{document}\n';
  await editor(a).evaluate((el, text) => { const v = el.cmView.view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } }); }, slowSource);
  await waitText(b, 'WorkerGroupFailure');
  // Start the request before the synchronous, bounded subprocess search.
  await a.waitForFunction(() => ![...document.querySelectorAll('button')].some(e => e.textContent.includes('Compiling')));
  const failureResponse = a.waitForResponse(r => new URL(r.url()).pathname.endsWith('/compile') && r.request().method() === 'POST', { timeout: 60000 });
  await a.getByRole('button', { name: 'Recompile', exact: true }).click();
  const killed = execFileSync('docker', ['exec', '-i', '-u', 'www-data', 'sharelatex', 'node', '--input-type=module'], {
    encoding: 'utf8', timeout: 12000,
    input: `import fs from 'node:fs'; import Path from 'node:path'; import assert from 'node:assert/strict';
const prefix = '/var/lib/overleaf/data/compiles/' + ${JSON.stringify(projectId)} + '-';
for (let attempt = 0; attempt < 160; attempt++) {
  const jobs = [];
  for (const n of fs.readdirSync('/proc')) {
    if (!/^\\d+$/.test(n)) continue;
    try {
      const cwd = fs.readlinkSync('/proc/' + n + '/cwd');
      const args = fs.readFileSync('/proc/' + n + '/cmdline', 'utf8').split('\\0');
      if (cwd.startsWith(prefix) && args.some(a => (Path.basename(a) === 'latexmk' || a === '/usr/local/texlive/2026/texmf-dist/scripts/latexmk/latexmk.pl'))) {
        const stat = fs.readFileSync('/proc/' + n + '/stat', 'utf8');
        jobs.push({ pid: Number(n), pgrp: Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]), cwd });
      }
    } catch {}
  }
  if (jobs.length) {
    assert.equal(jobs.length, 1); assert.equal(jobs[0].pid, jobs[0].pgrp);
    process.kill(-jobs[0].pid, 'SIGKILL'); console.log(JSON.stringify(jobs[0])); process.exit(0);
  }
  await new Promise(r => setTimeout(r, 50));
}
throw Error('No exact synthetic job group found; no process killed');`
  });
  metrics.killedSyntheticGroup = JSON.parse(killed).pid;
  const failure = await (await failureResponse).json(); metrics.workerLossStatus = failure.status;
  assert.notEqual(failure.status, 'success', 'Worker-group loss must not be reported as a successful compile');
  assert.equal(await buffer(a), slowSource, 'Worker failure lost source');
  await editor(a).evaluate((el, text) => { const v = el.cmView.view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } }); }, source.replace('Alpha text', 'WorkerRecoveredExactMarker Alpha text'));
  await waitText(b, 'WorkerRecoveredExactMarker');
  const retry = await compile(a); assert.equal(retry.status, 'success');
  await a.waitForFunction(() => [...document.querySelectorAll('.textLayer')].some(e => e.textContent.includes('WorkerRecoveredExactMarker')));
  await converged(a, b); passed('synthetic compile-group loss preserves source; explicit retry produces correct PDF');
  const sorted = metrics.peerMs.toSorted((a, b) => a - b);
  console.log(JSON.stringify({ ...metrics, peerMs: metrics.peerMs.map(Math.round), pairArrivalP95Ms: Math.round(sorted[Math.ceil(sorted.length * .95) - 1]), browser: browser.version(), projectUrl, result: 'passed', profile: process.env.PROFILE_LABEL || 'candidate0', scope: 'two local accounts; supported BMP text; no remote-network or capacity guarantee' }));
} finally { if (projectUrl) console.log('Retain for scoped cleanup: ' + projectUrl); await browser.close(); rmSync(work, { recursive: true, force: true }); }
