import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSyntheticAccounts } from './synthetic-accounts.mjs';
import { compileTimeline, now } from './compile-marks.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const container = process.env.HOSTING_APP_CONTAINER;
assert(container, 'Explicit synthetic-account target container is required');
const base = process.env.HOSTING_TEST_BASE || 'http://127.0.0.1:8081';
assert.equal(new URL(base).hostname, '127.0.0.1', 'This check is restricted to local staging');
const work = mkdtempSync(join(tmpdir(), 'latex-auth-'));
const artifactRoots = [];
const source = String.raw`\documentclass{article}
\usepackage[T1]{fontenc}
\usepackage{lmodern,amsmath,geometry,tikz}
\geometry{a4paper,margin=1in}
\begin{document}
Authorization fixture.
\input{chapter}
\begin{figure}[h]\centering
\begin{tikzpicture}\draw[->] (0,0) -- (4,0);\draw[->] (0,0) -- (0,2);\draw[thick] (0,0) parabola (3,1.5);\end{tikzpicture}
\caption{Synthetic graph}\end{figure}
\cite{fixture}
\bibliographystyle{plain}\bibliography{refs}
\end{document}
`;
const picture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64');
const chapterSource = 'Shared chapter.\\par\n' + Array.from({ length: 12 }, (_, i) => `\\subsection*{Question ${i + 1}}\nSynthetic calculation ${i + 1}. The project retains this exact source across editing, compilation, export and reload.\n\\begin{align} y_{${i + 1}} &= \\alpha + \\beta x_{${i + 1}} + \\varepsilon_{${i + 1}} \\\\ E &= mc^2 + \\int_0^1 x\\,dx \\end{align}\n${i % 4 === 3 ? '\\newpage\n' : ''}`).join('');
const fixtureFiles = { 'main.tex': source, 'chapter.tex': chapterSource, 'figure.png': picture, 'refs.bib': '@book{fixture,author={Synthetic Author},title={Participant Fixture},year={2026}}\n' };
for (const [name, bytes] of Object.entries(fixtureFiles)) writeFileSync(join(work, name), bytes);
execFileSync('/usr/bin/zip', ['-q', join(work, 'authorization-fixture.zip'), ...Object.keys(fixtureFiles)], { cwd: work });
try {
  await withSyntheticAccounts(async users => {
    const options = { headless: true, executablePath: process.env.CHROME_PATH };
    const persistent = process.env.HOSTING_OFFLINE_CHECK === '1' ? await chromium.launchPersistentContext(join(work, 'browser'), { ...options, viewport: { width: 1600, height: 1000 }, serviceWorkers: 'allow' }) : undefined;
    const browser = persistent?.browser() || await chromium.launch(options);
    const deadline = setTimeout(() => browser.close(), process.env.HOSTING_OFFLINE_CHECK === '1' ? 600000 : 180000);
    try {
      async function login(user) {
        const context = user === users[0] && persistent ? persistent : await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: process.env.HOSTING_OFFLINE_CHECK === '1' ? 'allow' : 'block' });
        await context.addInitScript(() => {
          let current = globalThis.fetch.bind(globalThis), refusals = 0;
          Object.defineProperty(globalThis, 'fetch', { configurable: true, get: () => current, set(fn) {
            current = async (...args) => {
              const response = await fn(...args);
              const target = new URL(typeof args[0] === 'string' || args[0] instanceof URL ? args[0] : args[0].url, location.href);
              if (location.pathname === '/recovery/native-workspace.html' && /\/sync\/(code|pdf)$/.test(target.pathname)) {
                (globalThis.nativeSyncCalls ||= []).push({ path: target.pathname, query: target.search, status: response.status, body: await response.clone().json() });
              }
              if (location.pathname === '/recovery/native-workspace.html' && !response.ok && refusals++ < 10) {
                const input = args[0], url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
                console.log('Native refused: ' + (args[1]?.method || input.method || 'GET') + ' ' + url.pathname.replace(/[a-f0-9]{24}/g, '<synthetic>'));
              }
              return response;
            };
          } });
        });
        await context.route('**/*', route => {
          const url = new URL(route.request().url());
          if (url.origin !== base) return route.abort();
          // Authorization-only check: avoid worker/package downloads; server endpoints remain real.
          if (url.pathname === '/participant/client.mjs') return route.fulfill({ contentType: 'application/javascript',
            body: 'export async function compile(){return Response.json({status:"error",outputFiles:[]})}export async function cancel(){return Response.json({})}' });
          return route.continue();
        });
        const page = await context.newPage(); page.setDefaultTimeout(20000);
        page.on('pageerror', error => console.error(JSON.stringify({ pageError: error.message.slice(0, 240) })));
        page.on('console', message => { if (/^Native (local status|refused):/.test(message.text())) console.log(message.text()); });
        let nativeFailures = 0;
        page.on('response', response => { if (page.url().includes('/recovery/native-workspace') && response.status() >= 400 && nativeFailures++ < 12) console.log(JSON.stringify({ nativeResourceFailure: new URL(response.url()).pathname.replace(/[a-f0-9]{24}/g, '<synthetic>'), status: response.status() })); });
        page.on('requestfailed', request => { if (page.url().includes('/recovery/native-workspace') && nativeFailures++ < 12) console.log(JSON.stringify({ nativeRequestFailed: new URL(request.url()).pathname.replace(/[a-f0-9]{24}/g, '<synthetic>'), reason: request.failure()?.errorText })); });
        await page.goto(base + '/login'); await page.locator('input[name=email]').fill(user.email);
        await page.locator('input[name=password]').fill(user.password); await page.getByRole('button', { name: /^Login/ }).click();
        await page.waitForURL(base + '/project'); return page;
      }
      const [alice, bob, carol] = await Promise.all(users.map(login));
      async function importProject(filename = 'authorization-fixture.zip') {
        const navigation = await alice.goto(base + '/project');
        try { await alice.getByRole('button', { name: /^(New project|Create a new project)$/i }).click(); }
        catch (error) {
          console.error(JSON.stringify({ stage: 'new-project', path: new URL(alice.url()).pathname,
            status: navigation.status(), title: await alice.title(), text: (await alice.locator('body').innerText()).slice(0, 350),
            buttons: (await alice.getByRole('button').allTextContents()).map(s => s.trim()).filter(Boolean).slice(0, 16) }));
          throw error;
        }
        await alice.getByText('Existing project (.zip)', { exact: true }).click();
        await alice.locator('input[type=file]').first().setInputFiles(join(work, filename));
        await alice.waitForURL(/\/project\/[a-f0-9]+/); const url = alice.url();
        await alice.getByRole('textbox', { name: /^Source Editor/ }).waitFor();
        const docId = await alice.evaluate(() => globalThis.overleafParticipantEditor.docId);
        return { url, docId };
      }
      async function csrf(page) {
        return page.evaluate(() => { const raw = document.querySelector('meta[name="ol-csrfToken"]').content; try { return JSON.parse(raw); } catch { return raw; } });
      }
      async function api(page, project, body, token) {
        if (token === undefined) token = await csrf(page);
        return page.request.post(project.url + '/participant-compile', { headers: token === null ? {} : { 'X-CSRF-Token': token }, data: body, maxRedirects: 0 });
      }
      async function deniedZip(page, project) {
        const response = await page.request.get(project.url.replace('/project/', '/Project/') + '/download/zip', { maxRedirects: 0 });
        assert([403, 404].includes(response.status()), 'Private source export must be denied');
      }
      async function inviteMember(member, user, project) {
        assert.equal(new URL(alice.url()).pathname, new URL(project.url).pathname);
        await alice.getByRole('button', { name: /Share/ }).click(); const dialog = alice.getByRole('dialog');
        await dialog.locator('input[type=email]').fill(user.email); await dialog.getByRole('button', { name: 'Invite', exact: true }).click();
        await dialog.getByText(user.email, { exact: true }).waitFor(); await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
        await member.goto(base + '/project'); const invite = member.getByRole('alert').filter({ hasText: 'authorization-fixture' });
        await invite.getByRole('button', { name: 'Join Project', exact: true }).click(); await invite.getByText('Open Project', { exact: true }).waitFor();
        await member.goto(project.url); await member.getByRole('textbox', { name: /^Source Editor/ }).waitFor();
      }
      const first = await importProject();
      await deniedZip(bob, first);
      assert([403, 404].includes((await api(carol, first, { op: 'join' })).status()), 'Outsider may not join compute pool');
      assert([403, 404].includes((await api(carol, first, { op: 'prepare-offline', docId: first.docId, text: source, version: 0 })).status()), 'Outsider may not download an offline snapshot');
      assert.equal((await api(alice, first, { op: 'join' }, null)).status(), 403, 'Missing CSRF must fail');
      assert.equal((await api(alice, first, { op: 'join' }, 'invalid-csrf')).status(), 403, 'Wrong CSRF must fail');
      const anonymous = await browser.newContext();
      const anon = await anonymous.request.post(first.url + '/participant-compile', { data: { op: 'join' }, maxRedirects: 0 });
      assert([302, 401, 403, 404].includes(anon.status()), 'Unauthenticated pool request must fail'); await anonymous.close();

      await inviteMember(bob, users[1], first);
      const ownerJoin = await api(alice, first, { op: 'join' }), bobJoin = await api(bob, first, { op: 'join' });
      assert(ownerJoin.ok() && bobJoin.ok()); const ownerWorker = (await ownerJoin.json()).worker, bobWorker = (await bobJoin.json()).worker;
      assert.equal((await api(bob, first, { op: 'claim', worker: ownerWorker })).status(), 409, 'Worker token cannot cross accounts');
      const second = await importProject();
      assert.equal((await api(alice, second, { op: 'claim', worker: ownerWorker })).status(), 409, 'Worker token cannot cross projects');
      assert.equal((await api(alice, first, { op: 'unknown-op' })).status(), 404, 'Unknown operation without a known job is refused');
      assert.equal((await api(alice, first, { op: 'queue', docId: 'invalid', text: source })).status(), 409);
      const queued = await api(alice, first, { op: 'queue', docId: first.docId, text: source }); assert(queued.ok());
      const job = (await queued.json()).job;
      assert.equal((await api(alice, first, { op: 'unknown-op', job })).status(), 400, 'Malformed operation on a known job is refused');
      const claimResponse = await api(bob, first, { op: 'claim', worker: bobWorker }); assert(claimResponse.ok());
      const claim = await claimResponse.json(); assert.equal(claim.job, job); assert.equal(claim.source.resources.find(r => r.path === 'main.tex').content, source);
      assert.equal((await api(bob, first, { op: 'status', job })).status(), 404, 'Shared compute does not grant job-owner APIs');
      const revoked = await alice.request.delete(first.url + '/users/' + users[1].id, { headers: { 'X-CSRF-Token': await csrf(alice) } }); assert(revoked.ok());
      await deniedZip(bob, first);
      for (const op of ['join', 'claim', 'heartbeat', 'finish', 'prepare-offline']) {
        const result = await api(bob, first, { op, worker: bobWorker, job, lease: claim.lease, digest: claim.source.digest });
        assert([403, 404].includes(result.status()), 'Revocation must precede processing: ' + op);
      }
      assert((await api(alice, first, { op: 'cancel', job })).ok());
      for (const project of [first, second]) {
        const response = await alice.request.get(project.url.replace('/project/', '/Project/') + '/download/zip'); assert(response.ok());
        const path = join(work, project.docId + '.zip'); writeFileSync(path, await response.body());
        assert.equal(execFileSync('/usr/bin/unzip', ['-p', path, 'main.tex'], { encoding: 'utf8' }), source);
      }
      assert((await api(alice, first, { op: 'leave', worker: ownerWorker })).ok());
      if (process.env.HOSTING_REVIEW_CHECK === '1') {
        await alice.goto(first.url); await alice.getByRole('textbox', { name: /^Source Editor/ }).waitFor();
        await inviteMember(bob, users[1], first);
        const key = await alice.evaluate(() => {
          const api = globalThis.overleafRecovery, editor = globalThis.overleafParticipantEditor;
          editor.facade.cmChange({ from: editor.facade.getValue().length, insert: '\n% Review seed\n' });
          const scope = api.currentScope(), record = api.list(scope.account, scope.project).find(copy => copy.record.doc === scope.doc).record;
          return api.save(api.fork({ ...record, candidate: record.candidate + '% Local resolution\n' }));
        });
        async function sharedText(page) { return page.evaluate(() => globalThis.overleafParticipantEditor.facade.getValue()); }
        async function appendPeer(text) {
          await bob.evaluate(text => { const e = globalThis.overleafParticipantEditor.facade; e.cmChange({ from: e.getValue().length, insert: text }); }, text);
          await alice.waitForFunction(text => globalThis.overleafParticipantEditor.facade.getValue().includes(text), text);
        }
        await appendPeer('% Peer first\n');
        await alice.getByRole('button', { name: 'Offline and recovery options', exact: true }).click();
        await alice.getByRole('menuitem', { name: 'Review local changes', exact: true }).click();
        const review = alice.getByRole('dialog', { name: 'Review local and shared changes' });
        await review.getByLabel('Retained local copy').selectOption(key);
        assert((await review.getByLabel('Current shared version').innerText()).includes('% Peer first'));
        const resolution = review.getByLabel('Resolved text');
        assert((await resolution.inputValue()).includes('% Local resolution'));
        assert(!(await resolution.inputValue()).includes('% Peer first'));
        const draft = await sharedText(alice) + '% Reviewed merge\n'; await resolution.fill(draft);
        await appendPeer('% Peer second\n'); const latest = await sharedText(alice);
        await review.getByRole('button', { name: 'Apply reviewed text', exact: true }).click();
        await review.getByRole('status').filter({ hasText: 'shared document changed' }).waitFor();
        assert.equal(await sharedText(alice), latest, 'Stale review must not mutate shared text');
        assert.equal(await resolution.inputValue(), draft, 'Stale review retains the resolution');
        await review.getByRole('button', { name: 'Refresh shared version', exact: true }).click();
        assert((await review.getByLabel('Current shared version').innerText()).includes('% Peer second'));
        assert.equal(await resolution.inputValue(), draft);
        const merged = latest + '% Reviewed merge\n'; await resolution.fill(merged);
        await review.getByRole('button', { name: 'Apply reviewed text', exact: true }).click();
        await review.getByRole('status').filter({ hasText: 'Applied through the shared editor' }).waitFor();
        await bob.waitForFunction(text => globalThis.overleafParticipantEditor.facade.getValue() === text, merged);
        assert(await alice.evaluate(key => globalThis.overleafRecovery.read(key).candidate.includes('% Local resolution'), key));
        await review.getByRole('button', { name: 'Close', exact: true }).click();
        await alice.reload(); await alice.waitForFunction(text => globalThis.overleafParticipantEditor?.facade.getValue() === text, merged);
        assert((await alice.request.delete(first.url + '/users/' + users[1].id, { headers: { 'X-CSRF-Token': await csrf(alice) } })).ok());
      }
      // Exercise the actual output route with a real PDF, not a nonexistent guessed build.
      artifactRoots.push({ project: first.url.split('/').at(-1), user: users[0].id });
      await alice.context().unroute('**/*');
      await alice.context().route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      await alice.goto(first.url); await alice.locator('.textLayer span').filter({ hasText: /^Authorization fixture\./ }).first().waitFor({ timeout: 60000 });
      const pdfUrl = await alice.evaluate(() => performance.getEntriesByType('resource').filter(e => /\/output\/output\.pdf/.test(e.name)).at(-1).name);
      const ownPdf = await alice.request.get(pdfUrl); assert(ownPdf.ok()); const pdf = await ownPdf.body(); assert(pdf.subarray(0, 5).equals(Buffer.from('%PDF-')));
      const project = first.url.split('/').at(-1), user = users[0].id, build = new URL(pdfUrl).pathname.match(/\/build\/([a-f0-9-]+)\//)?.[1];
      assert.match(build, /^[a-f0-9]+-[a-f0-9]+$/); artifactRoots.push({ project, user, anonymous: true });
      // Seed equivalent native cached-file layouts under this disposable project only.
      const seed = `import{mkdir,copyFile}from'node:fs/promises';let raw='';for await(const c of process.stdin)raw+=c;const{project:p,user:u,build:b}=JSON.parse(raw);if(!/^[a-f0-9]{24}$/.test(p)||!/^[a-f0-9]{24}$/.test(u)||!/^[a-f0-9]+-[a-f0-9]+$/.test(b))throw Error('Invalid fixture path');const base='/var/lib/overleaf/data/output/',owner=base+p+'-'+u,anon=base+p;await mkdir(anon);await mkdir(anon+'/generated-files/'+b,{recursive:true});for(const file of ['output.pdf','output.log'])await copyFile(owner+'/generated-files/'+b+'/'+file,anon+'/generated-files/'+b+'/'+file);for(const root of [owner,anon]){await mkdir(root+'/content/'+b,{recursive:true});await copyFile(owner+'/generated-files/'+b+'/output.pdf',root+'/content/'+b+'/aabb')}process.exit(0);`;
      execFileSync('docker', ['exec', '-i', '-w', '/overleaf/services/web', container, 'node', '--input-type=module', '-e', seed],
        { input: JSON.stringify({ project, user, build }), stdio: ['pipe', 'pipe', 'pipe'] });
      const outputs = [pdfUrl, `${base}/project/${project}/build/${build}/output/output.pdf`,
        `${base}/project/${project}/user/${user}/content/${build}/aabb`, `${base}/project/${project}/content/${build}/aabb`];
      const noSession = await browser.newContext();
      for (const url of outputs) {
        const range = await alice.request.get(url, { headers: { Range: 'bytes=0-15' } }); assert.equal(range.status(), 206); assert.deepEqual(await range.body(), pdf.subarray(0, 16));
        assert.equal(range.headers()['cache-control'], 'private, no-store'); assert.equal(range.headers().expires, undefined);
        for (const page of [bob, carol]) {
          const denied = await page.request.get(url, { maxRedirects: 0 });
          assert([401, 403, 404].includes(denied.status()), 'Revoked/outsider cannot download an existing output');
          assert(!(await denied.body()).subarray(0, 5).equals(Buffer.from('%PDF-')));
        }
        const deniedPdf = await noSession.request.get(url, { maxRedirects: 0 });
        assert([302, 401, 403, 404].includes(deniedPdf.status()), 'Anonymous output request must fail');
      }
      await noSession.close();
      await inviteMember(carol, users[2], first);
      for (const url of outputs) { const allowed = await carol.request.get(url); assert(allowed.ok()); assert.deepEqual(await allowed.body(), pdf); }
      assert((await alice.request.delete(first.url + '/users/' + users[2].id, { headers: { 'X-CSRF-Token': await csrf(alice) } })).ok());
      for (const url of outputs) assert([401, 403, 404].includes((await carol.request.get(url)).status()), 'PDF access revocation must be immediate');
      if (process.env.HOSTING_OFFLINE_CHECK === '1') {
        console.log('Checking complete-project offline preparation');
        const directPublic = await alice.evaluate(async () => {
          const controller = new AbortController(), response = await fetch('/recovery/busytex/texlive-extra.data', { signal: controller.signal });
          const powered = response.headers.get('x-powered-by'), reader = response.body.getReader(); await reader.read(); controller.abort(); await reader.cancel().catch(() => {});
          return { status: response.status, powered };
        });
        assert.equal(directPublic.status, 200); assert.equal(directPublic.powered, null, 'Public resource abort must bypass the application send-stream path');
        assert((await alice.request.get(base + '/login')).ok());
        const onlineText = await alice.evaluate(() => globalThis.overleafParticipantEditor.facade.getValue());
        const prepareStart = performance.now();
        const workspace = await alice.evaluate(() => globalThis.overleafRecovery.prepareProject()); assert.match(workspace, /^[a-f0-9-]{36}$/);
        await alice.goto(base + '/recovery/project-workspace.html#' + workspace);
        await alice.waitForURL(/\/recovery\/project-workspace\.html#[a-f0-9-]+/);
        const localUrl = alice.url(), context = alice.context();
        const offlineEditor = page => page.getByRole('textbox', { name: 'Offline source editor', exact: true });
        await offlineEditor(alice).waitFor(); assert.equal(await alice.locator('#files button').count(), 4);
        await alice.getByRole('button', { name: 'Prepare offline compiler', exact: true }).click();
        await alice.waitForFunction(() => document.querySelector('#status').textContent === 'Offline compiler is ready.' || document.querySelector('#status').dataset.error === 'true', null, { timeout: 240000 });
        assert.equal(await alice.locator('#status').textContent(), 'Offline compiler is ready.');
        const prepareMs = performance.now() - prepareStart;
        console.log('Public compiler/UI cache prepared; checking disconnected storage and compilation');
        await context.setOffline(true);
        const append = (page, text) => offlineEditor(page).evaluate((element, text) => { const view = element.cmView.view; view.dispatch({ changes: { from: view.state.doc.length, insert: text } }); }, text);
        const saved = page => page.getByRole('status').filter({ hasText: 'Saved in this browser.' }).waitFor();
        await alice.getByRole('button', { name: 'chapter.tex', exact: true }).click();
        await append(alice, '% First offline edit\n'); await saved(alice);
        const other = await context.newPage(); await other.goto(localUrl);
        await other.getByRole('button', { name: 'chapter.tex', exact: true }).click(); await offlineEditor(other).waitFor();
        await append(alice, '% Latest offline edit\n'); await saved(alice);
        await append(other, '% Conflicting tab edit\n'); await other.getByRole('status').filter({ hasText: 'Another tab saved this file' }).waitFor();
        assert((await offlineEditor(other).innerText()).includes('% Conflicting tab edit'));
        async function exportBytes(page, button, name) {
          const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: button, exact: true }).click()]);
          const path = join(work, name); await download.saveAs(path); return readFileSync(path);
        }
        assert((await exportBytes(other, 'Export file', 'conflicting.tex')).toString().includes('% Conflicting tab edit'));
        await other.close();
        await alice.reload(); await alice.getByRole('button', { name: 'chapter.tex', exact: true }).click(); await offlineEditor(alice).waitFor();
        const chapter = (await exportBytes(alice, 'Export file', 'offline-chapter.tex')).toString();
        assert.equal(chapter, fixtureFiles['chapter.tex'] + '% First offline edit\n% Latest offline edit\n'); assert(!chapter.includes('% Conflicting tab edit'));
        const aborted = await context.newPage(); await aborted.goto(localUrl); await offlineEditor(aborted).waitFor();
        await aborted.evaluate(() => {
          const original = IDBDatabase.prototype.transaction;
          IDBDatabase.prototype.transaction = function(...args) { const tx = original.apply(this, args); if (this.name === 'overleaf-local-projects' && args[1] === 'readwrite') queueMicrotask(() => tx.abort()); return tx; };
        });
        await append(aborted, '% Unsaved interrupted write\n'); await aborted.getByRole('status').filter({ hasText: 'previously saved copy is retained' }).waitFor();
        assert((await exportBytes(aborted, 'Export file', 'unsaved.tex')).toString().includes('% Unsaved interrupted write'));
        await aborted.close();
        await alice.getByRole('button', { name: 'figure.png', exact: true }).click();
        assert.deepEqual(await exportBytes(alice, 'Export file', 'offline-figure.png'), picture);
        assert.deepEqual(await exportBytes(alice, 'Download PDF', 'offline.pdf'), pdf);
        const exported = JSON.parse((await exportBytes(alice, 'Export project files', 'offline-project.json')).toString());
        assert.equal(exported.files.find(file => file.path === 'chapter.tex').content, chapter);
        assert.equal(exported.files.find(file => file.path === 'main.tex').content, onlineText);
        assert.deepEqual(Buffer.from(exported.files.find(file => file.path === 'figure.png').data, 'base64'), picture);
        const compileStart = performance.now(), firstOrigin = await now(alice);
        await alice.getByRole('button', { name: 'Recompile', exact: true }).click();
        await alice.getByRole('status').filter({ hasText: 'Compiled and saved in this browser.' }).waitFor({ timeout: 120000 });
        const firstCompileMs = performance.now() - compileStart, firstVisible = await now(alice) - firstOrigin;
        const compiled = await exportBytes(alice, 'Download PDF', 'compiled-offline.pdf'); assert(compiled.subarray(0, 5).equals(Buffer.from('%PDF-')));
        const text = execFileSync('/Users/macc/miniforge3/envs/myproject/bin/pdftotext', [join(work, 'compiled-offline.pdf'), '-'], { encoding: 'utf8' });
        assert(text.includes('Authorization fixture.') && text.includes('Shared chapter.'));
        assert(text.includes('Question 12') && text.includes('Synthetic graph') && text.includes('Participant Fixture') && !text.includes('[?]'));
        assert(Number(execFileSync('/Users/macc/miniforge3/envs/myproject/bin/pdfinfo', [join(work, 'compiled-offline.pdf')], { encoding: 'utf8' }).match(/^Pages:\s+(\d+)/m)?.[1]) >= 3);
        assert.equal(text, execFileSync('/Users/macc/miniforge3/envs/myproject/bin/pdftotext', [join(work, 'offline.pdf'), '-'], { encoding: 'utf8' }), 'Disconnected compilation must preserve the connected fixture output');
        const geometry = name => execFileSync('/Users/macc/miniforge3/envs/myproject/bin/pdfinfo', [join(work, name)], { encoding: 'utf8' }).match(/^Page size:.+$/m)?.[0];
        assert.equal(geometry('compiled-offline.pdf'), geometry('offline.pdf'));
        const compilerWorker = alice.workers().find(worker => new URL(worker.url()).pathname.endsWith('/busytex_worker.js'));
        const linearMemoryBytes = await compilerWorker.evaluate(async () => (await self.pipeline.Module).HEAPU8.length);
        await alice.getByRole('button', { name: 'chapter.tex', exact: true }).click();
        await alice.getByRole('button', { name: 'Show in PDF', exact: true }).click(); await alice.locator('.pdf-marker').waitFor();
        const marker = await alice.locator('.pdf-marker').boundingBox();
        await alice.getByRole('button', { name: 'main.tex', exact: true }).click();
        await alice.mouse.dblclick(marker.x + 2, marker.y + 2);
        await alice.waitForFunction(() => document.querySelector('#filename').textContent === 'chapter.tex');
        await append(alice, '% Navigation must now be stale\n'); await saved(alice);
        await alice.getByRole('button', { name: 'Show in PDF', exact: true }).click();
        await alice.getByRole('status').filter({ hasText: 'Recompile the current source' }).waitFor();
        const warmStart = performance.now(), warmOrigin = await now(alice); await alice.getByRole('button', { name: 'Recompile', exact: true }).click();
        await alice.getByRole('status').filter({ hasText: 'Compiled and saved in this browser.' }).waitFor({ timeout: 120000 });
        const warmCompileMs = performance.now() - warmStart, warmVisible = await now(alice) - warmOrigin;
        const timeline = await compileTimeline(alice, compilerWorker, firstOrigin);
        console.log(JSON.stringify({ offlineCompileTimeline: { firstVisible: Math.round(firstVisible), warmStartsAt: Math.round(warmOrigin - firstOrigin), warmVisible: Math.round(warmVisible), timeline } }));
        await alice.reload(); await offlineEditor(alice).waitFor(); await alice.locator('#pdf canvas').first().waitFor();
        await alice.getByRole('button', { name: 'Saved projects', exact: true }).click();
        console.log('Checking native CE+ offline interface');
        await alice.locator('a[href*="native-workspace.html#"]').first().click();
        await alice.getByRole('textbox', { name: /^Source Editor/ }).waitFor({ timeout: 30000 });
        await alice.evaluate(() => { const node = document.querySelector('#local-status'); console.log('Native local status: ' + node.textContent); new MutationObserver(() => console.log('Native local status: ' + node.textContent)).observe(node, { subtree: true, childList: true, characterData: true }); });
        // Keep bounded diagnostics for this synthetic fixture when the real SDK rejects a compile.
        await alice.evaluate(async () => {
          const { PdfLatex } = await import('/recovery/busytex-sdk.mjs'), compile = PdfLatex.prototype.compile;
          PdfLatex.prototype.compile = async function(...args) {
            const result = await compile.apply(this, args);
            globalThis.nativeCompileResult = { success: result.success, pdf: !!result.pdf, synctex: !!result.synctex,
              log: String(result.log || '').slice(-4000) };
            return result;
          };
        });
        if ((await alice.locator('#local-status').textContent()).startsWith('Native editor')) await alice.getByRole('button', { name: /^Recompile/ }).first().click();
        // `stale`: a status already shown before this compile was requested (e.g. an earlier refusal) is not its outcome.
        const nativeCompiled = async stale => {
          await alice.waitForFunction(stale => { const status = document.querySelector('#local-status'); return status.textContent !== stale && (status.dataset.error === 'true' || status.textContent === 'Compiled and saved in this browser.'); }, stale, { timeout: 120000 });
          assert.equal(await alice.locator('#local-status').getAttribute('data-error'), 'false', JSON.stringify({ status: await alice.locator('#local-status').textContent(), result: await alice.evaluate(() => globalThis.nativeCompileResult) }));
        };
        await nativeCompiled();
        await alice.locator('.textLayer span').filter({ hasText: /^Authorization fixture\./ }).first().waitFor({ timeout: 120000 });
        const nativeEditor = alice.getByRole('textbox', { name: /^Source Editor/ });
        await alice.getByRole('treeitem', { name: 'chapter.tex', exact: true }).click();
        assert.equal(await nativeEditor.evaluate(element => element.cmView.view.state.doc.toString()), chapter + '% Navigation must now be stale\n');
        await nativeEditor.evaluate(element => { const view = element.cmView.view; view.dispatch({ selection: { anchor: 1 } }); view.focus(); });
        await alice.getByRole('button', { name: 'Go to code location in PDF', exact: true }).click();
        await alice.waitForFunction(() => globalThis.nativeSyncCalls?.some(call => call.path.endsWith('/code') && call.status === 200 && call.body.pdf?.length));
        await alice.getByRole('treeitem', { name: 'main.tex', exact: true }).click();
        const sharedSpan = alice.locator('.textLayer span').filter({ hasText: /chapter/ }).first();
        const sharedWord = await sharedSpan.evaluate(span => {
          const text = span.firstChild, range = document.createRange(), start = text.textContent.indexOf('chapter');
          range.setStart(text, start); range.setEnd(text, start + 'chapter'.length);
          const box = range.getBoundingClientRect(), outer = span.getBoundingClientRect();
          return { x: box.x + box.width / 2 - outer.x, y: box.y + box.height / 2 - outer.y };
        });
        await sharedSpan.dblclick({ position: sharedWord });
        let nativeInversePassed = false;
        try {
          await alice.waitForFunction(() => globalThis.nativeSyncCalls?.some(call => call.path.endsWith('/pdf') && call.status === 200 && call.body.code?.[0]?.file === 'chapter.tex'), null, { timeout: 5000 });
          await alice.waitForFunction(() => document.querySelector('[role="textbox"][aria-label^="Source Editor"]')?.cmView.view.state.doc.toString().startsWith('Shared chapter.'));
          nativeInversePassed = true;
        } catch { console.error(JSON.stringify({ nativeNavigation: await alice.evaluate(() => globalThis.nativeSyncCalls), sharedWord })); }
        await alice.getByRole('treeitem', { name: 'main.tex', exact: true }).click();
        await alice.evaluate(async () => {
          const { project, files } = await globalThis.overleafLocalProjects.read(location.hash.slice(1)), file = files.find(file => file.path === 'main.tex');
          globalThis.overleafRecovery.save({ schema: 1, account: project.account, project: project.project, workspace: project.id, doc: file.doc,
            writer: crypto.randomUUID(), revision: file.revision, base: file.base, candidate: file.content + '% Explicit recovery candidate\n', name: file.path, updatedAt: Date.now() });
        });
        await alice.getByRole('button', { name: 'Local only options', exact: true }).click();
        await alice.getByRole('menuitem', { name: 'Recovery copies', exact: true }).click();
        const recovery = alice.getByRole('dialog', { name: 'Review offline recovery copy' });
        assert((await recovery.getByRole('textbox', { name: 'Recovered text' }).inputValue()).includes('% Explicit recovery candidate'));
        await recovery.getByRole('button', { name: 'Save recovered text locally', exact: true }).click();
        await alice.waitForFunction(() => document.querySelector('[role="textbox"][aria-label^="Source Editor"]')?.cmView.view.state.doc.toString().includes('% Explicit recovery candidate'));
        await alice.locator('#local-status').filter({ hasText: 'Saved in this browser.' }).waitFor();
        assert((await nativeEditor.evaluate(element => element.cmView.view.state.doc.toString())).includes('% Explicit recovery candidate'));
        await nativeEditor.evaluate(element => { const view = element.cmView.view, text = view.state.doc.toString(), from = text.indexOf('Authorization fixture.'); view.dispatch({ changes: { from, to: from + 'Authorization fixture.'.length, insert: 'Native offline fixture.' } }); });
        await alice.locator('#local-status').filter({ hasText: 'Saved in this browser.' }).waitFor();
        await alice.getByRole('button', { name: /^Recompile/ }).first().click();
        await nativeCompiled();
        await alice.locator('.textLayer span').filter({ hasText: /^Native offline fixture\./ }).first().waitFor({ timeout: 120000 });
        await exportBytes(alice, 'Download project (.zip)', 'native-offline.zip');
        assert.equal(execFileSync('/usr/bin/unzip', ['-p', join(work, 'native-offline.zip'), 'main.tex'], { encoding: 'utf8' }), await nativeEditor.evaluate(element => element.cmView.view.state.doc.toString()));
        assert.deepEqual(execFileSync('/usr/bin/unzip', ['-p', join(work, 'native-offline.zip'), 'figure.png']), picture);
        await alice.reload(); await nativeEditor.waitFor();
        assert((await nativeEditor.evaluate(element => element.cmView.view.state.doc.toString())).includes('Native offline fixture.'));
        const interrupted = await context.newPage(); await interrupted.goto(alice.url());
        const interruptedEditor = interrupted.getByRole('textbox', { name: /^Source Editor/ }); await interruptedEditor.waitFor();
        await interrupted.evaluate(() => {
          const original = IDBDatabase.prototype.transaction;
          IDBDatabase.prototype.transaction = function(...args) { const tx = original.apply(this, args); if (this.name === 'overleaf-local-projects' && args[1] === 'readwrite') queueMicrotask(() => tx.abort()); return tx; };
        });
        await interruptedEditor.evaluate(element => { element.cmView.view.dispatch({ changes: { from: 0, insert: '% Native unsaved text after interrupted write\n' } }); });
        await interrupted.locator('#local-status[data-error=true]').filter({ hasText: 'previously saved copy is retained' }).waitFor();
        try { await exportBytes(interrupted, 'Download project (.zip)', 'native-interrupted.zip'); }
        catch (error) {
          console.error(JSON.stringify({ interruptedStatus: await interrupted.locator('#local-status').textContent(), dialogs: await interrupted.getByRole('dialog').allTextContents() }));
          await interrupted.screenshot({ path: '/tmp/latex-native-interrupted.png' }); throw error;
        }
        assert(execFileSync('/usr/bin/unzip', ['-p', join(work, 'native-interrupted.zip'), 'main.tex'], { encoding: 'utf8' }).startsWith('% Native unsaved text after interrupted write'));
        assert(!(await alice.evaluate(async () => (await globalThis.overleafLocalProjects.read(location.hash.slice(1))).files.find(file => file.path === 'main.tex').content)).includes('Native unsaved text after interrupted write'));
        await interrupted.close();
        const cdp = await context.newCDPSession(alice), appManifest = await cdp.send('Page.getAppManifest');
        assert.deepEqual(appManifest.errors, []); assert.equal(JSON.parse(appManifest.data).scope, '/recovery/');
        assert.deepEqual((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors, []);
        await cdp.detach();
        console.log('Checking offline project and native file creation');
        await alice.getByRole('button', { name: 'Local only options', exact: true }).click();
        await alice.getByRole('menuitem', { name: 'Saved projects', exact: true }).click();
        await alice.getByRole('textbox', { name: 'New local project name' }).fill('Synthetic local project');
        await alice.getByRole('button', { name: 'Create local project', exact: true }).click();
        await nativeEditor.waitFor();
        assert((await nativeEditor.evaluate(element => element.cmView.view.state.doc.toString())).includes('Hello world.'));
        await alice.getByRole('button', { name: /^New file$/i }).click();
        await alice.getByRole('textbox', { name: /^File name$/i }).fill('local.tex');
        await alice.getByRole('button', { name: 'Create', exact: true }).click();
        await alice.getByRole('treeitem', { name: 'local.tex', exact: true }).waitFor();
        await alice.waitForFunction(() => document.querySelector('[role="textbox"][aria-label^="Source Editor"]')?.cmView.view.state.doc.toString() === '');
        await nativeEditor.evaluate(element => { element.cmView.view.dispatch({ changes: { from: 0, insert: '% Created without a server\n' } }); });
        await alice.locator('#local-status').filter({ hasText: 'Saved in this browser.' }).waitFor();
        await alice.getByRole('button', { name: /^New folder$/i }).click();
        await alice.getByRole('dialog').getByRole('textbox').fill('empty-folder');
        await alice.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
        await alice.getByRole('treeitem', { name: 'empty-folder', exact: true }).waitFor();
        const localProjectUrl = alice.url();
        const creationChecks = await alice.evaluate(async () => {
          const api = globalThis.overleafLocalProjects, before = await api.read(location.hash.slice(1));
          let duplicate = false, stale = false, invalid = false;
          try { await api.add(before.project, 'doc', 'local.tex'); } catch { duplicate = true; }
          try { await api.add(before.project, 'doc', 'missing/file.tex'); } catch { invalid = true; }
          await api.add(before.project, 'folder', 'concurrent-folder');
          try { await api.add(before.project, 'doc', 'stale.tex'); } catch { stale = true; }
          const after = await api.read(before.project.id);
          return { duplicate, invalid, stale, files: after.files.map(file => file.path) };
        });
        assert.deepEqual(creationChecks, { duplicate: true, invalid: true, stale: true, files: ['local.tex', 'main.tex'] });
        await alice.reload(); await nativeEditor.waitFor();
        await alice.getByRole('treeitem', { name: 'local.tex', exact: true }).click();
        assert.equal(await nativeEditor.evaluate(element => element.cmView.view.state.doc.toString()), '% Created without a server\n');
        await alice.getByRole('treeitem', { name: 'empty-folder', exact: true }).waitFor();
        await alice.getByRole('button', { name: 'Review on server', exact: true }).click();
        await alice.locator('#local-status').filter({ hasText: 'no shared counterpart' }).waitFor();
        assert.equal(alice.url(), localProjectUrl);
        await exportBytes(alice, 'Download project (.zip)', 'local-created.zip');
        assert.equal(execFileSync('/usr/bin/unzip', ['-p', join(work, 'local-created.zip'), 'local.tex'], { encoding: 'utf8' }), '% Created without a server\n');
        // Every exported file must hold its own text, not the text of whichever file the shared editor shows last.
        const exportedMain = execFileSync('/usr/bin/unzip', ['-p', join(work, 'local-created.zip'), 'main.tex'], { encoding: 'utf8' });
        assert(exportedMain.includes('Hello world.') && !exportedMain.includes('% Created without a server'), 'Offline ZIP main.tex must be its own saved text: ' + JSON.stringify(exportedMain.slice(0, 60)));
        const staleStatus = await alice.locator('#local-status').textContent();
        await alice.getByRole('button', { name: /^Recompile/ }).first().click(); await nativeCompiled(staleStatus);
        await alice.locator('.textLayer span').filter({ hasText: /^Hello/ }).first().waitFor({ timeout: 120000 });
        assert(nativeInversePassed, 'Native inverse navigation must open the child source');
        await alice.goto(localUrl); await offlineEditor(alice).waitFor();
        const lastPdf = await exportBytes(alice, 'Download PDF', 'before-cancel.pdf');
        await alice.getByRole('button', { name: 'Recompile', exact: true }).click();
        await alice.getByRole('button', { name: 'Stop', exact: true }).click();
        await alice.getByRole('status').filter({ hasText: /Compilation canceled/ }).waitFor({ timeout: 30000 });
        assert.deepEqual(await exportBytes(alice, 'Download PDF', 'after-cancel.pdf'), lastPdf, 'Canceled recompilation must retain previous PDF');
        const oldMain = await offlineEditor(alice).evaluate(element => element.cmView.view.state.doc.toString());
        await offlineEditor(alice).evaluate(element => {
          const view = element.cmView.view; view.dispatch({ changes: { from: 0, insert: '\\RequirePackage{qualification-package-that-does-not-exist}\n' } });
        }); await saved(alice);
        await alice.getByRole('button', { name: 'Recompile', exact: true }).click();
        await alice.getByRole('status').filter({ hasText: /Compilation failed/ }).waitFor({ timeout: 120000 });
        assert((await exportBytes(alice, 'Export file', 'failed-source.tex')).toString().includes('qualification-package-that-does-not-exist'));
        await offlineEditor(alice).evaluate((element, text) => { const view = element.cmView.view; view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }); }, oldMain); await saved(alice);
        const allowed = JSON.parse(execFileSync('docker', ['exec', container, 'node', '--input-type=module', '-e',
          "import{readFileSync}from'node:fs';const m=JSON.parse(readFileSync('/overleaf/services/web/public/recovery/recovery-sw.js','utf8').match(/const manifest = (.+);/)[1]);console.log(JSON.stringify([...m.assets,...m.compilerAssets].map(a=>[a.path,a.parts?.length||0])));"], { encoding: 'utf8' }));
        const cache = await alice.evaluate(async allowed => {
          const assets = new Map(allowed);
          let bytes = 0;
          for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) {
            const url = new URL(request.url), path = url.pathname, part = url.search.match(/^\?part=(\d+)$/);
            if (url.origin !== location.origin || !assets.has(path) || (url.search && (!part || Number(part[1]) >= assets.get(path)))) throw Error('Unpinned cache entry: ' + path);
            bytes += (await (await (await caches.open(name)).match(request)).arrayBuffer()).byteLength;
          }
          return bytes;
        }, allowed);
        console.log(JSON.stringify({ offlinePreparationMs: prepareMs, firstOfflineCompileMs: firstCompileMs, warmOfflineCompileMs: warmCompileMs, compilerLinearMemoryBytes: linearMemoryBytes, publicCacheBytes: cache, offlineNavigation: true, savedProjectReopened: true }));
        await alice.getByRole('button', { name: 'main.tex', exact: true }).click();
        await append(alice, '% Offline main review\n'); await saved(alice);
        await context.setOffline(false); await alice.getByRole('button', { name: 'Review on server', exact: true }).click();
        await alice.waitForURL(/\/project\/[a-f0-9]+#recovery=/);
        const dialog = alice.getByRole('dialog', { name: 'Review local and shared changes' }); await dialog.waitFor();
        assert.equal((await dialog.getByLabel('Current shared version').innerText()).trimEnd(), onlineText.trimEnd());
        assert((await dialog.getByLabel('Resolved text').inputValue()).includes('% Offline main review'));
        assert.equal(await alice.evaluate(() => globalThis.overleafParticipantEditor.facade.getValue()), onlineText, 'Reconnect must never apply offline work automatically');
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await importProject('local-created.zip');
        // The participant editor hook is replaced asynchronously after navigation; wait for the imported root document.
        await alice.waitForFunction(() => globalThis.overleafParticipantEditor?.facade.getValue().includes('Hello world.'), null, { timeout: 30000 })
          .catch(async error => { console.error(JSON.stringify({ importedEditorHead: (await alice.evaluate(() => globalThis.overleafParticipantEditor?.facade.getValue() ?? null))?.slice(0, 80), tree: await alice.getByRole('treeitem').allTextContents() })); throw error; });
        await alice.getByRole('treeitem', { name: 'local.tex', exact: true }).click();
        await alice.waitForFunction(() => globalThis.overleafParticipantEditor.facade.getValue() === '% Created without a server\n');
      }
      console.log(JSON.stringify({ authorizationPassed: true, csrfEnforced: true, outsidersDenied: true,
        workerAccountAndProjectBound: true, revokedLeaseDenied: true, malformedInputRefused: true, ownerSourcesExact: true,
        allFourOutputPathsProtected: true, rangeRequestsPreserved: true, currentMemberCanReadOwnerPdf: true,
        ...(process.env.HOSTING_REVIEW_CHECK === '1' ? { sideBySideReview: true, concurrentChangeRefused: true, nativeMergedTextAfterReload: true } : {}),
        ...(process.env.HOSTING_OFFLINE_CHECK === '1' ? { completeProjectStored: true, offlineCompilation: true, offlineEditReloadExport: true, nativeNavigationAndRecovery: true, localProjectFileFolderCreation: true, nativeZipImport: true, manifestInstallability: true, conflictingTabRefused: true, interruptedWritePreservedSavedState: true, reconnectDidNotApply: true } : {}) }));
    } finally { clearTimeout(deadline); await browser.close(); }
  }, 3, container);
} finally {
  if (artifactRoots.length) {
    const cleanup = `import{Project}from'./app/src/models/Project.mjs';import{User}from'./app/src/models/User.mjs';import{readFile,readdir,rm}from'node:fs/promises';let raw='';for await(const c of process.stdin)raw+=c;for(const v of JSON.parse(raw)){if(!/^[a-f0-9]{24}$/.test(v.project)||!/^[a-f0-9]{24}$/.test(v.user))throw Error('Invalid fixture identity');if(await Project.findById(v.project).exec()||await User.findById(v.user).exec())throw Error('Preserve existing user/project');const root='/var/lib/overleaf/data/output/'+v.project+(v.anonymous===true?'':'-'+v.user);let builds;try{builds=await readdir(root+'/generated-files')}catch(e){if(e.code==='ENOENT')continue;throw e}for(const b of builds){if(!/^[a-f0-9]+-[a-f0-9]+$/.test(b)||await readFile(root+'/generated-files/'+b+'/output.log','utf8')!=='Compiled on an authorized participant device.\\n')throw Error('Preserve unknown output')}await rm(root,{recursive:true,force:true});try{await readdir(root);throw Error('Cleanup readback failed')}catch(e){if(e.code!=='ENOENT')throw e}}process.exit(0);`;
    execFileSync('docker', ['exec', '-i', '-w', '/overleaf/services/web', container, 'node', '--input-type=module', '-e', cleanup],
      { input: JSON.stringify(artifactRoots), stdio: ['pipe', 'pipe', 'pipe'] });
  }
  rmSync(work, { recursive: true, force: true });
}
