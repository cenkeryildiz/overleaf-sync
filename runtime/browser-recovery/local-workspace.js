// SPDX-License-Identifier: AGPL-3.0-only
(() => {
  'use strict';
  const api = globalThis.overleafRecovery, status = document.querySelector('#status');
  const report = (text, error = false) => { status.textContent = text; status.dataset.error = String(error); };
  const buttons = [...document.querySelectorAll('button')];
  let selected, draft, view, State, View, commands, keymap;
  const choice = document.querySelector('#copies');
  const comparison = document.querySelector('#comparison'), changes = document.querySelector('#changes'), summary = document.querySelector('#comparison-summary');
  function clearComparison() { comparison.hidden = true; changes.replaceChildren(); }
  function refresh() {
    const old = selected;
    const records = api.list(draft.account, draft.project);
    choice.replaceChildren();
    for (const { key, record } of records) {
      const option = document.createElement('option'); option.value = key; option.textContent = record.name + ' · ' + new Date(record.updatedAt).toLocaleString(); choice.append(option);
    }
    choice.value = old;
  }
  function open(name) {
    const record = api.read(name);
    if (draft && (record.account !== draft.account || record.project !== draft.project)) throw Error('Copy belongs to a different account or project');
    selected = name; draft = api.fork(record);
    clearComparison();
    document.querySelector('#filename').textContent = record.name;
    view?.destroy();
    view = new View({ parent: document.querySelector('#editor'), state: State.create({ doc: record.candidate, extensions: [
      View.lineWrapping, commands.b6(), keymap.of([
        { key: 'Mod-z', run: commands.tN }, { key: 'Mod-Shift-z', run: commands.ZS }, { key: 'Mod-y', run: commands.ZS },
        // Native command keymaps are identified by the pinned bundle generator.
        ...globalThis.overleafLocalKeymap,
      ]), View.contentAttributes.of({ 'aria-label': 'Local source editor' }),
      State.transactionFilter.of(tr => {
        if (!tr.docChanged) return tr;
        if (/[\uD800-\uDFFF\0]/.test(tr.newDoc.toString())) { report('This editor cannot retain emoji or supplementary characters yet. The edit was not applied.', true); return []; }
        try {
          const next = { ...draft, candidate: tr.newDoc.toString(), revision: draft.revision + 1, updatedAt: Date.now() };
          const saved = api.save(next); draft = next; selected = saved;
          // Preserve the pre-edit copy; other tabs have distinct writer identities.
          queueMicrotask(() => { location.replace('#' + encodeURIComponent(saved)); refresh(); clearComparison(); }); report('Saved in this browser. Not sent to the server.'); return tr;
        } catch { report('Edit paused: browser storage failed. Export your work or free browser storage.', true); return []; }
      }),
    ] }) });
    location.replace('#' + encodeURIComponent(name)); refresh(); report('Local copy opened. No server changes were made.');
  }
  function download(bytes, type, extension) {
    const blob = new Blob([bytes], { type }), url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = draft.name.replace(/[\\/:\x00-\x1f]/g, '_') + extension; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  try {
    const name = decodeURIComponent(location.hash.slice(1));
    // Load only the existing native CodeMirror modules; no application/auth bootstrap.
    self.webpackChunk_overleaf_web.push([[989001], {}, require => {
      State = require(13591).$t; const nativeView = require(19472); View = nativeView.Lz; keymap = nativeView.w4; commands = require(78147);
      globalThis.overleafLocalKeymap = Object.values(commands).find(value => Array.isArray(value) && value.some(binding => binding.key === 'Enter') && value.some(binding => binding.key === 'ArrowLeft')) || [];
    }]);
    if (!State || !View || !commands?.b6 || !globalThis.overleafLocalKeymap.length) throw Error('Native editor modules did not load');
    open(name);
    choice.addEventListener('change', () => { try { open(choice.value); } catch (error) { report(error.message, true); } });
    document.querySelector('#undo').onclick = () => { commands.tN(view); view.focus(); };
    document.querySelector('#redo').onclick = () => { commands.ZS(view); view.focus(); };
    document.querySelector('#export').onclick = () => download(view.state.doc.toString(), 'text/plain;charset=utf-8', '');
    document.querySelector('#export-record').onclick = () => download(JSON.stringify(draft, null, 2), 'application/json', '.recovery.json');
    document.querySelector('#compare').onclick = () => {
      clearComparison(); comparison.hidden = false;
      const original = draft.base.text, current = view.state.doc.toString();
      summary.textContent = 'Comparison unavailable. Your copies are kept; export text to compare externally.';
      // Bound optional review work; editing, storage and export remain available.
      if (original.length + current.length > 500000) return;
      try {
        const parts = globalThis.Diff?.diffLines(original, current, { timeout: 75, maxEditLength: 2000 });
        if (!parts) return;
        let added = 0, removed = 0;
        const output = document.createDocumentFragment();
        for (const part of parts) {
          const span = document.createElement('span');
          span.dataset.change = part.added ? 'added' : part.removed ? 'removed' : 'unchanged';
          span.textContent = part.value.replace(/^(?=[\s\S])/gm, part.added ? '+ ' : part.removed ? '- ' : '  ');
          if (part.added) added += part.count;
          if (part.removed) removed += part.count;
          output.append(span);
        }
        summary.textContent = added || removed ? `${added} added, ${removed} removed line(s). + added; - removed. This compares with the saved version when this copy began, not the current server.` : 'No changes from the saved version when this copy began.';
        changes.replaceChildren(output);
      } catch { /* A failed comparison must not affect retained source. */ }
    };
    document.querySelector('#delete').onclick = () => {
      if (!confirm('Delete this selected recovery copy from this browser? Export it first if you need to keep it.')) return;
      localStorage.removeItem(selected); const next = api.list(draft.account, draft.project)[0];
      if (next) open(next.key); else { view.destroy(); clearComparison(); choice.replaceChildren(); buttons.forEach(b => b.disabled = b.id !== 'connect'); report('No local copies remain for this project.'); }
    };
    document.querySelector('#connect').onclick = () => { location.assign('/project/' + draft.project + '#recovery=' + encodeURIComponent(selected)); };
  } catch (error) { buttons.forEach(button => button.disabled = true); report(error.message + '. Existing browser copies were kept.', true); }
})();
