// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { patchLanUuid } from '../browser-recovery/apply.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [kind, input, output] = process.argv.slice(2);
assert(input && output && input !== output, 'Use separate original and output paths');
let source = readFileSync(input, 'utf8');
const once = (from, to) => { assert.equal(source.split(from).length - 1, 1, 'Pinned integration anchor differs'); source = source.replace(from, to); };
if (kind === 'router') {
  assert.equal(createHash('sha256').update(source).digest('hex'), '9db30f230df472a64e19ee56a05d02ca237ce174812cafc4185c410a9a96dfc0', 'Pinned router identity differs');
  once("import CompileController from './Features/Compile/CompileController.mjs'", "import CompileController from './Features/Compile/CompileController.mjs'\nimport { livePreview } from './Features/Compile/LivePreview.mjs'");
  once("  compileProjectHttp: new RateLimiter", "  livePreviewHttp: new RateLimiter('live-preview-http', { points: 2400, duration: 60 }),\n  compileProjectHttp: new RateLimiter");
  once("  webRouter.post(\n    '/project/:Project_id/compile',", "  webRouter.post(\n    '/project/:Project_id/live-preview',\n    AsyncLocalStorage.middleware,\n    AuthorizationMiddleware.ensureUserCanReadProject,\n    RateLimiterMiddleware.rateLimit(rateLimiters.livePreviewHttp, { params: ['Project_id'] }),\n    livePreview\n  )\n\n  webRouter.post(\n    '/project/:Project_id/compile',");
} else if (kind === 'editor') {
  assert.equal(createHash('sha256').update(source).digest('hex'), 'cd299e675279ce5b18c2be172a0a64a7a143ff63f8fd9eb85c7849ebb60b4772', 'Installed editor identity differs');
  source = patchLanUuid(source, readFileSync(new URL('../browser-recovery/recovery-core.js', import.meta.url), 'utf8'));
  source += '\n' + readFileSync(new URL('./client.js', import.meta.url), 'utf8');
} else throw Error('Choose router or editor');
writeFileSync(output, source, { flag: 'wx' });
