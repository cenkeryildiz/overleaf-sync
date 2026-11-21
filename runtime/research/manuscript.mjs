// SPDX-License-Identifier: AGPL-3.0-only
// MATH-CHECK-01 / ANALYSIS-01 manuscript side: read math snippets, `% assume:` declarations, `% analysis` specs and
// inserted result blocks from LaTeX source, build adapter requests and the LaTeX to insert. Pure text logic: it runs
// nothing, edits nothing and never evaluates document text (math goes to mathcheck.py's own parser as a string).
import { DependencyGraph } from './deps.mjs';
import { latexCoefficientTable, latexText, sha256 } from './outputs.mjs';

const MAX_SNIPPETS = 200, MAX_CSV = 5 * 1024 * 1024;
const lines = text => { const out = []; let at = 0; for (const line of text.split('\n')) { out.push({ line, at }); at += line.length + 1; } return out; };

const MATH = [[/\\begin\{(equation\*?|align\*?|gather\*?|multline\*?)\}/y, m => `\\end{${m[1]}}`], [/\\\[/y, () => '\\]'], [/\\\(/y, () => '\\)'], [/\$\$/y, () => '$$'], [/\$/y, () => '$']];
/** Inline and display math with the offsets of their contents: [{text, base, end, open, close}]. */
export function mathSnippets(text) {
  const out = []; let i = 0;
  while (i < text.length && out.length < MAX_SNIPPETS) {
    if (text[i] === '\\' && !/^(?:\[|\(|begin)/.test(text.slice(i + 1, i + 6))) { i += 2; continue; }   // escaped \$, \% and other macros
    if (text[i] === '%') { const eol = text.indexOf('\n', i); i = eol < 0 ? text.length : eol + 1; continue; }   // a comment runs to the end of its line
    let matched = false;
    for (const [open, closeOf] of MATH) {
      open.lastIndex = i; const m = open.exec(text); if (!m) continue;
      const close = closeOf(m), start = i + m[0].length; let end = text.indexOf(close, start);
      while (end > 0 && close === '$' && text[end - 1] === '\\') end = text.indexOf(close, end + 1);
      if (end < 0) { i = text.length; matched = true; break; }
      out.push({ text: text.slice(start, end), base: start, end, open: i, close: end + close.length }); i = end + close.length; matched = true; break;
    }
    if (!matched) i++;
  }
  return out;
}

/** The math snippet containing `pos`, for a check with an empty selection. */
export const snippetAt = (text, pos) => mathSnippets(text).find(s => pos >= s.open && pos <= s.close) ?? null;

/** Strip math delimiters, \label/\nonumber and trailing sentence punctuation from a selection, keeping exact offsets. */
export function trimSelection(text, base) {
  let from = 0, to = text.length;
  const outer = text.replace(/[\s.,;]*$/, '').length, inner = mathSnippets(text).find(s => s.open === text.match(/^\s*/)[0].length && s.close === outer);
  if (inner) { from = inner.base; to = inner.end; }
  let body = text.slice(from, to).replace(/\\(?:label\{[^{}]*\}|nonumber|notag)/g, m => ' '.repeat(m.length));
  const lead = body.match(/^\s*/)[0].length; body = body.slice(lead); from += lead;
  const trail = body.match(/[\s.,;]*$/)[0].length; body = body.slice(0, body.length - trail);
  return { text: body, base: base + from };
}

/** Top-level pieces separated by `,` `;` `\quad` `\qquad` `\text{and}` or `\\`: several constraints in one selection. */
export function splitParts(text, base) {
  const parts = []; let depth = 0, start = 0;
  const sep = /,|;|\\qquad|\\quad|\\text\{\s*and\s*\}|\\\\/y;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '(' || c === '[') depth++; else if (c === '}' || c === ')' || c === ']') depth--;
    else if (depth === 0) { sep.lastIndex = i; const m = sep.exec(text); if (m) { parts.push([start, i]); start = i + m[0].length; i = start - 1; } }
  }
  parts.push([start, text.length]);
  return parts.map(([a, b]) => { const raw = text.slice(a, b), lead = raw.match(/^\s*/)[0].length; return { text: raw.trim(), base: base + a + lead }; }).filter(p => p.text);
}
const INEQUALITY = /<|>|\\le(?:q)?\b|\\ge(?:q)?\b|\\neq?\b/;
/** 'constraints' when the selection states inequalities or several relations; otherwise an equation 'check'. */
export function mathRequest(text, base, context) {
  const parts = splitParts(text, base);
  if (parts.length > 1 || INEQUALITY.test(text)) return { op: 'constraints', texts: parts.map(p => p.text), parts, context };
  return { op: 'check', text: parts[0]?.text ?? '', base: parts[0]?.base ?? base, context };
}

export const ASSUMPTIONS = ['real', 'positive', 'negative', 'nonnegative', 'nonpositive', 'nonzero', 'integer'];
const symbolName = raw => { const m = String(raw).trim().match(/^\\?([A-Za-z]+)(?:_\{?([A-Za-z0-9]+)\}?)?$/); return m ? m[1] + (m[2] ? '_' + m[2] : '') : null; };
/** `% assume: x positive nonzero; \alpha real` lines -> [{symbol, name, assumptions, range}] (document order). */
export function declarations(text) {
  const out = [];
  for (const { line, at } of lines(text)) {
    const m = line.match(/^(\s*%+\s*assume:?\s+)(.*)$/); if (!m) continue;
    let offset = at + m[1].length;
    for (const piece of m[2].split(/[;,]/)) {
      const words = piece.trim().split(/\s+/).filter(Boolean), lead = piece.match(/^\s*/)[0].length;
      if (words.length >= 2) out.push({ symbol: words[0], name: symbolName(words[0]), assumptions: words.slice(1), range: [offset + lead, offset + lead + piece.trim().length] });
      offset += piece.length + 1;
    }
  }
  return out;
}
/** Declared assumptions (first declaration wins, as the notation check reports later ones) overridden by the panel's choices. */
export function contextFor(decls, overrides = {}) {
  const symbols = {};
  for (const d of decls) if (d.name && !(d.name in symbols)) symbols[d.name] = d.assumptions.filter(a => ASSUMPTIONS.includes(a));
  for (const [name, flags] of Object.entries(overrides)) symbols[name] = flags.filter(a => ASSUMPTIONS.includes(a));
  return { symbols };
}

// ---------------------------------------------------------------- analysis specs and result blocks
const OPS = { python: ['ols', 'figure'], r: ['ols', 'panel_fe', 'ttest', 'arima'] };
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
export const safePath = path => typeof path === 'string' && path.length > 0 && path.length <= 512 && !/^([\\/]|[A-Za-z]:|~)/.test(path) && !path.split(/[\\/]/).includes('..') && !/[\u0000-\u001f]/.test(path);
/**
 * `% analysis <id> <python|r> <op> key=value ...` lines. Keys: data, y, x (a,b), robust, cluster, hac_lags, entity, group, mu,
 * conf_level, order (p,d,q), inputs (extra project files or @other-id), caption="...", label. Values are data, never code.
 */
export function analysisSpecs(text, file = '') {
  const specs = [];
  for (const { line, at } of lines(text)) {
    const m = line.match(/^\s*%+\s*analysis\s+(.*)$/); if (!m) continue;
    const words = [...m[1].matchAll(/([A-Za-z_]+)=(?:"([^"]*)"|(\S+))|(\S+)/g)];
    const bare = words.filter(w => w[4]).map(w => w[4]), params = Object.fromEntries(words.filter(w => w[1]).map(w => [w[1], w[2] ?? w[3]]));
    for (const flag of bare.slice(3)) params[flag] = true;
    const [id, lang = '', op = ''] = bare, spec = { id, lang: lang.toLowerCase(), op, params, file, range: [at, at + line.length], line: line.trim() };
    spec.error = !ID.test(id ?? '') ? 'The analysis id must be a letter followed by letters, digits, - or _' : !OPS[spec.lang] ? 'The language must be python or r'
      : !OPS[spec.lang].includes(op) ? `${spec.lang === 'r' ? 'R' : 'Python'} analyses offered here: ${OPS[spec.lang].join(', ')}` : !safePath(params.data) ? 'data= must name a project file' : null;
    spec.inputs = [params.data, ...String(params.inputs ?? '').split(',').filter(Boolean)];
    if (!spec.error && spec.inputs.some(p => !p.startsWith('@') && !safePath(p))) spec.error = 'inputs= must name project files or @analysis ids';
    specs.push(spec);
  }
  return specs;
}

const BEGIN = /^% research-result ([A-Za-z][A-Za-z0-9_-]{0,39}) key=([a-z0-9]+) begin$/, END = /^% research-result ([A-Za-z][A-Za-z0-9_-]{0,39}) end$/;
/** Inserted result blocks: [{id, key, from, to}] where from..to spans the begin line through the end line. */
export function resultBlocks(text) {
  const out = [], open = new Map();
  for (const { line, at } of lines(text)) {
    let m = line.trim().match(BEGIN); if (m) { open.set(m[1], { id: m[1], key: m[2], from: at }); continue; }
    m = line.trim().match(END); if (m && open.has(m[1])) { out.push({ ...open.get(m[1]), to: at + line.length }); open.delete(m[1]); }
  }
  return out;
}
export const resultBlock = (id, key, body, note) => [`% research-result ${id} key=${key} begin`, ...(note ? [`% ${note.replace(/[\r\n]+/g, ' ')}`] : []), body, `% research-result ${id} end`].join('\n');

/** Minimal RFC 4180 CSV -> {columns:{name:[...]}}; numbers become numbers, empty cells null. Bounded. */
export function parseCsv(text) {
  if (typeof text !== 'string' || text.length > MAX_CSV) throw Error('The data file is missing, binary or larger than 5 MB');
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c; continue; }
    if (c === '"' && cell === '') quoted = true; else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows.filter(r => r.length > 1 || r[0] !== '');
  if (!header || new Set(header).size !== header.length) throw Error('The data file needs one header row with distinct column names');
  if (body.some(r => r.length !== header.length)) throw Error('Every data row must have as many cells as the header');
  const numeric = header.map((_, j) => body.every(r => r[j].trim() === '' || Number.isFinite(Number(r[j]))));
  return { columns: Object.fromEntries(header.map((name, j) => [name, body.map(r => r[j].trim() === '' ? null : numeric[j] ? Number(r[j]) : r[j])])), rows: body.length };
}

const list = v => String(v ?? '').split(',').map(s => s.trim()).filter(Boolean);
/** Adapter request from a spec and its parsed data (column names travel as data; the adapters never parse them as code). */
export function buildRequest(spec, data) {
  const p = spec.params, request = { op: spec.op, data: data.columns };
  if (['ols', 'panel_fe', 'figure'].includes(spec.op)) { request.y = String(p.y ?? ''); request.x = list(p.x); }
  if (spec.op === 'ols' && spec.lang === 'python') request.robust = p.robust === true || p.robust === '1';
  if (p.cluster && spec.lang === 'r') request.cluster = String(p.cluster);
  if (p.hac_lags !== undefined && spec.lang === 'r') request.hac_lags = Number(p.hac_lags);
  if (spec.op === 'panel_fe') request.id = String(p.entity ?? '');
  if (spec.op === 'ttest') { request.x = String(p.x ?? ''); if (p.group) request.group = String(p.group); if (p.mu !== undefined) request.mu = Number(p.mu); if (p.conf_level !== undefined) request.conf_level = Number(p.conf_level); }
  if (spec.op === 'arima') { request.x = String(p.x ?? ''); request.order = list(p.order).map(Number); }
  return request;
}

const fmt = (v, digits = 4) => v === null || v === undefined || !Number.isFinite(Number(v)) ? '--' : String(Number(Number(v).toPrecision(digits)));
/** LaTeX for a computed result: a coefficient table, an inline scalar sentence for t-tests, or a figure (PNG saved at `figurePath`). */
export function renderLatex(spec, result, figurePath) {
  if (result?.status !== 'computed') throw Error('Only a computed result can be inserted');
  const label = /^[A-Za-z0-9:_-]{1,60}$/.test(spec.params.label ?? '') ? spec.params.label : '', caption = spec.params.caption ?? '';
  if (spec.op === 'figure') {
    if (!safePath(figurePath)) throw Error('Invalid figure path');
    return ['\\begin{figure}[htbp]', '\\centering', `\\includegraphics[width=\\linewidth]{${figurePath}}`, ...(caption ? [`\\caption{${latexText(caption)}}`] : []), ...(label ? [`\\label{${label}}`] : []), '\\end{figure}'].join('\n');
  }
  if (spec.op === 'ttest') {
    const level = `${fmt(100 * (result.conf_level ?? 0.95), 3)}\\%`, two = Array.isArray(result.groups);
    const what = two ? `$\\bar{x}_{\\mathrm{${latexText(result.groups[0])}}} - \\bar{x}_{\\mathrm{${latexText(result.groups[1])}}} = ${fmt(result.difference)}$` : `$\\bar{x} = ${fmt(result.estimate)}$`;
    return `${what} (${level} CI $[${fmt(result.ci_low)}, ${fmt(result.ci_high)}]$; $t_{${fmt(result.df, 4)}} = ${fmt(result.t)}$, $p = ${fmt(result.p, 3)}$${two ? '' : `, $H_0\\colon \\mu = ${fmt(result.mu)}$`})`;
  }
  const table = spec.op === 'arima' ? { ...result, p: result.terms.map(() => null), r_squared: null } : result;   // ARIMA reports no per-term p
  return latexCoefficientTable(table, { caption, label });
}

/** Text-file digest used for staleness; binary files arrive as their project hash. */
const digestOf = file => file === undefined ? null : typeof file.content === 'string' ? sha256(file.content) : Promise.resolve('blob:' + String(file.hash ?? ''));
/**
 * Project state from a snapshot {path: {content}|{hash}}: every spec's status without running anything.
 * fresh (block key matches the current inputs), stale, new (never inserted), refused (cycle, missing input, invalid spec or duplicate id).
 */
export async function projectState(files) {
  const specs = [], blocks = new Map();
  for (const [path, file] of Object.entries(files)) if (/\.tex$/i.test(path) && typeof file.content === 'string') {
    specs.push(...analysisSpecs(file.content, path));
    for (const block of resultBlocks(file.content)) blocks.set(block.id, { ...block, file: path });
  }
  const graph = new DependencyGraph(), seen = new Map(), states = new Map();
  for (const spec of specs) { if (seen.has(spec.id)) spec.error = `Duplicate analysis id ${spec.id} (also in ${seen.get(spec.id).file})`; else seen.set(spec.id, spec); }
  const paths = new Set(specs.flatMap(s => s.error ? [] : s.inputs.filter(i => !i.startsWith('@'))));
  for (const path of paths) if (files[path]) graph.set('file:' + path, { digest: await digestOf(files[path]) });
  for (const spec of specs) if (!spec.error) graph.set('result:' + spec.id, { digest: spec.line, inputs: spec.inputs.map(i => i.startsWith('@') ? 'result:' + i.slice(1) : 'file:' + i) });
  const cycles = new Map(); let cycle;
  while ((cycle = graph.cycle())) for (const node of cycle) { cycles.set(node, cycle); graph.remove(node); }   // refuse each cycle; the rest still gets a status
  const missing = graph.missing();
  for (const spec of specs) {
    const node = 'result:' + spec.id, block = blocks.get(spec.id);
    let state;
    if (spec.error) state = { status: 'refused', reason: spec.error };
    else if (cycles.has(node)) state = { status: 'refused', reason: 'Dependency cycle: ' + cycles.get(node).map(n => n.replace(/^\w+:/, '')).join(' → ') };
    else if (missing.some(m => m.id === node)) state = { status: 'refused', reason: 'Missing input ' + missing.filter(m => m.id === node).map(m => m.input.replace(/^\w+:/, '')).join(', ') };
    else { const key = graph.key(node); state = { key, status: !block ? 'new' : block.key === key ? 'fresh' : 'stale', reason: !block ? 'Not inserted yet' : block.key === key ? 'Up to date with its declared inputs' : 'Inputs changed since this result was inserted' }; }
    states.set(states.has(spec.id) ? `${spec.id} (duplicate at ${spec.file}:${spec.range[0]})` : spec.id, { spec, block, ...state });   // a duplicate stays visible as refused
  }
  return { states, graph, order: cycles.size || missing.length ? null : graph.plan().order.filter(n => n.startsWith('result:')).map(n => n.slice(7)) };
}
