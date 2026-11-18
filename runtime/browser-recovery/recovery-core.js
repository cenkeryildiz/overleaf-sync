// SPDX-License-Identifier: AGPL-3.0-only
// Cenker YILDIZ, 2026. Recovery copies never replay automatically.
(() => {
  'use strict';
  const prefix = 'overleaf.recovery.v1.';
  function randomUUID() {
    if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return hex.slice(0,8) + '-' + hex.slice(8,12) + '-' + hex.slice(12,16) + '-' + hex.slice(16,20) + '-' + hex.slice(20);
  }
  const writer = randomUUID();
  const entries = new Map();
  let current, controls, offeredReview, toolbarLoading = false;
  const id = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
  const valid = value => value?.schema === 1 && id(value.account) && id(value.project) && id(value.doc)
    && typeof value.writer === 'string' && /^[a-f0-9-]{36}$/.test(value.writer)
    && Number.isSafeInteger(value.revision) && value.revision >= 0
    && Number.isSafeInteger(value.base?.version) && value.base.version >= 0
    && typeof value.base.text === 'string' && typeof value.candidate === 'string'
    && typeof value.name === 'string' && Number.isFinite(value.updatedAt);
  function key(record) {
    if (!valid(record)) throw Error('Invalid recovery identity or record');
    return prefix + [record.account, record.project, record.doc, record.writer].join('.');
  }
  function read(name) {
    if (!name?.startsWith(prefix)) throw Error('Invalid recovery key');
    const record = JSON.parse(localStorage.getItem(name));
    if (!valid(record) || key(record) !== name) throw Error('Recovery copy is missing or malformed');
    return record;
  }
  function save(record) {
    const name = key(record), text = JSON.stringify(record);
    localStorage.setItem(name, text);
    if (localStorage.getItem(name) !== text) throw Error('Browser did not retain the recovery copy');
    return name;
  }
  function list(account, project) {
    if (!id(account) || !id(project)) throw Error('Invalid account/project');
    const start = prefix + account + '.' + project + '.', records = [];
    for (let n = 0; n < localStorage.length; n++) {
      const name = localStorage.key(n); if (!name?.startsWith(start)) continue;
      try { records.push({ key: name, record: read(name) }); } catch { /* Keep malformed copies untouched. */ }
    }
    return records.sort((a, b) => b.record.updatedAt - a.record.updatedAt);
  }
  function fork(record) {
    if (!valid(record)) throw Error('Invalid recovery copy');
    return { ...record, writer: randomUUID(), revision: 0, updatedAt: Date.now() };
  }
  function status(text, error = false) {
    if (!controls) return;
    const node = controls.querySelector('[role=status]'); node.textContent = text; node.title = text; node.dataset.error = String(error); controls.dataset.error = String(error);
  }
  // Routine confirmations go to the menu, not the toolbar, so typing does not flash messages.
  function note(text) { const node = controls?.querySelector('[data-recovery-note]'); if (node) node.textContent = text; }
  function meta(name) {
    const element = document.querySelector('meta[name="' + name + '"]');
    if (!element) return null;
    return ['json', 'number'].includes(element.dataset.type) ? JSON.parse(element.content) : element.content;
  }
  function scope(container) {
    const account = meta('ol-user_id'), clientProject = meta('ol-project_id'), doc = container.doc_id;
    const local = globalThis.overleafOfflineNative;
    const offline = location.pathname === '/recovery/native-workspace.html' && local?.account === account && local?.clientProject === clientProject;
    const project = offline ? local.project : clientProject;
    if (!id(account) || !id(project) || !id(doc) || (!offline && location.pathname !== '/project/' + project)) throw Error('Recovery identity is unavailable');
    return { account, project, doc };
  }
  function recordFor(container, text, name) {
    let entry = entries.get(container.doc_id);
    if (!entry) {
      const scoped = scope(container), doc = container.doc;
      const version = doc?.getVersion();
      const snapshot = doc?._doc?.snapshot;
      const raw = typeof snapshot?.toRaw === 'function' ? snapshot.toRaw() : snapshot;
      // Keep baseline text once; retain native review ranges without duplicating content.
      const savedSnapshot = raw === text ? undefined : raw?.content === text
        ? { ...raw, content: undefined, contentInBaseText: true } : raw;
      entry = { schema: 1, ...scoped, writer, revision: 0, name: typeof name === 'string' && name ? name : container.docName || scoped.doc + '.tex',
        base: { version, text, kind: doc?.type, snapshot: savedSnapshot },
        candidate: text, updatedAt: Date.now() };
      const localFile = globalThis.overleafOfflineNative?.file(container.doc_id);
      if (localFile) { entry.base = localFile.base; entry.workspace = globalThis.overleafOfflineNative.workspace; }
      // Freeze the baseline independently of subsequent engine mutations.
      entry = JSON.parse(JSON.stringify(entry));
      if (!valid(entry)) throw Error('Recovery baseline is unavailable');
    } else {
      const scoped = scope(container);
      if (entry.account !== scoped.account || entry.project !== scoped.project) throw Error('Recovery identity changed');
    }
    return entry;
  }
  function extension(State, Transaction, container, name) {
    return State.transactionFilter.of(tr => {
      if (!tr.docChanged || tr.annotation(Transaction.remote)) return tr;
      try {
        if (globalThis.overleafOfflineNative?.savingHeld) throw Error('Local saving is held');
        const previous = recordFor(container, tr.startState.doc.toString(), name);
        const next = { ...previous, revision: previous.revision + 1, candidate: tr.newDoc.toString(), updatedAt: Date.now() };
        const stored = save(next); entries.set(container.doc_id, next);
        globalThis.overleafSessionCheckpoint?.track(stored, next);
        note('Recovery copy of your latest edit saved in this browser.'); return tr;
      } catch {
        status('Edit paused: browser storage failed. Export your work or free browser storage.', true); return [];
      }
    });
  }
  async function offlineReady() {
    const build = globalThis.overleafRecoveryBuild;
    if (!build || !navigator.serviceWorker) throw Error('Offline workspace is unavailable in this browser');
    const registration = await navigator.serviceWorker.register('/recovery/recovery-sw.js', { scope: '/recovery/', updateViaCache: 'none' });
    const worker = registration.installing || registration.waiting || registration.active;
    if (!worker) throw Error('Offline workspace did not install');
    if (worker.state !== 'activated') await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Offline workspace installation timed out')), 20000);
      worker.addEventListener('statechange', () => {
        if (worker.state === 'activated') { clearTimeout(timer); resolve(); }
        if (worker.state === 'redundant') { clearTimeout(timer); reject(Error('Offline workspace installation failed')); }
      });
    });
    await new Promise((resolve, reject) => {
      const channel = new MessageChannel(), timer = setTimeout(() => { channel.port1.close(); reject(Error('Offline cache did not respond')); }, 5000);
      channel.port1.onmessage = e => { clearTimeout(timer); channel.port1.close(); e.data?.version === build.version ? resolve() : reject(Error('Offline cache version mismatch')); };
      worker.postMessage({ type: 'VERSION' }, [channel.port2]);
    });
  }
  async function openLocal() {
    try {
      if (!current?.container.doc || current.container.doc.hasBufferedOps()) throw Error('Wait for shared edits to finish saving before switching');
      const text = current.facade.getValue(), previous = recordFor(current.container, text, current.name);
      const record = { ...previous, candidate: text, updatedAt: Date.now() };
      const name = save(record); entries.set(record.doc, record);
      status('Preparing offline workspace…'); await offlineReady();
      location.assign('/recovery/local-workspace.html#' + encodeURIComponent(name));
    } catch (error) { status(error.message, true); }
  }
  async function prepareCompiler(progress = () => {}, paths = []) {
    await offlineReady();
    const registration = await navigator.serviceWorker.getRegistration('/recovery/');
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => { channel.port1.close(); reject(Error('Compiler preparation timed out; local projects are retained')); }, 1200000);
      channel.port1.onmessage = event => {
        if (event.data?.progress) { progress(event.data.progress); return; }
        clearTimeout(timer); channel.port1.close();
        event.data?.ready ? resolve(event.data) : reject(Error(event.data?.error || 'Compiler preparation failed'));
      };
      const observed = performance.getEntriesByType('resource').map(entry => new URL(entry.name)).filter(url => url.origin === location.origin).map(url => url.pathname);
      registration.active.postMessage({ type: 'PREPARE_COMPILER', paths: [...paths, ...observed] }, [channel.port2]);
    });
  }
  function reviewSnapshot(record) {
    if (!valid(record) || !current) throw Error('Recovery copy is unavailable');
    const { facade, container } = current, identity = scope(container), doc = container.doc;
    if (['account', 'project', 'doc'].some(name => identity[name] !== record[name])) throw Error('Open this copy with its own account, project and document');
    if (!container.socket.socket.connected || !doc || doc.hasBufferedOps()) throw Error('Wait for the shared document to connect and finish saving');
    const version = doc.getVersion(), text = facade.getValue();
    if (!Number.isSafeInteger(version) || version < record.base.version || facade.view.state.readOnly) throw Error('This document is not ready for editing');
    return { ...identity, version, text, facade, container };
  }
  function applyReviewed(record, reviewed, text) {
    if (typeof text !== 'string' || text.length > 2000000 || /[\uD800-\uDFFF\0]/.test(text)) throw Error('Resolution exceeds the supported text limits');
    // Preserve both sides even when a later stale-review check refuses the apply.
    save(fork({ ...record, candidate: text }));
    const now = reviewSnapshot(record);
    if (now.container !== reviewed.container || now.facade !== reviewed.facade || now.version !== reviewed.version || now.text !== reviewed.text)
      throw Error('The shared document changed. Refresh the shared version and review again. Your resolution is kept.');
    const parts = globalThis.Diff?.diffLines(now.text, text, { timeout: 75, maxEditLength: 2000 });
    if (!parts || parts.filter(p => !p.added).map(p => p.value).join('') !== now.text || parts.filter(p => !p.removed).map(p => p.value).join('') !== text)
      throw Error('Comparison is too large; export your retained resolution for review');
    save(fork({ ...record, candidate: now.text }));
    let offset = 0, change;
    const changes = [];
    for (const part of parts) {
      if (part.added || part.removed) {
        if (!change) changes.push(change = { from: offset, to: offset, insert: '' });
        if (part.removed) { offset += part.value.length; change.to = offset; }
        else change.insert += part.value;
      } else { offset += part.value.length; change = undefined; }
    }
    if (changes.length) now.facade.cmChange(changes);
    if (now.facade.getValue() !== text) throw Error('The editor refused the change. Your resolution is kept.');
  }
  async function openReview(key) {
    try {
      if (!globalThis.overleafRecoveryReview) await new Promise((resolve, reject) => {
        const script = document.createElement('script'); script.src = '/recovery/review.js?v=' + globalThis.overleafRecoveryBuild.version;
        script.onload = resolve; script.onerror = () => { script.remove(); reject(Error('Review interface did not load; copies are kept')); }; document.head.append(script);
      });
      await globalThis.overleafRecoveryReview(key);
    } catch (error) { status(error.message, true); }
  }
  async function prepareProject() {
    try {
      const record = recordFor(current.container, current.facade.getValue(), current.name), before = reviewSnapshot(record);
      status('Saving the complete project for offline use…');
      if (!globalThis.overleafLocalProjects) await new Promise((resolve, reject) => {
        const script = document.createElement('script'); script.src = '/recovery/project-store.js?v=' + globalThis.overleafRecoveryBuild.version;
        script.onload = resolve; script.onerror = () => { script.remove(); reject(Error('Offline project storage did not load')); }; document.head.append(script);
      });
      const response = await fetch('/project/' + before.project + '/participant-compile', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': meta('ol-csrfToken') },
        body: JSON.stringify({ op: 'prepare-offline', docId: before.doc, version: before.version, text: before.text }),
      });
      if (!response.ok) throw Error('Offline preparation refused or source changed; your shared project is unchanged');
      const payload = await response.json(), after = reviewSnapshot(record);
      if (before.container !== after.container || before.version !== after.version || before.text !== after.text) throw Error('Source changed; prepare the project again');
      const pdfUrl = performance.getEntriesByType('resource').map(entry => entry.name).reverse().find(name => {
        const url = new URL(name); return url.origin === location.origin && url.pathname.startsWith('/project/' + before.project + '/') && /\/output\/output\.pdf$/.test(url.pathname);
      });
      let pdf;
      if (pdfUrl) { const result = await fetch(pdfUrl, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' }); if (result.ok) pdf = await result.blob(); }
      await offlineReady();
      const publicUrl = value => { const url = new URL(value, location.href); return url.origin === location.origin && /^\/(js|stylesheets|fonts)\//.test(url.pathname) ? url.pathname : null; };
      let projectMeta = {};
      try {
        const response = await fetch('/project/' + before.project + '/metadata', { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
        if (response.ok) projectMeta = (await response.json()).projectMeta || {};
      } catch { /* Completion metadata is optional; exact project files remain authoritative. */ }
      const native = { meta: [...document.querySelectorAll('meta[name^="ol-"]')].filter(node => !/csrf|token|session|analytics/i.test(node.name)).map(node => ({ name: node.name, content: node.content, present: node.hasAttribute('content'), type: node.dataset.type })),
        scripts: [...document.querySelectorAll('script[src]')].map(node => publicUrl(node.src)).filter(Boolean),
        styles: [...document.querySelectorAll('link[rel="stylesheet"]')].map(node => publicUrl(node.href)).filter(Boolean),
        resources: performance.getEntriesByType('resource').map(entry => publicUrl(entry.name)).filter(Boolean), projectMeta };
      const key = await globalThis.overleafLocalProjects.create(payload, before.account, before.project, pdf, native);
      status('Project recovery copy saved in this browser.'); return key;
    } catch (error) { status(error.message, true); }
  }
  function attach(facade, container, name) {
    current = { facade, container, name };
    if (globalThis.overleafOfflineNative) { globalThis.overleafOfflineNative.attach(facade, container, name); return; }
    try { globalThis.overleafSessionCheckpoint?.start(scope(container)); } catch { /* Missing identity keeps recovery copies local. */ }
    if (location.hash?.startsWith('#recovery=') && location.hash !== offeredReview) {
      offeredReview = location.hash; queueMicrotask(() => openReview(decodeURIComponent(location.hash.slice(10))));
    }
    if (controls?.isConnected) return;
    const ui = globalThis.overleafOfflineToolbar;
    if (!ui) {
      // The toolbar helper is a pinned public file; load it once, then build the controls.
      if (!toolbarLoading) {
        toolbarLoading = true; const script = document.createElement('script'); script.src = '/recovery/offline-toolbar.js';
        script.onload = () => attach(current.facade, current.container, current.name); script.onerror = () => { toolbarLoading = false; };
        (document.head || document.body).append(script);
      }
      return;
    }
    ui.stylesheet();
    try { const settings = meta('ol-userSettings'); if (typeof settings?.overallTheme === 'string') ui.theme(settings.overallTheme); } catch { /* theme is cosmetic */ }
    controls = document.createElement('div'); controls.className = 'recovery-controls olx-bar olx-native'; controls.setAttribute('aria-label', 'Workspace connection and recovery');
    const state = document.createElement('span'); state.setAttribute('role', 'status'); state.setAttribute('aria-live', 'polite'); controls.append(state);
    const trigger = ui.button({ className: 'olx-chip', iconName: 'cloud_done', label: 'Offline', ariaLabel: 'Offline and recovery options' });
    const head = document.createElement('div'); head.className = 'olx-menu-head';
    const dot = document.createElement('span'); dot.className = 'olx-dot'; const headText = document.createElement('div');
    const title = document.createElement('strong'), detail = document.createElement('small'); detail.dataset.recoveryNote = '';
    detail.textContent = 'Recovery copies of your edits are kept in this browser.'; headText.append(title, detail); head.append(dot, headText);
    const connected = online => {
      title.textContent = online ? 'Connected' : 'Disconnected'; dot.dataset.state = online ? 'connected' : 'disconnected';
      trigger.dataset.tone = online ? 'connected' : 'disconnected'; trigger.querySelector('.olx-icon').textContent = online ? 'cloud_done' : 'cloud_off';
    };
    connected(container.socket.socket.connected);
    container.socket.on('disconnect', () => connected(false));
    container.socket.on('joinProjectResponse', () => connected(true));
    const workOffline = async () => {
      trigger.disabled = true;
      try {
        const workspace = await prepareProject(); if (!workspace) return;
        const saved = await globalThis.overleafLocalProjects.read(workspace);
        await prepareCompiler(message => status(message), saved.project.native.resources);
        location.assign('/recovery/native-workspace.html#' + workspace);
      } catch (error) { status(error.message + '. Saved project files are retained.', true); }
      finally { trigger.disabled = false; }
    };
    const { list: menuList } = ui.menu(trigger, [
      { header: head }, 'divider',
      { icon: 'offline_pin', label: 'Work offline', description: 'Save this project with its compiler, then open it in this editor without a connection', onClick: workOffline },
      { icon: 'folder_open', label: 'Saved projects', description: 'Open or create projects stored in this browser', onClick: () => location.assign('/recovery/project-workspace.html') },
      'divider',
      { icon: 'compare_arrows', label: 'Review local changes', description: 'Compare text saved in this browser with the shared version', onClick: () => openReview() },
      { icon: 'history', label: 'Recovery copies', description: 'View, export or delete copies of this document', onClick: openLocal },
    ]);
    const wrap = document.createElement('div'); wrap.className = 'olx-menu-wrap'; wrap.append(trigger, menuList); controls.append(wrap);
    ui.mount(controls);
  }
  globalThis.overleafRecovery = Object.freeze({ prefix, valid, key, read, save, list, fork, extension, attach, offlineReady, reviewSnapshot, applyReviewed,
    prepareProject, prepareCompiler, currentScope: () => scope(current.container) });
})();
