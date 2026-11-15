// SPDX-License-Identifier: AGPL-3.0-only
// The generator inserts a digest-pinned list of public static files only.
const manifest = __RECOVERY_MANIFEST__;
const cacheName = 'overleaf-local-' + manifest.version;
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(cacheName);
  try {
    for (const asset of manifest.assets) {
      const url = new URL(asset.path, self.location.origin);
      if (url.origin !== self.location.origin || url.search || (!url.pathname.startsWith('/recovery/') && !manifest.nativePaths.includes(url.pathname))) throw Error('Unexpected cache asset');
      const response = await fetch(url, { credentials: 'omit', cache: 'reload', redirect: 'error' });
      if (!response.ok || response.type === 'opaque') throw Error('Public asset unavailable');
      const bytes = await response.arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
      if (hash !== asset.sha256) throw Error('Public asset integrity mismatch');
      await cache.put(url, new Response(bytes, { status: 200, headers: { 'Content-Type': asset.type, 'Cache-Control': 'no-store' } }));
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
});
self.addEventListener('fetch', event => {
  // Controlled local-workspace clients never fall through to network, even for unknown URLs.
  event.respondWith((async () => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.search || !manifest.assets.some(a => a.path === url.pathname)) return new Response('Unavailable in Local only mode', { status: 503 });
    return await (await caches.open(cacheName)).match(url) || new Response('Offline asset is missing. Local copies are retained.', { status: 503 });
  })());
});
