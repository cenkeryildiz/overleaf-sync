// SPDX-License-Identifier: MIT
export async function downloadProjectFile(page, label, path) {
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.locator('a').filter({ hasText: /^Download\s*chevron_right$/ }).hover();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: label, exact: true }).click()]);
  await download.saveAs(path);
}
