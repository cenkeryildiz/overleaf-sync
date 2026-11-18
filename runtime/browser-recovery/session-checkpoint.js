// SPDX-License-Identifier: AGPL-3.0-only
// Recovery source stays local until the native server proves the same version is durable.
(() => {
  'use strict';
  if (globalThis.overleafSessionCheckpoint) return;
  const recoveryPrefix = 'overleaf.recovery.v1.', markerPrefix = 'overleaf.checkpoint.v1.';
  const owned = new Map(), claiming = new Map(), unproven = new Set();
  let scope, timer, inflight;
  const id = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
  const hex = bytes => [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
  const marker = key => markerPrefix + key.slice(recoveryPrefix.length);
  const report = state => { try { dispatchEvent(new CustomEvent('overleaf-durability', { detail: { state } })); } catch { /* Display only. */ } };
  function live(expected = scope) {
    if (!expected || globalThis.overleafOfflineNative || location.pathname !== '/project/' + expected.project) return false;
    const node = document.querySelector('meta[name="ol-user_id"]');
    let account = node?.content;
    try { if (node?.dataset.type === 'json') account = JSON.parse(account); } catch { return false; }
    return account === expected.account;
  }
  function record(key, raw) {
    const value = JSON.parse(raw);
    if (!globalThis.overleafRecovery?.valid(value) || value.workspace || value.account !== scope?.account || value.project !== scope?.project ||
        key !== recoveryPrefix + [value.account, value.project, value.doc, value.writer].join('.')) throw Error('Unowned recovery copy');
    return value;
  }
  function prepare(item) {
    if (item.hashing) return item.hashing;
    const raw = item.raw;
    item.hashing = (async () => {
      const value = record(item.key, raw), hash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value.candidate)));
      if (item.raw === raw) item.ready = { raw, id: value.doc, hash, revision: value.revision };
    })().catch(() => {}).finally(() => {
      item.hashing = undefined;
      if (item.raw !== raw) void prepare(item);
    });
    return item.hashing;
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void flush(); }, 30000);
  }
  function claim(key, retry) {
    if (claiming.has(key)) return;
    const locks = navigator.locks;
    // Without cross-tab locks only this page's fresh records may be cleaned; old markers stay recoverable.
    if (retry && !locks?.request) return;
    let entered;
    const acquired = new Promise(resolve => { entered = resolve; });
    claiming.set(key, acquired);
    const hold = lock => {
      if (!lock || !live()) { entered(); return; }
      try {
        const raw = localStorage.getItem(key);
        if (raw === null && retry && key.startsWith(recoveryPrefix + scope.account + '.' + scope.project + '.')) {
          localStorage.removeItem(marker(key)); entered(); return;
        }
        record(key, raw);
        const item = { key, raw };
        const held = new Promise(resolve => { item.release = resolve; });
        localStorage.setItem(marker(key), JSON.stringify({ key }));
        owned.set(key, item);
        void prepare(item); schedule(); entered();
        return held;
      } catch { entered(); }
    };
    if (locks?.request) void locks.request('overleaf-checkpoint:' + key, { ifAvailable: true }, hold).catch(() => entered());
    else void hold(true);
    void acquired.finally(() => claiming.delete(key));
  }
  function start(next) {
    if (!id(next?.account) || !id(next?.project) || !live(next)) return;
    if (scope && (scope.account !== next.account || scope.project !== next.project)) return;
    scope = { account: next.account, project: next.project };
    const prefix = markerPrefix + scope.account + '.' + scope.project + '.';
    try {
      for (let index = 0; index < localStorage.length; index++) {
        const name = localStorage.key(index); if (!name?.startsWith(prefix)) continue;
        const pending = JSON.parse(localStorage.getItem(name));
        if (typeof pending?.key === 'string' && marker(pending.key) === name && !owned.has(pending.key)) claim(pending.key, true);
      }
    } catch { /* Unreadable markers never authorize source removal. */ }
  }
  function track(key, value) {
    try {
      if (!live() || !key.startsWith(recoveryPrefix) || value.workspace) return;
      const raw = localStorage.getItem(key); record(key, raw); unproven.add(key);
      const item = owned.get(key);
      if (item) { item.raw = raw; void prepare(item); schedule(); }
      else claim(key, false);
    } catch { /* Checkpoint failure must not weaken the synchronous recovery write. */ }
  }
  async function checkpoint(keepalive) {
    const expected = scope;
    if (!live(expected)) return;
    if (!keepalive) {
      await Promise.all(claiming.values());
      await Promise.all([...owned.values()].map(prepare));
    }
    const selected = new Map(), captured = [];
    for (const item of owned.values()) {
      const ready = item.ready;
      if (!ready || ready.raw !== item.raw || localStorage.getItem(item.key) !== ready.raw) continue;
      selected.set(ready.id, ready);
    }
    const docs = [...selected.values()].slice(0, 32).map(({ id, hash }) => ({ id, hash }));
    if (!docs.length) return;
    for (const item of owned.values()) if (item.ready && docs.some(doc => doc.id === item.ready.id && doc.hash === item.ready.hash)) captured.push({ item, ...item.ready });
    const body = JSON.stringify({ op: 'checkpoint', docs });
    if (new TextEncoder().encode(body).length > 8192) return;
    if (typeof AbortController !== 'function') return;
    const csrf = document.querySelector('meta[name="ol-csrfToken"]')?.content;
    let token = csrf; try { token = JSON.parse(csrf); } catch { /* Native metadata also permits raw strings. */ }
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/project/' + expected.project + '/participant-compile', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', keepalive, signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body });
      if (!response.ok) return;
      const proof = (await response.json()).checkpoint;
      if (controller.signal.aborted || !live(expected) || !proof || proof.durable !== true || proof.project !== expected.project || proof.user !== expected.account ||
          !Number.isSafeInteger(proof.version) || proof.version < 0 || !Array.isArray(proof.documents) || proof.documents.length !== docs.length ||
          new Set(proof.documents.map(doc => doc.id)).size !== docs.length || proof.documents.some(doc => !Number.isSafeInteger(doc.version) || doc.version < 0 || !docs.some(want => want.id === doc.id && want.hash === doc.hash))) return;
      for (const { item, raw, revision } of captured) {
        if (item.raw !== raw || localStorage.getItem(item.key) !== raw || record(item.key, raw).revision !== revision) continue;
        localStorage.removeItem(item.key);
        if (localStorage.getItem(item.key) !== null) continue;
        localStorage.removeItem(marker(item.key)); owned.delete(item.key); unproven.delete(item.key); item.release?.();
      }
      // Server-durable only once every edit this page tracked was proven and removed.
      if (!unproven.size && captured.length) report('server');
    } finally { clearTimeout(deadline); }
  }
  function flush({ keepalive = false } = {}) {
    if (inflight) return inflight;
    clearTimeout(timer); timer = undefined;
    inflight = checkpoint(keepalive).catch(() => {}).finally(() => {
      inflight = undefined;
      if (owned.size && live()) schedule();
    });
    return inflight;
  }
  addEventListener('pagehide', () => { void flush({ keepalive: true }); });
  addEventListener('online', schedule);
  const leaving = event => {
    const target = event.target?.closest?.('a[href],form[action]');
    if (!target) return;
    try { if (/\/logout\/?$/.test(new URL(target.href || target.action, location.href).pathname)) void flush({ keepalive: true }); } catch { /* Not a sign-out navigation. */ }
  };
  document.addEventListener('click', leaving, true);
  document.addEventListener('submit', leaving, true);
  globalThis.overleafSessionCheckpoint = Object.freeze({ start, track, flush });
})();
