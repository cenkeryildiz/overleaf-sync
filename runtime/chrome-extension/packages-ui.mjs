// SPDX-License-Identifier: AGPL-3.0-only
// TEX-PKG: Settings › Packages (package list, what this project needs, installed packages) and the "Install missing
// packages" button on a failed compile. Every download is a click here; nothing installs on open, import or join.
import { settingRow } from './this-computer.mjs';
import * as store from './packages/store.mjs';
import { fromSources, fromLog } from './packages/detect.mjs';

const node = (tag, props = {}, ...children) => { const element = document.createElement(tag); for (const [k, v] of Object.entries(props)) k.startsWith('data-') ? element.setAttribute(k, v) : (element[k] = v); element.append(...children.filter(c => c !== null && c !== undefined)); return element; };
const button = (label, onclick, primary = false) => node('button', { type: 'button', className: `btn ${primary ? 'btn-primary' : 'btn-secondary'} btn-sm`, textContent: label, onclick });
const kb = bytes => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
const LABEL = { project: 'in this project', bundled: 'included with the compiler', installed: 'installed', missing: 'missing', unsupported: 'not available here', unknown: 'unknown' };

export async function packageRows(context) {
  const note = node('p', { className: 'olx-computer-note', role: 'status', id: 'olx-packages-status' });
  const listRow = settingRow({ id: 'packages-catalog', title: 'TeX Live package list', description: '', control: node('div') });
  const needsRow = settingRow({ id: 'packages-needed', title: 'This project needs', description: '', control: node('div') });
  const installedRow = settingRow({ id: 'packages-installed', title: 'Installed in this browser', description: '', control: node('div') });
  const tex = await import('/extension/lan-compile-ui.mjs').then(m => m.chosenTex()).catch(() => null);   // TEX-PKG-03
  installedRow.describe(`Active for this browser’s compiler${tex ? ` and for this computer’s TeX installation ${tex} when it helps compile for the group (copied into each job’s private folder, never into the installation)` : ''}, for every project; not shared with collaborators.`);
  const needs = node('ul', { className: 'olx-package-list', ariaLabel: 'Package requirements' }), have = node('ul', { className: 'olx-package-list', ariaLabel: 'Installed packages' });
  let controller = null;
  const busy = (label, run) => async () => {
    if (controller) return; controller = new AbortController(); const cancel = button('Cancel', () => controller?.abort());
    note.replaceChildren(label + ' ', cancel);
    try { await run(controller.signal, text => { note.replaceChildren(text + ' ', cancel); }); note.textContent = ''; }
    catch (error) { note.replaceChildren(error.message + ' ', button('Retry', busy(label, run))); }
    finally { controller = null; await refresh(); }
  };
  const refreshList = busy('Downloading the package list…', (signal, progress) => store.refreshCatalog({ signal, progress }));

  async function refresh() {
    const cat = await store.catalog().catch(() => null);
    listRow.describe(cat ? `Downloaded ${new Date(cat.fetchedAt).toLocaleString()} from ${new URL(cat.mirror).host}; signature checked with the TeX Live key.` : 'Not downloaded yet. Refresh downloads it (about 3 MB) from a CTAN mirror.');
    listRow.row.querySelector('.ide-setting-input').replaceChildren(button(cat ? 'Refresh' : 'Download list', refreshList));
    const wanted = [...fromSources(context.sources()), ...fromLog(context.compileLog())];
    const rows = await store.resolve(wanted, new Set(context.sources().map(s => s.path)));
    const missing = rows.filter(r => r.state === 'missing');
    needsRow.describe(rows.length ? `${rows.length} files from \\usepackage, \\documentclass and the last compile log. Source scanning is a hint: macros can load other files.` : 'No package requirements found in the sources or the last compile log.');
    needs.replaceChildren(...rows.map(r => node('li', { 'data-state': r.state }, node('code', { textContent: r.file }), ` — ${LABEL[r.state]}`,
      r.package && r.state !== 'missing' ? ` (${r.package}${r.revision ? ' r' + r.revision : ''})` : null, r.reason ? `: ${r.reason}` : null,
      r.state === 'missing' ? ` — package ${r.package}${r.install.length > 1 ? ` with ${r.install.length - 1} dependenc${r.install.length === 2 ? 'y' : 'ies'}` : ''}, ${kb(r.bytes)}, licence ${r.license} ` : null,
      r.state === 'missing' ? confirmInstall([r.package], r) : null)));
    needsRow.row.querySelector('.ide-setting-input').replaceChildren(missing.length > 1 ? confirmInstall([...new Set(missing.map(r => r.package))], { install: [...new Set(missing.flatMap(r => r.install))], bytes: missing.reduce((s, r) => s + r.bytes, 0) }, 'Install all missing') : node('span'));
    const list = await store.installed();
    have.replaceChildren(...list.map(p => node('li', {}, node('code', { textContent: p.name }), ` r${p.revision}, ${kb(p.size)}, licence ${p.license} `,
      p.hasPrevious ? button('Previous version', busy(`Switching ${p.name} back…`, () => store.rollback(p.name))) : null, ' ',
      button('Remove', async () => {
        if (p.neededBy.length && !confirm(`${p.neededBy.join(', ')} depend${p.neededBy.length === 1 ? 's' : ''} on ${p.name}. Projects using them will stop compiling. Remove anyway?`)) return;
        await busy(`Removing ${p.name}…`, () => store.uninstall(p.name, { compiling: context.compiling() }))();
      }))));
    if (!list.length) have.replaceChildren(node('li', { textContent: 'Nothing installed yet.' }));
  }
  /** Install button that first shows the exact set, size and licences, then needs a second click. */
  function confirmInstall(names, plan, label = 'Install') {
    const wrap = node('span');
    const ask = () => wrap.replaceChildren(`Install ${plan.install.join(', ')} (${kb(plan.bytes)} download)? `,
      button('Confirm install', busy(`Installing ${names.join(', ')}…`, (signal, progress) => store.install(names, { signal, progress })), true), ' ', button('Cancel', () => wrap.replaceChildren(button(label, ask))));
    wrap.append(button(label, ask)); return wrap;
  }
  await refresh();
  return [note, listRow.row, needsRow.row, node('div', { className: 'ide-setting' }, needs), installedRow.row, node('div', { className: 'ide-setting' }, have)];
}

/** After a compile: `log` of a failure that names missing files gets a button that opens Settings › Packages; null clears it. */
export async function compileHint(log) {
  document.getElementById('olx-package-hint')?.remove();
  const files = log ? fromLog(log) : []; if (!files.length) return;
  const rows = await store.resolve(files), useful = rows.filter(r => r.state === 'missing' || r.state === 'unknown'); if (!useful.length) return;
  const status = document.querySelector('#local-status'); if (!status) return;
  status.after(node('button', { type: 'button', id: 'olx-package-hint', className: 'btn btn-primary btn-sm', textContent: 'Install missing packages', title: useful.map(r => r.file).join(', '),
    onclick: async () => {
      const settings = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? b.textContent).trim() === 'Settings'); settings?.click();
      for (let i = 0; i < 40 && !document.getElementById('ide-settings-tabs-tab-packages'); i++) await new Promise(r => setTimeout(r, 50));
      document.getElementById('ide-settings-tabs-tab-packages')?.click();
    } }));
}
