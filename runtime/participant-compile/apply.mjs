// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [kind, input, output, version, editorVersion] = process.argv.slice(2);
assert(input && output && input !== output);
let source = readFileSync(input, 'utf8');
const hash = createHash('sha256').update(source).digest('hex');
function once(before, after) { assert.equal(source.split(before).length - 1, 1); source = source.replace(before, after); }
if (kind === 'router') {
  assert.equal(hash, '9db30f230df472a64e19ee56a05d02ca237ce174812cafc4185c410a9a96dfc0');
  once("import CompileController from './Features/Compile/CompileController.mjs'", "import CompileController from './Features/Compile/CompileController.mjs'\nimport { raw as participantRaw } from 'express'\nimport { participantCompile } from './Features/Compile/ParticipantCompile.mjs'");
  once('  compileProjectHttp: new RateLimiter', "  participantHttp: new RateLimiter('participant-http', { points: 600, duration: 60 }),\n  compileProjectHttp: new RateLimiter");
  once("  webRouter.post(\n    '/project/:Project_id/compile',", "  webRouter.get(\n    '/project/:Project_id/participant-output-auth',\n    AsyncLocalStorage.middleware,\n    AuthorizationMiddleware.ensureUserCanReadProject,\n    (req, res) => res.sendStatus(204)\n  )\n\n  webRouter.post(\n    '/project/:Project_id/participant-compile',\n    AsyncLocalStorage.middleware,\n    AuthorizationMiddleware.ensureUserCanReadProject,\n    RateLimiterMiddleware.rateLimit(rateLimiters.participantHttp, { params: ['Project_id'] }),\n    participantRaw({ type: 'application/octet-stream', limit: '24mb' }),\n    participantCompile\n  )\n\n  webRouter.post(\n    '/project/:Project_id/compile',");
} else if (kind === 'email') {
  assert.equal(hash, 'f9eff9db9b876dc8e5be9e926f7a8d86276eae819d5708508b08e8e68757d964');
  once("logger.info({ options }, 'Would send email if enabled.')", "logger.info('Email delivery disabled; message not sent.')");
  once('console.log("EMAIL_SETTINGS  = ", EMAIL_SETTINGS)\n', '');
} else if (kind === 'sync') {
  assert.equal(hash, '51632668637d4eef9c36912edfb160790bb9deb37ca963613656522066dc00eb');
  once("    : getCompileDir(projectId, userId)\n  const timeout = 60 * 1000", "    : getCompileDir(projectId, userId)\n  if (runInOutputDir && !Settings.clsi?.dockerRunner) command.push('-d', directory)\n  const timeout = 60 * 1000");
} else if (kind === 'editor') {
  assert.equal(hash, '4510ce9f048b891d5677316f905f0f4f190ae5fdd7a5462d188b7c9bb0be10e3');
  const { patchTypingCaret } = await import('../live-caret/apply.mjs');
  source = patchTypingCaret(source);
  source += '\n' + readFileSync(new URL('./editor.js', import.meta.url), 'utf8');
} else if (kind === 'main') {
  assert.equal(hash, '100e8036346af0aae05c08e140ef86b1f8d1d0e6805c906d87b59d9d4bc34e53');
  const clientVersion = createHash('sha256').update(readFileSync(new URL('./client.mjs', import.meta.url))).digest('hex');
  source = readFileSync(new URL('./bootstrap.js', import.meta.url), 'utf8').replace("'/participant/client.mjs'", `'/participant/client.mjs?v=${clientVersion}'`) + '\n' + source;
} else if (kind === 'manifest') {
  assert.equal(hash, '53e9110d3c4b943c30ac5c842a75989cbbc9059ee4a997b290ae50799c0f5b5e');
  assert.match(version || '', /^[a-f0-9]{64}$/); assert.match(editorVersion || '', /^[a-f0-9]{64}$/);
  const main = '/js/8607-0a5113f4c48f158e90d6.js?v=100e8036346af0aae05c08e140ef86b1f8d1d0e6805c906d87b59d9d4bc34e53';
  const runtime = '/js/runtime-0239170c7f0b0a6c5b25.js';
  const replace = value => typeof value === 'string' ? value === main ? main.split('?')[0] + '?v=' + version : value === runtime ? runtime + '?v=' + editorVersion : value :
    Array.isArray(value) ? value.map(replace) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k,replace(v)])) : value;
  source = JSON.stringify(replace(JSON.parse(source)));
} else throw Error('Choose router, editor, main, sync, email or manifest');
writeFileSync(output, source, { flag: 'wx' });
