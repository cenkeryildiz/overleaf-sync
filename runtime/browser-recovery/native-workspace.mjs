// SPDX-License-Identifier: AGPL-3.0-only
// Local data adapter: the existing CE+ UI and OT document remain the editor.
import { projectZip } from './project-zip.mjs';
import { LocalCompiler, fingerprint, navigation, forward, backward } from './project-compile.mjs';
// LAN sharing (standalone only): `lan` is the owner's running room or the participant's session; both offer join/edit/cursor.
const lanEvents = {}, joined = globalThis.overleafStandalone && /^#(join|room)=/.test(location.hash) ? await (await import('/extension/lan-ui.mjs')).joinForm(location.hash.slice(1), lanEvents) : null;
const api = joined?.api ?? globalThis.overleafLocalProjects;
let lan = joined?.shared ?? null;
const report = state => dispatchEvent(new CustomEvent('overleaf-durability', { detail: { state } }));
const status = (text, error = false) => { const node = document.querySelector('#local-status'); node.textContent = text; node.title = text; node.dataset.error = error; };
{
  // Offline controls live in the native toolbar; server-only Share and History are hidden here.
  const ui = globalThis.overleafOfflineToolbar, bar = document.querySelector('#local-bar');
  const chip = ui.button({ className: 'olx-chip', iconName: 'cloud_off', label: 'Local only', ariaLabel: 'Local only options' }); chip.dataset.tone = 'local';
  const head = document.createElement('div'); head.className = 'olx-menu-head';
  const dot = document.createElement('span'); dot.className = 'olx-dot'; dot.dataset.state = 'disconnected';
  const text = document.createElement('div'); text.innerHTML = joined ? '<strong>Shared session</strong><small>This project exists only in this tab and ends when the owner stops sharing.</small>' : globalThis.overleafStandalone ? '<strong>Working on this device</strong><small>Source and compiled PDFs stay in this extension. Export a ZIP to transfer your project.</small>' : '<strong>Working in this browser</strong><small>Edits and compiled PDFs are saved on this device. Collaboration, history and sharing need a connection.</small>';
  head.append(dot, text);
  const { list } = ui.menu(chip, [
    { header: head }, 'divider',
    { id: 'local-projects', icon: 'folder_open', label: 'Saved projects', description: 'Switch to another project stored in this browser' },
    { id: 'local-copies', icon: 'history', label: 'Recovery copies', description: 'Compare this file with an earlier recovery copy' },
    ...(globalThis.overleafStandalone ? [{ id: 'local-deleted', icon: 'restore', label: 'Deleted files', description: 'Restore files deleted from this local project' }] : []),
    { id: 'local-export', icon: 'data_object', label: 'Recovery copy (.json)', description: 'Download every file with its saved versions' },
    ...(joined ? [{ id: 'local-savecopy', icon: 'save', label: 'Save a copy on this device', description: 'Only when the owner allows copies' }] : []),
  ]);
  const wrap = document.createElement('div'); wrap.className = 'olx-menu-wrap'; wrap.append(chip, list);
  const separator = document.createElement('span'); separator.className = 'olx-separator';
  if (globalThis.overleafStandalone) bar.append(ui.button({ id: 'local-open-pdf', label: 'Open PDF', ariaLabel: 'Open an existing PDF', iconName: 'picture_as_pdf' }));
  // Project ZIP and PDF downloads live in the editor's File menu (its ZIP link is routed to exportZip below).
  bar.append(ui.button({ id: 'local-review', label: 'Review on server', ariaLabel: 'Review on server', iconName: 'cloud_sync' }), ...(globalThis.overleafStandalone && (!joined || joined.room) ? [ui.button({ id: 'local-share', label: 'Share', ariaLabel: 'Share on this network', iconName: 'share' })] : []), separator, wrap);
  bar.querySelector('#local-status').after(ui.durability());
  ui.mount(bar, { hideLabels: ['Share', 'History'] });
  if (globalThis.overleafStandalone) document.querySelector('#local-review').hidden = true;
}
let project, files, active, pending = Promise.resolve(), failure, nav, controller, outputDigest;
const compiler = new LocalCompiler(), editors = new Map();
// TEX-PKG: installed packages (store.mjs) join each compile as files; their manifest is part of the source key, so a PDF
// made with other package versions is not shown as current. A failed compile that names missing files offers Install.
const packageSet = () => import('/extension/packages/store.mjs').then(m => m.compileSet()).catch(() => ({ files: [], manifest: [] }));
const packageHint = log => import('/extension/packages-ui.mjs').then(m => m.compileHint(log)).catch(() => {});
// Unchanged when nothing is installed, so PDFs saved before this feature stay current.
const sourceKey = (list, packages) => fingerprint(project, packages.manifest.length ? [...list, { path: '.texmf/manifest', content: JSON.stringify(packages.manifest) }] : list);   // stays a 64-hex digest (project-store checks it)
let compileLog = 'Compiled locally.\n';
// Native CE+ reuses one editor view for every document: read each document's own text, never another file's.
const textOf = editor => editor?.container.doc?.getSnapshot?.() ?? (editor && editor === active ? editor.facade.getValue() : undefined);
async function flush() {
  for (const editor of editors.values()) editor.container.flush();
  let writing;
  do { writing = pending; await writing; } while (writing !== pending);
  if (failure) throw failure;
}
function outputFiles() {
  if (!project.pdf && !globalThis.overleafStandalone) return [];
  const build = project.pdfImported ? project.pdfDigest : project.outputDigest || project.digest;
  return [...(project.pdf ? ['output.pdf'] : []), ...(project.synctex ? ['output.synctex.gz'] : []), 'output.log'].map(path => ({ path,
    type: path === 'output.pdf' ? 'pdf' : path === 'output.log' ? 'log' : 'synctex.gz', build,
    url: `/recovery/native-output/${project.id}/${build}/${path}`, ...(path === 'output.pdf' ? { size: project.pdf.size, ranges: [], createdAt: new Date() } : {}) }));
}
/** The word under a source caret and which occurrence of it on that line it is (0-based), or undefined. */
function caretWord(text, line, column) {
  const source = text?.split('\n')[line - 1]; if (source === undefined || !Number.isSafeInteger(column)) return;
  const words = [...source.replace(/(?<!\\)%.*/, '').replace(/\\(?:begin|end)\s*\{[^}]*\}/g, m => ' '.repeat(m.length)).matchAll(/\\?[\p{L}\p{N}]+/gu)].filter(m => !m[0].startsWith('\\'));   // never a command name
  const at = words.find(m => m.index <= column && column <= m.index + m[0].length); if (!at || at[0].length < 2) return;
  return { word: at[0], occurrence: words.filter(m => m[0] === at[0] && m.index < at.index).length };
}
// Source → PDF: besides the viewer's yellow line highlight, mark the caret's word itself. The region is the one returned
// to the viewer (PDF points); the mark lives in that page, so it scrolls and zooms with it, and fades like the highlight.
let marking = 0;
function markWord(target, node) {
  document.querySelectorAll('.olx-caret-word').forEach(n => n.remove()); const run = ++marking;
  if (!target) return;
  const place = (tries = 0) => {
    if (run !== marking) return;
    const page = document.querySelector(`.pdfViewer .page[data-page-number="${node.page}"]`), layer = page?.querySelector('.textLayer');
    const points = Number(page?.style.width.match(/\*\s*([\d.]+)px/)?.[1]), scale = points > 0 && page.getBoundingClientRect().width / points;   // pdf.js: width = scale × page points
    if (!layer?.querySelector('span') || !scale) { if (tries < 30) setTimeout(() => place(tries + 1), 100); return; }   // page still rendering
    const origin = page.getBoundingClientRect(), slack = 2 * scale, found = [];
    const area = { left: origin.left + node.x * scale - slack, top: origin.top + node.y * scale - slack, right: origin.left + (node.x + node.width) * scale + slack, bottom: origin.top + (node.y + node.height) * scale + slack };
    for (const span of layer.querySelectorAll('span')) {
      const text = span.firstChild; if (text?.nodeType !== 3) continue;
      for (const m of text.textContent.matchAll(/[\p{L}\p{N}]+/gu)) if (m[0] === target.word) {
        const range = new Range(); range.setStart(text, m.index); range.setEnd(text, m.index + m[0].length); const r = range.getBoundingClientRect();
        if (r.left + r.width / 2 >= area.left && r.left + r.width / 2 <= area.right && r.top + r.height / 2 >= area.top && r.top + r.height / 2 <= area.bottom) found.push(r);
      }
    }
    if (!found.length) return;   // e.g. the word was typeset by a macro or inside math
    found.sort((a, b) => Math.abs(a.top - b.top) > 2 ? a.top - b.top : a.left - b.left);
    const rect = found[target.occurrence]; if (!rect) return;   // no substitute when this occurrence was not typeset
    const mark = document.createElement('div'); mark.className = 'olx-caret-word';
    Object.assign(mark.style, { position: 'absolute', zIndex: 3, left: rect.left - origin.left - 1 + 'px', top: rect.top - origin.top - 1 + 'px', width: rect.width + 2 + 'px', height: rect.height + 2 + 'px',
      background: 'rgba(255, 110, 0, 0.35)', outline: '2px solid rgb(225, 75, 0)', borderRadius: '2px', pointerEvents: 'none', transition: 'opacity 1s' });
    page.append(mark);
    setTimeout(() => { mark.style.opacity = '0'; setTimeout(() => mark.remove(), 1100); }, 1100);   // the viewer's highlight shows for ~1.1 s, then fades over 1 s
  };
  place();
}
function download(bytes, name, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type })), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
try {
  const stored = await api.read(location.hash.slice(1)); project = stored.project; files = new Map(stored.files.map(file => [file.path, file]));
  // Stable local UUID namespace keeps native preferences across reloads without using a shared project's ID.
  const clientProject = project.id.replaceAll('-', '').slice(0, 24);
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
  setMeta('ol-baseAssetPath', globalThis.overleafStandalone ? '/' : '/recovery/');
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
  const cursors = new Map(); // session-name -> last caret, for getConnectedUsers
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
        const reply = (text, version) => callback(null, text.split('\n').map(line => unescape(encodeURIComponent(line))), version, [], { changes: [], comments: [] }, 'sharejs-text-ot', { canSkipLeaveDoc: false });
        if (lan) Promise.resolve(lan.join(file.path)).then(state => state ? reply(state.text, state.v) : reply(file.content, file.revision), error => callback(error));
        else reply(file.content, file.revision);
      } else if (name === 'applyOtUpdate') {
        const [doc, update] = args;
        const editor = editors.get(doc), version = editor?.container.doc?.getVersion(), text = textOf(editor);
        pending = pending.then(async () => {
          if (failure) throw failure;
          const file = [...files.values()].find(file => file.doc === doc), gone = () => ![...files.values()].some(file => file.doc === doc);
          if (lan && !file) { callback(null); return; } // the file was deleted in the shared session: nothing to save
          if (!editor || !file || (!lan && update.v !== version) || typeof text !== 'string') throw Error('Local source version changed');
          // Shared: the owner's log orders and transforms the edit; the acknowledgement carries the version it was applied at.
          const applied = lan ? await lan.edit(file.path, update).catch(error => { if (gone()) return null; throw error; }) : update.v;
          if (applied === null) { callback(null); return; }
          if (lan) persist(file.path, joined ? textOf(editors.get(doc)) : lan.text(file.path)); // saved after the acknowledgement; shared text is authoritative
          else { const next = await api.save(file, text); files.set(next.path, next); }
          nav = undefined; callback(null); if (applied !== null) broadcast('otUpdateApplied', { doc, v: applied }); // null: an explicit reconciliation dropped or replaced it
          status('Saved in this browser. PDF may be from an earlier compilation.'); report('device');
        }).catch(error => {
          failure = error; if (lan) console.warn('[lan] edit failed:', error.message); status(error.message + ' Export your work before closing.', true); report('visible');
          // Keep the unsaved OT operation pending; an error acknowledgement opens a modal that blocks export.
          socket.disconnect();
        });
      } else if (name === 'leaveDoc') void pending.then(() => callback(failure || null));
      else if (name === 'clientTracking.updatePosition') { const file = [...files.values()].find(file => file.doc === args[0]?.doc_id); if (lan && file && Number.isSafeInteger(args[0].row) && Number.isSafeInteger(args[0].column)) lan.cursor({ path: file.path, row: args[0].row, column: args[0].column }); callback(null, []); }
      else if (name === 'clientTracking.getConnectedUsers') callback(null, [...cursors.values()].map(c => ({ client_id: c.id, user_id: c.user_id, email: '', first_name: c.name, last_name: '', cursorData: { doc_id: c.doc_id, row: c.row, column: c.column } })));
      else if (['clientTracking.setCursor', 'getConnectedUsers'].includes(name)) callback(null, []);
      else callback(Error('This action requires a connection. Local files are retained.'));
      return this;
    } };
  globalThis.io = { version: '0.9-local', connect: () => transport };
  // ---- LAN sharing glue: the native editor's own client transforms; the owner's log (lan-host.mjs) orders every edit.
  const hue = name => [...new TextEncoder().encode('lan:' + name)].reduce((h, b) => (h * 31 + b) >>> 0, 7).toString(16).padStart(8, '0').repeat(3);
  const persist = (path, text) => { // keep the local copy equal to the shared text (the owner's copy is the real one; a participant's is memory only)
    pending = pending.then(async () => {
      const file = files.get(path); if (!file || failure || file.content === text) return;
      const next = await api.save(file, text); files.set(next.path, next); nav = undefined;
    }).catch(error => { failure = error; status(error.message + ' Export your work before closing.', true); report('visible'); socket.disconnect(); });
  };
  lanEvents.onRemote = (path, { op, v, by }) => {
    const doc = files.get(path)?.doc; if (!doc) return;
    broadcast('otUpdateApplied', { doc, op, v, meta: { source: 'lan:' + by, user_id: hue(by), ts: Date.now() } });
    if (joined) setTimeout(() => { const text = textOf(editors.get(doc)); if (typeof text === 'string') persist(path, text); }, 0); else persist(path, lan?.text(path));
  };
  lanEvents.onCursor = ({ name, path, row, column }) => {
    const doc = files.get(path)?.doc; if (!doc) return;
    const entry = { id: 'lan:' + name, user_id: hue(name), name, doc_id: doc, row, column }; cursors.set(name, entry);
    broadcast('clientTracking.clientUpdated', { ...entry, email: '' });
  };
  lanEvents.onPeers = names => {
    for (const name of [...cursors.keys()]) if (!names.includes(name)) { broadcast('clientTracking.clientDisconnected', 'lan:' + name); cursors.delete(name); }
    // A known peer makes the editor publish its caret at once; until then it only does so every five minutes.
    for (const name of names) if (!cursors.has(name)) lanEvents.onCursor({ name, path: project.main, row: 0, column: 0 });
  };
  // S2-05: a lost connection locks editing behind a notice; unsent edits stay in this tab's memory until a rejoin reconciles them.
  let notice = null;
  const node = (tag, props) => Object.assign(document.createElement(tag), props);
  const lock = (text, ...controls) => { notice?.remove(); notice = node('div', { className: 'lan-join' }); notice.setAttribute('role', 'alert'); notice.append(node('div', { className: 'lan-panel' })); notice.firstChild.append(node('p', { textContent: text }), ...controls); document.body.append(notice); };
  const unlock = () => { notice?.remove(); notice = null; };
  lanEvents.onLost = (reason, { retrying }) => {
    status(reason, true);
    if (retrying) return lock(reason + '. Reconnecting... Your unsent edits are kept in this tab.');
    const link = node('input', { ariaLabel: 'New join link (empty: the same room)', placeholder: 'New join link (empty: the same room)', autocomplete: 'off', spellcheck: false });
    const code = node('input', { ariaLabel: 'Passcode (empty: the same room)', placeholder: 'Passcode (empty: the same room)', autocomplete: 'off', spellcheck: false }), note = node('p', { role: 'status' });
    const rejoin = node('button', { type: 'button', textContent: 'Rejoin', onclick: async () => {
      note.textContent = 'Connecting...'; const passcode = code.value; code.value = '';
      try { await lan.rejoin({ link: link.value.trim() || undefined, passcode: passcode || undefined }); } catch (error) { note.textContent = error.message; }
    } });
    lock(reason + '. Your unsent edits are kept in this tab until you rejoin or leave.', link, code, rejoin, node('button', { type: 'button', textContent: 'Leave', onclick: () => lan?.leave() }), note);
  };
  lanEvents.onResumed = async conflicts => {
    unlock(); status('Reconnected to the shared project.');
    if (!conflicts.length) return;
    const { reconcile } = await import('/extension/lan-guest.mjs');
    for (const path of conflicts) {
      const file = files.get(path), doc = file?.doc && editors.get(file.doc)?.container.doc;
      if (!doc) { lan?.forget(path); continue; }
      const deliver = (op, v) => broadcast('otUpdateApplied', op ? { doc: file.doc, op, v, meta: { source: 'lan:Owner', user_id: hue('Owner'), ts: Date.now() } } : { doc: file.doc, v }); // no op: the acknowledgement shape used for applyOtUpdate
      for (let choice = 'auto', note = ''; lan;) { // the owner's version is never replaced; only this tab's unsent edits are kept or dropped
        try { if (await reconcile(lan, path, doc, deliver, choice)) break; } catch (error) { note = error.message + '. '; }
        choice = await new Promise(resolve => lock(`${note}The owner changed ${path} while you were away, and you have unsent edits in it. The owner's version is kept either way.`,
          node('button', { type: 'button', textContent: 'Apply my edits on top', onclick: () => resolve('keep') }),
          node('button', { type: 'button', textContent: 'Discard my unsent edits', onclick: () => resolve('discard') })));
        unlock();
      }
    }
  };
  lanEvents.onEnd = reason => {
    unlock(); lan = null; socket.disconnect(); status(reason, true);
    const done = document.createElement('div'); done.setAttribute('role', 'alert'); done.className = 'lan-join';
    const box = document.createElement('p'); box.textContent = reason + '. Editing is locked; any edits not yet acknowledged were not delivered to the owner.';
    done.append(box); document.body.append(done);
  };
  lanEvents.onStopped = () => { lan = null; cursors.clear(); status('Sharing stopped. Your project is unchanged on this device.'); };
  if (globalThis.overleafStandalone) { // stage 3 LAN-COMPILE-01: rows under Settings > This computer
    import('/extension/lan-compile-ui.mjs').then(m => m.mount({ lan: () => lan, joined: !!joined, events: lanEvents })).catch(error => console.warn('[group] unavailable:', error.message));
  }
  document.querySelector('#local-share')?.addEventListener('click', async () => {
    const button = document.querySelector('#local-share');
    if (joined?.room) { joined.room.showPanel(); return; }
    if (lan?.panel) { lan.panel.hidden = !lan.panel.hidden; if (!lan.panel.hidden) lan.panel.querySelector('.lan-btn')?.focus(); return; }
    button.disabled = true;
    try {
      await flush();
      if ([...editors.values()].some(editor => editor.container.doc?.hasBufferedOps())) throw Error('Finish typing, then share again');
      const source = {
        tree: () => ({ main: project.main, folders: project.folders || [], docs: [...files.values()].filter(file => file.doc).map(file => file.path),
          files: [...files.values()].map(file => ({ path: file.path, bytes: file.doc ? new TextEncoder().encode(file.content) : Uint8Array.from(atob(file.data), char => char.charCodeAt(0)) })) }),
        text(path) { // the owner's open editor is the truth for its document; others come from the saved file
          const file = files.get(path); if (!file?.doc) return null;
          const doc = editors.get(file.doc)?.container.doc;
          return doc ? { text: doc.getSnapshot(), version: doc.getVersion() } : { text: file.content, version: file.revision };
        },
        persist, apply: op => fsApply(op),
      };
      const internet = await import('/extension/p2p-ui.mjs'), choice = await internet.shareChoice();
      if (!choice) return;
      const host = choice === 'lan' ? await (await import('/extension/lan-ui.mjs')).shareFlow({ source, events: lanEvents })
        : await internet.internetShare({ source, events: lanEvents, name: choice.name });
      for (const file of files.values()) if (file.doc && editors.get(file.doc)?.container.doc) host.join(file.path); // freeze open documents' state before any edit
      lan = host; status(choice === 'lan' ? 'Sharing on this network.' : 'Sharing over the internet. PDFs compile on this computer.'); lanEvents.onSharing?.();
    } catch (error) { status(error.message, true); }
    finally { button.disabled = false; }
  });
  globalThis.overleafNetworkSocket ??= globalThis.WebSocket; // stage 4 room finder only (p2p-signal.mjs: configured broker URLs); the editor keeps no socket
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
      if (!globalThis.overleafStandalone && url.pathname.startsWith('/js/')) url.pathname = '/recovery' + url.pathname;
      super(url, options);
    }
  };
  globalThis.overleafOfflineNative = Object.freeze({ account: project.account, project: project.project, clientProject, workspace: project.id,
    get savingHeld() { return !!failure; },
    file: doc => [...files.values()].find(file => file.doc === doc),
    attach(facade, container) { active = { facade, container }; editors.set(container.doc_id, active); } });
  if (globalThis.overleafStandalone) { // DOCEXEC-01: nothing research-related loads or connects until the person asks for it
    const research = () => import('/extension/cells-ui.mjs');
    const current = () => { const file = active && [...files.values()].find(item => item.doc === active.container.doc_id); return file && { path: file.path }; };
    const context = { project: () => project.id, clientProject: () => clientProject, shared: () => !!lan || !!joined, file: current, view: () => document.querySelector('.cm-content')?.cmView?.view,
      text: path => { const file = files.get(path); return file?.doc ? textOf(editors.get(file.doc)) ?? file.content : undefined; }, exists: path => files.has(path),
      sources: () => [...files.values()].map(file => ({ path: file.path, content: file.doc ? textOf(editors.get(file.doc)) ?? file.content : undefined })), compileLog: () => compileLog, compiling: () => !!controller };
    const inFile = pattern => event => event.target instanceof Element && !!event.target.closest('.cm-editor') && pattern.test(current()?.path ?? '');
    const inCode = inFile(/\.(?:py|r)$/i), inCells = inFile(/\.(?:py|r|ipynb)$/i);   // .ipynb: right-click converts; it never runs
    addEventListener('contextmenu', event => { if (inCells(event)) { event.preventDefault(); research().then(m => m.cellMenu(context, event)); } }, true);
    addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && inCode(event)) { event.preventDefault(); event.stopPropagation(); research().then(m => m.runCell(context)); } }, true);
    addEventListener('click', () => requestAnimationFrame(() => { if (document.querySelector('.ide-settings-tab-nav') && !document.getElementById('ide-settings-tabs-tab-this-computer')) import('/extension/this-computer.mjs').then(m => { m.attach(context); m.attach(context, { id: 'packages', label: 'Packages', symbol: 'inventory_2', load: () => import('/extension/packages-ui.mjs').then(p => p.packageRows(context)) }); }); }), true);
    lanEvents.onSharing = () => research().then(m => m.revoke(project.id));
    // transport for research-ui.mjs (math check, analyses); the helper is reached only when that UI runs something
    globalThis.overleafResearchRun = (job, options) => research().then(m => m.researchRun(context, job, options));
  }
  // Native reference completion reads the current snapshot through history-shaped endpoints, even offline.
  let snapshotVersion = 0, snapshotFiles = new Map();
  const snapshot = async () => {
    await flush();
    const result = new Map();
    for (const file of files.values()) {
      if (typeof file.content === 'string') result.set(file.path, { content: file.content });
      else {
        const bytes = Uint8Array.from(atob(file.data), char => char.charCodeAt(0));
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
        result.set(file.path, { hash, byteLength: bytes.length });
      }
    }
    return result;
  };
  const originalFetch = globalThis.fetch.bind(globalThis);
  const MIRROR_ORIGINS = new Set(["https://ftp.fau.de", "https://mirror.init7.net", "https://ftp.snt.utwente.nl", "https://ctan.mirror.garr.it", "https://mirrors.mit.edu", "https://ctan.math.illinois.edu", "https://mirror.aarnet.edu.au", "https://mirrors.tuna.tsinghua.edu.cn"]);
  const change = async action => {
    if (!joined) await flush(); // a participant's copy is memory only, and its pending edits may wait on the owner, who waits on this change
    const saved = await api.change(project, [...files.values()], action);
    project = saved.project; files = new Map(saved.files.map(file => [file.path, file])); nav = undefined;
    status('Saved in this browser. PDF may be from an earlier compilation.'); report('device');
    return saved;
  };
  const entity = (kind, id) => {
    for (const parent of folders.values()) {
      const list = parent.node[{ doc: 'docs', file: 'fileRefs', folder: 'folders' }[kind]];
      const node = list?.find(node => node._id === id);
      if (node) return { node, parent, list, path: parent.path ? parent.path + '/' + node.name : node.name };
    }
    throw Error('Local file or folder is missing');
  };
  const split = path => { const at = path.lastIndexOf('/'); return [path.slice(0, Math.max(0, at)), path.slice(at + 1)]; };
  const folderAt = path => [...folders.values()].find(folder => folder.path === path);
  const toBase64 = bytes => { let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(text); };
  /** One file-tree change by project path ({kind:'folder'|'doc', path} | {kind:'put', path, file|bytes, doc} | {kind:'relocate', from, to} | {kind:'remove', from}):
   * saved through the project API and shown in the native tree. Local edits, the sharing owner (lan-host source.apply) and a
   * participant replaying an owner-accepted change (lan-guest onFs) all come through here. */
  const fsApply = async op => {
    if (op.kind === 'folder' || op.kind === 'doc') {
      if (!joined) await flush();
      const [dir, name] = split(op.path), parent = folderAt(dir);
      if (!parent || !name) throw Error('Invalid local parent or name');
      const next = await api.add(project, op.kind, op.path); project = next.project; nav = undefined;
      let entity;
      if (next.file) { files.set(op.path, next.file); entity = { _id: next.file.doc, name }; parent.node.docs.push(entity); }
      else { entity = folder(name); parent.node.folders.push(entity); folders.set(entity._id, { node: entity, path: op.path }); }
      broadcast(next.file ? 'reciveNewDoc' : 'reciveNewFolder', parent.node._id, structuredClone(entity));
      return entity;
    }
    if (op.kind === 'put') {
      const resource = op.file ?? (op.doc ? { path: op.path, content: new TextDecoder('utf-8', { fatal: true }).decode(op.bytes) } : { path: op.path, data: toBase64(op.bytes) });
      await change({ kind: 'put', file: resource });
      const saved = files.get(resource.path), parts = saved.path.split('/'), name = parts.pop(), previousFolders = new Set(folders.keys());
      const folder = ensureFolder(parts.join('/'));
      // Nested upload folders must reach both the adapter and the native tree.
      for (const [id, entry] of folders) if (!previousFolders.has(id)) {
        const parentPath = entry.path.split('/').slice(0, -1).join('/'), parentFolder = [...folders.values()].find(folder => folder.path === parentPath);
        broadcast('reciveNewFolder', parentFolder.node._id, { ...entry.node, folders: [], docs: [], fileRefs: [] });
      }
      const node = { _id: saved.doc || crypto.randomUUID().replaceAll('-', '').slice(0, 24), name };
      folder[saved.doc ? 'docs' : 'fileRefs'].push(node);
      if (!saved.doc) assets.set(node._id, saved);
      broadcast(saved.doc ? 'reciveNewDoc' : 'reciveNewFile', folder._id, structuredClone(node));
      return { entity_id: node._id, entity_type: saved.doc ? 'doc' : 'file' };
    }
    if (op.kind === 'main') { await change({ kind: 'settings', main: op.path }); broadcast('rootDocUpdated', files.get(project.main).doc); return {}; }
    if (op.kind !== 'relocate' && op.kind !== 'remove') throw Error('Invalid local project action');
    const from = op.from, remove = op.kind === 'remove', [dir, base] = split(from), within = folderAt(dir);
    const kind = ['doc', 'file', 'folder'].find(kind => within?.node[{ doc: 'docs', file: 'fileRefs', folder: 'folders' }[kind]].some(node => node.name === base));
    if (!kind) throw Error('Local file or folder is missing');
    const item = entity(kind, within.node[{ doc: 'docs', file: 'fileRefs', folder: 'folders' }[kind]].find(node => node.name === base)._id);
    const [toDir, name] = remove ? [dir, base] : split(op.to), parent = remove ? item.parent : folderAt(toDir);
    if (!parent || !name) throw Error('Invalid local destination');
    const to = op.to;
    await change(remove ? { kind: 'remove', from } : { kind: 'relocate', from, to });
    item.list.splice(item.list.indexOf(item.node), 1);
    if (!remove) { item.node.name = name; parent.node[{ doc: 'docs', file: 'fileRefs', folder: 'folders' }[kind]].push(item.node); }
    const inside = path => path === from || path.startsWith(from + '/');
    for (const [id, folder] of folders) if (inside(folder.path)) { if (remove) folders.delete(id); else folder.path = to + folder.path.slice(from.length); }
    for (const [id, file] of assets) if (inside(file.path)) { if (remove) assets.delete(id); else assets.set(id, files.get(to + file.path.slice(from.length))); }
    if (remove) for (const [id, editor] of editors) if (![...files.values()].some(file => file.doc === id)) { editors.delete(id); if (active === editor) active = undefined; }
    if (remove) broadcast('removeEntity', item.node._id);
    else {
      if (parent !== item.parent) broadcast('reciveEntityMove', item.node._id, parent.node._id);
      if (name !== base) broadcast('reciveEntityRename', item.node._id, name);
    }
    broadcast('rootDocUpdated', files.get(project.main).doc);
  };
  lanEvents.onFs = fsApply;
  // While sharing, the owner's room checks and orders every change (lan-host.mjs); a participant's change returns once applied here.
  const fsChange = op => lan ? lan.fs(op) : fsApply(op);
  const localFetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
    const method = init?.method || (input instanceof Request ? input.method : 'GET');
    // TEX-PKG: GET to the TeX Live mirrors (store.mjs MIRRORS, manifest host_permissions) is the one exception; checked against the signed list.
    if (method === 'GET' && MIRROR_ORIGINS.has(url.origin)) return originalFetch(input, init);
    if (url.origin !== location.origin) return new Response('External requests disabled in Local only mode', { status: 503 });
    if (globalThis.overleafStandalone && url.pathname.startsWith(`/recovery/native-output/${project.id}/`) && url.pathname.endsWith('/output.log')) return new Response(compileLog, { headers: { 'Content-Type': 'text/plain' } });
    if (joined && url.pathname.startsWith(`/recovery/native-output/${project.id}/${project.outputDigest}/`)) { // shared session: the PDF lives in this tab only
      const bytes = url.pathname.endsWith('/output.pdf') ? project.pdf : url.pathname.endsWith('/output.synctex.gz') && project.synctex ? new Blob([project.synctex]) : null;
      if (!bytes) return new Response('Local output unavailable', { status: 404 });
      const range = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('Range')?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0, end = range ? Math.min(bytes.size - 1, range[2] ? Number(range[2]) : bytes.size - 1) : bytes.size - 1;
      if (range && start > end) return new Response(null, { status: 416 });
      return new Response(bytes.slice(start, end + 1), { status: range ? 206 : 200, headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.size}` } : {}) } });
    }
    if (url.pathname === `/editingSession/${clientProject}` && method === 'PUT') return new Response(null, { status: 204 });
    const editing = url.pathname.match(new RegExp(`^/project/${clientProject}/(doc|file|folder)/([a-f0-9]{24})(?:/(rename|move))?$`));
    if (globalThis.overleafStandalone && editing && (method === 'DELETE' || method === 'POST')) {
      try {
        const item = entity(editing[1], editing[2]), from = item.path;
        const body = method === 'DELETE' ? {} : JSON.parse(init?.body ?? await input.clone().text());
        const parent = editing[3] === 'move' ? folders.get(body.folder_id) : item.parent;
        const name = editing[3] === 'rename' ? body.name : item.node.name;
        if (!parent || typeof name !== 'string' || name.includes('/')) throw Error('Invalid local destination');
        await fsChange(method === 'DELETE' ? { kind: 'remove', from } : { kind: 'relocate', from, to: parent.path ? parent.path + '/' + name : name });
        return new Response(null, { status: 204 });
      } catch (error) { return Response.json({ message: error.message }, { status: 409 }); }
    }
    if (globalThis.overleafStandalone && url.pathname === `/project/${clientProject}/settings` && method === 'POST') {
      try {
        const body = JSON.parse(init?.body ?? await input.clone().text()), main = body.rootDocId === undefined ? undefined : [...files.values()].find(file => file.doc === body.rootDocId)?.path;
        if (body.rootDocId !== undefined && !main) throw Error('Choose an existing text main document');
        if (lan && main !== undefined) await fsChange({ kind: 'main', path: main }); // shared: the owner orders set-main with the other tree changes
        if (!lan || body.compiler !== undefined || body.name !== undefined) await change({ kind: 'settings', main: lan ? undefined : main, compiler: body.compiler, name: body.name });
        if (body.compiler !== undefined) broadcast('compilerUpdated', project.compiler);
        if (main !== undefined) broadcast('rootDocUpdated', files.get(project.main).doc);
        return new Response(null, { status: 204 });
      } catch (error) { return Response.json({ message: error.message }, { status: 409 }); }
    }
    if (globalThis.overleafStandalone && url.pathname === '/user/settings' && method === 'POST') {
      try { await change({ kind: 'settings', preferences: JSON.parse(init?.body ?? await input.clone().text()) }); return new Response(null, { status: 204 }); }
      catch (error) { return Response.json({ message: error.message }, { status: 409 }); }
    }
    if (globalThis.overleafStandalone && url.pathname.toLowerCase() === `/project/${clientProject}/upload` && method === 'POST') {
      try {
        const body = init?.body instanceof FormData ? init.body : await input.formData(), file = body.get('qqfile');
        if (!(file instanceof File)) throw Error('Choose a file to upload');
        const parent = folders.get(body.get('targetFolderId') || url.searchParams.get('folder_id') || root._id);
        if (!parent) throw Error('Local upload folder is missing');
        const { readProject } = await import('/extension/imports.mjs'), imported = await readProject([file]);
        if (imported.resources.length !== 1 || imported.folders.length) throw Error('Import ZIP projects from Saved projects');
        const resource = imported.resources[0], directoryPath = body.get('relativePath');
        // Uppy serializes an absent relativePath as the literal string "null".
        const relative = directoryPath && directoryPath !== 'null' ? directoryPath : body.get('name') || file.name;
        resource.path = parent.path ? parent.path + '/' + relative : relative;
        init?.signal?.throwIfAborted();
        const doc = typeof resource.content === 'string';
        // Shared uploads travel as exact bytes; the owner and every peer rebuild the same resource from them.
        const result = await fsChange({ kind: 'put', path: resource.path, doc, ...(lan ? { bytes: doc ? new TextEncoder().encode(resource.content) : Uint8Array.from(atob(resource.data), c => c.charCodeAt(0)) } : { file: resource }) });
        return Response.json({ success: true, ...result });
      } catch (error) { return Response.json({ success: false, error: error.message }, { status: 409 }); }
    }
    if (globalThis.overleafStandalone && url.pathname === `/project/${clientProject}/latest/history` && method === 'GET') {
      snapshotFiles = await snapshot(); snapshotVersion = 0;
      return Response.json({ chunk: { startVersion: 0, history: { snapshot: { files: Object.fromEntries(snapshotFiles) }, changes: [] } } });
    }
    if (globalThis.overleafStandalone && url.pathname === `/project/${clientProject}/changes` && method === 'GET') {
      if (Number(url.searchParams.get('since')) !== snapshotVersion) return Response.json({ message: 'Reload the local project snapshot' }, { status: 409 });
      const current = await snapshot(), operations = [];
      for (const [pathname, previous] of snapshotFiles) if (JSON.stringify(current.get(pathname)) !== JSON.stringify(previous)) operations.push({ pathname, newPathname: '' });
      for (const [pathname, file] of current) if (JSON.stringify(snapshotFiles.get(pathname)) !== JSON.stringify(file)) operations.push({ pathname, file });
      snapshotFiles = current;
      if (operations.length) snapshotVersion++;
      return Response.json({ changes: operations.length ? [{ operations, timestamp: new Date().toISOString(), authors: [] }] : [], hasMore: false });
    }
    if (globalThis.overleafStandalone && url.pathname.startsWith(`/project/${clientProject}/blob/`) && method === 'GET') {
      const hash = url.pathname.split('/').at(-1);
      for (const [path, file] of snapshotFiles) if (file.hash === hash) return new Response(Uint8Array.from(atob(files.get(path).data), char => char.charCodeAt(0)));
      return new Response('Local asset unavailable', { status: 404 });
    }
    if (url.pathname === `/project/${clientProject}/flush` && method === 'POST') {
      try { await flush(); return new Response(null, { status: 204 }); }
      catch (error) { return Response.json({ message: error.message }, { status: 409 }); }
    }
    const creating = url.pathname.match(new RegExp(`^/project/${clientProject}/(doc|folder)$`));
    if (creating && method === 'POST') {
      try {
        const body = JSON.parse(init?.body ?? await input.clone().text());
        const parent = folders.get(body.parent_folder_id);
        if (!parent || typeof body.name !== 'string' || body.name.includes('/')) throw Error('Invalid local parent or name');
        const entity = await fsChange({ kind: creating[1], path: parent.path ? parent.path + '/' + body.name : body.name });
        status('Created in this browser. Export the project to transfer new files.');
        return Response.json(entity);
      } catch (error) { return Response.json({ message: error.message }, { status: 409 }); }
    }
    if (url.pathname === `/project/${clientProject}/changes/users` && method === 'GET') return Response.json([]);
    if (url.pathname === `/project/${clientProject}/metadata` && method === 'GET') return Response.json({ projectMeta: project.native.projectMeta || {} });
    const metadata = url.pathname.match(new RegExp(`^/project/${clientProject}/doc/([a-f0-9]{24})/metadata$`));
    if (metadata && method === 'POST') return Response.json({ docId: metadata[1], meta: project.native.projectMeta?.[metadata[1]] || { labels: [], packages: {}, packageNames: [] } });
    if (url.pathname === `/project/${clientProject}/output` && method === 'DELETE') {
      if (controller) return Response.json({ error: 'Compilation already running' }, { status: 409 });
      compiler.carry = undefined;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === `/project/${clientProject}/compile/stop`) { controller?.abort(); return Response.json({ stopped: true }); }
    if (url.pathname === `/project/${clientProject}/compile` && method === 'POST') {
      if (url.searchParams.get('auto_compile') === 'true' && localStorage.getItem(`autocompile_enabled:${clientProject}`) === 'false') {
        status('Autocompile is off. Recompile to update the PDF.');
        return Response.json({ status: 'success', outputFiles: outputFiles(), compileGroup: 'standard', stats: {}, timings: {}, outputFilesArchive: null });
      }
      if (controller) return Response.json({ error: 'Compilation already running' }, { status: 409 });
      controller = new AbortController();
      try {
        for (let attempt = 0; ; attempt++) {
          await flush();
          const saved = await api.read(project.id);
          if ([...files.values()].some(file => saved.files.find(other => other.path === file.path)?.revision !== file.revision)) throw Error('Another tab changed this project. Reload before compiling.');
          const packages = await packageSet(), digest = await sourceKey(saved.files, packages);   // installed TeX packages are part of what a PDF was made from
          // The editor's automatic compile on open: the saved PDF was compiled from exactly these sources, so show it.
          if (attempt === 0 && url.searchParams.get('auto_compile') === 'true' && project.pdf && project.synctex && project.outputDigest === digest) {
            const savedNav = await navigation(project.synctex, project, [...files.values()]).catch(() => undefined);
            if (savedNav) {
              nav = savedNav; outputDigest = digest; status('Compiled and saved in this browser.');
              return Response.json({ status: 'success', outputFiles: outputFiles(), compileGroup: 'standard', stats: {}, timings: {}, outputFilesArchive: null });
            }
          }
          status('Compiling on this device…');
          const result = await (globalThis.overleafGroupCompile?.(project, saved.files, text => status(text), controller.signal) ?? compiler.compile(project, [...saved.files, ...packages.files], text => status(text), controller.signal)); // stage 3: the group's TeX when chosen
          compileLog = result.log || 'Compiled locally.\n';
          await flush();
          if (controller.signal.aborted) throw Error('Source changed during compilation. Compile again.');
          // Typing (or a participant's edit while sharing) during the compile: compile the latest source instead of reporting an error.
          if (digest !== await sourceKey([...files.values()], packages)) { if (attempt < 3) { status('Source changed; compiling the latest version…'); continue; } throw Error('Source changed during compilation. Compile again.'); }
          project = await api.output(project, saved.files, new Blob([result.pdf], { type: 'application/pdf' }), result.synctex, digest);
          nav = await navigation(project.synctex, project, [...files.values()]); outputDigest = digest;
          status('Compiled and saved in this browser.'); packageHint(null);
          return Response.json({ status: 'success', outputFiles: outputFiles(),
            compileGroup: 'standard', stats: {}, timings: {}, outputFilesArchive: null });
        }
      } catch (error) { compileLog = error.log || error.message; status(error.message + ' Previous PDF retained.', true); packageHint(compileLog); return Response.json({ status: 'error', outputFiles: outputFiles() }); }
      finally { controller = undefined; }
    }
    if (url.pathname.startsWith(`/project/${clientProject}/sync/`)) {
      const saved = await api.read(project.id);
      if (!nav || outputDigest !== await sourceKey(saved.files, await packageSet())) return Response.json({ error: 'Recompile current source first' }, { status: 409 });
      if (url.pathname.endsWith('/code')) {
        const path = url.searchParams.get('file')?.split('/').filter(part => part && part !== '.').join('/'), node = forward(nav, path, Number(url.searchParams.get('line')));
        markWord(node?.line === Number(url.searchParams.get('line')) ? caretWord(saved.files.find(file => file.path === path)?.content, node.line, Number(url.searchParams.get('column'))) : undefined, node);
        return node ? Response.json({ pdf: [{ page: node.page, h: node.x, v: node.y, width: node.width, height: node.height }] }) : Response.json({ error: 'No location' }, { status: 404 });
      }
      const node = backward(nav, Number(url.searchParams.get('page')), Number(url.searchParams.get('h')), Number(url.searchParams.get('v')));
      // SyncTeX leaf boxes identify a line, not a column; let the native editor refine the PDF selection.
      return node ? Response.json({ code: [{ file: node.path, line: node.line }] }) : Response.json({ error: 'No location' }, { status: 404 });
    }
    const asset = url.pathname.match(new RegExp(`^/project/${clientProject}/file/([a-f0-9]{24})`));
    if (asset && assets.has(asset[1])) { const file = assets.get(asset[1]); return new Response(file.content ?? Uint8Array.from(atob(file.data), c => c.charCodeAt(0))); }
    if (method !== 'GET') return new Response('This action requires a connection', { status: 503 });
    if (/\/messages$/.test(url.pathname)) return Response.json([]);
    return originalFetch(input, init);
  };
  globalThis.fetch = localFetch; globalThis.overleafParticipantFetch = localFetch;
  if (globalThis.overleafStandalone) {
    // The native upload dialog uses XHR; route only its local endpoint through the same guarded adapter. PDF.js also reads
    // chrome-extension: URLs with XHR, so a shared session's in-memory PDF goes through the adapter too, not the service worker.
    const NativeXHR = globalThis.XMLHttpRequest;
    globalThis.XMLHttpRequest = class extends NativeXHR {
      #local; #url; #method; #headers; #state = 0; #result; #text = ''; #buffer; #controller;
      open(method, input, ...args) {
        const url = new URL(input, location.href); this.#method = method.toUpperCase(); this.#headers = new Headers();
        this.#local = url.origin === location.origin && ((this.#method === 'POST' && url.pathname.toLowerCase() === `/project/${clientProject}/upload`) ||
          (!!joined && this.#method === 'GET' && url.pathname.startsWith('/recovery/native-output/')));
        this.#url = url.href; this.#result = undefined; this.#text = ''; this.#buffer = undefined; this.#state = 1;
        return super.open(method, input, ...args);
      }
      setRequestHeader(name, value) { if (this.#local) this.#headers.set(name, value); else super.setRequestHeader(name, value); }
      get readyState() { return this.#local ? this.#state : super.readyState; }
      get status() { return this.#local ? this.#result?.status || 0 : super.status; }
      get statusText() { return this.#local ? this.#result?.statusText || '' : super.statusText; }
      get responseText() { return this.#local ? this.#text : super.responseText; }
      get response() { return this.#local ? this.#buffer ?? (this.responseType === 'json' ? (this.#text ? JSON.parse(this.#text) : null) : this.#text) : super.response; }
      get responseURL() { return this.#local ? this.#url : super.responseURL; }
      getResponseHeader(name) { return this.#local ? this.#result?.headers.get(name) || null : super.getResponseHeader(name); }
      getAllResponseHeaders() { return this.#local ? [...(this.#result?.headers || [])].map(([key, value]) => `${key}: ${value}\r\n`).join('') : super.getAllResponseHeaders(); }
      send(body) {
        if (!this.#local) return super.send(body);
        const controller = this.#controller = new AbortController();
        const timer = this.timeout ? setTimeout(() => { this.abort(); this.dispatchEvent(new ProgressEvent('timeout')); }, this.timeout) : undefined;
        this.dispatchEvent(new ProgressEvent('loadstart')); this.upload.dispatchEvent(new ProgressEvent('loadstart'));
        void (async () => {
          try {
            const result = await localFetch(this.#url, { method: this.#method, headers: this.#headers, ...(this.#method === 'POST' ? { body } : {}), signal: controller.signal });
            const buffer = this.responseType === 'arraybuffer' ? await result.arrayBuffer() : undefined, text = buffer ? '' : await result.text(); if (controller.signal.aborted) return;
            this.#result = result; this.#text = text; this.#buffer = buffer; this.#state = 4;
            if (this.#method === 'POST') {
              this.upload.dispatchEvent(new ProgressEvent('progress', { lengthComputable: true, loaded: body.get('qqfile')?.size || 0, total: body.get('qqfile')?.size || 0 }));
              this.upload.dispatchEvent(new ProgressEvent('load')); this.upload.dispatchEvent(new ProgressEvent('loadend'));
            } else this.dispatchEvent(new ProgressEvent('progress', { lengthComputable: true, loaded: buffer?.byteLength ?? text.length, total: buffer?.byteLength ?? text.length }));
            this.dispatchEvent(new Event('readystatechange')); this.dispatchEvent(new ProgressEvent('load')); this.dispatchEvent(new ProgressEvent('loadend'));
          } catch { if (!controller.signal.aborted) { this.#state = 4; this.dispatchEvent(new ProgressEvent('error')); this.dispatchEvent(new ProgressEvent('loadend')); } }
          finally { clearTimeout(timer); }
        })();
      }
      abort() {
        if (!this.#local) return super.abort();
        this.#controller?.abort(); this.#state = 0;
        this.dispatchEvent(new ProgressEvent('abort')); this.dispatchEvent(new ProgressEvent('loadend'));
      }
    };
  }
  const resources = () => [...files.values()].map(file => { const text = textOf(editors.get(file.doc)); return typeof text === 'string' ? { ...file, content: text } : file; });
  if (globalThis.overleafStandalone) document.querySelector('#local-open-pdf').onclick = () => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'application/pdf,.pdf'; input.setAttribute('aria-label', 'Choose an existing PDF');
    input.onchange = async () => {
      try {
        const pdf = input.files[0]; if (!pdf) return;
        if (pdf.size > 16 * 1024 * 1024 || await pdf.slice(0, 5).text() !== '%PDF-') throw Error('Choose a PDF of at most 16 MB');
        const pdfjs = await import('./pdf.mjs'); pdfjs.GlobalWorkerOptions.workerSrc = '/recovery/pdf.worker.mjs';
        const loading = pdfjs.getDocument({ data: new Uint8Array(await pdf.arrayBuffer()), isEvalSupported: false, stopAtErrors: true });
        try { const document = await loading.promise; await document.getPage(1); }
        catch { throw Error('This PDF could not be opened. The previous PDF is retained.'); }
        finally { await loading.destroy(); }
        await flush(); project = await api.viewPdf(project, pdf); location.reload();
      }
      catch (error) { status(error.message, true); }
      finally { input.remove(); }
    };
    input.oncancel = () => input.remove(); input.hidden = true; document.body.append(input); input.click();
  };
  async function exportZip() {
    try { if (joined) await joined.shared.exportCopy('export'); download(await projectZip(resources()), project.project + '.zip', 'application/zip'); }
    catch (error) { status(error.message + '. Your source files are retained.', true); }
  }
  if (joined) { // visible state only: every handler above still needs an owner-signed ticket, and the owner re-checks the grant
    const copyControls = ['#local-export', '#local-savecopy'].map(id => document.querySelector(id));
    const allowCopies = grant => { for (const node of copyControls) { node.disabled = grant !== 'copy'; node.title = grant === 'copy' ? '' : 'The project owner has not allowed copies of this project'; } };
    lanEvents.onGrant = allowCopies; allowCopies(joined.shared.store.grant);
  }
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href]'); if (!link) return;
    const url = new URL(link.href, location.href);
    // Only the navigation is cancelled: the menu's own click handler still runs and closes the menu.
    if (url.origin === location.origin && url.pathname === '/project/' + clientProject + '/download/zip') {
      event.preventDefault(); void exportZip();
    }
    // File > Download as PDF links to a server download path; serve the saved PDF here (a joined participant needs the owner's grant).
    else if (url.origin === location.origin && url.pathname.endsWith('/output.pdf')) {
      event.preventDefault();
      if (!project.pdf) { status('No saved PDF yet. Recompile the project first.', true); return; }
      (joined ? joined.shared.authorize('download') : Promise.resolve()).then(() => download(project.pdf, 'output.pdf', 'application/pdf'), error => status(error.message, true));
    }
  }, true);
  document.querySelector('#local-export').onclick = async () => {
    try { if (joined) await joined.shared.exportCopy('export'); } catch (error) { status(error.message, true); return; }
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
  if (globalThis.overleafStandalone) document.querySelector('#local-deleted').onclick = async () => {
    try {
      await flush();
      if (!project.deleted?.length) { status('No deleted files to restore.'); return; }
      const dialog = document.createElement('dialog'); dialog.setAttribute('aria-label', 'Restore deleted local files'); dialog.className = 'recovery-review';
      const title = document.createElement('h2'); title.textContent = 'Deleted files'; dialog.append(title);
      for (const entry of project.deleted) {
        const row = document.createElement('p'), label = document.createElement('span'), button = document.createElement('button');
        label.textContent = [...entry.files.map(file => file.path), ...entry.folders].join(', ') + ' '; button.textContent = 'Restore';
        button.onclick = async () => { button.disabled = true; try { await change({ kind: 'restore', id: entry.id }); location.reload(); } catch (error) { status(error.message, true); button.disabled = false; } };
        row.append(label, button); dialog.append(row);
      }
      const close = document.createElement('button'); close.textContent = 'Close'; close.onclick = () => dialog.close(); dialog.append(close);
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
  if (joined) document.querySelector('#local-savecopy').onclick = async () => {
    try {
      await joined.shared.saveCopy(({ main, resources }) => globalThis.overleafLocalProjects.local(joined.project.native, 'Copy of shared project', resources, main));
      status('A standalone copy was saved in Saved projects.');
    } catch (error) { status(error.message, true); }
  };
  document.querySelector('#local-projects').onclick = () => location.assign('/recovery/project-workspace.html');
  addEventListener('beforeunload', event => { if ([...editors.values()].some(editor => editor.container.doc?.hasBufferedOps())) { event.preventDefault(); event.returnValue = ''; } });
  addEventListener('pagehide', () => compiler?.stop());
  compiler?.warm().catch(() => {}); // OPT-02: compiler start overlaps native editor script loading; failures resurface on compile
  for (const href of project.native.styles) {
    const url = new URL(href, location.origin); if (url.origin !== location.origin || !url.pathname.startsWith('/stylesheets/')) throw Error('Invalid native stylesheet');
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = (globalThis.overleafStandalone ? '' : '/recovery') + url.pathname; document.head.append(link);
  }
  for (const src of project.native.scripts) {
    const url = new URL(src, location.origin); if (url.origin !== location.origin || !url.pathname.startsWith('/js/')) throw Error('Invalid native script');
    await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = (globalThis.overleafStandalone ? '' : '/recovery') + url.pathname; script.onload = resolve; script.onerror = () => reject(Error('Native editor asset unavailable')); document.body.append(script); });
  }

  status('Native editor — Local only. Compile and export on this device.');
  // MATH-CHECK-01 / ANALYSIS-01: only when a research transport (the native research host bridge) is present; nothing runs on open.
  // The UI modules load on the first right-click or Ctrl+Alt+M/R in the editor, not on open (S3-16: unused tools cost nothing).
  if (globalThis.overleafStandalone && typeof globalThis.overleafResearchRun === 'function') {
    let loading = null;
    const first = event => {
      if (loading || event.defaultPrevented || !(event.target instanceof Element) || !event.target.closest('.cm-content')) return;   // .py/.R right-clicks are Run cell's
      if (event.type === 'keydown' && !(event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey && (event.code === 'KeyM' || event.code === 'KeyR'))) return;
      event.preventDefault(); event.stopPropagation();   // shortcut: this one right-click shows no browser menu even where research offers none
      loading = import('/extension/research-ui.mjs').then(ui => ui.registerResearch({ run: globalThis.overleafResearchRun, trusted: () => !lan && !joined && globalThis.overleafResearchTrusted?.(project.id) === true }))
        .then(handlers => handlers?.[event.type]?.(event)).catch(() => { loading = null; });
    };
    addEventListener('contextmenu', first, true); addEventListener('keydown', first, true);
  }
} catch (error) { status(error.message + '. Existing local files are retained.', true); }
