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
// Offline pages are served these pinned packages from the verified Cache Storage copy; Emscripten's IndexedDB package
// cache would duplicate ~635 MB there, and writing it dominated the first offline compile (OPT-02). Connected pages keep it.
if (location.pathname.startsWith('/recovery/busytex/')) {
  Object.defineProperty(self, 'indexedDB', { value: undefined });
  // The generated package loaders console.error exactly these two lines before their normal fetch fallback; Chrome lists them as extension errors.
  const nativeError = console.error.bind(console), expected = ['using IndexedDB to cache data can only be done on a web page or in a web worker', 'falling back to default preload behavior'];
  console.error = (...args) => { if (!(args.length === 1 && expected.includes(args[0]?.message ?? args[0]))) nativeError(...args); };
}
// Measurement only (OPT-01): stage marks that browser checks read with performance.getEntriesByType('mark').
const nativePost = self.postMessage.bind(self), compileStreaming = WebAssembly.compileStreaming, instantiate = WebAssembly.instantiate;
self.postMessage = (data, ...rest) => {
  const text = data?.print;
  if (data?.initialized) performance.mark('worker:initialized');
  else if (data?.pdf !== undefined) performance.mark('worker:result');
  else if (typeof text === 'string' && /^(?:\$ busytex \S+|New compilation started|All downloads complete|Data packages used \(not preloaded\))/.test(text))
    performance.mark('worker:' + text.slice(0, 160));
  return nativePost(data, ...rest);
};
if (compileStreaming) WebAssembly.compileStreaming = (...args) => compileStreaming(...args).finally(() => performance.mark('worker:wasm compiled'));
WebAssembly.instantiate = (...args) => instantiate(...args).finally(() => performance.mark('worker:wasm instantiated'));
importScripts('busytex_worker.original.js');
