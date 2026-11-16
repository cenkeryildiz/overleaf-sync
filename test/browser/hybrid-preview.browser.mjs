import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url = process.env.OVERLEAF_TEST_PROJECT_URL;
assert(url?.startsWith('http://127.0.0.1:8080/project/'), 'Designate the disposable copy explicitly');
const base = new URL(url).origin, browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
let original, page;
const replies = [], errors = [], samples = [], nativeSamples = [], tokens = new Set();
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  page = await context.newPage(); page.setDefaultTimeout(35000);
  page.on('request', r => { if(r.method()==='POST' && r.url().includes('preview'))console.log(JSON.stringify({requestPath:new URL(r.url()).pathname})); });
  page.on('response', r => { if(r.request().method()==='POST')console.log(JSON.stringify({responsePath:new URL(r.url()).pathname,status:r.status()})); });
  page.on('pageerror', e => errors.push(e.message.slice(0, 200)));
  page.on('response', async r => { if (new URL(r.url()).pathname.endsWith('/live-preview')) { let data; try { data = await r.json(); } catch {} if(data?.token)tokens.add(data.token); replies.push({ status: r.status(), ok: data?.ok, error: data?.error, frame: data?.frame, active: data?.active }); } });
  await page.goto(base + '/login'); await page.locator('input[name=email]').fill('alice@example.test');
  await page.locator('input[name=password]').fill(process.env.OVERLEAF_TEST_ALICE_PASSWORD);
  await page.getByRole('button', { name: /^Login/ }).click(); await page.waitForURL(base + '/project');
  await page.goto(url); const editor = page.getByRole('textbox', { name: /^Source Editor/ }); await editor.waitFor();
  original = await editor.evaluate(e => e.cmView.view.state.doc.toString());
  const env = [...original.matchAll(/\\begin\{questions\}/g)].at(-1); assert(env);
  const questions = [...original.slice(env.index).matchAll(/\\question(?:\[[^\]]*\])?/g)]; assert(questions.length >= 3);
  const position = env.index + questions[1].index + questions[1][0].length;
  await editor.evaluate((e, at) => { const v = e.cmView.view; v.dispatch({ selection: { anchor: at }, scrollIntoView: true }); v.focus(); }, position);
  await page.waitForFunction(() => document.querySelector('[aria-label="Live preview"] img')?.complete || document.querySelector('.recovery-controls button:last-child')?.textContent.includes('Retry'), null, { timeout: 40000 });
  if (!await page.locator('[aria-label="Live preview"] img').count()) throw Error('Initial live page unavailable');
  await editor.evaluate((e, at) => { const v = e.cmView.view; v.dispatch({ changes: { from: at, insert: ' LiveProbeA ' }, selection: { anchor: at + 11 } }); v.focus(); }, position);
  await page.waitForFunction(() => document.querySelector('[aria-label="Live preview"] [role=document]')?.textContent.includes('LiveProbeA'), null, { timeout: 20000 });
  const visibleBox=await page.locator('[aria-label="Live preview"] img').boundingBox();assert(visibleBox?.width>100 && visibleBox?.height>100,'Live page must have visible geometry');
  await page.waitForTimeout(500);
  for (const letter of ['B', 'C', 'D']) {
    await editor.evaluate(e => { const v = e.cmView.view, at = v.state.doc.toString().indexOf('LiveProbe') + 9; v.dispatch({ selection: { anchor: at, head: at + 1 } }); v.focus(); });
    await page.evaluate(() => {
      globalThis.liveInput = null; globalThis.livePaint = null;
      document.addEventListener('beforeinput', () => { globalThis.liveInput ??= performance.now(); }, { once: true, capture: true });
      document.addEventListener('overleaf:live-frame', () => requestAnimationFrame(() => requestAnimationFrame(() => { globalThis.livePaint = performance.now(); })), { once: true });
    });
    await page.keyboard.type(letter);
    await page.waitForFunction(() => globalThis.livePaint !== null && globalThis.liveInput !== null);
    samples.push(await page.evaluate(() => livePaint - liveInput));
    assert((await editor.evaluate(e => e.cmView.view.state.doc.toString())).includes('LiveProbe' + letter));
  }
  await page.waitForFunction(() => document.querySelector('[aria-label="Live preview"] [role=document]')?.textContent.includes('LiveProbeD'));
  assert(replies.some(r => (JSON.stringify(r.frame?.text)||'').includes('LiveProbeD')), 'Rendered text must contain actual latest edit');
  await page.getByRole('button', { name: 'Show final PDF', exact: true }).click();
  assert.equal(await page.locator('[aria-label="Live preview"]').count(), 0);
  await page.waitForFunction(() => document.querySelectorAll('.textLayer').length > 0);
  const finalPage=replies.filter(r=>r.frame).at(-1).frame.page+1;
  await page.locator('.page[data-page-number="'+finalPage+'"]').scrollIntoViewIfNeeded();
  await editor.evaluate(e=>{const v=e.cmView.view,at=v.state.doc.toString().indexOf('LiveProbe')+9;v.dispatch({changes:{from:at,to:at+1,insert:'A'}})});
  await page.waitForFunction(()=>[...document.querySelectorAll('.textLayer')].some(e=>e.textContent.includes('LiveProbeA')));
  for(const letter of ['B','C','D']){
    await editor.evaluate(e=>{const v=e.cmView.view,at=v.state.doc.toString().indexOf('LiveProbe')+9;v.dispatch({selection:{anchor:at,head:at+1}});v.focus()});
    await page.evaluate(letter=>{globalThis.nativeInput=null;globalThis.nativePaint=null;document.addEventListener('beforeinput',()=>{nativeInput=performance.now()},{once:true,capture:true});const observer=new MutationObserver(()=>{if([...document.querySelectorAll('.textLayer')].some(e=>e.textContent.includes('LiveProbe'+letter))){observer.disconnect();requestAnimationFrame(()=>requestAnimationFrame(()=>{nativePaint=performance.now()}))}});observer.observe(document.body,{subtree:true,childList:true,characterData:true})},letter);
    await page.keyboard.type(letter);await page.waitForFunction(()=>nativeInput!==null&&nativePaint!==null);nativeSamples.push(await page.evaluate(()=>nativePaint-nativeInput));
  }
  const exact = await editor.evaluate(e => e.cmView.view.state.doc.toString());
  await page.reload(); await editor.waitFor(); assert(await editor.evaluate(e => e.cmView.view.state.doc.toString()) === exact, 'Source did not reload exactly');
  console.log(JSON.stringify({ passed: true, samplesMs: samples, nativeSamplesMs: nativeSamples, frames: replies.filter(r => r.frame).length, errors, sourceReloadExact: true }));
} catch (e) {
  console.log(JSON.stringify({ passed: false, failure: e.message, clientFailure: await page?.evaluate(() => ({live:document.querySelector('[aria-label="Live preview"]')?.getBoundingClientRect().toJSON(),host:document.querySelector('[data-testid=pdf-viewer]')?.getBoundingClientRect().toJSON(),pdfPages:document.querySelectorAll('.page[data-page-number]').length,canvas:document.querySelectorAll('canvas').length})), requests: replies.map(r => ({ status: r.status, ok: r.ok, error: r.error, revision: r.frame?.revision, page: r.frame?.page, hasProbe: (JSON.stringify(r.frame?.text) || '').includes('LiveProbe') })), errors }));
  process.exitCode = 1;
} finally {
  if(page && !page.isClosed()){const toggle=page.getByRole('button',{name:'Show final PDF',exact:true});if(await toggle.count())await toggle.click().catch(()=>{});await page.waitForTimeout(800);}
  if (original && page && !page.isClosed()) {
    const editor = page.getByRole('textbox', { name: /^Source Editor/ });
    if (await editor.count()) await editor.evaluate((e, text) => { const v = e.cmView.view; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } }); }, original);
    await page.waitForTimeout(800);
  }
  if (process.env.HYBRID_RESULT_FILE) fs.writeFileSync(process.env.HYBRID_RESULT_FILE, JSON.stringify({ samples, nativeSamples, replies: replies.map(r => ({ status:r.status, ok:r.ok, error:r.error, revision:r.frame?.revision })), errors }), { mode: 0o600 });
  if (page && !page.isClosed()) await page.evaluate(async tokens => { const raw=document.querySelector('meta[name=ol-csrfToken]')?.content; let csrf;try{csrf=JSON.parse(raw)}catch{csrf=raw} for(const token of tokens) await fetch(location.pathname+'/live-preview',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({livePreview:{op:'close',token}})}); }, [...tokens]).catch(()=>{});
  await browser.close();
}
