// SPDX-License-Identifier: AGPL-3.0-only
// MATH-CHECK-01 and ANALYSIS-01 in the native editor. Triggers: right-click in the editor, Ctrl+Alt+M (check equation) and
// Ctrl+Alt+R (run the `% analysis` line at the cursor). Results render into the one results panel under the editor, owned by
// cells-ui.mjs (sharedPanel), whose Insert / Stop / Rerun act on the current check or analysis. A check never changes the source; an analysis result enters the manuscript only through Insert.
// Execution goes through the `run` transport supplied at registration (the native research host): nothing runs on open.
import { mathSnippets, snippetAt, trimSelection, mathRequest, declarations, contextFor, ASSUMPTIONS, analysisSpecs, resultBlocks, resultBlock, parseCsv, buildRequest, renderLatex, projectState } from './research/manuscript.mjs';
import { renderOutput, provenance } from './research/outputs.mjs';
import { coalescer } from './research/deps.mjs';
import { sharedPanel, ownsPanel, ensureStyle } from './cells-ui.mjs';

const LABEL = { issue_found: 'Issue found', no_issue_found: 'No issue found in the supported check', inconclusive: 'Inconclusive', unsupported: 'Unsupported notation',
  computed: 'Computed', unavailable: 'Unavailable', error: 'Could not run', canceled: 'Stopped', fresh: 'Up to date', stale: 'Stale', new: 'Not inserted', refused: 'Refused' };
const COMPUTE = { diff: 'Derivative', integrate: 'Integral', limit: 'Limit', solve: 'Solve', optimize: 'Optimize' };
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) if (k.includes('-')) node.setAttribute(k, v); else node[k] = v;
  node.append(...children.filter(c => c !== null && c !== undefined && c !== false)); return node; };
const view = () => document.querySelector('.cm-content')?.cmView?.view;
const badge = status => { const node = el('span', { textContent: LABEL[status] ?? status }); node.dataset.state = status; return node; };
const projectId = () => document.querySelector('meta[name="ol-project_id"]')?.content;
async function snapshot() {
  const response = await fetch(`/project/${projectId()}/latest/history`);
  if (!response.ok) throw Error('The project files could not be read');
  return (await response.json()).chunk.history.snapshot.files;
}

/** Readiness row for the "This computer" drawer: asks the selected Python for SymPy, nothing else. */
export async function renderReadiness(container, run) {
  const row = el('div', { className: 'research-readiness', textContent: 'Math check: checking the selected Python…' }); row.dataset.feature = 'math'; container.append(row);
  try {
    const out = await run({ tool: 'math', request: { op: 'version' } }, { signal: new AbortController().signal });
    row.dataset.ready = String(out?.status === 'ready');
    row.textContent = out?.status === 'ready' ? `Math check: ready (SymPy ${out.sympy} in the selected Python)` : `Math check: unavailable — ${out?.reason ?? 'no answer from the selected Python'}`;
  } catch (error) { row.dataset.ready = 'false'; row.textContent = `Math check: unavailable — ${error.message}`; }
  return row;
}

export function registerResearch({ run, trusted = () => false, readiness = null }) {
  if (typeof run !== 'function' || globalThis.overleafResearchRegistered) return;
  globalThis.overleafResearchRegistered = true;
  ensureStyle();
  if (readiness) renderReadiness(readiness, run);
  let current = null, controller = null, staged = new Map(), states = new Map(), previousKeys = null, list = null;

  // ---- panel
  const parts = {};
  const owner = { insert: () => insert(), stop: () => stop(), rerun: () => rerun() };
  function panel() {
    const p = sharedPanel(owner);
    Object.assign(parts, { title: p.title, state: p.state, insert: p.buttons.insert, stop: p.buttons.stop, rerun: p.buttons.rerun, body: p.body }); list = p.list;
    return p.root;
  }
  const setState = (status, text = LABEL[status] ?? status) => { panel(); parts.state.dataset.state = status; parts.state.textContent = text; };
  const buttons = () => {
    if (!ownsPanel(owner)) return;   // Run cell holds the panel now; its own state stays
    parts.stop.disabled = !controller; parts.rerun.disabled = !!controller || !current;
    const stage = current?.kind === 'analysis' ? staged.get(current.id) : null;
    parts.insert.disabled = !!controller || !stage?.latex || !!stage.blocked;
    parts.insert.title = current?.kind === 'math' ? 'A math check never changes your source' : stage?.blocked ?? '';
  };

  async function execute(tool, request) {
    controller?.abort(); const mine = controller = new AbortController(); setState('running', 'Running…'); buttons();
    const aborted = new Promise(resolve => mine.signal.addEventListener('abort', () => resolve({ status: 'canceled' }), { once: true }));
    try { return await Promise.race([run({ tool, request }, { signal: mine.signal }), aborted]); }
    catch (error) { return { status: 'error', reason: error.message }; }
    finally { if (controller === mine) controller = null; buttons(); }
  }
  function stop() { controller?.abort(); }
  const where = (from, to) => { const doc = view()?.state.doc; if (!doc || to > doc.length) return `characters ${from}–${to}`; const a = doc.lineAt(from), b = doc.lineAt(to); return `line ${a.number}:${from - a.from + 1}` + (b.number === a.number ? `–${to - b.from + 1}` : ` to ${b.number}:${to - b.from + 1}`); };
  const rangeButton = ([from, to], text) => el('button', { type: 'button', className: 'rr-range', textContent: where(from, to), title: 'Select this range in the editor',
    onclick: () => { const v = view(); if (v && to <= v.state.doc.length && (text === undefined || v.state.doc.sliceString(from, to) === text)) { v.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true }); v.focus(); } } });

  // ---- math check
  function startMath(from, to) {
    const v = view(); if (!v) return;
    const doc = v.state.doc.toString(); let sel = { text: doc.slice(from, to), base: from };
    if (from === to) { const s = snippetAt(doc, from); if (!s) { show('Equation check', 'unsupported', el('p', { textContent: 'Select an equation, or place the cursor inside math, then check it.' })); return; } sel = { text: s.text, base: s.base }; }
    const { text, base } = trimSelection(sel.text, sel.base);
    current = { kind: 'math', text, base, overrides: current?.kind === 'math' ? current.overrides : {}, compute: current?.compute ?? { name: 'diff' } };
    return runMath();
  }
  async function runMath(computeRequest = null) {
    const doc = view()?.state.doc.toString() ?? '', decls = declarations(doc), context = contextFor(decls, current.overrides);
    const request = mathRequest(current.text, current.base, context);
    const notation = { op: 'notation', declarations: decls.filter(d => d.name).map(({ symbol, assumptions, range }) => ({ symbol, assumptions, range })), snippets: mathSnippets(doc).map(({ text, base }) => ({ text, base })) };
    const started = performance.now();
    const out = await execute('math', { op: 'batch', requests: [request, notation, ...(computeRequest ? [computeRequest] : [])] });
    current.elapsed = Math.round(performance.now() - started);
    if (out.status !== 'batch') { show('Equation check', out.status, el('p', { textContent: out.status === 'canceled' ? 'Stopped. Nothing was changed.' : out.reason ?? 'No answer' })); return out; }
    current.result = out.results[0]; current.notation = out.results[1]; current.computed = out.results[2] ?? current.computed; current.request = request; current.decls = decls;
    renderMath(); return out;
  }
  function renderMath() {
    const { result: r, request } = current, body = [];
    body.push(el('p', {}, 'Selection ', rangeButton([current.base, current.base + current.text.length], current.text), ': ', el('code', { textContent: current.text })));
    if (r.status === 'unsupported') body.push(el('p', { textContent: r.reason }), r.range ? el('p', {}, 'At ', rangeButton(r.range)) : null);
    else if (request.op === 'constraints') {
      body.push(el('p', { textContent: r.reason + '. Variables are treated as real in constraint checks.' }));
      body.push(el('ul', {}, ...request.parts.map((p, i) => el('li', {}, el('code', { textContent: p.text }), ' ', rangeButton([p.base, p.base + p.text.length], p.text), (r.which ?? []).includes(i) ? el('strong', { textContent: ' — part of the contradiction' }) : null))));
    } else {
      body.push(el('p', { textContent: r.reason }));
      body.push(el('p', {}, 'Read as:'), el('ul', {}, ...(r.steps ?? []).map(step => el('li', {}, el('code', { textContent: `${step.left} = ${step.right}` }), ` — ${LABEL[step.status]}`,
        step.counterexample ? el('div', { textContent: `Counterexample at ${Object.entries(step.counterexample.at).map(([k, v]) => `${k} = ${v}`).join(', ')}: left ${step.counterexample.left}, right ${step.counterexample.right}` }) : null,
        step.kind === 'domain' ? el('div', { textContent: step.reason }) : null))));
    }
    const symbols = Object.keys(r.assumptions ?? {});
    if (symbols.length) {
      body.push(el('p', { textContent: 'Assumptions (from % assume: lines, changed here for this session only; add a % assume: line to keep them):' }));
      for (const name of symbols) {
        const flags = new Set(current.overrides[name] ?? r.assumptions[name]);
        body.push(el('fieldset', { className: 'rr-row' }, el('legend', { textContent: name }), ...ASSUMPTIONS.map(flag => el('label', {}, el('input', { type: 'checkbox', checked: flags.has(flag),
          onchange: e => { const next = new Set(current.overrides[name] ?? r.assumptions[name]); e.target.checked ? next.add(flag) : next.delete(flag); current.overrides = { ...current.overrides, [name]: [...next] }; runMath(); } }), ' ' + flag))));
      }
    }
    if (r.bound && Object.keys(r.bound).length) body.push(el('p', { textContent: `Bound variables (local to their sum or integral, not sampled): ${Object.keys(r.bound).join(', ')}` }));
    const used = new Set(symbols), unknown = current.decls.filter(d => d.assumptions.some(a => !ASSUMPTIONS.includes(a)));
    const notes = [...(r.suggestions ?? []), ...((current.notation?.findings ?? []).filter(f => f.kind !== 'undeclared_symbol' && (used.has(f.symbol) || /assumption|declaration/.test(f.kind))))];
    for (const d of unknown) notes.push({ reason: `% assume: ${d.symbol} lists an assumption that is not supported (${d.assumptions.filter(a => !ASSUMPTIONS.includes(a)).join(', ')}); it was ignored. Supported: ${ASSUMPTIONS.join(', ')}`, range: d.range });
    if (notes.length) body.push(el('p', { textContent: 'Suggestions (not errors):' }), el('ul', {}, ...notes.map(n => el('li', {}, n.reason, ' ', n.range ? rangeButton(n.range) : null))));
    body.push(computeRow());
    if (current.elapsed !== undefined) body.push(el('p', { className: 'rr-note', textContent: `Checked in ${current.elapsed} ms. A check never changes your source; “no issue found” covers only this supported check, not the argument around it.` }));
    show('Equation check', r.status, ...body);
  }
  function computeRow() {
    const c = current.compute, vars = Object.keys(current.result?.assumptions ?? {});
    const name = el('select', { 'aria-label': 'Computation', onchange: e => { c.name = e.target.value; renderMath(); } }, ...Object.entries(COMPUTE).map(([k, v]) => el('option', { value: k, textContent: v, selected: k === c.name })));
    const variable = el('select', { 'aria-label': 'Variable', onchange: e => { c.var = e.target.value; } }, ...(vars.length ? vars : ['x']).map(v => el('option', { value: v, textContent: v, selected: v === c.var })));
    c.var = vars.includes(c.var) ? c.var : vars[0] ?? 'x';
    const point = el('input', { 'aria-label': 'Limit point', placeholder: 'point, e.g. 0 or \\infty', value: c.point ?? '', size: 12, oninput: e => { c.point = e.target.value; } });
    const lo = el('input', { 'aria-label': 'Interval start', placeholder: 'from', value: c.interval?.[0] ?? '', size: 5, oninput: e => { c.interval = [e.target.value, c.interval?.[1] ?? '']; } });
    const hi = el('input', { 'aria-label': 'Interval end', placeholder: 'to', value: c.interval?.[1] ?? '', size: 5, oninput: e => { c.interval = [c.interval?.[0] ?? '', e.target.value]; } });
    const go = el('button', { type: 'button', textContent: 'Compute', onclick: () => {
      const text = current.text, context = contextFor(current.decls, current.overrides);
      const request = c.name === 'optimize' ? { op: 'optimize', text, var: c.var, interval: c.interval?.[0] && c.interval?.[1] ? c.interval : null } : { op: 'compute', name: c.name, text, var: c.var, context, point: c.point || '0' };
      c.request = request; runMath(request);
    } });
    const out = current.computed, row = el('div', {}, el('div', { className: 'rr-row' }, name, ' with respect to ', variable, c.name === 'limit' ? point : null, c.name === 'optimize' ? el('span', {}, 'on [', lo, ', ', hi, '] (optional)') : null, go));
    if (out) {
      const lines = out.status === 'computed' ? [out.result !== undefined ? `Result: ${out.result}` : null, out.critical_points ? `Critical points: ${out.critical_points.map(p => `${p.x} (${p.kind.replaceAll('_', ' ')}, value ${p.value})`).join('; ') || 'none'}` : null,
        out.extrema ? `Minimum ${out.extrema.min.value} at ${out.extrema.min.at.join(', ')}; maximum ${out.extrema.max.value} at ${out.extrema.max.at.join(', ')}` : null, out.global ? `Global extrema: ${out.global}` : null, out.domain ? `Domain: ${out.domain}` : null,
        out.assumptions ? `Assumptions: ${Object.entries(out.assumptions).map(([k, v]) => `${k} ${v.join(' ') || 'unrestricted'}`).join('; ')}` : null] : [out.reason];
      row.append(el('div', { className: 'rr-computed' }, el('strong', { textContent: (LABEL[out.status] ?? out.status) + ': ' }), ...lines.filter(Boolean).map(t => el('code', { textContent: t + '\n' }))));
    }
    return row;
  }

  // ---- analysis
  function startAnalysis(pos) {
    const v = view(); if (!v) return;
    const line = v.state.doc.lineAt(pos), spec = analysisSpecs(line.text)[0];
    if (!spec) { show('Analysis', 'unsupported', el('p', { textContent: 'Place the cursor on a “% analysis <id> <python|r> <op> data=… ” line to run it.' })); return; }
    current = { kind: 'analysis', id: spec.id }; return analyze(spec.id);
  }
  async function analyze(id, { quiet = false } = {}) {
    let files, state;
    try { files = await snapshot(); state = await projectState(files); } catch (error) { if (!quiet) show('Analysis', 'error', el('p', { textContent: error.message })); return; }
    const s = state.states.get(id); if (!s) { if (!quiet) show(`Analysis ${id}`, 'refused', el('p', { textContent: 'This analysis is no longer declared in the project.' })); return; }
    if (s.status === 'refused') { if (!quiet) show(`Analysis ${id}`, 'refused', el('p', { textContent: s.reason })); return; }
    let request; try { request = buildRequest(s.spec, parseCsv(files[s.spec.params.data].content)); } catch (error) { if (!quiet) show(`Analysis ${id}`, 'refused', el('p', { textContent: `${s.spec.params.data}: ${error.message}` })); return; }
    if (!quiet || current?.id === id) show(`Analysis ${id}`, 'running', el('p', { textContent: `Running ${s.spec.lang === 'r' ? 'R' : 'Python'} ${s.spec.op} on ${s.spec.params.data}…` }));
    const started = performance.now(), result = await execute(s.spec.lang === 'r' ? 'r' : 'python', request), elapsed = Math.round(performance.now() - started);
    if (result.status === 'canceled') { if (current?.id === id) show(`Analysis ${id}`, 'canceled', el('p', { textContent: 'Stopped. The manuscript and any earlier result are unchanged.' })); return; }
    const stage = { id, key: s.key, spec: s.spec, result, elapsed, data: files[s.spec.params.data].content };
    if (result.status === 'computed') {
      try { stage.figure = `research/${id}-${s.key}.png`; stage.latex = renderLatex(s.spec, result, stage.figure); } catch (error) { stage.blocked = error.message; }
      const after = (await projectState(await snapshot())).states.get(id);
      if (after?.key !== s.key) stage.blocked = 'Its inputs changed while it ran; Rerun before inserting';
      const upstream = s.spec.inputs.filter(i => i.startsWith('@')).map(i => i.slice(1)).filter(u => state.states.get(u)?.status !== 'fresh');
      if (upstream.length) stage.blocked = `Depends on ${upstream.join(', ')}, which ${upstream.length > 1 ? 'are' : 'is'} not up to date; rerun and insert ${upstream.length > 1 ? 'them' : 'it'} first`;
    }
    staged.set(id, stage); if (current?.kind === 'analysis' && current.id === id) renderAnalysis(); refreshSoon.touch('run');
    return stage;
  }
  function renderAnalysis() {
    const stage = staged.get(current.id); if (!stage) return;
    const { result: r, spec } = stage, body = [el('p', {}, el('code', { textContent: spec.line }), ' in ', spec.file)];
    if (r.status !== 'computed') { show(`Analysis ${spec.id}`, r.status, ...body, el('p', { textContent: r.reason ?? 'No result' }), r.status === 'unavailable' ? el('p', { textContent: 'This analysis is disabled until the selected environment provides it. Nothing was installed.' }) : null); return; }
    body.push(el('p', { textContent: [r.method, r.nobs !== undefined ? `n = ${r.nobs}` : null, r.dropped_rows ? `${r.dropped_rows} row(s) dropped (${r.missing_policy ?? 'missing values'})` : null, r.versions ? Object.entries(r.versions).map(([k, v]) => `${k} ${v}`).join(', ') : null, `${stage.elapsed} ms`].filter(Boolean).join(' · ') }));
    if (spec.op === 'figure') { const img = renderOutput('image/png', r.png_base64); body.push(img.kind === 'image' ? el('img', { src: `data:image/png;base64,${img.base64}`, alt: `Figure for analysis ${spec.id}` }) : el('p', { textContent: img.reason })); }
    else if (Array.isArray(r.terms)) {
      const t = renderOutput('application/x.table+json', { columns: ['Term', 'Estimate', 'Std. error', 'p', '95% CI'], rows: r.terms.map((term, i) => [term, r.estimate?.[i], r.std_error?.[i], r.p?.[i], r.ci_low ? `[${r.ci_low[i]}, ${r.ci_high[i]}]` : ''].map(v => typeof v === 'number' ? String(Number(v.toPrecision(5))) : v ?? '')) });
      body.push(el('table', {}, el('tr', {}, ...t.columns.map(c => el('th', { textContent: c }))), ...t.rows.map(row => el('tr', {}, ...row.map(c => el('td', { textContent: c }))))));
    }
    if (stage.latex) body.push(el('p', { textContent: 'Insert places this between result markers after the analysis line (replacing an earlier copy):' }), el('pre', { textContent: stage.latex }));
    if (stage.blocked) body.push(el('p', { textContent: 'Insert is unavailable: ' + stage.blocked }));
    show(`Analysis ${spec.id}`, stage.inserted ? 'fresh' : 'computed', ...body);
  }
  async function insert() {
    const stage = current?.kind === 'analysis' && staged.get(current.id), v = view(); if (!stage?.latex || stage.blocked || !v) return;
    const now = (await projectState(await snapshot())).states.get(stage.id);
    if (now?.key !== stage.key) { stage.blocked = 'Its inputs changed after it ran; Rerun before inserting'; renderAnalysis(); return; }
    const doc = v.state.doc.toString(), spec = analysisSpecs(doc).find(s => s.id === stage.id);
    if (!spec) { renderAnalysis(); parts.body.append(el('p', { textContent: `Open ${stage.spec.file}, which declares analysis ${stage.id}, to insert it there.` })); return; }
    if (stage.spec.op === 'figure') {   // a new file per input key: an existing file is never overwritten, earlier figures are kept
      const bytes = Uint8Array.from(atob(stage.result.png_base64), c => c.charCodeAt(0)), name = stage.figure.split('/').pop(), form = new FormData();
      form.append('qqfile', new File([bytes], name, { type: 'image/png' })); form.append('relativePath', stage.figure); form.append('name', name);
      const response = await fetch(`/project/${projectId()}/upload`, { method: 'POST', body: form });
      const sha1 = [...new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
      if (!response.ok && (await snapshot())[stage.figure]?.hash !== sha1) { stage.blocked = `${stage.figure} could not be saved (an existing file with other content is never replaced)`; renderAnalysis(); return; }
    }
    const p = await provenance({ cell: `${stage.spec.file}#${stage.id}`, language: stage.spec.lang, runtime: Object.entries(stage.result.versions ?? {}).map(([k, val]) => `${k} ${val}`).join(', '), code: stage.spec.line, inputs: { [stage.spec.params.data]: stage.data }, output: stage.result });
    const note = `analysis ${stage.id}: ${stage.result.method}; ${p.runtime}; code ${p.code.slice(0, 12)}, data ${Object.values(p.inputs)[0].slice(0, 12)}, output ${p.output.slice(0, 12)} (sha256)`;
    const block = resultBlock(stage.id, stage.key, stage.latex, note), existing = resultBlocks(doc).find(b => b.id === stage.id);
    v.dispatch({ changes: existing ? { from: existing.from, to: existing.to, insert: block } : { from: spec.range[1], insert: '\n' + block } });
    stage.inserted = true; renderAnalysis(); refreshSoon.touch('insert');
  }
  function rerun() { if (!current || controller) return; if (current.kind === 'math') return runMath(current.compute?.request ?? null); return analyze(current.id); }

  // ---- project results: stale marking from declared inputs (no execution), optional trusted refresh of changed inputs only
  async function refresh() {
    let state; try { state = await projectState(await snapshot()); } catch { return; }
    states = state.states; if (!list) return;
    const changed = previousKeys ? [...states.values()].filter(s => s.status === 'stale' && s.key && previousKeys.get(s.spec.id) !== s.key).map(s => s.spec.id) : [];
    previousKeys = new Map([...states.values()].map(s => [s.spec.id, s.key]));
    list.replaceChildren(...(states.size ? [el('p', { textContent: 'Analyses in this project:' })] : []), ...[...states.values()].map(s => el('div', { className: 'rr-row' },
      el('button', { type: 'button', textContent: s.spec.id, title: 'Show this result', onclick: () => { current = { kind: 'analysis', id: s.spec.id }; staged.has(s.spec.id) ? renderAnalysis() : show(`Analysis ${s.spec.id}`, s.status, el('p', { textContent: s.reason })); buttons(); } }),
      badge(s.status), ' ', s.reason, s.status !== 'refused' ? el('button', { type: 'button', textContent: 'Rerun', 'aria-label': `Rerun ${s.spec.id}`, onclick: () => { current = { kind: 'analysis', id: s.spec.id }; analyze(s.spec.id); } }) : null)));
    if (changed.length && trusted() && !controller) for (const id of (state.order ?? []).filter(id => changed.includes(id))) await analyze(id, { quiet: true });   // only after a live change, never on open
  }
  const refreshSoon = coalescer(refresh, 400);
  function show(title, status, ...body) { panel(); parts.title.textContent = title; setState(status); parts.body.replaceChildren(...body.filter(Boolean)); buttons(); if (!list.childElementCount) refreshSoon.touch('show'); }

  // ---- triggers: context menu and shortcuts in the editor only
  let menu = null;
  const closeMenu = () => { menu?.remove(); menu = null; };
  const actions = pos => {
    const v = view(), sel = v.state.selection.main, doc = v.state.doc, items = [];
    const inSelection = !sel.empty && pos >= sel.from && pos <= sel.to;
    if (inSelection || snippetAt(doc.toString(), pos)) items.push(['Check equation', 'Ctrl+Alt+M', () => inSelection ? startMath(sel.from, sel.to) : startMath(pos, pos)]);
    if (analysisSpecs(doc.lineAt(pos).text).length) items.push(['Run analysis', 'Ctrl+Alt+R', () => startAnalysis(pos)]);
    return items;
  };
  const contextmenu = e => {
    const v = view(); if (!v || !v.contentDOM.contains(e.target)) return;
    const pos = v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.head, items = actions(pos);
    if (!items.length) return;   // the browser's own menu stays for everything else
    e.preventDefault(); closeMenu();
    menu = el('div', { id: 'research-menu', role: 'menu' }, ...items.map(([label, keys, act]) => el('button', { type: 'button', role: 'menuitem', onclick: () => { closeMenu(); act(); } }, el('span', { textContent: label }), el('kbd', { textContent: keys }))));
    menu.style.left = `${Math.min(e.clientX, innerWidth - 220)}px`; menu.style.top = `${Math.min(e.clientY, innerHeight - 90)}px`; document.body.append(menu); menu.querySelector('button').focus();
  };
  document.addEventListener('contextmenu', contextmenu, true);
  document.addEventListener('pointerdown', e => { if (menu && !menu.contains(e.target)) closeMenu(); }, true);
  const keydown = e => {
    if (menu && e.key === 'Escape') { closeMenu(); view()?.focus(); return; }
    if (!e.ctrlKey || !e.altKey || e.metaKey || e.shiftKey || !['KeyM', 'KeyR'].includes(e.code)) return;
    const v = view(); if (!v?.hasFocus) return;
    e.preventDefault(); e.stopPropagation();
    const sel = v.state.selection.main;
    if (e.code === 'KeyM') startMath(sel.from, sel.to); else startAnalysis(sel.head);
  };
  document.addEventListener('keydown', keydown, true);
  document.addEventListener('input', e => { if (view()?.contentDOM.contains(e.target) && states.size) refreshSoon.touch('edit'); }, true);
  setInterval(() => { if (states.size && !controller && !document.getElementById('research-results')?.hidden) refreshSoon.touch('poll'); }, 4000);
  return { contextmenu, keydown };   // the loader in native-workspace.mjs replays the gesture that loaded this module   // shortcut: polls for data-file changes made outside the editor (uploads); an editor/file-tree change event would replace it
}
