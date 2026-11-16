import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSyntheticAccounts } from './synthetic-accounts.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const container = process.env.HOSTING_APP_CONTAINER;
assert(container, 'Explicit synthetic-account target container is required');
const base = process.env.HOSTING_TEST_BASE || 'http://127.0.0.1:8081';
assert.equal(new URL(base).hostname, '127.0.0.1', 'This check is restricted to local staging');
const work = mkdtempSync(join(tmpdir(), 'latex-auth-'));
const artifactRoots = [];
const source = '\\documentclass{article}\n\\begin{document}\nAuthorization fixture.\n\\end{document}\n';
writeFileSync(join(work, 'main.tex'), source);
execFileSync('/usr/bin/zip', ['-q', join(work, 'authorization-fixture.zip'), 'main.tex'], { cwd: work });
try {
  await withSyntheticAccounts(async users => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
    const deadline = setTimeout(() => browser.close(), 180000);
    try {
      async function login(user) {
        const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
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
        await page.goto(base + '/login'); await page.locator('input[name=email]').fill(user.email);
        await page.locator('input[name=password]').fill(user.password); await page.getByRole('button', { name: /^Login/ }).click();
        await page.waitForURL(base + '/project'); return page;
      }
      const [alice, bob, carol] = await Promise.all(users.map(login));
      async function importProject() {
        const navigation = await alice.goto(base + '/project');
        try { await alice.getByRole('button', { name: /^(New project|Create a new project)$/i }).click(); }
        catch (error) {
          console.error(JSON.stringify({ stage: 'new-project', path: new URL(alice.url()).pathname,
            status: navigation.status(), title: await alice.title(), text: (await alice.locator('body').innerText()).slice(0, 350),
            buttons: (await alice.getByRole('button').allTextContents()).map(s => s.trim()).filter(Boolean).slice(0, 16) }));
          throw error;
        }
        await alice.getByText('Existing project (.zip)', { exact: true }).click();
        await alice.locator('input[type=file]').first().setInputFiles(join(work, 'authorization-fixture.zip'));
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
      for (const op of ['join', 'claim', 'heartbeat', 'finish']) {
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
        await alice.getByRole('button', { name: 'Review local changes', exact: true }).click();
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
      console.log(JSON.stringify({ authorizationPassed: true, csrfEnforced: true, outsidersDenied: true,
        workerAccountAndProjectBound: true, revokedLeaseDenied: true, malformedInputRefused: true, ownerSourcesExact: true,
        allFourOutputPathsProtected: true, rangeRequestsPreserved: true, currentMemberCanReadOwnerPdf: true,
        ...(process.env.HOSTING_REVIEW_CHECK === '1' ? { sideBySideReview: true, concurrentChangeRefused: true, nativeMergedTextAfterReload: true } : {}) }));
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
