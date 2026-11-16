// SPDX-License-Identifier: AGPL-3.0-only
const settings = require('/etc/overleaf/participant-base.cjs');
for (const name of ['OVERLEAF_INVITE_TOKEN_SECRET', 'OVERLEAF_SESSION_SECRET']) {
  if (!process.env[name] || process.env[name].length < 32 || process.env[name].includes('REPLACE_'))
    throw Error(name + ' must be a persistent random secret');
}
settings.security = { ...settings.security, sessionSecret: process.env.OVERLEAF_SESSION_SECRET };
const origin = new URL(settings.siteUrl);
if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
    !['http:', 'https:'].includes(origin.protocol)) throw Error('OVERLEAF_SITE_URL must be a plain HTTP(S) origin');
if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
  throw Error('A public OVERLEAF_SITE_URL requires HTTPS');
settings.secureCookie = origin.protocol === 'https:';
if (process.env.EXTERNAL_AUTH?.includes('oidc') && process.env.OVERLEAF_OIDC_PROVIDER_ID === 'google') {
  for (const name of ['OVERLEAF_OIDC_CLIENT_ID', 'OVERLEAF_OIDC_CLIENT_SECRET']) {
    const value = process.env[name];
    if (!value || value.includes('REPLACE_') || /\s/.test(value)) throw Error(name + ' requires private Google web-client credentials');
  }
  if (!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(process.env.OVERLEAF_OIDC_CLIENT_ID))
    throw Error('Google requires a web OAuth client ID');
}
settings.participantCompilationOnly = true;
module.exports = settings;
