// SPDX-License-Identifier: AGPL-3.0-only
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('extension/index.html') }));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const match = url.pathname.match(/^\/recovery\/native-output\/([a-f0-9-]{36})\/([a-f0-9]{64})\/(output\.(?:pdf|synctex\.gz|log))$/);
  if (!match || url.origin !== location.origin || event.request.method !== 'GET') return;
  event.respondWith((async () => {
    const project = await new Promise((resolve, reject) => {
      const request = indexedDB.open('overleaf-local-projects', 1);
      request.onerror = () => reject(Error('Local storage unavailable'));
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('projects')) { db.close(); resolve(null); return; }
        const tx = db.transaction(['projects']), get = tx.objectStore('projects').get(match[1]);
        get.onsuccess = () => resolve(get.result); get.onerror = () => reject(Error('Local output unavailable')); tx.oncomplete = () => db.close();
      };
    });
    if (!project || (project.pdfImported ? project.pdfDigest : project.outputDigest || project.digest) !== match[2]) return new Response('Local output unavailable', { status: 404 });
    const pdf = match[3] === 'output.pdf';
    const bytes = pdf ? project.pdf : match[3] === 'output.synctex.gz' ? new Blob([project.synctex]) : new Blob(['Compiled locally.\n']);
    if (!bytes) return new Response('Local output unavailable', { status: 404 });
    const headers = { 'Content-Type': pdf ? 'application/pdf' : 'application/octet-stream', 'Content-Length': String(bytes.size), 'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes' };
    const range = event.request.headers.get('Range')?.match(/^bytes=(\d+)-(\d*)$/);
    if (range) {
      const start = Number(range[1]), end = Math.min(bytes.size - 1, range[2] ? Number(range[2]) : bytes.size - 1);
      if (start > end || end >= bytes.size) return new Response(null, { status: 416 });
      return new Response(bytes.slice(start, end + 1), { status: 206, headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${bytes.size}` } });
    }
    return new Response(bytes, { headers });
  })());
});
