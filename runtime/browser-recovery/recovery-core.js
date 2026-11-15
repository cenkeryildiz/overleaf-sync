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
  let current, controls;
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
    if (controls) { controls.querySelector('[role=status]').textContent = text; controls.dataset.error = String(error); }
  }
  function meta(name) {
    const element = document.querySelector('meta[name="' + name + '"]');
    if (!element) return null;
    return ['json', 'number'].includes(element.dataset.type) ? JSON.parse(element.content) : element.content;
  }
  function scope(container) {
    const account = meta('ol-user_id'), project = meta('ol-project_id'), doc = container.doc_id;
    if (!id(account) || !id(project) || !id(doc) || location.pathname !== '/project/' + project) throw Error('Recovery identity is unavailable');
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
        const previous = recordFor(container, tr.startState.doc.toString(), name);
        const next = { ...previous, revision: previous.revision + 1, candidate: tr.newDoc.toString(), updatedAt: Date.now() };
        save(next); entries.set(container.doc_id, next); status('Recovery copy saved in this browser'); return tr;
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
  function attach(facade, container, name) {
    current = { facade, container, name };
    if (controls?.isConnected) return;
    controls = document.createElement('div'); controls.className = 'recovery-controls'; controls.setAttribute('aria-label', 'Workspace connection and recovery');
    const connection = document.createElement('span'); connection.textContent = container.socket.socket.connected ? 'Connected' : 'Disconnected'; controls.append(connection);
    container.socket.on('disconnect', () => { connection.textContent = 'Disconnected'; });
    container.socket.on('joinProjectResponse', () => { connection.textContent = 'Connected'; });
    const state = document.createElement('span'); state.setAttribute('role', 'status'); state.textContent = 'Recovery ready'; controls.append(state);
    const local = document.createElement('button'); local.type = 'button'; local.className = 'btn btn-sm btn-secondary'; local.textContent = 'Local only'; local.addEventListener('click', openLocal); controls.append(local);
    const copies = document.createElement('button'); copies.type = 'button'; copies.className = 'btn btn-sm btn-secondary'; copies.textContent = 'Recovery copies'; copies.addEventListener('click', async () => {
      try { const scoped = scope(current.container), first = list(scoped.account, scoped.project)[0]; if (!first) { status('No recovery copies yet'); return; } await offlineReady(); location.assign('/recovery/local-workspace.html#' + encodeURIComponent(first.key)); } catch (error) { status(error.message, true); }
    }); controls.append(copies);
    controls.style.cssText = 'position:fixed;bottom:8px;right:16px;z-index:1000;display:flex;gap:8px;align-items:center;padding:6px;background:var(--bg-primary,#fff);color:var(--content-primary,#333);border:1px solid #bbb;border-radius:5px;font:12px system-ui;max-width:90vw';
    document.body.append(controls);
  }
  globalThis.overleafRecovery = Object.freeze({ prefix, valid, key, read, save, list, fork, extension, attach, offlineReady });
})();
