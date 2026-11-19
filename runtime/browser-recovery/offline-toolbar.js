// SPDX-License-Identifier: AGPL-3.0-only
// Offline controls placed inside the native CE+ editor toolbar, styled with its own themed tokens.
(() => {
  if (globalThis.overleafOfflineToolbar) return;
  const icon = name => { const node = document.createElement('span'); node.className = 'material-symbols olx-icon'; node.setAttribute('aria-hidden', 'true'); node.translate = false; node.textContent = name; return node; };
  function button({ id, label, ariaLabel, iconName, className = '', onClick }) {
    const node = document.createElement('button'); node.type = 'button'; if (id) node.id = id;
    node.className = 'olx-button ' + className; if (iconName) node.append(icon(iconName));
    if (label) { const text = document.createElement('span'); text.className = 'olx-button-label'; text.textContent = label; node.append(text); }
    if (ariaLabel) { node.setAttribute('aria-label', ariaLabel); node.title = ariaLabel; }
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }
  let menuSerial = 0;
  function menu(trigger, entries) {
    const list = document.createElement('div'); list.className = 'olx-menu'; list.setAttribute('role', 'menu'); list.hidden = true;
    list.id = 'olx-menu-' + ++menuSerial; trigger.setAttribute('aria-controls', list.id);
    trigger.id ||= list.id + '-trigger'; list.setAttribute('aria-labelledby', trigger.id);
    const items = [];
    for (const entry of entries) {
      if (entry === 'divider') { const line = document.createElement('div'); line.className = 'olx-menu-divider'; line.setAttribute('role', 'separator'); list.append(line); continue; }
      if (entry.header) { list.append(entry.header); continue; }
      const item = document.createElement('button'); item.type = 'button'; item.className = 'olx-menu-item'; item.setAttribute('role', 'menuitem'); if (entry.id) item.id = entry.id;
      item.tabIndex = -1;
      item.append(icon(entry.icon));
      const text = document.createElement('span'); text.className = 'olx-menu-text';
      const title = document.createElement('span'); title.className = 'olx-menu-title'; title.textContent = entry.label; text.append(title);
      if (entry.description) { const small = document.createElement('span'); small.className = 'olx-menu-description'; small.textContent = entry.description; text.append(small); }
      item.append(text); item.setAttribute('aria-label', entry.label);
      item.addEventListener('click', () => { close(true); entry.onClick?.(); });
      items.push(item); list.append(item);
    }
    const enabled = () => items.filter(item => !item.disabled && !item.hidden);
    const open = (last = false) => { list.hidden = false; trigger.setAttribute('aria-expanded', 'true'); const available = enabled(); available[last ? available.length - 1 : 0]?.focus(); };
    const close = (focus = false) => { if (list.hidden) return; list.hidden = true; trigger.setAttribute('aria-expanded', 'false'); if (focus) trigger.focus(); };
    trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', () => (list.hidden ? open() : close()));
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(event.key === 'ArrowUp'); }
      else if (event.key === 'Escape' && !list.hidden) { event.preventDefault(); close(true); }
    });
    list.addEventListener('keydown', event => {
      const available = enabled(), index = available.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); close(true); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); const next = index < 0 ? (event.key === 'ArrowUp' ? available.length - 1 : 0) : (index + (event.key === 'ArrowDown' ? 1 : available.length - 1)) % available.length; available[next]?.focus();
      } else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); available[event.key === 'Home' ? 0 : available.length - 1]?.focus(); }
    });
    const leave = event => { if (!trigger.contains(event.relatedTarget) && !list.contains(event.relatedTarget)) close(); };
    list.addEventListener('focusout', leave); trigger.addEventListener('focusout', leave);
    document.addEventListener('pointerdown', event => { if (!list.hidden && !list.contains(event.target) && !trigger.contains(event.target)) close(); }, true);
    return { list, close };
  }
  // Native toolbar is React-rendered: re-insert after re-renders; fall back to a fixed corner until it exists.
  function mount(root, { hideLabels = [] } = {}) {
    const place = () => {
      const actions = document.querySelector('.ide-redesign-toolbar-actions');
      if (actions) {
        if (root.parentElement !== actions) actions.prepend(root);
        root.classList.remove('olx-floating');
        for (const control of actions.querySelectorAll('.ide-redesign-toolbar-button-container > button, .ide-redesign-toolbar-button-container .dropdown > span > button')) {
          const name = control.getAttribute('aria-label') || control.textContent.trim();
          if (hideLabels.some(label => name === label || name.endsWith(label))) control.closest('.ide-redesign-toolbar-button-container').hidden = true;
        }
      } else if (!root.isConnected) { root.classList.add('olx-floating'); document.body.append(root); }
    };
    place();
    new MutationObserver(place).observe(document.body, { childList: true, subtree: true });
  }
  function stylesheet() {
    if (document.querySelector('link[data-olx]')) return;
    // No query string: the offline cache serves only exact pinned paths.
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.dataset.olx = ''; link.href = '/recovery/offline-ui.css';
    document.head.append(link);
  }
  // Edit durability, never overstated: no off-host backup exists, so none is claimed.
  const durabilityLabels = {
    visible: ['warning', 'Not saved: on screen only. Export your work before closing.'],
    local: ['history', 'Not yet saved to server — kept on this device'],
    acknowledged: ['cloud_sync', 'Received by collaboration — not yet saved to server, kept on this device'],
    device: ['offline_pin', 'Saved on this device — not on the server'],
    server: ['cloud_done', 'Saved to server — not backed up off-host'],
  };
  function durability() {
    const node = document.createElement('span'); node.className = 'olx-durability'; node.setAttribute('role', 'status'); node.setAttribute('aria-live', 'polite'); node.hidden = true;
    const label = document.createElement('span'); node.append(icon('history'), label);
    const set = state => {
      const entry = durabilityLabels[state], from = node.dataset.state;
      // A late acknowledgement or receipt never upgrades past a newer edit or a failure.
      if (!entry || from === state || (state === 'acknowledged' && from !== 'local') || (state === 'server' && from !== 'local' && from !== 'acknowledged')) return;
      node.dataset.state = state; node.firstChild.textContent = entry[0]; label.textContent = entry[1]; node.title = entry[1]; node.hidden = false;
    };
    addEventListener('overleaf-durability', event => set(event.detail?.state));
    return node;
  }
  // CE+ overallTheme: 'light-' is light, '' is the dark default, 'system' follows the OS.
  const themeKey = 'overleaf-offline-theme';
  function theme(value) {
    if (value === undefined) { try { value = localStorage.getItem(themeKey); } catch { value = null; } }
    else { try { localStorage.setItem(themeKey, value); } catch { /* storage may be unavailable; theme still applies */ } }
    const root = document.documentElement;
    if (value === 'light-') root.dataset.theme = 'light'; else if (value === '') root.dataset.theme = 'dark'; else delete root.dataset.theme;
  }
  theme();
  globalThis.overleafOfflineToolbar = Object.freeze({ icon, button, menu, mount, stylesheet, theme, durability });
})();
