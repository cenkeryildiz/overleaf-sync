// Opt-in checks for release-gate behaviour that had no test: R1 permissions/session, R2 live Unicode/IME,
// R4 membership revocation, R5 project workflows, R6 private access under public static prefixes.
// Local staging only; synthetic qualification-* accounts and their projects are deleted afterwards.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSyntheticAccounts } from './synthetic-accounts.mjs';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const container = process.env.HOSTING_APP_CONTAINER;
assert(container, 'Explicit synthetic-account target container is required');
const base = process.env.HOSTING_TEST_BASE || 'http://127.0.0.1:8081';
assert.equal(new URL(base).hostname, '127.0.0.1', 'This check is restricted to local instances');
const work = mkdtempSync(join(tmpdir(), 'latex-phase-'));
const name = 'phase-coverage-' + Date.now();
const files = { 'main.tex': '\\documentclass{article}\n\\begin{document}\nPhase fixture.\n\\input{chapter}\n\\end{document}\n', 'chapter.tex': 'Chapter text.\n', 'figure.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64') };
for (const [file, bytes] of Object.entries(files)) writeFileSync(join(work, file), bytes);
execFileSync('/usr/bin/zip', ['-q', join(work, name + '.zip'), ...Object.keys(files)], { cwd: work });
const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const passed = [];
const pass = step => { passed.push(step); console.log('Passed: ' + step); };

// Exact native tree identities via the container's own models (read-only).
function tree(project) {
  assert(/^[a-f0-9]{24}$/.test(project));
  const code = `import ProjectGetter from './app/src/Features/Project/ProjectGetter.mjs';const p=await ProjectGetter.promises.getProject(process.argv[1],{rootFolder:1});const out={};const walk=(f,prefix)=>{out[prefix||'/']={type:'folder',id:String(f._id)};for(const d of f.docs||[])out[prefix+d.name]={type:'doc',id:String(d._id)};for(const r of f.fileRefs||[])out[prefix+r.name]={type:'file',id:String(r._id)};for(const c of f.folders||[])walk(c,prefix+c.name+'/')};walk(p.rootFolder[0],'');console.log('TREE:'+JSON.stringify(out));process.exit(0);`;
  const out = execFileSync('docker', ['exec', '-w', '/overleaf/services/web', container, 'node', '--input-type=module', '-e', code, project], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out.match(/TREE:(.+)/)[1]);
}
function unzip(bytes, label) {
  const dir = join(work, label); execFileSync('/bin/mkdir', ['-p', dir]); writeFileSync(join(dir, 'p.zip'), bytes);
  const list = execFileSync('/usr/bin/unzip', ['-Z1', join(dir, 'p.zip')], { encoding: 'utf8' }).split('\n').filter(Boolean).filter(p => !p.endsWith('/')).sort();
  execFileSync('/usr/bin/unzip', ['-q', '-o', join(dir, 'p.zip'), '-d', join(dir, 'x')]);
  return Object.fromEntries(list.map(p => [p, readFileSync(join(dir, 'x', p))]));
}

try {
  await withSyntheticAccounts(async users => {
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
    const deadline = setTimeout(() => browser.close(), 300000);
    try {
      async function login(user) {
        const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, serviceWorkers: 'block' });
        await context.route('**/*', route => {
          const url = new URL(route.request().url());
          if (url.origin !== base) return route.abort();
          // Not a compile check: keep the browser compiler from downloading its packages.
          if (url.pathname === '/participant/client.mjs') return route.fulfill({ contentType: 'application/javascript',
            body: 'export async function compile(){return Response.json({status:"error",outputFiles:[]})}export async function cancel(){return Response.json({})}' });
          return route.continue();
        });
        const page = await context.newPage(); page.setDefaultTimeout(20000);
        await page.goto(base + '/login'); await page.locator('input[name=email]').fill(user.email);
        await page.locator('input[name=password]').fill(user.password); await page.getByRole('button', { name: /^Login/ }).click();
        await page.waitForURL(base + '/project'); return page;
      }
      const [alice, bob, carol] = await Promise.all(users.map(login));
      const editor = page => page.getByRole('textbox', { name: /^Source Editor/ });
      const text = page => editor(page).evaluate(el => el.cmView.view.state.doc.toString());
      const csrf = page => page.evaluate(() => { const raw = document.querySelector('meta[name="ol-csrfToken"]').content; try { return JSON.parse(raw); } catch { return raw; } });
      const call = async (page, method, path, data, extra = {}) => page.request.fetch(base + path, { method, headers: { 'X-CSRF-Token': await csrf(page) }, maxRedirects: 0, ...(data ? { data } : {}), ...extra });
      async function converged(a, b) {
        // Both sides must hold the same text twice in a row (no edit still in flight).
        let last;
        for (const started = Date.now(); Date.now() - started < 20000; await a.waitForTimeout(250)) {
          const [x, y] = await Promise.all([text(a), text(b)]);
          if (x === y && x === last) return x;
          last = x === y ? x : undefined;
        }
        const [x, y] = await Promise.all([text(a), text(b)]);
        throw Error('Editors did not converge: ' + JSON.stringify({ a: x.slice(-160), b: y.slice(-160) }));
      }
      async function joinAs(member, user, privileges) {
        const response = await call(alice, 'POST', `/project/${project}/invite`, { email: user.email, privileges });
        assert(response.ok(), 'Invite failed: ' + response.status());
        await member.goto(base + '/project'); const invite = member.getByRole('alert').filter({ hasText: name });
        await invite.getByRole('button', { name: 'Join Project', exact: true }).click(); await invite.getByText('Open Project', { exact: true }).waitFor();
        await member.goto(projectUrl); await editor(member).waitFor();
      }

      // Import and membership.
      await alice.getByRole('button', { name: /^(New project|Create a new project)$/i }).click();
      await alice.getByText('Existing project (.zip)', { exact: true }).click();
      await alice.locator('input[type=file]').first().setInputFiles(join(work, name + '.zip'));
      await alice.waitForURL(/\/project\/[a-f0-9]{24}/); const projectUrl = alice.url(), project = projectUrl.match(/[a-f0-9]{24}/)[0];
      await editor(alice).waitFor();
      await joinAs(bob, users[1], 'readAndWrite'); await joinAs(carol, users[2], 'readOnly');
      await converged(alice, bob); await converged(alice, carol); pass('import, editor and read-only membership');

      // R1: read-only member cannot change content or structure; anonymous access refused.
      const ids = tree(project);
      const before = await text(alice);
      await editor(carol).click(); await carol.keyboard.insertText('CAROL-SHOULD-NOT-APPEAR');
      assert.equal(await editor(carol).evaluate(el => el.cmView.view.state.readOnly || el.getAttribute('contenteditable') === 'false'), true, 'Read-only editor must not accept typing');
      for (const [method, path, data] of [['POST', `/project/${project}/doc/${ids['chapter.tex'].id}/rename`, { name: 'x.tex' }], ['DELETE', `/project/${project}/file/${ids['figure.png'].id}`], ['POST', `/project/${project}/doc`, { name: 'carol.tex', parent_folder_id: ids['/'].id }], ['POST', `/project/${project}/invite`, { email: 'outsider@example.test', privileges: 'readAndWrite' }]]) {
        const response = await call(carol, method, path, data);
        assert([401, 403].includes(response.status()), `Read-only ${method} ${path.replace(/[a-f0-9]{24}/g, '<id>')} returned ${response.status()}`);
      }
      assert.deepEqual(Object.keys(tree(project)).sort(), Object.keys(ids).sort()); assert.equal(await text(alice), before);
      const anonymous = await browser.newContext(); await anonymous.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      for (const path of [`/project/${project}`, `/project/${project}/download/zip`, `/Project/${project}/download/zip`]) {
        const response = await anonymous.request.get(base + path, { maxRedirects: 0 });
        assert(response.status() !== 200 || !(await response.body()).subarray(0, 2).equals(Buffer.from('PK')), 'Anonymous request must not receive project data: ' + response.status());
        assert([302, 401, 403, 404].includes(response.status()), `Anonymous ${path.replace(/[a-f0-9]{24}/g, '<id>')} returned ${response.status()}`);
      }
      pass('read-only content/structure/invite refusal and anonymous refusal');

      // R6/TG-07: private paths reached through public static prefixes are never served.
      for (const prefix of ['recovery', 'participant', 'js', 'fonts', 'images']) {
        for (const tail of [`%2e%2e/project/${project}/download/zip`, `..%2fproject/${project}/download/zip`, `%2e%2e/Project/${project}/download/zip`, `%2e%2e/project/${project}/output/output.pdf`]) {
          const response = await anonymous.request.get(`${base}/${prefix}/${tail}`, { maxRedirects: 0 });
          const body = await response.body();
          assert(!body.subarray(0, 2).equals(Buffer.from('PK')) && !body.subarray(0, 5).equals(Buffer.from('%PDF-')), `Public prefix /${prefix} leaked private bytes (${response.status()})`);
        }
      }
      for (const path of ['/recovery/', '/participant/', '/recovery/.env', '/participant/../../etc/passwd']) {
        const response = await anonymous.request.get(base + path, { maxRedirects: 0 });
        assert.notEqual(response.status(), 200, 'Unexpected public listing/file: ' + path);
      }
      await anonymous.close(); pass('public static prefixes cannot reach private project or output bytes');

      // R2: concurrent Unicode (combining, CJK, RTL), IME composition and non-BMP handling converge exactly.
      const end = async page => { await editor(page).click(); await page.keyboard.press('Meta+ArrowDown'); };
      await end(alice); await end(bob);
      await Promise.all([alice.keyboard.insertText('\nAlice café e\u0301 漢字 עברית'), bob.keyboard.insertText('\nBob ñ ü ß Ελληνικά')]);
      const unicode = await converged(alice, bob);
      assert(unicode.includes('Alice café e\u0301 漢字 עברית') && unicode.includes('Bob ñ ü ß Ελληνικά'), 'Both Unicode insertions must survive exactly');
      const cdp = await alice.context().newCDPSession(alice); await end(alice);
      await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
      await cdp.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
      await cdp.send('Input.insertText', { text: '日本' });
      await bob.waitForFunction(() => document.querySelector('[aria-label^="Source Editor"]')?.cmView.view.state.doc.toString().includes('日本'));
      const afterIme = await converged(alice, bob); assert(!afterIme.includes('にほ'), 'Composition text must not be committed');
      await end(bob); await bob.keyboard.insertText('\nNonBMP 😀 marker');
      await alice.waitForTimeout(1500);
      const a = await text(alice), b = await text(bob), surrogate = /[\uD800-\uDFFF]/;
      assert(a.startsWith(afterIme.slice(0, 20)) && a.includes('Alice café'), 'Earlier acknowledged text must survive a non-BMP attempt');
      if (a !== b) {
        // Native CE+ refuses non-BMP characters: the sender must keep its text locally and the server copy must stay valid.
        assert(!surrogate.test(a), 'Server copy must not hold a partial surrogate');
      }
      await bob.reload(); await editor(bob).waitFor(); const reloaded = await converged(alice, bob);
      assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(reloaded), 'No lone surrogate after reload');
      pass(`concurrent Unicode/IME convergence; non-BMP ${surrogate.test(reloaded) ? 'accepted' : 'refused without corruption'}`);

      // R5: folder, move, rename, binary upload, delete, ZIP export and clone, with a live peer.
      const root = tree(project)['/'].id;
      const folder = await (await call(alice, 'POST', `/project/${project}/folder`, { name: 'parts', parent_folder_id: root })).json();
      assert(/^[a-f0-9]{24}$/.test(folder._id));
      const chapter = tree(project)['chapter.tex'].id;
      assert((await call(alice, 'POST', `/project/${project}/doc/${chapter}/move`, { folder_id: folder._id })).ok());
      assert((await call(alice, 'POST', `/project/${project}/doc/${chapter}/rename`, { name: 'part1.tex' })).ok());
      await bob.getByRole('treeitem', { name: 'parts' }).click().catch(() => {});
      await bob.getByRole('treeitem', { name: 'part1.tex' }).waitFor();
      const upload = await alice.request.post(`${base}/Project/${project}/upload?folder_id=${root}`, { headers: { 'X-CSRF-Token': await csrf(alice) },
        multipart: { name: 'data.bin', qqfile: { name: 'data.bin', mimeType: 'application/octet-stream', buffer: binary } } });
      assert(upload.ok(), 'Upload failed: ' + upload.status()); assert((await upload.json()).success);
      await bob.getByRole('treeitem', { name: 'data.bin' }).waitFor();
      const duplicateName = await call(alice, 'POST', `/project/${project}/doc`, { name: 'main.tex', parent_folder_id: root });
      assert(!duplicateName.ok(), 'Duplicate file name must be refused');
      const traversal = await call(alice, 'POST', `/project/${project}/doc/${chapter}/rename`, { name: '../escape.tex' });
      assert(!traversal.ok(), 'Path traversal rename must be refused');
      const source = await text(alice);
      const exported = unzip(await (await alice.request.get(`${base}/Project/${project}/download/zip`)).body(), 'export');
      assert.deepEqual(Object.keys(exported), ['data.bin', 'figure.png', 'main.tex', 'parts/part1.tex']);
      assert(exported['data.bin'].equals(binary)); assert(exported['figure.png'].equals(files['figure.png']));
      assert.equal(exported['parts/part1.tex'].toString(), files['chapter.tex']); assert.equal(exported['main.tex'].toString(), source);
      pass('folder/move/rename/upload with live peer tree and exact ZIP export');
      const fileId = tree(project)['data.bin'].id;
      assert((await call(alice, 'DELETE', `/project/${project}/file/${fileId}`)).ok());
      await bob.getByRole('treeitem', { name: 'data.bin' }).waitFor({ state: 'detached' });
      const clone = await (await call(alice, 'POST', `/Project/${project}/clone`, { projectName: name + '-copy' })).json();
      assert(/^[a-f0-9]{24}$/.test(clone.project_id));
      const copied = unzip(await (await alice.request.get(`${base}/Project/${clone.project_id}/download/zip`)).body(), 'clone');
      const original = unzip(await (await alice.request.get(`${base}/Project/${project}/download/zip`)).body(), 'after-delete');
      assert.deepEqual(Object.keys(copied), Object.keys(original)); assert.deepEqual(Object.keys(original), ['figure.png', 'main.tex', 'parts/part1.tex']);
      for (const path of Object.keys(original)) assert(copied[path].equals(original[path]), 'Clone differs: ' + path);
      assert.equal((await call(bob, 'GET', `/Project/${clone.project_id}/download/zip`)).status() >= 400, true, 'Collaborators of the original must not read the copy');
      pass('delete propagates live; clone is exact and private to its owner');

      // R4: revoking a member stops their live access without changing the owner's source.
      const exact = await converged(alice, bob);
      assert((await call(alice, 'DELETE', `/project/${project}/users/${users[1].id}`)).ok());
      await bob.waitForTimeout(1500); await end(bob).catch(() => {}); await bob.keyboard.insertText('REVOKED-BOB-TEXT').catch(() => {});
      await alice.waitForTimeout(3000);
      assert.equal(await text(alice), exact, 'Revoked member edits must never reach the project');
      assert([403, 404, 302].includes((await bob.request.get(`${base}/Project/${project}/download/zip`, { maxRedirects: 0 })).status()), 'Revoked member export must be refused');
      const rejoin = await bob.goto(projectUrl); assert(!rejoin.ok() || !(await editor(bob).isVisible().catch(() => false)), 'Revoked member must not reopen the editor');
      pass('revocation stops live edits and export');

      // R1: logging out in another tab never lets the stale editor write.
      const exactBeforeLogout = await converged(alice, carol);
      await joinAs(bob, users[1], 'readAndWrite'); await converged(alice, bob);
      const second = await bob.context().newPage(); await second.goto(base + '/project');
      await second.evaluate(async token => { await fetch('/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: '{}' }); }, await csrf(bob));
      const loggedOut = await bob.request.get(`${base}/Project/${project}/download/zip`, { maxRedirects: 0 });
      assert.notEqual(loggedOut.status(), 200, 'Logged-out session must not export');
      await end(bob).catch(() => {}); await bob.keyboard.insertText('LOGGED-OUT-BOB-TEXT').catch(() => {});
      await alice.waitForTimeout(3000);
      const ownerText = await text(alice);
      assert(!ownerText.includes('LOGGED-OUT-BOB-TEXT'), 'An editor whose session was logged out must not keep writing');
      assert(ownerText.startsWith(exactBeforeLogout.slice(0, 10)), 'Owner source must stay valid');
      pass('logout in another tab stops the stale editor writing');

      console.log(JSON.stringify({ phaseCoveragePassed: true, steps: passed }));
    } finally { clearTimeout(deadline); await browser.close(); }
  }, 3, container);
} finally { rmSync(work, { recursive: true, force: true }); }
