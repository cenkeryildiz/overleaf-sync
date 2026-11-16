import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'playwright');
assert(process.env.PREVIEW_FIXTURE_ZIP && process.env.PREVIEW_COPY_RESULT);
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH});
try {
 const base='http://127.0.0.1:8080',context=await browser.newContext({serviceWorkers:'block'});
 await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
 const page=await context.newPage();page.setDefaultTimeout(45000);
 await page.goto(base+'/login');await page.locator('input[name=email]').fill('alice@example.test');await page.locator('input[name=password]').fill(process.env.OVERLEAF_TEST_ALICE_PASSWORD);
 await page.getByRole('button',{name:/^Login/}).click();await page.waitForURL(base+'/project');
 await page.getByRole('button',{name:'New project',exact:true}).click();await page.getByText('Existing project (.zip)',{exact:true}).click();await page.locator('input[type=file]').first().setInputFiles(process.env.PREVIEW_FIXTURE_ZIP);
 await page.waitForURL(/\/project\/[a-f0-9]{24}/);await page.getByRole('textbox',{name:/^Source Editor/}).waitFor();
 fs.writeFileSync(process.env.PREVIEW_COPY_RESULT,JSON.stringify({projectUrl:page.url()}),{mode:0o600});console.log(JSON.stringify({importedCopy:page.url()}));
}finally{await browser.close()}
