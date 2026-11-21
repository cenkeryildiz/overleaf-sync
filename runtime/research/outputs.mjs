// SPDX-License-Identifier: AGPL-3.0-only
// DOCEXEC-01 / ANALYSIS-01 output pipeline. Everything a kernel or analysis script returns is untrusted data:
// it becomes a bounded inert render model (text, PNG, plain table) or is blocked. Nothing here executes or inserts anything.
export const LIMITS = Object.freeze({ text: 64 * 1024, png: 2 * 1024 * 1024, pixels: 4096, rows: 200, columns: 20, cell: 200 });
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g; // C0/C1 controls and bidi overrides
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const clean = (value, max) => { const text = String(value ?? '').replace(CONTROL, '\ufffd'); return text.length > max ? text.slice(0, max) : text; };

/** One mime-keyed output -> {kind:'text'|'image'|'table'|'blocked', ...}. The UI sets textContent / an <img> blob; never innerHTML. */
export function renderOutput(mime, data) {
  if (mime === 'text/plain') { const text = clean(data, LIMITS.text); return { kind: 'text', text, truncated: String(data ?? '').length > LIMITS.text }; }
  if (mime === 'image/png') {
    const b64 = typeof data === 'string' ? data.replace(/\s/g, '') : '';
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length > LIMITS.png * 4 / 3 + 4) return blocked(mime, 'Invalid or oversized PNG');
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    if (bytes.length > LIMITS.png || bytes.length < 33 || PNG.some((v, i) => bytes[i] !== v)) return blocked(mime, 'Not a PNG image');
    const view = new DataView(bytes.buffer), width = view.getUint32(16), height = view.getUint32(20);
    if (String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR' || !width || !height || width > LIMITS.pixels || height > LIMITS.pixels) return blocked(mime, 'PNG header invalid or image too large');
    return { kind: 'image', mime, base64: b64, width, height };
  }
  if (mime === 'application/x.table+json') {
    const table = typeof data === 'string' ? (() => { try { return JSON.parse(data); } catch { return null; } })() : data;
    if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) return blocked(mime, 'Malformed table');
    const columns = table.columns.slice(0, LIMITS.columns).map(c => clean(c, LIMITS.cell));
    const rows = table.rows.slice(0, LIMITS.rows).map(row => (Array.isArray(row) ? row : []).slice(0, columns.length).map(cell => clean(cell, LIMITS.cell)));
    return { kind: 'table', columns, rows, truncated: table.rows.length > rows.length || table.columns.length > columns.length };
  }
  return blocked(mime, 'This output type is not displayed (HTML, SVG, script and rich widgets are never rendered)');
}
const blocked = (mime, reason) => ({ kind: 'blocked', mime: clean(mime, 80), reason });

const ESCAPES = { '\\': '\\textbackslash{}', '&': '\\&', '%': '\\%', '$': '\\$', '#': '\\#', '_': '\\_', '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' };
export const latexText = value => clean(value, LIMITS.cell).replace(/[\\&%$#_{}~^]/g, c => ESCAPES[c]).replace(/[\r\n]+/g, ' ');
const number = (value, digits = 4) => (value === null || value === undefined || !Number.isFinite(Number(value))) ? '--' : String(Number(Number(value).toPrecision(digits)));

/** Staged coefficient table from the shared analysis result schema; the caller shows it and inserts only on explicit user action. */
export function latexCoefficientTable(result, { caption = '', label = '' } = {}) {
  const need = ['terms', 'estimate', 'std_error', 'p'];
  if (!result || result.status !== 'computed' || need.some(k => !Array.isArray(result[k]) || result[k].length !== result.terms?.length)) throw Error('Not a computed coefficient result');
  if (label && !/^[A-Za-z0-9:_-]{1,60}$/.test(label)) throw Error('Invalid label');
  const rows = result.terms.map((t, i) => `${latexText(t)} & ${number(result.estimate[i])} & ${number(result.std_error[i])} & ${number(result.p[i], 3)} \\\\`);
  return ['\\begin{table}[htbp]', '\\centering', ...(caption ? [`\\caption{${latexText(caption)}}`] : []), ...(label ? [`\\label{${label}}`] : []),
    '\\begin{tabular}{lrrr}', '\\hline', 'Term & Estimate & Std. error & $p$ \\\\', '\\hline', ...rows, '\\hline',
    `\\multicolumn{4}{l}{\\small $n=${Number(result.nobs) | 0}$, $R^2=${number(result.r_squared)}$; ${latexText(result.method)}} \\\\`, '\\end{tabular}', '\\end{table}'].join('\n');
}

const hex = buffer => [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
export const sha256 = async data => hex(await globalThis.crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data));
const safeRelative = path => typeof path === 'string' && path.length > 0 && path.length <= 512 && !/^([\\/]|[A-Za-z]:|~)/.test(path) && !path.split(/[\\/]/).includes('..') && !/[\u0000-\u001f]/.test(path);

/** Project-level provenance: digests, order, versions, seed. Absolute/private paths and environment dumps are refused. */
export async function provenance({ cell, language, runtime, packages = {}, order, seed = null, code, inputs = {}, output }) {
  if (!safeRelative(cell) || Object.keys(inputs).some(p => !safeRelative(p))) throw Error('Provenance accepts project-relative paths only');
  const names = Object.keys(packages); if (names.length > 50) throw Error('Too many packages');
  return {
    cell, language: clean(language, 20), runtime: clean(runtime, 80), packages: Object.fromEntries(names.map(n => [clean(n, 60), clean(packages[n], 40)])),
    order: Number.isInteger(order) ? order : null, seed: seed === null ? null : Number(seed),
    code: await sha256(code), inputs: Object.fromEntries(await Promise.all(Object.entries(inputs).map(async ([p, d]) => [p, await sha256(d)]))),
    output: await sha256(typeof output === 'string' ? output : JSON.stringify(output)),
  };
}
