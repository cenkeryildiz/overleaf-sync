// SPDX-License-Identifier: AGPL-3.0-only
import { downloadZip } from './client-zip.mjs';
export async function projectZip(files) {
  if (!Array.isArray(files) || files.length > 1000) throw Error('Invalid project export');
  const paths = new Set(); let size = 0;
  function* inputs() {
    for (const file of files) {
      if (typeof file.path !== 'string' || !file.path || file.path.length > 1024 || /[\\\x00-\x1f\x7f:]/.test(file.path) ||
          !file.path.split('/').every(part => part && part !== '.' && part !== '..') || paths.has(file.path) ||
          (typeof file.content === 'string') === (typeof file.data === 'string')) throw Error('Invalid project file');
      paths.add(file.path);
      const bytes = typeof file.content === 'string' ? new TextEncoder().encode(file.content) : Uint8Array.from(atob(file.data), c => c.charCodeAt(0));
      size += bytes.length;
      // Allow bounded unsaved recovery text beyond the saved workspace's64MiB limit.
      if (size > 80 * 1024 * 1024) throw Error('Export exceeds local limits. Export unsaved files separately.');
      yield { name: file.path, input: bytes };
    }
  }
  return downloadZip(inputs()).blob();
}
