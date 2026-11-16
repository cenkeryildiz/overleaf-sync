// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { patchLanUuid } from '../browser-recovery/apply.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [kind, input, output, version] = process.argv.slice(2);
assert(input && output && input !== output, 'Use separate original and output paths');
let source = readFileSync(input, 'utf8');
const once = (from, to) => { assert.equal(source.split(from).length - 1, 1, 'Pinned integration anchor differs'); source = source.replace(from, to); };
if (kind === 'router') {
  assert.equal(createHash('sha256').update(source).digest('hex'), '9db30f230df472a64e19ee56a05d02ca237ce174812cafc4185c410a9a96dfc0', 'Pinned router identity differs');
  once("import CompileController from './Features/Compile/CompileController.mjs'", "import CompileController from './Features/Compile/CompileController.mjs'\nimport { livePreview } from './Features/Compile/LivePreview.mjs'");
  once("  compileProjectHttp: new RateLimiter", "  livePreviewHttp: new RateLimiter('live-preview-http', { points: 2400, duration: 60 }),\n  compileProjectHttp: new RateLimiter");
  once("  webRouter.post(\n    '/project/:Project_id/compile',", "  webRouter.post(\n    '/project/:Project_id/live-preview',\n    AsyncLocalStorage.middleware,\n    AuthorizationMiddleware.ensureUserCanReadProject,\n    RateLimiterMiddleware.rateLimit(rateLimiters.livePreviewHttp, { params: ['Project_id'] }),\n    livePreview\n  )\n\n  webRouter.post(\n    '/project/:Project_id/compile',");
} else if (kind === 'editor') {
  const hash = createHash('sha256').update(source).digest('hex');
  assert(['cd299e675279ce5b18c2be172a0a64a7a143ff63f8fd9eb85c7849ebb60b4772', '4510ce9f048b891d5677316f905f0f4f190ae5fdd7a5462d188b7c9bb0be10e3'].includes(hash), 'Installed editor identity differs');
  if (hash.startsWith('cd299e')) source = patchLanUuid(source, readFileSync(new URL('../browser-recovery/recovery-core.js', import.meta.url), 'utf8'));
  source += '\n' + readFileSync(new URL('./client.js', import.meta.url), 'utf8');
} else if (kind === 'runtime') {
  assert.match(version || '', /^[a-f0-9]{64}$/);
  assert.equal(createHash('sha256').update(source).digest('hex'), 'd5a88ef72332d8a2facfe62fb20980771e1c987b73d77468dd2c9616b5df81b3', 'Pinned runtime identity differs');
  once('+".js",b.miniCssF=', '+".js"+(e===7565?"?v='+version+'":""),b.miniCssF=');
} else if (kind === 'manifest') {
  assert.match(version || '', /^[a-f0-9]{64}$/);
  const manifest = JSON.parse(source);
  const previous = '/js/runtime-0239170c7f0b0a6c5b25.js';
  assert.equal(manifest['runtime.js'], previous, 'Pinned runtime path differs');
  const replace = value => typeof value === 'string' ? (value === previous ? value+'?v='+version : value) : Array.isArray(value) ? value.map(replace) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replace(v)])) : value;
  source = JSON.stringify(replace(manifest));
} else throw Error('Choose router, editor, runtime or manifest');
writeFileSync(output, source, { flag: 'wx' });
