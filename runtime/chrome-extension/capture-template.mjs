// SPDX-License-Identifier: AGPL-3.0-only
// Build input only: capture public native-editor settings from a disposable synthetic account, never a user's project.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { withSyntheticAccounts } from '../../test/browser/synthetic-accounts.mjs';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = 'http://127.0.0.1:8081', container = 'latex-google-local-app-1';
await withSyntheticAccounts(async users => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto(base + '/login');
    await page.locator('input[name=email]').fill(users[0].email);
    await page.locator('input[name=password]').fill(users[0].password);
    await page.getByRole('button', { name: /^Login/ }).click(); await page.waitForURL(base + '/project');
    const project = await page.evaluate(async () => {
      let csrf = document.querySelector('meta[name="ol-csrfToken"]').content;
      try { csrf = JSON.parse(csrf); } catch { /* Native raw-string metadata is also supported. */ }
      const response = await fetch('/project/new', { method: 'POST', headers: { 'Content-Type': 'application/json',
        'X-CSRF-Token': csrf },
        body: JSON.stringify({ projectName: 'Local project', template: 'none' }) });
      if (!response.ok) throw Error('Synthetic template creation refused');
      return response.json();
    });
    await page.goto(base + '/project/' + project.project_id);
    await page.getByRole('textbox', { name: /^Source Editor/ }).waitFor();
    const template = await page.evaluate(() => {
      const publicPath = raw => { const url = new URL(raw, location.href); return url.origin === location.origin && /^\/(js|stylesheets|fonts)\//.test(url.pathname) ? url.pathname : null; };
      return { meta: [...document.querySelectorAll('meta[name^="ol-"]')].filter(node => !/csrf|token|session|analytics/i.test(node.name))
        .map(node => ({ name: node.name, content: node.content, present: node.hasAttribute('content'), type: node.dataset.type })),
      scripts: [...document.querySelectorAll('script[src]')].map(node => publicPath(node.src)).filter(Boolean),
      styles: [...document.querySelectorAll('link[rel="stylesheet"]')].map(node => publicPath(node.href)).filter(Boolean), resources: [], projectMeta: {} };
    });
    let encoded = JSON.stringify(template);
    assert(!users.some(user => encoded.includes(user.password)), 'Never retain credentials');
    for (const user of users) encoded = encoded.replaceAll(user.id, '000000000000000000000001').replaceAll(user.email, 'local@example.invalid');
    encoded = encoded.replaceAll(project.project_id, '000000000000000000000002');
    const sanitized = JSON.parse(encoded);
    for (const item of sanitized.meta) {
      if (item.name === 'ol-user') item.content = JSON.stringify({ _id: '000000000000000000000001', first_name: 'Local', last_name: '', email: 'local@example.invalid' });
      if (item.name === 'ol-projectName') item.content = 'Local project';
    }
    writeFileSync(new URL('./native-template.json', import.meta.url), JSON.stringify(sanitized, null, 2) + '\n');
    console.log(`Captured public template: ${sanitized.meta.length} settings, ${sanitized.scripts.length} scripts`);
  } finally { await browser.close(); }
}, 2, container);
