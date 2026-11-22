// SPDX-License-Identifier: AGPL-3.0-only
// Stage 3 rows under Settings > This computer (this-computer.mjs ROWS): the TeX installation this computer uses, "Help compile
// for the group" and its status (participants), and "Compile my PDFs with the group's TeX" (everyone). mount() installs the
// compile route the workspace asks first (globalThis.overleafGroupCompile); it answers undefined whenever the bundled
// in-browser compiler should run instead. The dialog is rebuilt on every open, so state lives here, not in the rows.
import { settingRow } from './this-computer.mjs';
import { participantGroup, texHost, bytesOf } from './lan-compile.mjs';

let ui = null; // set by mount(); computerRows() reads it

/** lan(): the owner's running room or the participant's session (null when not sharing); joined: this tab is a participant. */
export function mount({ lan, joined, events }) {
  const tex = texHost(), view = { tex: null, texError: '', pool: { workers: 0, engines: [] }, wanted: false, helpWanted: false, error: '' };
  let participant = null;
  const pool = () => (participant ? participant.state : view.pool);
  if (joined) {
    participant = participantGroup({ send: m => lan().session.send(m), tex, onChange: () => refresh() });
    events.onGroup = m => { participant.handle(m).catch(error => console.warn('[group]', error.message)); };
    const { onLost, onResumed } = events;
    events.onLost = (...a) => { participant.lost(); refresh(); return onLost?.(...a); };
    events.onResumed = (...a) => { if (view.helpWanted) participant.help(true).catch(() => {}); return onResumed?.(...a); }; // a new connection opts in again
  } else events.onPool = info => { view.pool = info; refresh(); };

  globalThis.overleafGroupCompile = (project, files, progress, signal) => {
    const session = lan(); if (!view.wanted || !session || !pool().workers) return undefined;
    const input = { main: project.main, compiler: project.compiler, files: files.map(bytesOf) };
    progress('Sending this compile to the group…');
    const run = participant ? participant.request(input, progress, signal)
      : session.group.request(input, m => progress(m.k === 'started' ? `Compiling on ${m.by}’s computer…` : m.retry ? `Retrying on another computer (${m.reason})…` : `Waiting for a helping computer (position ${m.position})…`), signal);
    return run.then(result => { globalThis.overleafGroupStats = result.stats; progress(`Compiled on ${result.stats?.by ?? 'a helping'}’s computer.`); return result; });
  };

  let rows = null;
  async function loadTex() {
    try { view.tex = await tex.status(); view.texError = ''; } catch (error) { view.tex = null; view.texError = error.message; }
    refresh();
  }
  const ready = () => !!(view.tex?.directory && view.tex.sandbox && view.tex.engines?.length);
  function refresh() {
    if (!rows?.texChoice.isConnected) return;
    const { texChoice, tx, help, h, st, group, g } = rows, p = pool();
    // TeX installation: an explicit choice among the installations found here, or a folder picked by hand
    texChoice.replaceChildren(new Option(view.tex?.directory ? view.tex.directory : 'Not chosen', view.tex?.directory ?? ''),
      ...(view.tex?.detected ?? []).filter(path => path !== view.tex?.directory).map(path => new Option(path, path)), new Option('Choose a folder…', '#choose'));
    texChoice.disabled = !view.tex;
    tx.describe(view.error || (!view.tex ? `${view.texError || 'Checking…'} This computer can still compile in the browser.`
      : !view.tex.sandbox ? 'This Mac has no compiler sandbox (sandbox-exec), so its TeX cannot be used.'
      : ready() ? `Ready: ${view.tex.engines.join(', ')}.` : `Not chosen. ${view.tex.detected?.length ? 'Pick one of the installations found on this computer.' : 'No installation was found; choose its folder.'} Nothing is downloaded or installed.`));
    if (help) {
      const s = participant.state;
      help.checked = s.helping; help.disabled = !lan() || (!ready() && !s.helping);
      st.describe(s.helping || s.status !== 'Off' ? s.status : !lan() ? 'Off: not in a shared session.' : !ready() ? 'Off: choose a TeX installation first.' : 'Off');
    }
    const usable = !!lan() && p.workers > 0;
    group.checked = view.wanted && usable; group.disabled = !usable;
    g.describe(!lan() ? 'Shared compilation: available only while sharing on this network.' : usable
      ? `Shared compilation: available, ${p.workers} computer${p.workers === 1 ? '' : 's'} helping (${p.engines.join(', ')}). Off: this browser compiles.`
      : 'Shared compilation: unavailable, no computer is helping. This browser keeps compiling your PDFs.');
  }
  const toggle = onChange => { const box = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'form-check-input' }); box.setAttribute('role', 'switch'); box.addEventListener('change', () => onChange(box.checked, box)); return box; };
  const status = row => { row.row.querySelector('.ide-setting-description').setAttribute('role', 'status'); return row; };
  ui = () => {
    const texChoice = Object.assign(document.createElement('select'), { className: 'form-select form-select-sm' });
    texChoice.addEventListener('change', async () => {
      const value = texChoice.value; if (!value || value === view.tex?.directory) return;
      texChoice.disabled = true; view.error = '';
      try { await (value === '#choose' ? tex.choose() : tex.select(value)); } catch (error) { view.error = error.message; }
      await loadTex();
    });
    const tx = settingRow({ id: 'olx-tex-choice', title: 'TeX installation', control: texChoice });
    let help = null, h = null, st = null;
    if (joined) {
      help = toggle(async (on, box) => {
        view.helpWanted = on; view.error = '';
        try { await participant.help(on); } catch (error) { view.helpWanted = false; box.checked = false; view.error = error.message; }
        refresh();
      });
      h = settingRow({ id: 'olx-help-compile', title: 'Help compile for the group', control: help,
        description: 'Uses the TeX installation above to compile other people’s PDFs while you are in this session. The owner must allow “Can keep a copy”: TeX writes temporary files on this computer, removed after each job.' });
      st = status(settingRow({ id: 'olx-help-status', title: 'Contribution status', control: document.createElement('span') }));
    }
    const group = toggle(on => { view.wanted = on; refresh(); });
    const g = status(settingRow({ id: 'olx-group-compile', title: 'Compile my PDFs with the group’s TeX', control: group }));
    rows = { texChoice, tx, help, h, st, group, g };
    refresh(); loadTex();
    return [tx.row, ...(joined ? [h.row, st.row] : []), g.row];
  };
}

/** this-computer.mjs row contract. */
export async function computerRows() {
  if (!ui) throw Error('Shared compilation is unavailable in this page.');
  return ui();
}
