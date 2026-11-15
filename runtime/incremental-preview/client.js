// SPDX-License-Identifier: AGPL-3.0-only
(() => {
  const recovery = globalThis.overleafRecovery;
  if (!recovery || globalThis.overleafLivePreview) return;
  let current, session, enabled = false, failed = false, busy = false, epoch = 0, pending = false, button, panel, image, caption, lastFrame;
  const encoder = new TextEncoder();
  function csrf() { const raw = document.querySelector('meta[name="ol-csrfToken"]')?.content || document.querySelector('meta[name="csrf-token"]')?.content; try { return JSON.parse(raw); } catch { return raw; } }
  async function request(body, keepalive = false) {
    const project = location.pathname.match(/^\/project\/([a-f0-9]{24})/)?.[1]; if (!project) throw Error('Project unavailable');
    const response = await fetch(`/project/${project}/live-preview`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() }, body: JSON.stringify({ livePreview: body }), keepalive });
    if (!response.ok) throw Error('Live preview unavailable; PDF remains available.');
    return response.status === 204 ? null : response.json();
  }
  function close() { const old = session; session = null; lastFrame = null; epoch++; panel?.remove(); panel = null; if (old) request({ op: 'close', token: old.token }, true).catch(() => {}); }
  function status(message) { if (button) button.title = message; if (caption) caption.textContent = message; }
  function editor() { return document.querySelector('[aria-label^="Source Editor"]')?.cmView?.view; }
  function sourceLine() { const view = editor(); return view ? view.state.doc.lineAt(view.state.selection.main.head).number : 1; }
  function diff(before, after) {
    let from = 0, a = before.length, b = after.length;
    while (from < a && from < b && before[from] === after[from]) from++;
    if (from > 0 && /[\uDC00-\uDFFF]/.test(before[from] || after[from] || '')) from--;
    while (a > from && b > from && before[a - 1] === after[b - 1]) { a--; b--; }
    if (a < before.length && /[\uDC00-\uDFFF]/.test(before[a] || '')) { a++; b++; }
    return { offset: encoder.encode(before.slice(0, from)).length, remove: encoder.encode(before.slice(from, a)).length, insert: after.slice(from, b) };
  }
  async function show(frame, identity) {
    const next = new Image(); next.alt = 'Live typeset page'; next.src = 'data:image/png;base64,' + frame.png; await next.decode();
    if (!enabled || identity !== epoch || !current || session?.text !== current.facade.getValue()) return;
    const host = document.querySelector('[data-testid="pdf-viewer"]'); if (!host) return;
    if (!panel?.isConnected) {
      host.style.position = 'relative'; panel = document.createElement('div'); panel.setAttribute('aria-label', 'Live preview');
      panel.style.cssText = 'position:absolute;inset:0;z-index:5;overflow:auto;background:#ddd;display:flex;flex-direction:column;align-items:center';
      caption = document.createElement('div'); caption.setAttribute('role', 'status'); caption.style.cssText = 'position:sticky;top:0;align-self:stretch;padding:5px 10px;background:#fff;color:#333;border-bottom:1px solid #bbb;font:12px system-ui;z-index:1'; panel.append(caption); host.append(panel);
    }
    next.style.cssText = 'display:block;width:min(100%,816px);height:auto;background:white;box-shadow:0 1px 4px #888';
    next.addEventListener('dblclick', jump); image?.remove(); image = next; panel.append(next); lastFrame = frame;
    caption.textContent = `Live page ${frame.page + 1} · Final PDF updates separately`;
    panel.dataset.revision = String(frame.revision); panel.dataset.page = String(frame.page + 1);
    document.dispatchEvent(new CustomEvent('overleaf:live-frame', { detail: { revision: frame.revision, page: frame.page + 1 } }));
  }
  async function jump(event) {
    if (!lastFrame || !session || busy || session.text !== current?.facade.getValue()) return;
    const bounds = image.getBoundingClientRect(), frame = lastFrame;
    const x = (event.clientX - bounds.left) * frame.width / bounds.width, y = (event.clientY - bounds.top) * frame.height / bounds.height;
    try {
      busy = true;
      const result = await request({ op: 'jump', token: session.token, revision: frame.revision, page: frame.page, x, y });
      if (frame !== lastFrame || session?.text !== current.facade.getValue()) return;
      if (result.path !== session.active) { status('Open the included source file to follow this location.'); return; }
      const view = editor(); if (!view) return;
      const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, result.line)));
      let selected = '';
      for (const block of frame.text.blocks || []) for (const item of block.lines || []) {
        const box = item.bbox; if (!box) continue;
        const left = box.x ?? box[0], top = box.y ?? box[1], width = box.w ?? box[2] - left, height = box.h ?? box[3] - top;
        if (x >= left && x <= left + width && y >= top && y <= top + height) {
          selected = item.text || ''; const label = selected.match(/^(\d+)\.\s/);
          if (label && x - left < 20) selected = '\0question:' + label[1];
        }
      }
      const refined = globalThis.overleafSynctexSelection?.refine(view, line.from, selected, () => null);
      view.dispatch({ selection: { anchor: refined?.from ?? line.from, head: refined?.to ?? line.from }, scrollIntoView: true }); view.focus();
    } catch { status('Source location unavailable. Use the final PDF navigation.'); }
    finally { busy = false; if (pending) pump(); }
  }
  let refreshPending = false;
  async function refresh() {
    if (!session || !enabled || busy) { refreshPending = true; return; }
    refreshPending = false; const token = session.token;
    try { const result = await request({ op: 'refresh', token, line: 1 }); if (result.restart && session?.token === token) { close(); pending = true; pump(); } }
    catch { if (session?.token === token) { close(); failed = true; status('Live preview unavailable. Use the final PDF.'); } }
  }
  const observer = new PerformanceObserver(list => { if (list.getEntries().some(entry => { try { const url = new URL(entry.name); return url.origin === location.origin && /\/output\/output\.pdf(?:\?|$)/.test(url.pathname); } catch { return false; } })) refresh(); });
  observer.observe({ type: 'resource', buffered: true });
  async function pump() {
    if (!enabled || failed || busy || !current) return;
    pending = false; busy = true; const identity = epoch, selected = current, text = selected.facade.getValue(), line = sourceLine();
    try {
      status('Preparing live preview…');
      if (!session) {
        const result = await request({ op: 'start', docId: selected.container.doc_id, text, line });
        if (identity !== epoch || !enabled || current !== selected) { request({ op: 'close', token: result.token }, true).catch(() => {}); return; }
        session = { token: result.token, active: result.active, revision: result.frame.revision, text };
        await show(result.frame, identity);
      } else {
        const result = await request({ op: 'edit', token: session.token, base: session.revision, revision: session.revision + 1, ...diff(session.text, text), line });
        if (identity !== epoch || !session || current !== selected) return;
        session.text = text; session.revision = result.frame.revision; await show(result.frame, identity);
      }
    } catch {
      if (identity === epoch) { failed = true; close(); status('Live preview unavailable. Final PDF remains available.'); if (button) button.textContent = 'Retry live preview'; }
    } finally {
      busy = false;
      if (refreshPending) refresh();
      if (enabled && !failed && (pending || current?.facade.getValue() !== session?.text)) queueMicrotask(pump);
    }
  }
  function attach(facade, container, name) {
    if (current?.container !== container) { close(); failed = false; current = { facade, container, name }; pending = true; }
    if (!button?.isConnected) {
      button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-sm btn-secondary'; button.textContent = enabled ? 'Show final PDF' : 'Live preview';
      button.addEventListener('click', () => { if (failed) { failed = false; enabled = true; } else enabled = !enabled; button.textContent = enabled ? 'Show final PDF' : 'Live preview'; if (!enabled) close(); else { pending = true; pump(); } });
      document.querySelector('.recovery-controls')?.append(button);
    }
    queueMicrotask(pump);
  }
  globalThis.overleafRecovery = Object.freeze({ ...recovery,
    attach(...args) { recovery.attach(...args); attach(...args); },
    extension(State, Transaction, container, name) { return [recovery.extension(State, Transaction, container, name), State.transactionExtender.of(tr => {
      if (tr.docChanged || tr.selection) queueMicrotask(() => { if (current?.container === container) { pending = true; pump(); } }); return null;
    })]; }
  });
  globalThis.overleafLivePreview = Object.freeze({ diff });
  addEventListener('pagehide', close);
})();
