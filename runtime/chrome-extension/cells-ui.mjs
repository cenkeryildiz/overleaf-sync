// SPDX-License-Identifier: AGPL-3.0-only
// DOCEXEC-01 / RESEARCH-RUNTIME-01 in the native editor: "This computer" rows (Python, R, Jupyter kernel, Run cells,
// Math check), Run cell from the editor (right-click or Cmd/Ctrl+Enter in .py/.R files), and the results panel under the
// editor with Stop / Restart / Rerun and an explicit Insert. Code runs only in the research helper's confined kernel
// (research-host/src/session.rs), never because a file was opened, imported, synced or joined. Outputs are untrusted:
// they pass outputs.mjs and are shown as text, <img> blobs and plain tables, never as HTML.
import { renderOutput, latexText, sha256 } from './research/outputs.mjs';
import { settingRow } from './this-computer.mjs';

export const HOST = 'com.cenker.latex_research';
export const HINT = 'Install the helper once on this computer: in the folder you loaded this extension from, double-click "Install Sharing Helper", then quit and reopen the browser.';
const TIMEOUT_S = 60;

// ---------------------------------------------------------------- pure helpers (node-tested)
export const languageOf = path => /\.py$/i.test(path) ? 'python' : /\.r$/i.test(path) ? 'r' : null;
const MARKER = /^[ \t]*#[ \t]*%%.*$/gm; // the "percent" cell format used by Jupyter, VS Code and Spyder
/** Cells of a script: text between `# %%` lines; no marker means the whole file is one cell. Offsets are UTF-16. */
export function cellsOf(text) {
  const starts = [0]; for (const match of text.matchAll(MARKER)) if (match.index > 0) starts.push(match.index);
  return starts.map((from, index) => { const to = starts[index + 1] ?? text.length; return { index, from, to, code: text.slice(from, to) }; });
}
export const cellAt = (text, position) => cellsOf(text).findLast(cell => cell.from <= position) ?? cellsOf(text)[0];
/** Project-relative cell identity the kernel layer accepts ([A-Za-z0-9._/-], no '..', no leading '/'). */
export const cellId = (path, index) => (String(path).replace(/[^A-Za-z0-9._/-]/g, '_').split('/').filter(part => part && part !== '..' && part !== '.').join('/').slice(0, 180) || 'file') + '/' + (index === 'selection' ? 'selection' : 'cell-' + (index + 1));
/** Fresh-rerun comparison against the provenance recorded for the same cells before. */
export function differences(before, after) {
  return after.map(p => { const q = before.get(p.cell);
    return { cell: p.cell, change: !q ? 'new' : q.code !== p.code ? 'code changed' : q.status !== p.status ? `status ${q.status} → ${p.status}` : q.output !== p.output ? 'output changed' : 'same' }; });
}
/** LaTeX for one inserted output, preceded by a provenance comment. Kernel text is escaped; nothing from it is ever raw LaTeX. */
export function latexFor(view, provenance, graphic) {
  const short = digest => String(digest ?? '').slice(0, 12);
  const head = `% generated: ${provenance.cell} (run ${provenance.order + 1}, ${provenance.kernel} ${latexText(provenance.runtime)}, code sha256:${short(provenance.code)}, output sha256:${short(provenance.output)})`;
  if (view.kind === 'image') return `${head}\n\\includegraphics[width=\\linewidth]{${graphic}}\n`;
  if (view.kind === 'table') return [head, `\\begin{tabular}{${'l'.repeat(Math.max(1, view.columns.length))}}`, '\\hline', view.columns.map(latexText).join(' & ') + ' \\\\', '\\hline',
    ...view.rows.map(row => row.map(latexText).join(' & ') + ' \\\\'), '\\hline', '\\end{tabular}', ''].join('\n');
  const text = view.text.replace(/\s+$/, '');
  return text.includes('\n') ? `${head}\n\\begin{verbatim}\n${text.replaceAll('\\end{verbatim}', '\\end {verbatim}')}\n\\end{verbatim}\n` : `${head}\n${latexText(text)}\n`;
}

// ---------------------------------------------------------------- helper connection (opened only by a user action)
let helper = null;
function host() {
  if (helper) return helper;
  const port = chrome.runtime.connectNative(HOST), pending = new Map(), listeners = new Set(); let next = 1, closed = null;
  port.onMessage.addListener(message => {
    const entry = message?.id && pending.get(message.id);
    if (entry) { pending.delete(message.id); message.error ? entry.reject(Error(message.error)) : entry.resolve(message.result); } else for (const listener of listeners) listener(message);
  });
  port.onDisconnect.addListener(() => {
    closed = Error(chrome.runtime.lastError ? 'The research helper is not installed on this computer. ' + HINT : 'The research helper stopped');
    for (const entry of pending.values()) entry.reject(closed); pending.clear(); helper = null; for (const listener of listeners) listener({ ev: 'ended', reason: 'helper' });
  });
  helper = {
    call: (op, args = {}) => new Promise((resolve, reject) => { if (closed) return reject(closed); const id = next++; pending.set(id, { resolve, reject }); try { port.postMessage({ id, op, ...args }); } catch (error) { pending.delete(id); reject(error); } }),
    on: listener => listeners.add(listener),
  };
  helper.on(event => { if (event.ev === 'ended') { kernel = null; panelState?.('Kernel stopped' + (event.reason && event.reason !== 'stopped' && event.reason !== 'helper' ? ` (${event.reason.replace('_', ' ')})` : '')); } });
  return helper;
}

// ---------------------------------------------------------------- "This computer" rows
const node = (tag, props = {}, ...children) => { const element = Object.assign(document.createElement(tag), props); element.append(...children); return element; };
export async function computerRows(context) {
  const rows = [], note = node('p', { className: 'olx-computer-note', role: 'status' });
  let status;
  try { status = await host().call('status', { project: context.project() }); }
  catch (error) { return [settingRow({ id: 'computer-research', title: 'Python, R and Jupyter', description: error.message, control: node('span') }).row]; }
  const act = async (op, args) => { note.textContent = 'Saving…'; try { await host().call(op, args); note.textContent = ''; } catch (error) { note.textContent = error.message; } await refresh(); };
  const choose = (id, title, description, items, current, onPick) => {
    const select = node('select', { className: 'form-select form-select-sm' }); select.append(node('option', { value: '', textContent: 'Not selected' }));
    for (const item of items) select.append(node('option', { value: item.value, textContent: item.label, disabled: !!item.disabled, title: item.title ?? '', selected: item.value === current }));
    select.onchange = () => select.value && onPick(select.value);
    const made = settingRow({ id, title, description, control: select }); rows.push(made.row); return made;
  };
  const toggle = (id, title, feature) => {
    const input = node('input', { type: 'checkbox', className: 'form-check-input', role: 'switch' }), wrap = node('div', { className: 'form-switch' }, input);
    input.onchange = () => act('feature', { name: feature, on: input.checked });
    const made = settingRow({ id, title, description: '', control: wrap }); rows.push(made.row); return { ...made, input };
  };
  const label = rt => `${rt.label}${rt.version ? ' (' + rt.version + ')' : ''}`;
  const python = choose('computer-python', 'Python environment', 'Runs the kernel bridge and Python tools', [], '', value => act('select', { kind: 'python', path: value }));
  const r = choose('computer-r', 'R installation', 'Used by R analysis tools', [], '', value => act('select', { kind: 'r', path: value }));
  const kernelRow = choose('computer-kernel', 'Jupyter kernel', 'Installed kernels; cells use the selected one', [], '', value => act('kernel', { name: value }));
  const cells = toggle('computer-run-cells', 'Run cells', 'jupyter'), math = toggle('computer-math-check', 'Math check', 'math-check');
  const pyTools = toggle('computer-python-analysis', 'Python analysis', 'python-analysis'), rTools = toggle('computer-r-analysis', 'R analysis', 'r-analysis');
  const allowed = node('input', { type: 'checkbox', className: 'form-check-input', role: 'switch' }), consent = settingRow({ id: 'computer-project-consent', title: 'This project may run code', description: '', control: node('div', { className: 'form-switch' }, allowed) });
  allowed.onchange = () => act('consent', { project: context.project(), granted: allowed.checked }); rows.push(consent.row);
  const fill = (row, items) => { const select = row.row.querySelector('select'), keep = select.options[0]; select.replaceChildren(keep, ...items.map(item => node('option', { value: item.value, textContent: item.label, disabled: !!item.disabled, title: item.title ?? '', selected: !!item.selected }))); };
  async function refresh() {
    try { status = await host().call('status', { project: context.project() }); } catch (error) { note.textContent = error.message; return; }
    fill(python, status.python.map(rt => ({ value: rt.path, label: label(rt), selected: rt.selected })));
    fill(r, status.r.map(rt => ({ value: rt.path, label: label(rt), selected: rt.selected })));
    fill(kernelRow, status.kernels.map(k => ({ value: k.name, label: `${k.display || k.name} — ${k.language}${k.interpreter ? ', ' + k.interpreter : ''}`, disabled: !k.usable, title: k.reason ?? '', selected: k.selected })));
    const py = status.python.find(rt => rt.selected), kernelPick = status.kernels.find(k => k.selected);
    python.describe(py ? Object.values(py.support).filter(Boolean)[0] ?? 'Ready for the tools below' : 'Choose the environment to use on this computer');
    r.describe(status.r.length ? 'Used by R analysis tools' : 'No R installation was found');
    kernelRow.describe(kernelPick ? `${kernelPick.language === 'r' ? 'R' : 'Python'} cells run in this kernel` : status.kernels.length ? 'Choose a kernel for Run cells' : 'No Jupyter kernel is installed');
    for (const [row, name, what] of [[cells, 'jupyter', 'Right-click a .py or .R file, or press ⌘/Ctrl+Enter, to run a cell. Code runs only after you allow each project.'], [math, 'math-check', 'Right-click an equation or press Ctrl+Alt+M to check it with the selected Python (SymPy)'],
      [pyTools, 'python-analysis', 'Runs % analysis lines declared for Python (Ctrl+Alt+R)'], [rTools, 'r-analysis', 'Runs % analysis lines declared for R (Ctrl+Alt+R)']]) {
      const feature = status.features[name]; row.input.checked = feature.on;
      row.input.disabled = !feature.on && feature.ready !== true; // switching off always works
      row.describe(!status.sandbox ? 'Unavailable: this computer has no supported sandbox for running code' : feature.ready === true ? (feature.on ? 'On. ' : 'Off. ') + what : 'Unavailable: ' + feature.ready);
    }
    allowed.checked = !!status.consent; consent.describe(context.shared() ? 'Code never runs while this project is shared on the network' : status.consent ? 'Allowed on this computer. Switch off to be asked again.' : 'Asked the first time you run a cell in this project');
  }
  await refresh();
  return [...rows, note];
}

// ---------------------------------------------------------------- Run cell results panel (research-ui.mjs keeps its own #research-results)
let panelNode = null, panelState = null;
const STYLE = `.olx-results{flex:0 0 auto;max-height:42%;display:flex;flex-direction:column;border-top:1px solid var(--border-divider,#d0d5dd);background:var(--bg-light-primary,#fff);font-size:13px}
.olx-results header{display:flex;gap:6px;align-items:center;padding:4px 8px;border-bottom:1px solid var(--border-divider,#e4e7ec)}.olx-results header strong{margin-right:auto}
.olx-results header span{color:var(--content-secondary,#475467)}.olx-results ol{list-style:none;margin:0;padding:0;overflow:auto}
.olx-results li{padding:6px 10px;border-bottom:1px solid var(--border-divider,#f2f4f7)}.olx-results pre{white-space:pre-wrap;margin:4px 0;max-height:16em;overflow:auto;font-size:12px}
.olx-results img{max-width:100%;max-height:22em;display:block;margin:4px 0}.olx-results table{border-collapse:collapse;margin:4px 0}.olx-results td,.olx-results th{border:1px solid #d0d5dd;padding:1px 6px}
.olx-results [data-status=error],.olx-results [data-status=failed],.olx-results [data-status=stale]{color:#b42318}.olx-results details{color:var(--content-secondary,#475467);font-size:12px}
.olx-results button{font-size:12px}.olx-cell-menu{position:fixed;z-index:2000;background:#fff;border:1px solid #d0d5dd;border-radius:6px;box-shadow:0 4px 12px #0002;padding:4px 0}
.olx-cell-menu button{display:block;width:100%;text-align:left;border:0;background:none;padding:6px 16px}.olx-cell-menu button:hover,.olx-cell-menu button:focus{background:#f2f4f7}`;
const small = (label, onclick) => node('button', { type: 'button', className: 'btn btn-secondary btn-sm', textContent: label, onclick });
/** The panel under the editor, created on first use. `show(item)` adds a result and returns {update(item)}; item fields:
 *  {title, status, message?, outputs?: [{mime, data}], provenance?, actions?: [{label, run}]} (outputs go through outputs.mjs). */
export function resultsPanel(controls = {}) {
  const container = document.querySelector('.ide-redesign-editor-content')?.parentElement ?? document.querySelector('.cm-editor')?.parentElement;
  if (!panelNode || !panelNode.isConnected) {
    if (!document.getElementById('olx-results-style')) document.head.append(node('style', { id: 'olx-results-style', textContent: STYLE }));
    const state = node('span', { role: 'status' }), list = node('ol', { ariaLabel: 'Result list' });
    const bar = node('header', {}, node('strong', { textContent: 'Results' }), state, small('Stop', () => controls.stop?.()), small('Restart', () => controls.restart?.()), small('Rerun', () => controls.rerun?.()),
      node('button', { type: 'button', className: 'btn-close', ariaLabel: 'Close results', title: 'Close results', onclick: () => { panelNode.remove(); panelNode = null; } }));
    panelNode = node('section', { className: 'olx-results', ariaLabel: 'Results' }, bar, list);
    panelState = text => { state.textContent = text; };
    container?.append(panelNode);
  }
  const list = panelNode.querySelector('ol');
  return {
    state: text => panelState(text),
    show(item) {
      const entry = node('li'); list.append(entry); entry.scrollIntoView?.({ block: 'nearest' });
      const draw = next => { entry.replaceChildren(...renderItem(next)); entry.dataset.status = next.status ?? ''; };
      draw(item); return { update: draw, node: entry };
    },
  };
}
function renderItem(item) {
  const parts = [node('div', {}, node('strong', { textContent: item.title ?? 'Result' }), node('span', { textContent: item.status ? ' · ' + item.status : '' }))];
  if (item.message) parts.push(node('pre', { textContent: item.message }));
  for (const output of item.outputs ?? []) {
    const view = renderOutput(output.mime, output.data), actions = [];
    if (view.kind === 'text') parts.push(node('pre', { textContent: view.text + (view.truncated ? '\n… (truncated)' : '') }));
    else if (view.kind === 'image') { const img = node('img', { alt: 'Figure from ' + (item.title ?? 'cell'), width: view.width, height: view.height }); img.src = URL.createObjectURL(new Blob([Uint8Array.from(atob(view.base64), c => c.charCodeAt(0))], { type: 'image/png' })); img.onload = () => URL.revokeObjectURL(img.src); parts.push(img); }
    else if (view.kind === 'table') { const table = node('table'); table.append(node('tr', {}, ...view.columns.map(c => node('th', { textContent: c })))); for (const row of view.rows) table.append(node('tr', {}, ...row.map(c => node('td', { textContent: c })))); parts.push(table); }
    else parts.push(node('p', { textContent: `${view.mime}: ${view.reason}` }));
    if (item.insert && view.kind !== 'blocked' && output.insertable !== false) actions.push(small('Insert', () => item.insert(view, output)));
    if (actions.length) parts.push(node('div', {}, ...actions));
  }
  for (const action of item.actions ?? []) parts.push(small(action.label, action.run));
  if (item.provenance) { const p = item.provenance;
    parts.push(node('details', {}, node('summary', { textContent: 'Provenance' }), node('div', { textContent: `cell ${p.cell} · run ${p.order + 1} · execution count ${p.execution_count ?? '–'} · ${p.kernel} (${p.language} ${p.runtime}) · code sha256:${p.code} · output sha256:${p.output}${p.seed !== null && p.seed !== undefined ? ' · seed ' + p.seed : ''}` }))); }
  return parts;
}

// ---------------------------------------------------------------- running cells
let kernel = null; // {project, language} of the helper's running kernel
const history = new Map(); // cell id -> last provenance (this tab only)
const consentDialog = () => new Promise(resolve => {
  const dialog = node('dialog', { className: 'olx-consent' }); dialog.setAttribute('aria-label', 'Allow this project to run code');
  const allow = small('Allow on this computer', () => { dialog.close(); resolve(true); }), cancel = small('Cancel', () => { dialog.close(); resolve(false); });
  allow.className = 'btn btn-primary btn-sm';
  dialog.append(node('h2', { textContent: 'Run code from this project?' }), node('p', { textContent: 'Cells, equation checks and analyses from this project will run with the Python, R and Jupyter kernel selected under Settings › This computer. They run confined: no network, no access to your home folder or other files, and no keys from your environment. Only allow projects whose code you trust. You can withdraw this under Settings › This computer.' }), node('div', {}, allow, ' ', cancel));
  dialog.addEventListener('cancel', () => resolve(false)); dialog.addEventListener('close', () => dialog.remove()); document.body.append(dialog); dialog.showModal(); allow.focus();
});
async function ready(context, language, panel) {
  const project = context.project(), status = await host().call('status', { project });
  const fail = message => { panel.show({ title: 'Run cell', status: 'unavailable', message }); return false; };
  if (!status.sandbox) return fail('Running code needs a supported sandbox, which this computer does not have.');
  const cells = status.features.jupyter; if (!cells.on) return fail(cells.ready === true ? 'Run cells is off. Turn it on in Settings › This computer.' : 'Run cells is unavailable: ' + cells.ready + '. See Settings › This computer.');
  const pick = status.kernels.find(k => k.selected); if (!pick) return fail('No Jupyter kernel is selected. Choose one in Settings › This computer.');
  if ((pick.language === 'r' ? 'r' : 'python') !== language) return fail(`The selected kernel (${pick.display || pick.name}) runs ${pick.language === 'r' ? 'R' : 'Python'}, but this is ${language === 'r' ? 'an R' : 'a Python'} file. Choose a matching kernel in Settings › This computer.`);
  if (!status.consent) { if (!await consentDialog()) return fail('Not run: this project is not allowed to run code on this computer.'); await host().call('consent', { project, granted: true }); }
  if (kernel && kernel.project === project && kernel.language === language) return true;
  if (kernel) { await host().call('shutdown'); kernel = null; }
  panel.state('Starting kernel…'); const started = performance.now();
  const reply = await host().call('start', { project });
  if (reply.status !== 'ok') { await host().call('shutdown').catch(() => {}); return fail('The kernel did not start: ' + reply.reason); }
  kernel = { project, language, runtime: reply.runtime }; panel.state(`${pick.display || pick.name} ${reply.runtime} · started in ${Math.round(performance.now() - started)} ms`); return true;
}
async function execute(context, panel, path, cell) {
  const id = cellId(path, cell.index), title = `${path} · ${cell.index === 'selection' ? 'selection' : 'cell ' + (cell.index + 1)}`;
  const entry = panel.show({ title, status: 'running' });
  let reply; try { reply = await host().call('run', { project: context.project(), cell: id, code: cell.code, timeout: TIMEOUT_S }); }
  catch (error) { entry.update({ title, status: 'failed', message: error.message }); return null; }
  if (!reply.provenance) { entry.update({ title, status: reply.status ?? 'failed', message: reply.reason ?? 'The kernel did not run this cell' }); return null; }
  const outputs = reply.items.map(item => item.kind === 'error' ? { mime: 'text/plain', data: `${item.ename}: ${item.evalue}\n${item.traceback}`, insertable: false } : { mime: item.mime, data: item.data });
  if (reply.blocked.length) outputs.push({ mime: 'text/plain', data: 'Not displayed (rich output is never rendered): ' + reply.blocked.join(', '), insertable: false });
  if (reply.truncated) outputs.push({ mime: 'text/plain', data: 'Output was cut at the size limit.', insertable: false });
  const result = { title, status: reply.status + (reply.execution_count ? ` [${reply.execution_count}]` : ''), outputs, provenance: reply.provenance };
  result.insert = (view, output) => insert(context, panel, path, cell, reply.provenance, view, output, () => entry.update({ ...result, status: 'stale: the code changed after this run; rerun before inserting' }));
  entry.update(result); history.set(id, reply.provenance);
  return reply.provenance;
}
async function insert(context, panel, path, cell, provenance, view, output, stale) {
  const target = context.file(), editor = context.view();
  try {
    const source = context.text(path); if (source === undefined) throw Error(`${path} no longer exists`);
    const now = cell.index === 'selection' ? null : cellsOf(source)[cell.index];
    if (cell.index !== 'selection' && (!now || await sha256(now.code) !== provenance.code)) { stale(); return; }
    if (!target || !editor || languageOf(target.path)) throw Error('Open the .tex file where the result belongs, place the cursor, then choose Insert');
    let graphic = null;
    if (view.kind === 'image') { // a project file through the editor's own guarded upload route; the name is derived, never taken from output
      graphic = `generated/${provenance.cell.replace(/\//g, '-')}-${provenance.output.slice(0, 8)}.png`;
      const form = new FormData(); form.append('qqfile', new File([Uint8Array.from(atob(view.base64), c => c.charCodeAt(0))], graphic.split('/').pop(), { type: 'image/png' }));
      form.append('relativePath', graphic); form.append('name', graphic.split('/').pop());
      const response = await fetch(`/project/${context.clientProject()}/upload`, { method: 'POST', body: form }), body = await response.json().catch(() => ({}));
      if (!response.ok || !body.success) throw Error('The figure was not saved: ' + (body.error ?? response.status));
    }
    const at = editor.state.selection.main.head; editor.dispatch({ changes: { from: at, insert: latexFor(view, provenance, graphic) } }); editor.focus();
    panel.state(`Inserted into ${target.path}`);
  } catch (error) { panel.state(error.message); }
}
const controls = context => ({
  stop: () => host().call('interrupt').catch(() => {}),
  restart: async () => { const panel = resultsPanel(controls(context)); if (!kernel) return panel.state('No kernel is running');
    panel.state('Restarting…'); const reply = await host().call('restart').catch(error => ({ status: 'error', reason: error.message })); panel.state(reply.status === 'ok' ? 'Restarted: variables cleared' : 'Restart failed: ' + reply.reason); },
  rerun: () => runCell(context, 'rerun'),
});
let busy = false;
/** Entry point from the editor. mode: 'cell' (cursor cell or selection) or 'rerun' (fresh kernel, every cell in order). */
export async function runCell(context, mode = 'cell') {
  const panel = resultsPanel(controls(context)), file = context.file(), editor = context.view();
  if (busy) return panel.state('A cell is still running; Stop it first');
  if (!file || !editor) return panel.show({ title: 'Run cell', status: 'unavailable', message: 'Open a .py or .R file first.' });
  const language = languageOf(file.path); if (!language) return panel.show({ title: 'Run cell', status: 'unavailable', message: 'Run cell works in .py and .R files.' });
  if (context.shared()) return panel.show({ title: 'Run cell', status: 'unavailable', message: 'Running code is unavailable while this project is shared on the network or opened from a shared session.' });
  busy = true;
  try {
    if (!await ready(context, language, panel)) return;
    const text = editor.state.doc.toString(), selection = editor.state.selection.main;
    if (mode === 'rerun') {
      const cells = cellsOf(text).filter(cell => cell.code.trim()), before = new Map(history);
      panel.state('Fresh kernel: rerunning every cell in order…'); const reply = await host().call('restart'); if (reply.status !== 'ok') throw Error('Restart failed: ' + reply.reason);
      const after = []; for (const cell of cells) { const p = await execute(context, panel, file.path, cell); if (!p) break; after.push(p); if (p.status !== 'ok') break; }
      const diff = differences(before, after).filter(d => d.change !== 'same');
      panel.show({ title: `Rerun of ${file.path}`, status: after.length === cells.length && after.every(p => p.status === 'ok') ? 'complete' : 'stopped', message: diff.length ? 'Differences from the earlier runs (hidden state or changed code):\n' + diff.map(d => `${d.cell}: ${d.change}`).join('\n') : 'Same outputs as the earlier runs.' });
    } else await execute(context, panel, file.path, selection.empty ? cellAt(text, selection.head) : { index: 'selection', code: text.slice(selection.from, selection.to) });
  } catch (error) { panel.show({ title: 'Run cell', status: 'failed', message: error.message }); }
  finally { busy = false; }
}
// ---------------------------------------------------------------- transport for research-ui.mjs (S3-C: math check, analyses)
const TOOL_FEATURE = { math: ['math-check', 'Math check'], python: ['python-analysis', 'Python analysis'], r: ['r-analysis', 'R analysis'] };
/** `globalThis.overleafResearchRun({tool, request}, {signal})`: one packaged tool script in the helper's confined runner.
 *  Same gates as Run cell (not shared, sandbox, feature on, per-project consent asked here); only the readiness probe
 *  {op:'version'} skips consent. Stop aborts `signal`, which cancels the job. Resolves with the script's own result. */
export async function researchRun(context, { tool, request } = {}, { signal } = {}) {
  const feature = TOOL_FEATURE[tool]; if (!feature) return { status: 'error', reason: 'Unknown tool' };
  if (context.shared()) return { status: 'unavailable', reason: 'Running code is unavailable while this project is shared on the network or opened from a shared session.' };
  const project = context.project(), probe = request?.op === 'version' && Object.keys(request).length === 1;
  if (!probe) {
    let status; try { status = await host().call('status', { project }); } catch (error) { return { status: 'unavailable', reason: error.message }; }
    const state = status.features[feature[0]];
    if (!status.sandbox) return { status: 'unavailable', reason: 'Running code needs a supported sandbox, which this computer does not have.' };
    if (!state?.on) return { status: 'unavailable', reason: state?.ready === true ? `${feature[1]} is off. Turn it on in Settings › This computer.` : `${feature[1]} is unavailable: ${state?.ready}. See Settings › This computer.` };
    if (!status.consent) { if (!await consentDialog()) return { status: 'refused', reason: 'Not run: this project is not allowed to run code on this computer.' }; await host().call('consent', { project, granted: true }); }
  }
  if (signal?.aborted) return { status: 'canceled' };
  const cancel = () => host().call('cancel-script').catch(() => {}); signal?.addEventListener('abort', cancel, { once: true });
  try { return await host().call('script', { tool, request, project, timeout: TIMEOUT_S }); }
  finally { signal?.removeEventListener('abort', cancel); }
}

/** Sharing started: consent is asked again before code edited by others can run, and the kernel stops. */
export async function revoke(project) { try { await host().call('consent', { project, granted: false }); } catch {} kernel = null; }

/** Right-click menu with the one command, shown only in .py/.R files; Escape or any outside click closes it. */
export function cellMenu(context, event) {
  document.querySelector('.olx-cell-menu')?.remove();
  if (!document.getElementById('olx-results-style')) document.head.append(node('style', { id: 'olx-results-style', textContent: STYLE }));
  const selection = context.view()?.state.selection.main, menu = node('div', { className: 'olx-cell-menu', role: 'menu' });
  const item = node('button', { type: 'button', role: 'menuitem', textContent: selection && !selection.empty ? 'Run selection' : 'Run cell', onclick: () => { close(); runCell(context); } });
  item.setAttribute('aria-keyshortcuts', 'Meta+Enter Control+Enter'); menu.append(item);
  menu.style.left = Math.min(event.clientX, innerWidth - 180) + 'px'; menu.style.top = Math.min(event.clientY, innerHeight - 60) + 'px';
  const close = () => { menu.remove(); removeEventListener('pointerdown', outside, true); removeEventListener('keydown', escape, true); };
  const outside = e => { if (!menu.contains(e.target)) close(); }, escape = e => { if (e.key === 'Escape') { e.preventDefault(); close(); context.view()?.focus(); } };
  addEventListener('pointerdown', outside, true); addEventListener('keydown', escape, true);
  document.body.append(menu); item.focus();
}
