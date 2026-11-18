import assert from 'node:assert/strict';

export async function checkPool({ browser, alice, users, projectUrl, base }) {
  const pages = [alice], blocked = new Set(), accepted = [], replay = [];
  let recovering = false, recovered = false;
  async function api(page, body) {
    return page.evaluate(async body => {
      const csrf = (raw => { try { return JSON.parse(raw); } catch { return raw; } })(document.querySelector('meta[name="ol-csrfToken"]').content);
      const response = await fetch(location.pathname + '/participant-compile', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body),
      });
      return { status: response.status };
    }, body);
  }
  async function instrument(page, index) {
    await page.context().route('**/participant-compile', async route => {
      const req = route.request(); let body;
      try { body = req.postDataJSON(); } catch { body = null; }
      if (body?.op === 'claim' && blocked.has(index)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"job":null}' });
      if (body?.op === 'leave' && index === 1 && recovering) {
        blocked.add(1); blocked.delete(0); recovered = true;
      }
      if (req.headers()['content-type'] === 'application/octet-stream') {
        const metadata = JSON.parse(req.headers()['x-participant-job']);
        const response = await route.fetch();
        if (response.ok()) { accepted.push({ index, job: metadata.job }); replay.push({ index, metadata, bytes: req.postDataBuffer() }); }
        return route.fulfill({ response });
      }
      return route.fallback();
    });
  }
  await instrument(alice, 0);
  const editor = page => page.getByRole('textbox', { name: /^Source Editor/ });
  for (let index = 1; index < users.length; index++) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin !== base || /\/compile$/.test(url.pathname) ? route.abort() : route.continue();
    });
    await context.addInitScript(() => {
      globalThis.participantResults = [];
      document.addEventListener('overleaf:participant-result', e => participantResults.push(e.detail));
      const Native = Worker;
      globalThis.Worker = class extends Native {
        constructor(url, ...args) { super(url, ...args); this.participant = String(url).endsWith('/busytex_worker.js'); }
        postMessage(value, ...args) {
          if (this.participant && value.files && globalThis.failNextParticipantCompile) {
            globalThis.failNextParticipantCompile = false;
            this.dispatchEvent(new ErrorEvent('error', { message: 'Synthetic worker fault' })); return;
          }
          return super.postMessage(value, ...args);
        }
      };
    });
    const page = await context.newPage(); page.setDefaultTimeout(20000); await instrument(page, index); pages.push(page);
    await page.goto(base + '/login'); await page.locator('input[name=email]').fill(users[index].email);
    await page.locator('input[name=password]').fill(users[index].password); await page.getByRole('button', { name: /^Login/ }).click();
    await page.waitForURL(base + '/project');
    const denied = await page.evaluate(async project => {
      const csrf = (raw => { try { return JSON.parse(raw); } catch { return raw; } })(document.querySelector('meta[name="ol-csrfToken"]').content);
      return (await fetch(project + '/participant-compile', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: '{"op":"join"}' })).status;
    }, projectUrl);
    assert([403, 404].includes(denied), `Non-member worker registration returned ${denied}`);
    await alice.getByRole('button', { name: /Share/ }).click(); const dialog = alice.getByRole('dialog');
    await dialog.locator('input[type=email]').fill(users[index].email); await dialog.getByRole('button', { name: 'Invite', exact: true }).click();
    await dialog.getByText(users[index].email, { exact: true }).waitFor(); await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
    await page.reload(); const invite = page.getByRole('alert').filter({ hasText: 'participant' });
    await invite.getByRole('button', { name: 'Join Project', exact: true }).click();
    await invite.getByText('Open Project', { exact: true }).waitFor();
    await page.goto(projectUrl + '?participant-compile=1'); await editor(page).waitFor();
  }
  const start = performance.now();
  await Promise.all(pages.map(page => page.waitForFunction(() => participantResults.length >= 1, null, { timeout: 120000 })));
  const allFiveReadyMs = performance.now() - start;
  for (const page of pages) assert.equal(await editor(page).evaluate(e => e.cmView.view.state.doc.toString()), await editor(alice).evaluate(e => e.cmView.view.state.doc.toString()));
  const rounds = [];
  for (let round = 0; round < 3; round++) {
    const counts = await Promise.all(pages.map(page => page.evaluate(() => participantResults.length))), started = performance.now();
    await Promise.all(pages.map(page => page.getByRole('button', { name: /^Recompile/ }).first().click()));
    await Promise.all(pages.map((page, i) => page.waitForFunction(count => participantResults.length > count, counts[i], { timeout: 60000 })));
    rounds.push(performance.now() - started);
  }
  assert.equal((await api(alice, { op: 'claim', worker: 'invalid' })).status, 409);
  // One contributing device must service two other members in bounded time.
  for (let i = 0; i < pages.length; i++) if (i !== 1) blocked.add(i);
  const counts = await Promise.all([0, 3].map(i => pages[i].evaluate(() => participantResults.length)));
  const queuedAt = performance.now();
  await Promise.all([0, 3].map(i => pages[i].getByRole('button', { name: /^Recompile/ }).first().click()));
  await Promise.all([0, 3].map((i, n) => pages[i].waitForFunction(count => participantResults.length > count, counts[n], { timeout: 60000 })));
  const pairMs = performance.now() - queuedAt;
  const jobs = await Promise.all([0, 3].map(i => pages[i].evaluate(() => participantResults.at(-1).job)));
  for (const job of jobs) assert(accepted.some(r => r.index === 1 && r.job === job), 'A collaborator must perform each queued compile');
  const previous = replay.find(r => r.index === 1 && r.metadata.job === jobs[0]); assert(previous);
  const stale = await pages[1].request.post(projectUrl + '/participant-compile', { data: previous.bytes, headers: {
    'Content-Type': 'application/octet-stream', 'X-Participant-Job': JSON.stringify(previous.metadata),
    'X-CSRF-Token': await pages[1].evaluate(() => (raw => { try { return JSON.parse(raw); } catch { return raw; } })(document.querySelector('meta[name="ol-csrfToken"]').content)),
  } });
  assert.equal(stale.status(), 409, 'A duplicate result must not publish');
  // Terminate an actual worker through its error event before it executes this next job.
  recovering = true; await pages[1].evaluate(() => { globalThis.failNextParticipantCompile = true; });
  const beforeFault = await alice.evaluate(() => participantResults.length), faultAt = performance.now();
  await alice.getByRole('button', { name: /^Recompile/ }).first().click();
  await alice.waitForFunction(count => participantResults.length > count, beforeFault, { timeout: 60000 });
  const recoveryMs = performance.now() - faultAt, finalJob = await alice.evaluate(() => participantResults.at(-1).job);
  assert(recovered, 'Worker error must release its lease');
  assert(accepted.some(r => r.index === 0 && r.job === finalJob), 'Another device must complete the reassigned job');
  const revoked = await alice.evaluate(async user => {
    const raw = document.querySelector('meta[name="ol-csrfToken"]').content; let csrf; try { csrf = JSON.parse(raw); } catch { csrf = raw; }
    return (await fetch(location.pathname + '/users/' + user, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf } })).status;
  }, users[1].id);
  assert(revoked >= 200 && revoked < 300, 'Native owner must be able to revoke the test member');
  const denied = await api(pages[1], { op: 'join' }); assert([403, 404].includes(denied.status), 'Revoked member must not register another worker');
  // Later single-worker checks must not share this pool's contributing peer contexts.
  await Promise.all(pages.slice(1).map(page => page.context().close()));
  console.log(JSON.stringify({ poolPassed: true, users: users.length, allFiveReadyMs, fiveUserRoundMs: rounds, twoOtherUsersOnOneWorkerMs: pairMs,
    workerFaultRecoveredMs: recoveryMs, nonMembersDenied: users.length - 1, duplicateResultDenied: true, revokedMemberDenied: true, sourcesUnchanged: true }));
}
