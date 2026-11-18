// SPDX-License-Identifier: AGPL-3.0-only
(async () => {
  const api = globalThis.overleafLocalProjects, report = (text, error = false) => {
    const status = document.querySelector('#status'); status.textContent = text; status.dataset.error = error;
  };
  let project, files, file, view, State, View, commands, keymap, saving, failure, compiler, compiling, navigation, modules, pdfDocument, observer;
  const pdfStatus = text => { document.querySelector('#pdf-status').textContent = text; };
  function stale() { navigation = undefined; pdfStatus('Source changed. The PDF is from an earlier compilation. Recompile to update it and enable source jumps.'); }
  function download(bytes, name, type = 'application/octet-stream') {
    const url = URL.createObjectURL(new Blob([bytes], { type })), link = document.createElement('a');
    link.href = url; link.download = name.split('/').at(-1); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function unsaved() { return Boolean(view && (saving || view.state.doc.toString() !== file.content)); }
  async function flush() {
    if (failure) throw failure;
    if (saving) return saving;
    saving = (async () => {
      while (view && file.doc && view.state.doc.toString() !== file.content) {
        const text = view.state.doc.toString(); report('Saving in this browser…');
        const next = await api.save(file, text); files.set(next.path, next); file = next;
      }
      report('Saved in this browser. Shared project unchanged.');
    })().catch(error => { failure = error; report(error.message + ' Export your text before closing.', true); throw error; })
      .finally(() => { saving = undefined; });
    return saving;
  }
  async function open(path) {
    await flush(); const next = files.get(path); if (!next) throw Error('Saved file is missing');
    view?.destroy(); view = undefined; file = next; failure = undefined;
    document.querySelector('#filename').textContent = path;
    for (const button of document.querySelectorAll('#files button')) button.setAttribute('aria-current', String(button.dataset.path === path));
    const host = document.querySelector('#editor'); host.replaceChildren();
    for (const name of ['undo', 'redo', 'connect']) document.querySelector('#' + name).disabled = !file.doc;
    if (!file.doc) { host.textContent = 'Binary asset retained in this project. Use Export file to download its original bytes.'; return; }
    view = new View({ parent: host, state: State.create({ doc: file.content, extensions: [View.lineWrapping, commands.b6(), keymap.of([
      { key: 'Mod-z', run: commands.tN }, { key: 'Mod-Shift-z', run: commands.ZS }, { key: 'Mod-y', run: commands.ZS }, ...globalThis.overleafLocalKeymap,
    ]), View.contentAttributes.of({ 'aria-label': 'Offline source editor' }),
    State.transactionFilter.of(tr => {
      if (!tr.docChanged) return tr;
      if (failure || /[\uD800-\uDFFF\0]/.test(tr.newDoc.toString()) || tr.newDoc.length > 2000000) {
        report(failure?.message || 'This source edit exceeds the supported text limits. Export your work before continuing.', true); return [];
      }
      return tr;
    }), View.updateListener.of(update => {
      if (update.docChanged) { stale(); report('Saving in this browser…'); queueMicrotask(() => { void flush().catch(() => {}); }); }
    })] }) });
    report('Local source opened. Shared project unchanged.');
  }
  addEventListener('beforeunload', event => { if (unsaved()) { event.preventDefault(); event.returnValue = ''; } });
  addEventListener('pagehide', () => { compiler?.stop(); observer?.disconnect(); void pdfDocument?.destroy(); });
  async function renderPdf() {
    observer?.disconnect(); await pdfDocument?.destroy(); pdfDocument = undefined;
    const host = document.querySelector('#pdf'); host.replaceChildren();
    document.querySelector('#export-pdf').disabled = !project.pdf;
    if (!project.pdf) { pdfStatus('No saved PDF. Prepare the compiler while connected, then recompile.'); return; }
    const pdfjs = await import('/recovery/pdf.mjs'); pdfjs.GlobalWorkerOptions.workerSrc = '/recovery/pdf.worker.mjs';
    pdfDocument = await pdfjs.getDocument({ data: new Uint8Array(await project.pdf.arrayBuffer()), isEvalSupported: false,
      useSystemFonts: false, cMapUrl: '/recovery/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/recovery/pdfjs/standard_fonts/',
      wasmUrl: '/recovery/pdfjs/wasm/', iccUrl: '/recovery/pdfjs/iccs/' }).promise;
    const pages = new Map();
    observer = new IntersectionObserver(entries => { for (const entry of entries) if (entry.isIntersecting) void paint(entry.target).catch(error => report(error.message, true)); }, { root: host, rootMargin: '400px' });
    async function paint(element) {
      if (element.dataset.rendered) return; element.dataset.rendered = 'true'; observer.unobserve(element);
      const { page, viewport } = pages.get(element);
      const ratio = Math.min(devicePixelRatio || 1, 2), canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio);
      canvas.style.cssText = 'width:100%;height:100%'; canvas.setAttribute('aria-label', 'PDF page ' + element.dataset.page); element.append(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: [ratio, 0, 0, ratio, 0, 0] }).promise;
      canvas.ondblclick = async event => {
        try {
          if (!navigation || unsaved()) throw Error('Recompile the current source before using PDF/source jumps');
          if (!await currentOutput()) throw Error('Another tab changed source. Reload before compiling or navigating.');
          const rect = canvas.getBoundingClientRect(), point = viewport.convertToPdfPoint((event.clientX - rect.left) * viewport.width / rect.width, (event.clientY - rect.top) * viewport.height / rect.height);
          const node = modules.backward(navigation, Number(element.dataset.page), point[0] - page.view[0], page.view[3] - point[1]);
          if (!node) throw Error('No source location found'); await open(node.path);
          const line = view.state.doc.line(Math.min(node.line, view.state.doc.lines));
          view.dispatch({ selection: { anchor: line.from, head: line.to }, effects: View.scrollIntoView(line.from, { y: 'center' }) }); view.focus();
        } catch (error) { report(error.message, true); }
      };
    }
    for (let n = 1; n <= pdfDocument.numPages; n++) {
      const page = await pdfDocument.getPage(n), original = page.getViewport({ scale: 1 });
      const scale = Math.min(Math.max(200, host.clientWidth - 24) / original.width, 2, Math.sqrt(4000000 / (original.width * original.height)));
      const viewport = page.getViewport({ scale }), element = document.createElement('div'); element.className = 'pdf-page'; element.dataset.page = n;
      element.style.cssText = `width:${viewport.width}px;height:${viewport.height}px;max-width:100%`;
      pages.set(element, { page, viewport }); host.append(element); observer.observe(element);
    }
    document.querySelector('#to-pdf').onclick = async () => {
      try {
        if (!navigation || unsaved() || !await currentOutput()) throw Error('Recompile the current source before using PDF/source jumps');
        if (!view) throw Error('Open a source file first');
        const node = modules.forward(navigation, file.path, view.state.doc.lineAt(view.state.selection.main.head).number);
        if (!node) throw Error('No PDF location found');
        const element = host.querySelector(`[data-page="${node.page}"]`); if (!element) throw Error('PDF page missing');
        element.scrollIntoView({ block: 'center' }); await paint(element);
        host.querySelector('.pdf-marker')?.remove();
        const { page, viewport } = pages.get(element), point = viewport.convertToViewportPoint(page.view[0] + node.x, page.view[3] - node.y);
        const marker = document.createElement('div'); marker.className = 'pdf-marker'; marker.style.cssText = `left:${point[0]}px;top:${point[1]}px;width:${Math.max(12, node.width * viewport.scale)}px;height:${Math.max(12, node.height * viewport.scale)}px`;
        element.append(marker); report('Source location shown in PDF.');
      } catch (error) { report(error.message, true); }
    };
  }
  async function currentOutput() {
    const saved = await api.read(project.id);
    return project.outputDigest === await modules.fingerprint(project, saved.files);
  }
  async function compile() {
    if (compiling) return;
    compiling = new AbortController(); document.querySelector('#compile').disabled = true; document.querySelector('#cancel').disabled = false;
    try {
      await flush(); modules ||= await import('/recovery/project-compile.mjs'); compiler ||= new modules.LocalCompiler();
      const snapshot = await api.read(project.id);
      if ([...files.values()].some(file => snapshot.files.find(other => other.path === file.path)?.revision !== file.revision)) throw Error('Another tab changed this project. Reload before compiling.');
      const digest = await modules.fingerprint(project, snapshot.files); report('Compiling on this device…');
      const result = await compiler.compile(project, snapshot.files, text => report(text), compiling.signal);
      await flush();
      if (compiling.signal.aborted || digest !== await modules.fingerprint(project, [...files.values()])) throw Error('Source changed during compilation. Compile again.');
      project = await api.output(project, snapshot.files, new Blob([result.pdf], { type: 'application/pdf' }), result.synctex, digest);
      navigation = await modules.navigation(result.synctex, project, [...files.values()]);
      await renderPdf(); pdfStatus('Compiled from the saved local project. Double-click the PDF to open its source.'); report('Compiled and saved in this browser. Shared project unchanged.');
    } catch (error) { report(error.message, true); }
    finally { compiling = undefined; document.querySelector('#compile').disabled = false; document.querySelector('#cancel').disabled = true; }
  }
  let installPrompt;
  addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; document.querySelector('#install').hidden = false; });
  document.querySelector('#install').onclick = async () => { await installPrompt?.prompt(); installPrompt = undefined; document.querySelector('#install').hidden = true; };
  document.querySelector('#projects').onclick = () => location.assign('/recovery/project-workspace.html');
  document.querySelector('#prepare-compiler').onclick = async () => {
    const button = document.querySelector('#prepare-compiler'); button.disabled = true;
    try { await globalThis.overleafRecovery.prepareCompiler(text => report(text), project?.native?.resources || []); report('Offline compiler is ready.'); }
    catch (error) { report(error.message, true); } finally { button.disabled = false; }
  };
  document.querySelector('#compile').onclick = compile;
  document.querySelector('#cancel').onclick = () => compiling?.abort();
  try {
    if (!location.hash) {
      const saved = await api.list(), host = document.querySelector('#chooser-list'), chooser = document.querySelector('#chooser');
      document.body.dataset.view = 'chooser'; chooser.hidden = false; chooser.querySelector('.chooser-inner').append(document.querySelector('#status'));
      const latest = [...saved].sort((a, b) => b.preparedAt - a.preparedAt);
      try { const settings = JSON.parse(latest.find(p => p.native)?.native.meta.find(m => m.name === 'ol-userSettings')?.content || '{}'); if (typeof settings.overallTheme === 'string') globalThis.overleafOfflineToolbar?.theme(settings.overallTheme); } catch { /* theme is cosmetic */ }
      const template = saved.find(project => project.native);
      if (template) {
        const form = document.createElement('form'), name = document.createElement('input'), create = document.createElement('button');
        name.setAttribute('aria-label', 'New local project name'); name.placeholder = 'New local project name'; name.required = true; name.maxLength = 200;
        create.textContent = 'Create local project'; form.append(name, create); document.querySelector('#chooser-create').append(form);
        form.onsubmit = async event => {
          event.preventDefault(); create.disabled = true;
          try { location.assign('/recovery/native-workspace.html#' + await api.blank(template.id, name.value)); }
          catch (error) { report(error.message, true); create.disabled = false; }
        };
      }
      const size = bytes => bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
      for (const project of latest) {
        const row = document.createElement('div'); row.className = 'project-row';
        const title = project.name || project.main, badge = document.createElement('span'); badge.className = 'project-icon'; badge.setAttribute('aria-hidden', 'true'); badge.textContent = title.trim().charAt(0).toUpperCase() || 'P';
        const main = document.createElement('div'); main.className = 'project-main';
        const link = document.createElement('a'); link.href = '/recovery/' + (project.native ? 'native-workspace.html' : 'project-workspace.html') + '#' + project.id;
        const when = document.createElement('span'); when.className = 'when'; when.textContent = ' — ' + new Date(project.preparedAt).toLocaleString();
        link.append(title, when);
        const details = document.createElement('div'); details.className = 'project-meta';
        details.textContent = [project.main, Number.isSafeInteger(project.bytes) ? size(project.bytes) : null, project.pdf ? 'PDF saved' : 'Not compiled yet'].filter(Boolean).join(' · ');
        main.append(link, details);
        const tag = document.createElement('span'); tag.className = 'tag'; tag.dataset.kind = project.localOnly ? 'local' : 'shared'; tag.textContent = project.localOnly ? 'Local only' : 'From server';
        row.append(badge, main, tag); host.append(row);
      }
      if (!saved.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'No saved projects yet. Open a shared project while connected and choose Offline → Work offline.'; host.after(empty); }
      for (const id of ['connect', 'export-project', 'export-file', 'export-pdf', 'undo', 'redo', 'compile', 'to-pdf']) document.querySelector('#' + id).disabled = true;
      report(saved.length ? 'Choose a saved project or create a local project. Files remain in this browser; export a ZIP to transfer them.' : 'No saved projects. Connect to a shared project and choose Work offline.'); return;
    }
    ({ project, files } = await api.read(location.hash.slice(1))); files = new Map(files.map(file => [file.path, file]));
    self.webpackChunk_overleaf_web.push([[989002], {}, require => {
      State = require(13591).$t; const nativeView = require(19472); View = nativeView.Lz; keymap = nativeView.w4; commands = require(78147);
      globalThis.overleafLocalKeymap = Object.values(commands).find(value => Array.isArray(value) && value.some(binding => binding.key === 'Enter') && value.some(binding => binding.key === 'ArrowLeft')) || [];
    }]);
    if (!State || !View || !commands?.b6 || !globalThis.overleafLocalKeymap.length) throw Error('Native editor did not load');
    const list = document.querySelector('#files');
    for (const path of files.keys()) {
      const item = document.createElement('li'), button = document.createElement('button'); button.textContent = path; button.dataset.path = path;
      button.onclick = async () => { try { await open(path); } catch (error) { report(error.message, true); } }; item.append(button); list.append(item);
    }
    await open(project.main);
    document.querySelector('#undo').onclick = () => { commands.tN(view); view.focus(); };
    document.querySelector('#redo').onclick = () => { commands.ZS(view); view.focus(); };
    document.querySelector('#export-file').onclick = () => download(view ? view.state.doc.toString() : file.content ?? Uint8Array.from(atob(file.data), c => c.charCodeAt(0)), file.path);
    document.querySelector('#export-project').onclick = () => {
      const resources = [...files.values()].map(saved => ({ ...saved, ...(saved.path === file?.path && view ? { content: view.state.doc.toString() } : {}) }));
      download(JSON.stringify({ schema: 1, project: { ...project, pdf: undefined, synctex: undefined, native: undefined }, files: resources }), project.project + '.offline.json', 'application/json');
    };
    document.querySelector('#export-pdf').onclick = () => download(project.pdf, 'output.pdf', 'application/pdf');
    document.querySelector('#connect').onclick = async () => {
      try {
        await flush();
        if (project.localOnly || file.localOnly) throw Error('This file has no shared counterpart. Download the project ZIP from the native editor and import it while connected.');
        const record = { schema: 1, account: project.account, project: project.project, doc: file.doc, writer: crypto.randomUUID(),
          revision: file.revision, base: file.base, candidate: view.state.doc.toString(), name: file.path, updatedAt: Date.now() };
        const key = globalThis.overleafRecovery.save(record);
        location.assign('/project/' + project.project + '#recovery=' + encodeURIComponent(key));
      } catch (error) { report(error.message + ' Your offline project is retained.', true); }
    };
    await renderPdf().catch(error => pdfStatus('PDF preview unavailable: ' + error.message + '. You can still download the saved PDF.'));
    if (project.synctex && project.outputDigest) {
      modules ||= await import('/recovery/project-compile.mjs');
      if (await currentOutput()) { navigation = await modules.navigation(project.synctex, project, [...files.values()]); pdfStatus('Saved local compilation. Double-click the PDF to open its source.'); }
      else stale();
    }
  } catch (error) { report(error.message + '. Existing local data was kept.', true); }
})();
