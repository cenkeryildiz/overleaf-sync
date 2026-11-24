// SPDX-License-Identifier: AGPL-3.0-only
// TEX-PKG-02: bounded ustar/GNU/pax reader for TeX Live package archives. Regular files only; links, devices, absolute
// paths, `..`, backslashes and NULs are refused, as are archives over the file/byte limits.
const text = (bytes, from, length) => new TextDecoder().decode(bytes.subarray(from, from + length)).replace(/\0.*$/s, '');
const octal = (bytes, from, length) => { const s = text(bytes, from, length).trim(); if (!/^[0-7]*$/.test(s)) throw Error('Corrupt archive header'); return s ? parseInt(s, 8) : 0; };

export function readTar(bytes, { maxFiles = 5000, maxBytes = 256 * 1024 * 1024 } = {}) {
  const files = []; let at = 0, total = 0, longName = null, paxPath = null;
  while (at + 512 <= bytes.length) {
    const header = bytes.subarray(at, at + 512);
    if (header.every(b => b === 0)) break;
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (sum !== octal(header, 148, 8)) throw Error('Corrupt archive header');
    const size = octal(header, 124, 12), type = String.fromCharCode(header[156] || 48), start = at + 512;
    if (start + size > bytes.length) throw Error('Truncated archive');
    const body = bytes.subarray(start, start + size); at = start + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = text(body, 0, size); continue; }
    if (type === 'x') { const m = new TextDecoder().decode(body).match(/(?:^|\n)\d+ path=([^\n]*)\n/); paxPath = m ? m[1] : null; continue; }
    if (type === 'g') continue;
    const prefix = text(header, 345, 155), name = paxPath ?? longName ?? (prefix ? prefix + '/' : '') + text(header, 0, 100); longName = paxPath = null;
    if (type === '5') continue;
    if (type !== '0' && type !== '7') throw Error(`Archive entry ${name.slice(0, 80)} is not a regular file`);
    if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0') || name.split('/').some(part => part === '..')) throw Error('Archive path is not allowed: ' + name.slice(0, 80));
    if (files.length >= maxFiles || (total += size) > maxBytes) throw Error('Archive exceeds the size limit');
    files.push({ path: name.replace(/^\.\//, ''), data: body.slice() });
  }
  return files;
}
