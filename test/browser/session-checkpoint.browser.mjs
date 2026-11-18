// Native session durability: real Chrome, Mongo/document-updater/history and immutable version ZIP.
// Only synthetic qualification accounts/projects; no public network or compiler downloads.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { withSyntheticAccounts } from './synthetic-accounts.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const container = process.env.HOSTING_APP_CONTAINER, base = process.env.HOSTING_TEST_BASE || 'http://127.0.0.1:8081';
assert(container, 'Explicit synthetic-account target required'); assert.equal(new URL(base).hostname, '127.0.0.1');
const work = mkdtempSync(join(tmpdir(), 'latex-checkpoint-')), name = 'checkpoint-' + Date.now();
const files = { 'main.tex': '\documentclass{article}\n\begin{document}\nDurable fixture.\input{chapter}\n\end{document}\n', 'chapter.tex': 'Shared chapter.\n',
  'figure.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64') };
for (const [path, value] of Object.entries(files)) writeFileSync(join(work, path), value);
execFileSync('/usr/bin/zip', ['-q', join(work, name + '.zip'), ...Object.keys(files)], { cwd: work });
const hash = value => createHash('sha256').update(value).digest('hex'), metrics = {}, responses = [];
let lastStage = 'starting';
const stage = value => { lastStage = value; console.log('Checkpoint stage: ' + value); };
try {
  await withSyntheticAccounts(async users => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
    const deadline = setTimeout(() => browser.close(), 300000);
    let diagnosticProject, diagnosticDoc, diagnosticHash;
    try {
      async function context() {
        const value = await browser.newContext({ viewport: { width: 1500, height: 950 }, serviceWorkers: 'block' });
        await value.route('**/*', route => {
          const url = new URL(route.request().url()); if (url.origin !== base) return route.abort();
          if (url.pathname === '/participant/client.mjs') return route.fulfill({ contentType: 'application/javascript', body: 'export async function compile(){return Response.json({status:"error",outputFiles:[]})}export async function cancel(){return Response.json({})}' });
          return route.continue();
        });
        return value;
      }
      async function login(user) {
        const page = await (await context()).newPage(); page.setDefaultTimeout(20000);
        await page.goto(base + '/login'); await page.locator('input[name=email]').fill(user.email); await page.locator('input[name=password]').fill(user.password);
        await page.getByRole('button', { name: /^Login/ }).click(); await page.waitForURL(base + '/project'); return page;
      }
      const [owner, reader, outsider] = await Promise.all(users.map(login)); stage('individual logins ready');
      const editor = page => page.getByRole('textbox', { name: /^Source Editor/ });
      const currentText = page => editor(page).evaluate(node => node.cmView.view.state.doc.toString());
      const csrf = page => page.evaluate(() => { const raw = document.querySelector('meta[name="ol-csrfToken"]').content; try { return JSON.parse(raw); } catch { return raw; } });
      const request = async (page, path, data) => page.request.post(base + path, { headers: { 'X-CSRF-Token': await csrf(page) }, data, maxRedirects: 0 });
      function observe(page) {
        page.on('response', response => {
          if (!response.url().includes('/participant-compile')) return;
          let body; try { body = response.request().postDataJSON(); } catch { return; }
          if (body?.op === 'checkpoint') {
            let timeout;
            const body = Promise.race([response.text().catch(() => 'response unavailable'), new Promise(resolve => { timeout = setTimeout(() => resolve('response body unavailable within1s'), 1000); })]).finally(() => clearTimeout(timeout));
            responses.push({ status: response.status(), body });
          }
        });
      }
      await owner.getByRole('button', { name: /^(New project|Create a new project)$/i }).click();
      await owner.getByText('Existing project (.zip)', { exact: true }).click(); await owner.locator('input[type=file]').first().setInputFiles(join(work, name + '.zip'));
      await owner.waitForURL(/\/project\/[a-f0-9]{24}/); await editor(owner).waitFor();
      const url = owner.url(), project = new URL(url).pathname.split('/').at(-1);
      await owner.waitForFunction(() => globalThis.overleafSessionCheckpoint && globalThis.overleafParticipantEditor?.docId); stage('native project and helper ready');
      const doc = await owner.evaluate(() => overleafParticipantEditor.docId); diagnosticProject = project; diagnosticDoc = doc; observe(owner);
      const invited = await request(owner, `/project/${project}/invite`, { email: users[1].email, privileges: 'readOnly' }); assert(invited.ok());
      await reader.goto(base + '/project'); const invite = reader.getByRole('alert').filter({ hasText: name });
      await invite.getByRole('button', { name: 'Join Project', exact: true }).click(); await invite.getByText('Open Project', { exact: true }).waitFor(); await reader.goto(url); await editor(reader).waitFor();
      const otherTab = await owner.context().newPage(); await otherTab.goto(url); await editor(otherTab).waitFor();
      const sentinel = 'checkpoint-fixture-' + Date.now();
      await owner.evaluate(async name => {
        localStorage.setItem(name, 'keep'); const cache = await caches.open(name); await cache.put('/checkpoint-fixture', new Response('keep-cache'));
        await new Promise((resolve, reject) => { const open = indexedDB.open(name, 1); open.onupgradeneeded = () => open.result.createObjectStore('sentinel'); open.onerror = () => reject(open.error); open.onsuccess = () => { const db = open.result, tx = db.transaction('sentinel', 'readwrite'); tx.objectStore('sentinel').put('keep-idb', 'key'); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); }; });
      }, sentinel);
      async function saved(page, key) {
        await page.waitForFunction(key => { try { return !!overleafRecovery.reviewSnapshot(overleafRecovery.read(key)); } catch { return false; } }, key);
      }
      async function edit(page, marker) {
        const started = performance.now();
        const value = await page.evaluate(marker => {
          const api = overleafRecovery, e = overleafParticipantEditor.facade; e.cmChange({ from: e.getValue().length, insert: marker });
          const scope = api.currentScope(), copy = api.list(scope.account, scope.project).find(item => item.record.doc === scope.doc && item.record.candidate === e.getValue());
          if (!copy) throw Error('Synchronous pre-send recovery copy missing');
          return { key: copy.key, raw: localStorage.getItem(copy.key), candidate: copy.record.candidate, record: copy.record };
        }, marker);
        await saved(page, value.key); value.ackMs = performance.now() - started; return value;
      }
      async function storage(page, key) { return page.evaluate(key => ({ raw: localStorage.getItem(key), marker: localStorage.getItem('overleaf.checkpoint.v1.' + key.slice('overleaf.recovery.v1.'.length)) }), key); }
      async function flush(page, key) {
        const first = responses.length, started = performance.now(); stage('native durable checkpoint requested');
        await page.evaluate(() => Promise.race([overleafSessionCheckpoint.flush(), new Promise((_, reject) => setTimeout(() => reject(Error('Checkpoint exceeded120s')), 120000))]));
        const observed = responses.slice(first); const successful = observed.find(response => response.status >= 200 && response.status < 300);
        const proof = successful ? JSON.parse(await successful.body).checkpoint : null;
        assert.equal((await storage(page, key)).raw === null, true, 'A verified checkpoint must remove only its unchanged owned source');
        assert(proof?.durable, 'Actual native durable receipt missing: ' + JSON.stringify(await Promise.all(observed.map(async r => ({ status: r.status, body: await r.body })))));
        stage('native durable receipt verified'); return { proof, ms: performance.now() - started };
      }
      const first = await edit(owner, '% First durable edit\n'); metrics.saveAckMs = first.ackMs; stage('synchronous recovery and native edit acknowledgement verified');
      metrics.candidateBytes = Buffer.byteLength(first.raw); diagnosticHash = hash(first.candidate);
      const unrelated = await otherTab.evaluate(record => { const copy = { ...record, writer: crypto.randomUUID(), candidate: record.candidate + '% Other tab retained copy\n' }; return { key: overleafRecovery.save(copy), raw: JSON.stringify(copy) }; }, first.record);
      const checked = await flush(owner, first.key); metrics.checkpointMs = checked.ms;
      assert.deepEqual(await storage(owner, first.key), { raw: null, marker: null });
      assert.equal(await owner.evaluate(key => localStorage.getItem(key), unrelated.key), unrelated.raw);
      const zip = await owner.request.get(`${base}/project/${project}/version/${checked.proof.version}/zip`, { timeout: 60000 });
      assert(zip.ok(), 'Native immutable version ZIP unavailable: ' + zip.status()); writeFileSync(join(work, 'version.zip'), await zip.body());
      for (const [path, expected] of Object.entries({ ...files, 'main.tex': first.candidate })) assert.deepEqual(execFileSync('/usr/bin/unzip', ['-p', join(work, 'version.zip'), path]), Buffer.from(expected), 'Immutable version differs: ' + path);
      assert.equal(await reader.waitForFunction(value => overleafParticipantEditor.facade.getValue() === value, first.candidate).then(() => true), true);
      const invalid = await request(owner, `/project/${project}/participant-compile`, { op: 'checkpoint', docs: [{ id: doc, hash: '0'.repeat(64) }] }); assert.equal(invalid.status(), 409);
      const manifest = { op: 'checkpoint', docs: [{ id: doc, hash: hash(first.candidate) }] };
      for (const page of [reader, outsider]) {
        const retained = await page.evaluate(({ account, project, doc, candidate }) => { const value = { schema: 1, account, project, doc, writer: crypto.randomUUID(), revision: 1, name: 'main.tex', base: { version: 0, text: '' }, candidate, updatedAt: Date.now() }; const key = 'overleaf.recovery.v1.' + [account, project, doc, value.writer].join('.'); localStorage.setItem(key, JSON.stringify(value)); return { key, raw: localStorage.getItem(key) }; }, { account: users[page === reader ? 1 : 2].id, project, doc, candidate: first.candidate });
        const denied = await request(page, `/project/${project}/participant-compile`, manifest); assert([401, 403, 404].includes(denied.status()), 'Unauthorized checkpoint must fail: ' + denied.status());
        assert.equal(await page.evaluate(key => localStorage.getItem(key), retained.key), retained.raw);
      }
      const stale = await owner.evaluate(record => { const value = { ...record, writer: crypto.randomUUID(), candidate: 'Not on the native server', revision: 1 }; const key = overleafRecovery.save(value); overleafSessionCheckpoint.track(key, value); return { key, raw: localStorage.getItem(key) }; }, first.record);
      await owner.evaluate(() => overleafSessionCheckpoint.flush()); assert.equal((await storage(owner, stale.key)).raw, stale.raw);
      await owner.evaluate(({ key, text }) => { const value = JSON.parse(localStorage.getItem(key)); value.candidate = text; value.revision++; overleafRecovery.save(value); overleafSessionCheckpoint.track(key, value); }, { key: stale.key, text: first.candidate }); await flush(owner, stale.key);
      const closeCopy = await edit(owner, '% Survive lost response and page close\n');
      let lostProof;
      await owner.route('**/participant-compile', async route => {
        if (route.request().postDataJSON()?.op !== 'checkpoint') return route.continue();
        const response = await route.fetch(); assert(response.ok(), 'Server failed before response loss: ' + response.status()); lostProof = (await response.json()).checkpoint; await route.abort('failed');
      });
      await owner.evaluate(() => overleafSessionCheckpoint.flush()); assert(lostProof?.durable); const lost = await storage(owner, closeCopy.key); assert(lost.raw && lost.marker);
      metrics.pendingMarkerBytes = Buffer.byteLength(lost.marker); const closeStarted = performance.now(); await owner.close(); metrics.pageCloseMs = performance.now() - closeStarted;
      assert.equal((await storage(otherTab, closeCopy.key)).raw, closeCopy.raw);
      const reopened = await otherTab.context().newPage(); reopened.setDefaultTimeout(20000); observe(reopened); const retryStarted = performance.now(); await reopened.goto(url); await editor(reopened).waitFor();
      await reopened.waitForFunction(() => globalThis.overleafSessionCheckpoint); const retried = await flush(reopened, closeCopy.key); metrics.revisitRetryMs = performance.now() - retryStarted;
      assert.equal(retried.proof.version, lostProof.version, 'Retry without edits must reuse the same immutable native version');
      assert.equal(await currentText(reopened), closeCopy.candidate); assert.equal(await reopened.evaluate(key => localStorage.getItem(key), unrelated.key), unrelated.raw);
      metrics.repeatCheckpointMs = [];
      for (let index = 0; index < 2; index++) { const value = await edit(reopened, `% Repeat ${index}\n`), proof = await flush(reopened, value.key); metrics.repeatCheckpointMs.push(proof.ms); }
      const leftovers = await reopened.evaluate(({ account, project, sentinel }) => {
        const names = Object.keys(localStorage), prefix = account + '.' + project + '.';
        return { candidateKeys: names.filter(k => k.startsWith('overleaf.recovery.v1.' + prefix)), markers: names.filter(k => k.startsWith('overleaf.checkpoint.v1.' + prefix)), sentinel: localStorage.getItem(sentinel) };
      }, { account: users[0].id, project, sentinel });
      assert.deepEqual(leftovers.candidateKeys, [unrelated.key]); assert.deepEqual(leftovers.markers, []); assert.equal(leftovers.sentinel, 'keep');
      const cachesKept = await reopened.evaluate(async name => ({ cache: await (await caches.open(name)).match('/checkpoint-fixture').then(r => r.text()), idb: await new Promise((resolve, reject) => { const open = indexedDB.open(name); open.onsuccess = () => { const db = open.result, tx = db.transaction('sentinel'), read = tx.objectStore('sentinel').get('key'); read.onsuccess = () => resolve(read.result); tx.oncomplete = () => db.close(); }; open.onerror = () => reject(open.error); }) }), sentinel);
      assert.deepEqual(cachesKept, { cache: 'keep-cache', idb: 'keep-idb' });
      const logoutCopy = await edit(reopened, '% Retain after sign-out\n'); const signout = await reopened.context().newPage(); await signout.goto(base + '/project');
      const signedOut = await request(signout, '/logout', {}); assert([200, 302, 303].includes(signedOut.status()), 'Logout failed');
      await reopened.evaluate(() => overleafSessionCheckpoint.flush()); assert.equal((await storage(reopened, logoutCopy.key)).raw, logoutCopy.raw);
      const loggedOut = await request(reopened, `/project/${project}/participant-compile`, { op: 'checkpoint', docs: [{ id: doc, hash: hash(logoutCopy.candidate) }] }); assert([302, 401, 403, 404].includes(loggedOut.status()));
      assert.equal(await reader.waitForFunction(value => overleafParticipantEditor.facade.getValue() === value, logoutCopy.candidate).then(() => true), true);
      console.log(JSON.stringify({ sessionCheckpointPassed: true, realMongoHistoryReceipt: true, immutableVersionZipExact: true, otherTabRetained: true, staleAndUnauthorizedRefused: true, realPageCloseRetry: true, cachesAndIdbRetained: true, repeatedNoCandidateGrowth: true, ...metrics }));
    } catch (error) {
      if (diagnosticProject && diagnosticDoc && diagnosticHash && !metrics.checkpointMs) {
        const code = "import {createHash} from 'node:crypto';import D from './app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs';import H from './app/src/Features/History/HistoryManager.mjs';import P from './app/src/Features/Project/ProjectGetter.mjs';import E from './app/src/Features/Project/ProjectEntityHandler.mjs';import {getLatestSnapshot} from './app/src/Features/History/HistoryOTContentManager.mjs';let raw='';for await(const chunk of process.stdin)raw+=chunk;const input=JSON.parse(raw);if(!/^[a-f0-9]{24}$/.test(input.project)||!/^[a-f0-9]{24}$/.test(input.doc)||!/^[a-f0-9]{64}$/.test(input.hash))throw Error('Invalid diagnostic fixture');let active='import';const emit=v=>console.log('CHECKPOINT_DIAG:'+JSON.stringify(v));const timeout=setTimeout(()=>{emit({stage:active,timeout:true});process.exit(124)},45000);async function run(stage,fn){active=stage;const start=performance.now();emit({stage,start:true});try{const result=await fn();emit({stage,ms:performance.now()-start});return result}catch{emit({stage,ms:performance.now()-start,failed:true});throw Error('Native stage failed')}}try{const doc=await run('getDocument',()=>D.promises.getDocument(input.project,input.doc,-1));emit({stage:'documentHash',match:createHash('sha256').update(doc.lines.join(String.fromCharCode(10))).digest('hex')===input.hash,versionValid:Number.isSafeInteger(doc.version)});await run('flushMongo',()=>D.promises.flushProjectToMongo(input.project));await run('flushHistory',()=>H.promises.flushProject(input.project));const project=await run('getHistoryId',()=>P.promises.getProject(input.project,{overleaf:true}));emit({stage:'historyId',present:!!project.overleaf?.history?.id});const saved=await run('getLatestSnapshot',()=>getLatestSnapshot(project.overleaf.history.id));const docs=await E.promises.getAllDocs(input.project);const path=Object.entries(docs).find(([,v])=>String(v._id)===input.doc)?.[0]?.replace(new RegExp('^/'),'');const file=saved.snapshot.getFile(path);const content=file?.isEditable()?file.getContent({filterTrackedDeletes:true}):undefined;emit({stage:'historyFile',present:!!file,editable:!!file?.isEditable(),type:typeof content,hashMatch:typeof content==='string'&&createHash('sha256').update(content).digest('hex')===input.hash,versionValid:Number.isSafeInteger(saved.version)});clearTimeout(timeout);process.exit(0)}catch{clearTimeout(timeout);process.exit(1)}";
        let diagnostic;
        try { diagnostic = execFileSync('docker', ['exec', '-i', '-w', '/overleaf/services/web', container, 'node', '--input-type=module', '-e', code], { input: JSON.stringify({ project: diagnosticProject, doc: diagnosticDoc, hash: diagnosticHash }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 55000 }); }
        catch (failure) { diagnostic = failure.stdout?.toString() || ''; }
        for (const line of diagnostic.split('\n')) if (line.startsWith('CHECKPOINT_DIAG:')) console.error(line);
      }
      console.error(JSON.stringify({ lastStage, checkpointResponses: await Promise.all(responses.slice(-6).map(async response => ({ status: response.status, body: await response.body }))) })); throw error;
    } finally { clearTimeout(deadline); await browser.close(); }
  }, 3, container);
} finally { rmSync(work, { recursive: true, force: true }); }
