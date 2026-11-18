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
  function menu(trigger, entries) {
    const list = document.createElement('div'); list.className = 'olx-menu'; list.setAttribute('role', 'menu'); list.hidden = true;
    const items = [];
    for (const entry of entries) {
      if (entry === 'divider') { const line = document.createElement('div'); line.className = 'olx-menu-divider'; line.setAttribute('role', 'separator'); list.append(line); continue; }
      if (entry.header) { list.append(entry.header); continue; }
      const item = document.createElement('button'); item.type = 'button'; item.className = 'olx-menu-item'; item.setAttribute('role', 'menuitem'); if (entry.id) item.id = entry.id;
      item.append(icon(entry.icon));
      const text = document.createElement('span'); text.className = 'olx-menu-text';
      const title = document.createElement('span'); title.className = 'olx-menu-title'; title.textContent = entry.label; text.append(title);
      if (entry.description) { const small = document.createElement('span'); small.className = 'olx-menu-description'; small.textContent = entry.description; text.append(small); }
      item.append(text); item.setAttribute('aria-label', entry.label);
      item.addEventListener('click', () => { close(); entry.onClick?.(); });
      items.push(item); list.append(item);
    }
    const open = () => { list.hidden = false; trigger.setAttribute('aria-expanded', 'true'); items[0]?.focus(); };
    const close = (focus = false) => { if (list.hidden) return; list.hidden = true; trigger.setAttribute('aria-expanded', 'false'); if (focus) trigger.focus(); };
    trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', () => (list.hidden ? open() : close()));
    list.addEventListener('keydown', event => {
      const index = items.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); close(true); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
      } else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); items[event.key === 'Home' ? 0 : items.length - 1]?.focus(); }
    });
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
  // CE+ overallTheme: 'light-' is light, '' is the dark default, 'system' follows the OS.
  const themeKey = 'overleaf-offline-theme';
  function theme(value) {
    if (value === undefined) { try { value = localStorage.getItem(themeKey); } catch { value = null; } }
    else { try { localStorage.setItem(themeKey, value); } catch { /* storage may be unavailable; theme still applies */ } }
    const root = document.documentElement;
    if (value === 'light-') root.dataset.theme = 'light'; else if (value === '') root.dataset.theme = 'dark'; else delete root.dataset.theme;
  }
  theme();
  globalThis.overleafOfflineToolbar = Object.freeze({ icon, button, menu, mount, stylesheet, theme });
})();
