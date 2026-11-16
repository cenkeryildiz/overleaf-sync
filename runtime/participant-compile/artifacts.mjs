// SPDX-License-Identifier: AGPL-3.0-only
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export function safePath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 1024 &&
    !/[\\\x00-\x1f\x7f:]/.test(path) && path.split('/').every(p => p && p !== '.' && p !== '..');
}
export function prepareSnapshot(snapshot) {
  if (!safePath(snapshot.main) || !safePath(snapshot.active)) throw Error('Invalid project path');
  const paths = new Set();
  for (const resource of snapshot.resources) {
    if (!safePath(resource.path) || paths.has(resource.path)) throw Error('Invalid project path');
    paths.add(resource.path);
    if (resource.path === snapshot.active) { resource.content = snapshot.text; delete resource.data; }
  }
  if (!paths.has(snapshot.main) || !paths.has(snapshot.active)) throw Error('Missing project source');
  const compiler = snapshot.compiler || 'pdflatex';
  if (!['pdflatex', 'xelatex', 'lualatex'].includes(compiler)) throw Error('Unsupported project compiler');
  const source = { main: snapshot.main, compiler, resources: snapshot.resources };
  return { ...source, digest: createHash('sha256').update(JSON.stringify(source)).digest('hex') };
}
export function prepareResult(bytes, pdfLength, source, base) {
  if (!Number.isSafeInteger(pdfLength) || pdfLength < 20 || pdfLength > 16 * 1024 * 1024 ||
      bytes.length <= pdfLength || bytes.length - pdfLength > 8 * 1024 * 1024 ||
      bytes.subarray(0, 5).toString() !== '%PDF-') throw Error('Invalid PDF result');
  const text = gunzipSync(bytes.subarray(pdfLength), { maxOutputLength: 32 * 1024 * 1024 }).toString('utf8');
  if (!text.startsWith('SyncTeX Version:1\n') || !text.includes('\nContent:\n')) throw Error('Invalid navigation result');
  const paths = new Set(source.resources.map(r => r.path));
  const root = source.main.includes('/') ? source.main.slice(0, source.main.lastIndexOf('/') + 1) : '';
  let matches = 0;
  const normalized = text.replace(/^Input:(\d+):([^\r\n]+)$/gm, (_, id, input) => {
    let path = input.replace(/^\/home\/web_user\/project_dir\//, '');
    if (path.startsWith('./')) path = path.slice(2);
    if (!paths.has(path) && paths.has(root + path)) path = root + path;
    if (paths.has(path)) { matches++; return `Input:${id}:${base}/${path}`; }
    // Package inputs never become a request for a host file or a source document.
    return `Input:${id}:${base}/.participant-packages/${id}`;
  });
  if (!matches) throw Error('Navigation does not match the project');
  return { pdf: bytes.subarray(0, pdfLength), synctex: gzipSync(normalized) };
}
