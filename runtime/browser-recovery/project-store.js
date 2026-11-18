// SPDX-License-Identifier: AGPL-3.0-only
(() => {
  const id = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
  const path = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
    !/[\\\x00-\x1f\x7f:]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
  let database;
  function open() {
    if (!database) database = new Promise((resolve, reject) => {
      const request = indexedDB.open('overleaf-local-projects', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('projects', { keyPath: 'id' });
        request.result.createObjectStore('files', { keyPath: ['workspace', 'path'] }).createIndex('workspace', 'workspace');
      };
      request.onerror = () => { database = undefined; reject(Error('Local project storage did not open')); };
      request.onblocked = () => { database = undefined; reject(Error('Close other offline workspace tabs before updating storage')); };
      request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); database = undefined; }; resolve(db); };
    });
    return database;
  }
  async function transaction(stores, mode, run) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode); let result, error;
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(error || Error('Local storage failed; the previously saved copy is retained'));
      try { run(tx, value => { result = value; }, message => { error = Error(message); tx.abort(); }); }
      catch (cause) { error = cause; tx.abort(); }
    });
  }
  async function create(payload, account, project, pdf, native, options = {}) {
    if (!id(account) || !id(project) || payload.user !== account || payload.project !== project) throw Error('Offline preparation identity changed');
    const source = payload.source;
    if (!source || !path(source.main) || !['pdflatex', 'xelatex', 'lualatex'].includes(source.compiler) ||
        !Array.isArray(source.resources) || source.resources.length > 1000 || !Array.isArray(payload.documents)) throw Error('Invalid offline project');
    const documents = new Map();
    for (const doc of payload.documents) {
      if (!path(doc.path) || !id(doc.id) || !Number.isSafeInteger(doc.version) || doc.version < 0 || documents.has(doc.path)) throw Error('Invalid document identity');
      documents.set(doc.path, doc);
    }
    const keys = new Set(); let bytes = 0;
    for (const file of source.resources) {
      if (!path(file.path) || keys.has(file.path) || (typeof file.content === 'string') === (typeof file.data === 'string')) throw Error('Invalid project file');
      keys.add(file.path);
      bytes += typeof file.content === 'string' ? new TextEncoder().encode(file.content).length : atob(file.data).length;
      if (bytes > 64 * 1024 * 1024 || (documents.has(file.path) && typeof file.content !== 'string')) throw Error('Project exceeds offline limits');
    }
    if (!keys.has(source.main) || [...documents.keys()].some(key => !keys.has(key))) throw Error('Project files are incomplete');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ main: source.main, compiler: source.compiler, resources: source.resources }))))].map(b => b.toString(16).padStart(2, '0')).join('');
    if (hash !== source.digest) throw Error('Project snapshot integrity mismatch');
    if (pdf && (!(pdf instanceof Blob) || pdf.size > 16 * 1024 * 1024 || await pdf.slice(0, 5).text() !== '%PDF-')) throw Error('Invalid saved PDF');
    if (native && (!Array.isArray(native.meta) || native.meta.length > 256 || !Array.isArray(native.scripts) || native.scripts.length > 256 ||
        !Array.isArray(native.styles) || native.styles.length > 64 || JSON.stringify(native).length > 4 * 1024 * 1024 ||
        native.meta.some(item => !/^ol-[\w-]+$/.test(item.name) || /csrf|token|session|analytics/i.test(item.name) || typeof item.content !== 'string') ||
        [...native.scripts, ...native.styles].some(value => typeof value !== 'string' || !/^\/(js|stylesheets|fonts)\//.test(value)))) throw Error('Invalid native editor metadata');
    const workspace = { id: crypto.randomUUID(), account, project, main: source.main, compiler: source.compiler,
      preparedAt: Date.now(), pdf: pdf || null, digest: source.digest, bytes, ...(native ? { native } : {}),
      ...(options.localOnly ? { localOnly: true, name: options.name } : {}) };
    await transaction(['projects', 'files'], 'readwrite', (tx, result) => {
      tx.objectStore('projects').add(workspace);
      for (const file of source.resources) {
        const doc = documents.get(file.path);
        tx.objectStore('files').add({ ...file, workspace: workspace.id, revision: 0,
          ...(doc ? { doc: doc.id, base: { version: doc.version, text: file.content } } : {}) });
      }
      result(workspace.id);
    });
    return workspace.id;
  }
  async function read(workspace) {
    if (typeof workspace !== 'string' || !/^[a-f0-9-]{36}$/.test(workspace)) throw Error('Invalid local project');
    return transaction(['projects', 'files'], 'readonly', (tx, result, fail) => {
      let project, files;
      const ready = () => { if (project && files) result({ project, files: files.sort((a, b) => a.path.localeCompare(b.path)) }); };
      const a = tx.objectStore('projects').get(workspace); a.onsuccess = () => { project = a.result; if (!project) fail('Local project is missing'); else ready(); };
      const b = tx.objectStore('files').index('workspace').getAll(workspace); b.onsuccess = () => { files = b.result; ready(); };
    });
  }
  async function save(file, text) {
    if (!file.doc || !id(file.doc) || !path(file.path) || typeof text !== 'string' || text.length > 2000000 || /[\uD800-\uDFFF\0]/.test(text)) throw Error('Unsupported local source edit');
    return transaction(['projects', 'files'], 'readwrite', (tx, result, fail) => {
      const store = tx.objectStore('files'), get = store.get([file.workspace, file.path]);
      get.onsuccess = () => {
        const current = get.result;
        if (!current || current.doc !== file.doc || current.revision !== file.revision) return fail('Another tab saved this file. Your unsaved text is retained here; export it before reloading.');
        const getProject = tx.objectStore('projects').get(file.workspace);
        getProject.onsuccess = () => {
          const project = getProject.result; if (!project) return fail('Local project is missing');
          const write = bytes => {
            const size = bytes + new TextEncoder().encode(text).length - new TextEncoder().encode(current.content).length;
            if (size > 64 * 1024 * 1024) return fail('Project exceeds the supported local storage size. Export your unsaved text.');
            const next = { ...current, content: text, revision: current.revision + 1, updatedAt: Date.now() };
            store.put(next); tx.objectStore('projects').put({ ...project, bytes: size }); result(next);
          };
          if (Number.isSafeInteger(project.bytes)) write(project.bytes);
          else {
            const all = store.index('workspace').getAll(file.workspace);
            all.onsuccess = () => write(all.result.reduce((sum, file) => sum + (typeof file.content === 'string' ? new TextEncoder().encode(file.content).length : atob(file.data).length), 0));
          }
        };
      };
    });
  }
  async function list() {
    return transaction(['projects'], 'readonly', (tx, result) => {
      const request = tx.objectStore('projects').getAll(); request.onsuccess = () => result(request.result);
    });
  }
  async function blank(template, name) {
    if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\x00-\x1f\x7f]/.test(name)) throw Error('Enter a project name of 1–200 characters');
    const { project: source } = await read(template);
    if (!source.native) throw Error('Prepare the native editor while connected first');
    const project = crypto.randomUUID().replaceAll('-', '').slice(0, 24);
    const resources = [{ path: 'main.tex', content: '\\documentclass{article}\n\\begin{document}\nHello world.\n\\end{document}\n' }];
    const snapshot = { main: 'main.tex', compiler: 'pdflatex', resources };
    snapshot.digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(snapshot))))].map(b => b.toString(16).padStart(2, '0')).join('');
    return create({ user: source.account, project, source: snapshot, documents: [{ path: 'main.tex', id: crypto.randomUUID().replaceAll('-', '').slice(0, 24), version: 0 }] },
      source.account, project, null, { ...source.native, projectMeta: {} }, { localOnly: true, name: name.trim() });
  }
  async function add(project, kind, name) {
    if (!['doc', 'folder'].includes(kind) || !path(name)) throw Error('Invalid local file or folder');
    return transaction(['projects', 'files'], 'readwrite', (tx, result, fail) => {
      const projects = tx.objectStore('projects'), store = tx.objectStore('files');
      const request = projects.get(project.id);
      request.onsuccess = () => {
        const current = request.result;
        if (!current || (current.structure || 0) !== (project.structure || 0)) return fail('Another tab changed the project files. Reload before creating a file.');
        const all = store.index('workspace').getAll(project.id);
        all.onsuccess = () => {
          const files = all.result, folders = new Set(current.folders || []);
          for (const file of files) {
            const parts = file.path.split('/'); parts.pop();
            while (parts.length) { folders.add(parts.join('/')); parts.pop(); }
          }
          const parent = name.split('/').slice(0, -1).join('/');
          if (parent && !folders.has(parent)) return fail('Local parent folder is missing');
          if (folders.has(name) || files.some(file => file.path === name)) return fail('A file or folder with this name already exists');
          if (files.length + folders.size >= 1000) return fail('Project exceeds the supported file and folder limit');
          const next = { ...current, structure: (current.structure || 0) + 1 };
          let file;
          if (kind === 'folder') next.folders = [...folders, name];
          else {
            file = { workspace: project.id, path: name, doc: crypto.randomUUID().replaceAll('-', '').slice(0, 24), content: '', revision: 0, base: { version: 0, text: '' }, localOnly: true };
            store.add(file);
          }
          projects.put(next); result({ project: next, file });
        };
      };
    });
  }
  async function output(project, expected, pdf, synctex, digest) {
    if (!(pdf instanceof Blob) || pdf.size > 16 * 1024 * 1024 || await pdf.slice(0, 5).text() !== '%PDF-' ||
        !(synctex instanceof Uint8Array) || synctex.length > 8 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(digest)) throw Error('Invalid compiled output');
    return transaction(['projects', 'files'], 'readwrite', (tx, result, fail) => {
      const get = tx.objectStore('files').index('workspace').getAll(project.id);
      get.onsuccess = () => {
        const current = get.result;
        if (current.length !== expected.length || current.some(file => !expected.some(old => old.path === file.path && old.revision === file.revision))) return fail('Source changed during compilation. Compile again.');
        const request = tx.objectStore('projects').get(project.id);
        request.onsuccess = () => {
          if (!request.result) return fail('Local project is missing');
          const next = { ...request.result, pdf, synctex, outputDigest: digest };
          tx.objectStore('projects').put(next); result(next);
        };
      };
    });
  }
  globalThis.overleafLocalProjects = Object.freeze({ create, read, save, list, output, blank, add });
})();
