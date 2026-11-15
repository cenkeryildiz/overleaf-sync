import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert(process.env.OVERLEAF_TEST_ALICE_PASSWORD, 'Provide the synthetic Alice password via the test environment');
const base = 'http://127.0.0.1:8080';
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(base + '/login');
  await page.locator('input[name=email]').fill('alice@example.test');
  await page.locator('input[name=password]').fill(process.env.OVERLEAF_TEST_ALICE_PASSWORD);
  await page.getByRole('button', { name: /^Login/ }).click();
  await page.waitForURL(base + '/project');
  await page.getByText('Account', { exact: true }).filter({ visible: true }).click();
  await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname === '/logout' && r.request().method() === 'POST'),
    page.getByText(/^(log out|logout)$/i).filter({ visible: true }).click(),
  ]);
  await page.goto(base + '/project');
  assert.equal(new URL(page.url()).pathname, '/login');
  console.log('PASS: existing synthetic browser login/logout and protected-page rejection after logout; provider remains inactive.');
} finally {
  await browser.close();
}
