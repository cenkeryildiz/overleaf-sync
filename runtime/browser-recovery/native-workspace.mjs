// SPDX-License-Identifier: AGPL-3.0-only
// Local data adapter: the existing CE+ UI and OT document remain the editor.
import { LocalCompiler, fingerprint, navigation, forward, backward } from './project-compile.mjs';
import { projectZip } from './project-zip.mjs';
const api = globalThis.overleafLocalProjects;
const status = (text, error = false) => { const node = document.querySelector('#local-status'); node.textContent = text; node.title = text; node.dataset.error = error; };
{
  // Offline controls live in the native toolbar; server-only Share and History are hidden here.
  const ui = globalThis.overleafOfflineToolbar, bar = document.querySelector('#local-bar');
  const iconButton = (id, label, iconName) => ui.button({ id, ariaLabel: label, iconName, className: 'olx-icon-only' });
  const chip = ui.button({ className: 'olx-chip', iconName: 'cloud_off', label: 'Local only', ariaLabel: 'Local only options' }); chip.dataset.tone = 'local';
  const head = document.createElement('div'); head.className = 'olx-menu-head';
  const dot = document.createElement('span'); dot.className = 'olx-dot'; dot.dataset.state = 'disconnected';
  const text = document.createElement('div'); text.innerHTML = '<strong>Working in this browser</strong><small>Edits and compiled PDFs are saved on this device. Collaboration, history and sharing need a connection.</small>';
  head.append(dot, text);
  const { list } = ui.menu(chip, [
    { header: head }, 'divider',
    { id: 'local-projects', icon: 'folder_open', label: 'Saved projects', description: 'Switch to another project stored in this browser' },
    { id: 'local-copies', icon: 'history', label: 'Recovery copies', description: 'Compare this file with an earlier recovery copy' },
    { id: 'local-export', icon: 'data_object', label: 'Recovery copy (.json)', description: 'Download every file with its saved versions' },
  ]);
  const wrap = document.createElement('div'); wrap.className = 'olx-menu-wrap'; wrap.append(chip, list);
  const separator = document.createElement('span'); separator.className = 'olx-separator';
  bar.append(iconButton('local-zip', 'Download project (.zip)', 'folder_zip'), iconButton('local-pdf', 'Download PDF', 'picture_as_pdf'),
    ui.button({ id: 'local-review', label: 'Review on server', ariaLabel: 'Review on server', iconName: 'cloud_sync' }), separator, wrap);
  ui.mount(bar, { hideLabels: ['Share', 'History'] });
}
let project, files, active, pending = Promise.resolve(), failure, nav, controller, outputDigest;
const compiler = new LocalCompiler(), editors = new Map();
// Native CE+ reuses one editor view for every document: read each document's own text, never another file's.
const textOf = editor => editor?.container.doc?.getSnapshot?.() ?? (editor && editor === active ? editor.facade.getValue() : undefined);
async function flush() {
  for (const editor of editors.values()) editor.container.flush();
  let writing;
  do { writing = pending; await writing; } while (writing !== pending);
  if (failure) throw failure;
}
function outputFiles() {
  if (!project.pdf) return [];
  const build = project.outputDigest || project.digest;
  return ['output.pdf', ...(project.synctex ? ['output.synctex.gz'] : []), 'output.log'].map(path => ({ path,
    type: path === 'output.pdf' ? 'pdf' : path === 'output.log' ? 'log' : 'synctex.gz', build,
    url: `/recovery/native-output/${project.id}/${build}/${path}`, ...(path === 'output.pdf' ? { size: project.pdf.size, ranges: [], createdAt: new Date() } : {}) }));
}
function download(bytes, name, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type })), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
try {
  const stored = await api.read(location.hash.slice(1)); project = stored.project; files = new Map(stored.files.map(file => [file.path, file]));
  // Native OT backups must never reuse a live shared project's version namespace.
  const clientProject = crypto.randomUUID().replaceAll('-', '').slice(0, 24);
  if (!project.native?.scripts?.length || !project.native?.meta?.length) throw Error('Prepare this project again while connected to save the native editor');
  for (const item of project.native.meta) {
    if (!/^ol-[\w-]+$/.test(item.name) || /csrf|token|session|analytics/i.test(item.name) || typeof item.content !== 'string') throw Error('Invalid saved editor metadata');
    if (item.type === 'boolean' && typeof item.present !== 'boolean') throw Error('Prepare this project again to save native settings');
    const meta = document.createElement('meta'); meta.name = item.name; if (item.type !== 'boolean' || item.present) meta.content = item.content; if (item.type) meta.dataset.type = item.type; document.head.append(meta);
  }
  const setMeta = (name, value, type) => {
    let node = document.querySelector(`meta[name="${name}"]`); if (!node) { node = document.createElement('meta'); node.name = name; document.head.append(node); }
    if (type === 'boolean') { if (value) node.setAttribute('content', ''); else node.removeAttribute('content'); }
    else node.content = type === 'json' ? JSON.stringify(value) : String(value);
    if (type) node.dataset.type = type;
  };
  setMeta('ol-project_id', clientProject); setMeta('ol-user_id', project.account); setMeta('ol-csrfToken', 'local-only');
  for (const name of ['ol-shouldLoadHotjar', 'ol-customerIoEnabled', 'ol-showAiFeatures', 'ol-hasTrackChangesFeature']) setMeta(name, false, 'boolean');
  setMeta('ol-wsUrl', '', 'string'); setMeta('ol-useShareJsHash', false, 'boolean'); setMeta('ol-otMigrationStage', 0, 'number');
  setMeta('ol-baseAssetPath', '/recovery/');
  try { const settings = JSON.parse(document.querySelector('meta[name="ol-userSettings"]')?.content || '{}'); if (typeof settings.overallTheme === 'string') globalThis.overleafOfflineToolbar.theme(settings.overallTheme); } catch { /* theme is cosmetic */ }
  const user = JSON.parse(document.querySelector('meta[name="ol-user"]')?.content || '{}');
  const folder = name => ({ _id: crypto.randomUUID().replaceAll('-', '').slice(0, 24), name, docs: [], folders: [], fileRefs: [] });
  const root = folder(''), assets = new Map(), folders = new Map([[root._id, { node: root, path: '' }]]);
  const ensureFolder = path => {
    let parent = root, prefix = '';
    for (const part of path.split('/').filter(Boolean)) {
      prefix = prefix ? prefix + '/' + part : part;
      let child = parent.folders.find(f => f.name === part);
      if (!child) { child = folder(part); parent.folders.push(child); folders.set(child._id, { node: child, path: prefix }); }
      parent = child;
    }
    return parent;
  };
  for (const path of project.folders || []) ensureFolder(path);
  for (const file of files.values()) {
    const parts = file.path.split('/'), name = parts.pop(), parent = ensureFolder(parts.join('/'));
    if (file.doc) parent.docs.push({ _id: file.doc, name });
    else { const id = crypto.randomUUID().replaceAll('-', '').slice(0, 24); parent.fileRefs.push({ _id: id, name, hash: '' }); assets.set(id, file); }
  }
  const events = new Map(), broadcast = (name, ...args) => { for (const listener of [...(events.get(name) || [])]) listener(...args); };
  const socket = { connected: false, connecting: false, sessionid: crypto.randomUUID(), transports: [],
    connect() { this.connected = true; setTimeout(() => {
      broadcast('connect'); broadcast('joinProjectResponse', { protocolVersion: 2, publicId: this.sessionid, permissionsLevel: 'owner',
        project: { _id: clientProject, name: project.name || document.querySelector('meta[name="ol-projectName"]')?.content || project.main,
          rootDoc_id: files.get(project.main)?.doc, rootFolder: [structuredClone(root)], compiler: project.compiler, spellCheckLanguage: '',
          features: {}, tokens: {}, members: [], invites: [], owner: { ...user, _id: project.account },
          publicAccesLevel: 'private', trackChangesState: false } });
    }, 100); }, disconnect() { this.connected = false; broadcast('disconnect'); } };
  const transport = { socket, on(name, listener) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(listener); return this; },
    removeListener(name, listener) { events.get(name)?.delete(listener); return this; },
    connect() { socket.connect(); }, disconnect() { socket.disconnect(); },
    emit(name, ...args) {
      const callback = typeof args.at(-1) === 'function' ? args.pop() : () => {};
      if (name === 'joinDoc') {
        const file = [...files.values()].find(file => file.doc === args[0]);
        if (!file) { callback(Error('Local source is missing')); return; }
        callback(null, file.content.split('\n').map(line => unescape(encodeURIComponent(line))), file.revision, [], { changes: [], comments: [] }, 'sharejs-text-ot', { canSkipLeaveDoc: false });
      } else if (name === 'applyOtUpdate') {
        const [doc, update] = args;
        const editor = editors.get(doc), version = editor?.container.doc?.getVersion(), text = textOf(editor);
        pending = pending.then(async () => {
          if (failure) throw failure;
          const file = [...files.values()].find(file => file.doc === doc);
          if (!editor || !file || update.v !== version || typeof text !== 'string') throw Error('Local source version changed');
          const next = await api.save(file, text); files.set(next.path, next); nav = undefined;
          callback(null); broadcast('otUpdateApplied', { doc, v: update.v });
          status('Saved in this browser. PDF may be from an earlier compilation.');
        }).catch(error => {
          failure = error; status(error.message + ' Export your work before closing.', true);
          // Keep the unsaved OT operation pending; an error acknowledgement opens a modal that blocks export.
          socket.disconnect();
        });
      } else if (name === 'leaveDoc') void pending.then(() => callback(failure || null));
      else if (['clientTracking.setCursor', 'clientTracking.updatePosition', 'clientTracking.getConnectedUsers', 'getConnectedUsers'].includes(name)) callback(null, []);
      else callback(Error('This action requires a connection. Local files are retained.'));
      return this;
    } };
  globalThis.io = { version: '0.9-local', connect: () => transport };
  globalThis.WebSocket = class {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor() { throw Error('Live connections require Connected mode'); }
  };
  navigator.sendBeacon = () => false;
  const NativeWorker = globalThis.Worker;
  globalThis.Worker = class extends NativeWorker {
    constructor(input, options) {
      const url = new URL(input, location.href);
      if (url.origin !== location.origin) throw Error('Offline workers require prepared local resources');
      if (url.pathname.startsWith('/js/')) url.pathname = '/recovery' + url.pathname;
      super(url, options);
    }
  };
  globalThis.overleafOfflineNative = Object.freeze({ account: project.account, project: project.project, clientProject, workspace: project.id,
    get savingHeld() { return !!failure; },
    file: doc => [...files.values()].find(file => file.doc === doc),
    attach(facade, container) { active = { facade, container }; editors.set(container.doc_id, active); } });
  const originalFetch = globalThis.fetch.bind(globalThis);
  const localFetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    const method = init?.method || (input instanceof Request ? input.method : 'GET');
    if (url.origin !== location.origin) return new Response('External requests disabled in Local only mode', { status: 503 });
    if (url.pathname === `/editingSession/${clientProject}` && method === 'PUT') return new Response(null, { status: 204 });
    if (url.pathname === `/project/${clientProject}/flush` && method === 'POST') {
      try { await flush(); return new Response(null, { status: 204 }); }
      catch (error) { return Response.json({ message: error.message }, { status: 409 }); }
    }
    const creating = url.pathname.match(new RegExp(`^/project/${clientProject}/(doc|folder)$`));
    if (creating && method === 'POST') {
      try {
        await flush();
        const body = JSON.parse(init?.body ?? await input.clone().text());
        const parent = folders.get(body.parent_folder_id);
        if (!parent || typeof body.name !== 'string' || body.name.includes('/')) throw Error('Invalid local parent or name');
        const path = parent.path ? parent.path + '/' + body.name : body.name;
        const next = await api.add(project, creating[1], path); project = next.project; nav = undefined;
        let entity;
        if (next.file) {
          files.set(path, next.file); entity = { _id: next.file.doc, name: body.name }; parent.node.docs.push(entity);
        } else {
          entity = folder(body.name); parent.node.folders.push(entity); folders.set(entity._id, { node: entity, path });
        }
        broadcast(next.file ? 'reciveNewDoc' : 'reciveNewFolder', body.parent_folder_id, entity);
        status('Created in this browser. Export the project to transfer new files.');
        return Response.json(entity);
      } catch (error) { return Response.json({ message: error.message }, { status: 409 }); }
    }
    if (url.pathname === `/project/${clientProject}/changes/users` && method === 'GET') return Response.json([]);
    if (url.pathname === `/project/${clientProject}/metadata` && method === 'GET') return Response.json({ projectMeta: project.native.projectMeta || {} });
    const metadata = url.pathname.match(new RegExp(`^/project/${clientProject}/doc/([a-f0-9]{24})/metadata$`));
    if (metadata && method === 'POST') return Response.json({ docId: metadata[1], meta: project.native.projectMeta?.[metadata[1]] || { labels: [], packages: {}, packageNames: [] } });
    if (url.pathname === `/project/${clientProject}/compile/stop`) { controller?.abort(); return Response.json({ stopped: true }); }
    if (url.pathname === `/project/${clientProject}/compile` && method === 'POST') {
      if (controller) return Response.json({ error: 'Compilation already running' }, { status: 409 });
      controller = new AbortController();
      try {
        await flush();
        const saved = await api.read(project.id);
        if ([...files.values()].some(file => saved.files.find(other => other.path === file.path)?.revision !== file.revision)) throw Error('Another tab changed this project. Reload before compiling.');
        const digest = await fingerprint(project, saved.files); status('Compiling on this device…');
        const result = await compiler.compile(project, saved.files, text => status(text), controller.signal);
        await flush();
        if (controller.signal.aborted || digest !== await fingerprint(project, [...files.values()])) throw Error('Source changed during compilation. Compile again.');
        project = await api.output(project, saved.files, new Blob([result.pdf], { type: 'application/pdf' }), result.synctex, digest);
        nav = await navigation(project.synctex, project, [...files.values()]); outputDigest = digest;
        status('Compiled and saved in this browser.');
        return Response.json({ status: 'success', outputFiles: outputFiles(),
          compileGroup: 'standard', stats: {}, timings: {}, outputFilesArchive: null });
      } catch (error) { status(error.message + ' Previous PDF retained.', true); return Response.json({ status: 'error', outputFiles: outputFiles() }); }
      finally { controller = undefined; }
    }
    if (url.pathname.startsWith(`/project/${clientProject}/sync/`)) {
      const saved = await api.read(project.id);
      if (!nav || outputDigest !== await fingerprint(project, saved.files)) return Response.json({ error: 'Recompile current source first' }, { status: 409 });
      if (url.pathname.endsWith('/code')) {
        const path = url.searchParams.get('file')?.split('/').filter(part => part && part !== '.').join('/'), node = forward(nav, path, Number(url.searchParams.get('line')));
        return node ? Response.json({ pdf: [{ page: node.page, h: node.x, v: node.y, width: node.width, height: node.height }] }) : Response.json({ error: 'No location' }, { status: 404 });
      }
      const node = backward(nav, Number(url.searchParams.get('page')), Number(url.searchParams.get('h')), Number(url.searchParams.get('v')));
      return node ? Response.json({ code: [{ file: node.path, line: node.line, column: 0 }] }) : Response.json({ error: 'No location' }, { status: 404 });
    }
    const asset = url.pathname.match(new RegExp(`^/project/${clientProject}/file/([a-f0-9]{24})`));
    if (asset && assets.has(asset[1])) { const file = assets.get(asset[1]); return new Response(file.content ?? Uint8Array.from(atob(file.data), c => c.charCodeAt(0))); }
    if (method !== 'GET') return new Response('This action requires a connection', { status: 503 });
    if (/\/messages$/.test(url.pathname)) return Response.json([]);
    return originalFetch(input, init);
  };
  globalThis.fetch = localFetch; globalThis.overleafParticipantFetch = localFetch;
  const resources = () => [...files.values()].map(file => { const text = textOf(editors.get(file.doc)); return typeof text === 'string' ? { ...file, content: text } : file; });
  async function exportZip() {
    try { download(await projectZip(resources()), project.project + '.zip', 'application/zip'); }
    catch (error) { status(error.message + '. Your source files are retained.', true); }
  }
  document.querySelector('#local-zip').onclick = exportZip;
  document.querySelector('#local-pdf').onclick = () => {
    if (project.pdf) download(project.pdf, 'output.pdf', 'application/pdf'); else status('No saved PDF yet. Recompile the project first.', true);
  };
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href]'); if (!link) return;
    const url = new URL(link.href, location.href);
    if (url.origin === location.origin && url.pathname === '/project/' + clientProject + '/download/zip') {
      event.preventDefault(); event.stopImmediatePropagation(); void exportZip();
    }
  }, true);
  document.querySelector('#local-export').onclick = () => {
    download(JSON.stringify({ schema: 1, project: { ...project, pdf: undefined, synctex: undefined, native: undefined }, files: resources() }), project.project + '.offline.json', 'application/json');
  };
  document.querySelector('#local-copies').onclick = async () => {
    try {
      if (!active) throw Error('Open a source file first');
      const editor = active, doc = editor.container.doc_id, before = editor.facade.getValue();
      const copy = globalThis.overleafRecovery.list(project.account, project.project).find(({ record }) => record.workspace === project.id && record.doc === doc && record.candidate !== before);
      if (!copy) { status('No different recovery copy for this file.'); return; }
      const saved = (await api.read(project.id)).files.find(file => file.doc === doc);
      const dialog = document.createElement('dialog'); dialog.setAttribute('aria-label', 'Review offline recovery copy');
      dialog.className = 'recovery-review';
      const title = document.createElement('h2'); title.textContent = 'Recovery copy — ' + saved.path; dialog.append(title);
      const columns = document.createElement('div'); columns.className = 'recovery-review-columns';
      let resolution;
      for (const [name, value, readOnly] of [['Saved local file', saved.content, true], ['Recovered text', copy.record.candidate, false]]) {
        const label = document.createElement('label'); label.textContent = name;
        const field = document.createElement('textarea'); field.setAttribute('aria-label', name); field.value = value; field.readOnly = readOnly;
        field.style.cssText = 'display:block;width:100%;height:50vh;font:13px monospace'; label.append(field); columns.append(label); if (!readOnly) resolution = field;
      }
      dialog.append(columns);
      for (const [label, action] of [
        ['Save recovered text locally', async () => {
          const latest = (await api.read(project.id)).files.find(file => file.doc === doc);
          if (failure || active !== editor || editor.facade.getValue() !== before || latest.revision !== saved.revision) throw Error('Source changed or saving is held. Export the recovered text, then reload.');
          editor.facade.cmChange([{ from: 0, to: before.length, insert: resolution.value }]); dialog.close();
        }],
        ['Download recovered text', () => download(resolution.value, saved.path.split('/').at(-1), 'text/plain;charset=utf-8')],
        ['Close', () => dialog.close()],
      ]) {
        const button = document.createElement('button'); button.textContent = label;
        button.onclick = async () => { try { await action(); } catch (error) { status(error.message, true); } }; dialog.append(button);
      }
      dialog.onclose = () => dialog.remove(); document.body.append(dialog); dialog.showModal();
    } catch (error) { status(error.message, true); }
  };
  document.querySelector('#local-review').onclick = async () => {
    try {
      if (!active) throw Error('Open a source file first'); await flush();
      const file = [...files.values()].find(file => file.doc === active.container.doc_id);
      if (project.localOnly || file.localOnly) throw Error('This file has no shared counterpart. Download the project ZIP and import it while connected.');
      const record = { schema: 1, account: project.account, project: project.project, doc: file.doc, writer: crypto.randomUUID(), revision: file.revision,
        base: file.base, candidate: active.facade.getValue(), name: file.path, updatedAt: Date.now() };
      const key = globalThis.overleafRecovery.save(record); location.assign('/project/' + project.project + '#recovery=' + encodeURIComponent(key));
    } catch (error) { status(error.message, true); }
  };
  document.querySelector('#local-projects').onclick = () => location.assign('/recovery/project-workspace.html');
  addEventListener('beforeunload', event => { if ([...editors.values()].some(editor => editor.container.doc?.hasBufferedOps())) { event.preventDefault(); event.returnValue = ''; } });
  addEventListener('pagehide', () => compiler.stop());
  for (const href of project.native.styles) {
    const url = new URL(href, location.origin); if (url.origin !== location.origin || !url.pathname.startsWith('/stylesheets/')) throw Error('Invalid native stylesheet');
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/recovery' + url.pathname; document.head.append(link);
  }
  for (const src of project.native.scripts) {
    const url = new URL(src, location.origin); if (url.origin !== location.origin || !url.pathname.startsWith('/js/')) throw Error('Invalid native script');
    await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = '/recovery' + url.pathname; script.onload = resolve; script.onerror = () => reject(Error('Native editor asset unavailable; prepare again while connected')); document.body.append(script); });
  }
  status('Native editor — Local only. Logins, collaboration and server actions require connectivity.');
} catch (error) { status(error.message + '. Existing local files are retained.', true); }
