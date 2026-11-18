// SPDX-License-Identifier: AGPL-3.0-only
// TeX's network capability is limited to these public, provisioned assets, never source-derived URLs.
const publicFiles = new Set(['busytex_worker.original.js', 'busytex_biber.js', 'busytex_pipeline.js',
  'busytex.js', 'busytex.wasm', 'biber.js', 'biber.wasm', 'biber.data',
  'texlive-basic.js', 'texlive-basic.data', 'texlive-basic.js.providespackage.txt',
  'texlive-recommended.js', 'texlive-recommended.data', 'texlive-recommended.js.providespackage.txt',
  'texlive-extra.js', 'texlive-extra.data', 'texlive-extra.js.providespackage.txt']);
function allowed(value) {
  const url = new URL(typeof value === 'string' || value instanceof URL ? value : value.url, location.href);
  const path = url.pathname.replace(/^\/recovery\/busytex\//, '/participant/busytex/');
  if (url.origin !== location.origin || url.search || url.hash || !path.startsWith('/participant/busytex/') ||
      !publicFiles.has(path.slice('/participant/busytex/'.length))) throw Error('Worker network request refused');
  return url.href;
}
const nativeFetch = self.fetch.bind(self), nativeImport = self.importScripts.bind(self), nativeOpen = XMLHttpRequest.prototype.open;
self.fetch = (url, options) => nativeFetch(allowed(url), { ...options, method: 'GET', credentials: 'omit', redirect: 'error' });
self.importScripts = (...urls) => nativeImport(...urls.map(allowed));
XMLHttpRequest.prototype.open = function(method, url, ...rest) {
  if (method !== 'GET') throw Error('Worker network method refused');
  return nativeOpen.call(this, method, allowed(url), ...rest);
};
self.WebSocket = class { constructor() { throw Error('Worker sockets disabled'); } };
importScripts('busytex_worker.original.js');
