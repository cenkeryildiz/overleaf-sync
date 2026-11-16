// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export function configuration(site, client, port = '8080') {
  const url = new URL(site);
  assert(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password &&
    url.pathname === '/' && !url.search && !url.hash, 'Use a plain HTTP(S) site origin');
  assert(url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Public sites require HTTPS');
  assert(/^\d{1,5}$/.test(port) && +port > 0 && +port <= 65535, 'Invalid local port');
  const web = client.web;
  assert(web && /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(web.client_id) &&
    /^[A-Za-z0-9_-]+$/.test(web.client_secret), 'Google JSON must contain a web client');
  assert(web.redirect_uris?.includes(url.origin + '/oidc/login/callback'), 'Google client is missing this exact site callback');
  const values = { OVERLEAF_SITE_URL: url.origin, LATEX_PORT: port,
    OVERLEAF_INVITE_TOKEN_SECRET: randomBytes(32).toString('hex'),
    OVERLEAF_SESSION_SECRET: randomBytes(32).toString('hex'),
    OVERLEAF_OIDC_CLIENT_ID: web.client_id, OVERLEAF_OIDC_CLIENT_SECRET: web.client_secret };
  return readFileSync(new URL('./.env.example', import.meta.url), 'utf8').replace(/^(\w+)=(.*)$/gm,
    (line, name) => Object.hasOwn(values, name) ? name + '=' + values[name] : line);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [site, json, output, port] = process.argv.slice(2);
    assert(site && json && output && process.argv.length <= 6,
      'Usage: node configure.mjs SITE_URL GOOGLE_CLIENT_JSON PRIVATE_ENV_FILE [LOCAL_PORT]');
    const content = configuration(site, JSON.parse(readFileSync(json, 'utf8')), port);
    const destination = resolve(output), repository = fileURLToPath(new URL('../../../', import.meta.url));
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const target = resolve(realpathSync(dirname(destination)), destination.split('/').at(-1));
    const path = relative(repository, target);
    assert(path.startsWith('..' + '/') || isAbsolute(path), 'Keep private configuration outside the source repository');
    // Exclusive creation preserves existing persistent keys and deployments.
    writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
    console.log('Private configuration created. Existing files are never overwritten. Use its path with --env-file and LATEX_ENV_FILE.');
  } catch (error) {
    console.error(error.code === 'EEXIST' ? 'Configuration already exists; preserved without changes.' :
      error.name === 'AssertionError' ? error.message : 'Configuration failed; check the input paths and JSON.');
    process.exitCode = 1;
  }
}
