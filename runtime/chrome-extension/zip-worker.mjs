// SPDX-License-Identifier: AGPL-3.0-only
import { ZipReader } from './zipjs/zip-core-reader.js';
import { BlobReader } from './zipjs/core/io.js';
const safe = path => typeof path === 'string' && path.length > 0 && path.length <= 1024 &&
  !/[\\\x00-\x1f\x7f:]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..');
function resource(path, bytes) {
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!content.includes('\0') && content.isWellFormed() && content.length <= 2000000) return { path, content };
  } catch { /* Preserve binary files byte for byte. */ }
  let data = '';
  for (let n = 0; n < bytes.length; n += 8192) data += String.fromCharCode(...bytes.subarray(n, n + 8192));
  return { path, data: btoa(data) };
}
self.onmessage = async ({ data: files }) => {
  try {
    const resources = [], folders = [], names = new Set(); let total = 0;
    const name = path => {
      const directory = path.endsWith('/'), normalized = directory ? path.slice(0, -1) : path;
      if (!safe(normalized) || names.has(normalized) || names.size >= 1000) throw Error('Invalid, duplicate or excessive project paths');
      names.add(normalized); return { path: normalized, directory };
    };
    if (!files.length || files.length > 1000 || files.reduce((sum, file) => sum + file.size, 0) > 64 * 1024 * 1024) throw Error('Import supports at most 1000 entries and 64 MB');
    if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
      const reader = new ZipReader(new BlobReader(files[0]), { useWebWorkers: false, useCompressionStream: true, checkSignature: true, strictness: 'strict' });
      try {
        for await (const file of reader.getEntriesGenerator()) {
          const entry = name(file.filename);
          if (file.encrypted || !Number.isSafeInteger(file.uncompressedSize) || file.uncompressedSize > 64 * 1024 * 1024 - total) throw Error('Encrypted or oversized ZIP entry');
          if (entry.directory) { if (file.uncompressedSize) throw Error('Invalid directory entry'); folders.push(entry.path); continue; }
          const chunks = []; let size = 0;
          await file.getData(new WritableStream({ write(chunk) {
            total += chunk.length; size += chunk.length;
            if (total > 64 * 1024 * 1024) throw Error('Unpacked project exceeds 64 MB');
            chunks.push(chunk);
          } }), { checkSignature: true, useWebWorkers: false, useCompressionStream: true });
          const bytes = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          resources.push(resource(entry.path, bytes));
        }
        if (!names.size) throw Error('Empty ZIP archive');
      } finally { await reader.close(); }
    } else {
      for (const file of files) {
        const entry = name(file.webkitRelativePath || file.name);
        resources.push(resource(entry.path, new Uint8Array(await file.arrayBuffer())));
      }
    }
    self.postMessage({ resources, folders });
  } catch (error) { self.postMessage({ error: error.message }); }
};
