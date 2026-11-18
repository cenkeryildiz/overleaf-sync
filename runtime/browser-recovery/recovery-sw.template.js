// SPDX-License-Identifier: AGPL-3.0-only
// The generator inserts a digest-pinned list of public static files only.
const manifest = __RECOVERY_MANIFEST__;
const cacheName = 'overleaf-local-' + manifest.version;
const compilerName = 'overleaf-compiler-' + (manifest.compilerVersion || manifest.version);
async function store(cache, asset) {
  const url = new URL(asset.path, self.location.origin);
  if (url.origin !== self.location.origin || url.search || (!url.pathname.startsWith('/recovery/') && !manifest.nativePaths.includes(url.pathname))) throw Error('Unexpected cache asset');
  const headers = { 'Content-Type': asset.type, 'Cache-Control': 'no-store' }, partSize = 16 * 1024 * 1024;
  async function verified(options, expected, length) {
    const response = await fetch(url, { credentials: 'omit', cache: 'reload', redirect: 'error', ...options });
    if (!response.ok || response.type === 'opaque' || (options?.headers && response.status !== 206)) throw Error('Public resource download refused: ' + asset.path);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > partSize || (length !== undefined && bytes.byteLength !== length)) throw Error('Public resource size mismatch: ' + asset.path);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
    if (hash !== expected) throw Error('Public asset integrity mismatch');
    return bytes;
  }
  if (asset.parts) {
    for (const [part, hash] of asset.parts.entries()) {
      const key = url.href + '?part=' + part;
      if (await cache.match(key)) continue;
      const start = part * partSize, end = Math.min(asset.size, start + partSize) - 1;
      const bytes = await verified({ headers: { Range: 'bytes=' + start + '-' + end } }, hash, end - start + 1);
      await cache.put(key, new Response(bytes, { headers }));
    }
    await cache.put(url, new Response('', { headers: { ...headers, 'X-Offline-Parts': asset.parts.length, 'X-Offline-Size': asset.size } }));
  } else await cache.put(url, new Response(await verified({}, asset.sha256), { headers }));
}
async function cached(cache, url) {
  const response = await cache.match(url); if (!response?.headers.has('X-Offline-Parts')) return response;
  const parts = Number(response.headers.get('X-Offline-Parts')); let part = 0, reader;
  return new Response(new ReadableStream({
    async pull(controller) {
      try {
        while (part < parts) {
          if (!reader) {
            const next = await cache.match(url.href + '?part=' + part);
            if (!next?.body) throw Error('Prepared compiler resource is incomplete; prepare again while connected');
            reader = next.body.getReader();
          }
          const { done, value } = await reader.read();
          if (!done) { controller.enqueue(value); return; }
          reader = undefined; part++;
        }
        controller.close();
      } catch (error) { controller.error(error); }
    }, cancel() { return reader?.cancel(); },
  }), { headers: { 'Content-Type': response.headers.get('Content-Type'), 'Content-Length': response.headers.get('X-Offline-Size'), 'Cache-Control': 'no-store' } });
}
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(cacheName);
  try {
    for (const asset of manifest.assets) {
      await store(cache, asset);
    }
    await self.skipWaiting();
  } catch (error) { await caches.delete(cacheName); throw error; }
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  await self.clients.claim();
  for (const name of await caches.keys()) if (name.startsWith('overleaf-local-') && name !== cacheName) await caches.delete(name);
})()));
self.addEventListener('message', event => {
  if (event.data?.type === 'VERSION' && event.ports[0]) event.ports[0].postMessage({ version: manifest.version });
  if (event.data?.type === 'PREPARE_COMPILER' && event.ports[0]) event.waitUntil((async () => {
    const port = event.ports[0];
    try {
      if (!manifest.compilerAssets?.length) throw Error('Compiler resources are unavailable in this installation');
      const cache = await caches.open(compilerName);
      const requested = new Set(Array.isArray(event.data.paths) ? event.data.paths : []);
      const assets = manifest.compilerAssets.filter(asset => !asset.optional || requested.has(asset.path));
      for (const [index, asset] of assets.entries()) {
        port.postMessage({ progress: `Preparing offline compiler ${index + 1}/${assets.length}…` });
        if (asset.parts || !await cache.match(asset.path)) await store(cache, asset);
      }
      port.postMessage({ ready: true, bytes: assets.reduce((total, asset) => total + asset.size, 0) });
    } catch (error) { port.postMessage({ error: error.message + '. Check available browser storage and connectivity, then retry.' }); }
  })());
});
self.addEventListener('fetch', event => {
  // Controlled local-workspace clients never fall through to network, even for unknown URLs.
  event.respondWith((async () => {
    const url = new URL(event.request.url);
    for (const prefix of ['js', 'stylesheets', 'fonts', 'images']) if (url.pathname.startsWith('/recovery/' + prefix + '/')) {
      url.pathname = url.pathname.replace('/recovery/', '/'); break;
    }
    if (/^\/recovery\/favicon(?:-[\w]+)?\.svg$/.test(url.pathname)) url.pathname = url.pathname.replace('/recovery/', '/');
    if (url.pathname.startsWith('/js/pdfjs-dist/')) url.pathname = url.pathname.replace('/js/pdfjs-dist/', '/recovery/pdfjs/');
    if (event.request.method !== 'GET' || url.origin !== self.location.origin) return new Response('Unavailable in Local only mode', { status: 503 });
    const output = url.pathname.match(/^\/recovery\/native-output\/([a-f0-9-]{36})\/([a-f0-9]{64})\/(output\.(?:pdf|synctex\.gz|log))$/);
    if (output) {
      const project = await new Promise((resolve, reject) => {
        const request = indexedDB.open('overleaf-local-projects', 1);
        request.onerror = () => reject(Error('Local storage unavailable'));
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('projects')) { db.close(); resolve(null); return; }
          const tx = db.transaction(['projects']), get = tx.objectStore('projects').get(output[1]);
          get.onsuccess = () => resolve(get.result); get.onerror = () => reject(Error('Local project unavailable')); tx.oncomplete = () => db.close();
        };
      });
      if (!project || (project.outputDigest || project.digest) !== output[2]) return new Response('Local output unavailable', { status: 404 });
      return new Response(output[3] === 'output.pdf' ? project.pdf : output[3] === 'output.synctex.gz' ? project.synctex : 'Compiled locally.\n',
        { headers: { 'Content-Type': output[3] === 'output.pdf' ? 'application/pdf' : 'application/octet-stream', 'Cache-Control': 'private, no-store' } });
    }
    if (url.search && !/^\?v=[a-f0-9]{64}$/.test(url.search)) return new Response('Unavailable in Local only mode', { status: 503 });
    const name = manifest.assets.some(a => a.path === url.pathname) ? cacheName : manifest.compilerAssets?.some(a => a.path === url.pathname) ? compilerName : null;
    if (!name) return new Response('Unavailable in Local only mode', { status: 503 });
    return await cached(await caches.open(name), new URL(url.pathname, self.location.origin)) || new Response('Offline asset is missing. Prepare the compiler while connected. Local copies are retained.', { status: 503 });
  })());
});
