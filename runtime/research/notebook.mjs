// SPDX-License-Identifier: AGPL-3.0-only
// DOCEXEC-01: Jupyter notebook (.ipynb, nbformat 4) <-> percent-format script (`# %%` cells, the format Jupyter, VS Code and
// Spyder share). Pure text conversion: nothing is executed, and notebook outputs are never carried into the script
// (they are untrusted rich content); the count of dropped outputs is reported instead. Exports have no outputs.
export const LIMITS = { bytes: 5 * 1024 * 1024, cells: 2000 };
const MARKER = /^[ \t]*#[ \t]*%%(.*)$/;
const KERNEL = { python: { name: 'python3', display_name: 'Python 3', language: 'python' }, r: { name: 'ir', display_name: 'R', language: 'R' } };
const lines = text => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Script text -> notebook JSON text. `# %% [markdown]` cells become markdown with one leading `# ` removed per line. */
export function toNotebook(text, language) {
  const kernelspec = KERNEL[language]; if (!kernelspec) throw Error('Notebooks can be made from .py or .R files only');
  if (text.length > LIMITS.bytes) throw Error('This file is too large to export');
  const cells = [], all = lines(text); let current = null;
  const start = rest => { current = { kind: /^\s*\[markdown\]/i.test(rest) ? 'markdown' : /^\s*\[raw\]/i.test(rest) ? 'raw' : 'code', title: rest.replace(/^\s*\[(markdown|raw)\]/i, '').trim(), body: [] }; cells.push(current); };
  for (const line of all) { const m = line.replace(/\n$/, '').match(MARKER); if (m) start(m[1]); else { if (!current) start(''); current.body.push(line); } }
  if (cells.length > LIMITS.cells) throw Error('This file has too many cells to export');
  const notebook = { cells: cells.map(cell => {
    const body = cell.body.join('').replace(/\n$/, ''), source = lines(cell.kind === 'code' ? body : body.split('\n').map(l => l.replace(/^# ?/, '')).join('\n'));
    const metadata = cell.title ? { title: cell.title } : {};
    return cell.kind === 'code' ? { cell_type: 'code', execution_count: null, metadata, outputs: [], source } : { cell_type: cell.kind, metadata, source };
  }), metadata: { kernelspec, language_info: { name: kernelspec.language } }, nbformat: 4, nbformat_minor: 5 };
  return JSON.stringify(notebook, null, 1) + '\n';
}

/** Notebook JSON text -> {language: 'python'|'r', text, dropped: number of outputs not carried over}. Refuses anything else. */
export function fromNotebook(json) {
  if (typeof json !== 'string' || json.length > LIMITS.bytes) throw Error('This notebook is too large to convert');
  let nb; try { nb = JSON.parse(json); } catch { throw Error('This is not a valid notebook (the JSON does not parse)'); }
  if (!nb || typeof nb !== 'object' || nb.nbformat !== 4 || !Array.isArray(nb.cells)) throw Error('Only nbformat 4 notebooks can be converted');
  if (nb.cells.length > LIMITS.cells) throw Error('This notebook has too many cells to convert');
  const lang = String(nb.metadata?.kernelspec?.language ?? nb.metadata?.language_info?.name ?? '').toLowerCase();
  const language = lang === 'python' ? 'python' : lang === 'r' ? 'r' : null; if (!language) throw Error(`Notebooks in ${lang || 'an unknown language'} cannot be converted; only Python and R`);
  const text = s => Array.isArray(s) ? s.filter(x => typeof x === 'string').join('') : typeof s === 'string' ? s : '';
  let dropped = 0; const out = [];
  for (const cell of nb.cells) {
    if (!cell || typeof cell !== 'object') continue;
    const title = typeof cell.metadata?.title === 'string' ? ' ' + cell.metadata.title.replace(/[\r\n]+/g, ' ').trim() : '', body = text(cell.source).replace(/\n$/, '');
    if (cell.cell_type === 'code') { dropped += Array.isArray(cell.outputs) ? cell.outputs.length : 0; out.push(`# %%${title}\n${body}`); }
    else if (cell.cell_type === 'markdown' || cell.cell_type === 'raw') out.push(`# %% [${cell.cell_type}]${title}\n${body.split('\n').map(l => l ? '# ' + l : '#').join('\n')}`);
  }
  return { language, text: out.map(c => c + '\n').join(''), dropped };
}
/** Sibling path for the converted file: same folder and base name, new extension. */
export const convertedPath = (path, to) => path.replace(/\.(py|r|ipynb)$/i, '') + (to === 'notebook' ? '.ipynb' : to === 'r' ? '.R' : '.py');
