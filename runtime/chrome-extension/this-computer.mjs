// SPDX-License-Identifier: AGPL-3.0-only
// "This computer": device-local settings as one tab of the editor's existing Settings dialog (left rail, gear).
// Each optional tool contributes rows from its own module; nothing here talks to a helper. Add a module to ROWS to merge.
// A row module exports `computerRows(context)` -> Promise<HTMLElement[]>, built with `settingRow` for the native look.
export const ROWS = ['/extension/lan-compile-ui.mjs']; // lane S3-A test copy of S3-B's file: the merged list is ['/extension/research-ui.mjs', '/extension/lan-compile-ui.mjs']
const TAB = 'ide-settings-tabs-tab-this-computer', PANE = 'ide-settings-tabs-tabpane-this-computer';

/** One row in the Settings dialog's own markup: title, description, control on the right. */
export function settingRow({ id, title, description = '', control }) {
  const row = document.createElement('div'); row.className = 'ide-setting'; row.id = 'setting-' + id;
  const text = document.createElement('div'), label = document.createElement('label'), small = document.createElement('div');
  label.className = 'ide-setting-title'; label.textContent = title; label.htmlFor = id; small.className = 'ide-setting-description'; small.textContent = description;
  const right = document.createElement('div'); right.className = 'ide-setting-input'; control.id = id; right.append(control);
  text.append(label, small); row.append(text, right);
  return { row, describe: value => { small.textContent = value; } };
}

/** Adds the tab once the Settings dialog is open (called after any click; cheap when the dialog is absent). */
export function attach(context) {
  const nav = document.querySelector('.ide-settings-tab-nav'), content = document.querySelector('.ide-settings-tab-content');
  if (!nav || !content || document.getElementById(TAB)) return;
  const tab = document.createElement('button'); tab.type = 'button'; tab.id = TAB; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', PANE); tab.setAttribute('aria-selected', 'false'); tab.tabIndex = -1;
  tab.className = 'ide-settings-tab-link ide-settings-tab-link-button nav-link';
  const icon = document.createElement('span'); icon.className = 'material-symbols ide-settings-tab-link-icon unfilled'; icon.setAttribute('aria-hidden', 'true'); icon.translate = false; icon.textContent = 'computer';
  const name = document.createElement('span'); name.textContent = 'This computer'; tab.append(icon, name, Object.assign(document.createElement('div'), { className: 'flex-grow-1' }));
  const pane = document.createElement('div'); pane.id = PANE; pane.setAttribute('role', 'tabpanel'); pane.setAttribute('aria-labelledby', TAB); pane.className = 'tab-pane'; pane.hidden = true;
  const section = document.createElement('div'); section.className = 'ide-settings-section'; pane.append(section);
  nav.querySelector('a.ide-settings-tab-link-anchor') ? nav.querySelector('a.ide-settings-tab-link-anchor').before(tab) : nav.append(tab); content.append(pane);
  let loaded = false, restore = [];
  // The dialog's own tabs stay React's: ours only hides their panes while selected and gives them back on the next click.
  const leave = () => { if (pane.hidden) return; pane.hidden = true; pane.classList.remove('active'); tab.classList.remove('active'); tab.setAttribute('aria-selected', 'false'); for (const undo of restore) undo(); restore = []; };
  nav.addEventListener('click', event => { if (!tab.contains(event.target)) leave(); }, true);
  tab.addEventListener('click', async () => {
    if (!pane.hidden) return;
    for (const node of content.children) if (node !== pane && !node.hidden) { node.hidden = true; restore.push(() => { node.hidden = false; }); }
    for (const other of nav.querySelectorAll('[role=tab].active')) if (other !== tab) { other.classList.remove('active'); other.setAttribute('aria-selected', 'false'); restore.push(() => { other.classList.add('active'); other.setAttribute('aria-selected', 'true'); }); }
    tab.classList.add('active'); tab.setAttribute('aria-selected', 'true'); pane.hidden = false; pane.classList.add('active'); // S3-A fix: Bootstrap shows only .tab-pane.active
    if (loaded) return; loaded = true;
    for (const url of ROWS) {
      try { section.append(...await (await import(url)).computerRows(context)); }
      catch (error) { const { row } = settingRow({ id: 'computer-' + section.children.length, title: 'Unavailable', description: error.message, control: document.createElement('span') }); section.append(row); }
    }
  });
}
