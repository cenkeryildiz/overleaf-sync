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
    const folders = new Set(options.folders || []);
    for (const name of [...keys, ...folders]) {
      if (!path(name)) throw Error('Invalid project folder');
      const parts = name.split('/'); parts.pop();
      while (parts.length) { const parent = parts.join('/'); if (keys.has(parent)) throw Error('A project file cannot also be a folder'); folders.add(parent); parts.pop(); }
    }
    if ([...folders].some(name => keys.has(name)) || keys.size + folders.size > 1000) throw Error('Invalid project file and folder count');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ main: source.main, compiler: source.compiler, resources: source.resources }))))].map(b => b.toString(16).padStart(2, '0')).join('');
    if (hash !== source.digest) throw Error('Project snapshot integrity mismatch');
    if (pdf && (!(pdf instanceof Blob) || pdf.size > 16 * 1024 * 1024 || await pdf.slice(0, 5).text() !== '%PDF-')) throw Error('Invalid saved PDF');
    if (native && (!Array.isArray(native.meta) || native.meta.length > 256 || !Array.isArray(native.scripts) || native.scripts.length > 256 ||
        !Array.isArray(native.styles) || native.styles.length > 64 || JSON.stringify(native).length > 4 * 1024 * 1024 ||
        native.meta.some(item => !/^ol-[\w-]+$/.test(item.name) || /csrf|token|session|analytics/i.test(item.name) || typeof item.content !== 'string') ||
        [...native.scripts, ...native.styles].some(value => typeof value !== 'string' || !/^\/(js|stylesheets|fonts)\//.test(value)))) throw Error('Invalid native editor metadata');
    const workspace = { id: crypto.randomUUID(), account, project, main: source.main, compiler: source.compiler,
      preparedAt: Date.now(), pdf: pdf || null, digest: source.digest, bytes, ...(native ? { native } : {}),
      ...(options.localOnly ? { localOnly: true, name: options.name } : {}), folders: [...folders] };
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
    if (!file.doc || !id(file.doc) || !path(file.path) || typeof text !== 'string' || text.length > 2000000 || !text.isWellFormed() || text.includes('\0')) throw Error('Unsupported local source edit');
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
            if (size + (project.deletedBytes || 0) > 64 * 1024 * 1024) return fail('Project exceeds the supported local storage size. Export your unsaved text.');
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
    return local(source.native, name, [{ path: 'main.tex', content: '\\documentclass{article}\n\\begin{document}\nHello world.\n\\end{document}\n' }], 'main.tex', 'pdflatex', source.account);
  }
  async function local(native, name, resources, main, compiler = 'pdflatex', account = crypto.randomUUID().replaceAll('-', '').slice(0, 24), folders = []) {
    if (!native?.scripts?.length || !native?.meta?.length) throw Error('The bundled native editor is unavailable');
    if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\x00-\x1f\x7f]/.test(name)) throw Error('Enter a project name of 1–200 characters');
    if (!Array.isArray(folders) || folders.length > 1000 || folders.some(value => !path(value))) throw Error('Invalid local folders');
    if (!Array.isArray(resources) || !resources.some(file => file.path === main && typeof file.content === 'string')) throw Error('Choose a text source as the main document');
    const project = crypto.randomUUID().replaceAll('-', '').slice(0, 24);
    const snapshot = { main, compiler, resources };
    snapshot.digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(snapshot))))].map(b => b.toString(16).padStart(2, '0')).join('');
    return create({ user: account, project, source: snapshot, documents: resources.filter(file => typeof file.content === 'string')
      .map(file => ({ path: file.path, id: crypto.randomUUID().replaceAll('-', '').slice(0, 24), version: 0 })) },
      account, project, null, { ...native, projectMeta: {} }, { localOnly: true, name: name.trim(), folders });
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
          if (files.length + folders.size + (current.deleted || []).reduce((n, entry) => n + entry.files.length + entry.folders.length, 0) >= 1000) return fail('Project exceeds the supported file and folder limit');
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
  async function change(project, expected, action) {
    if (!['relocate', 'remove', 'put', 'restore', 'settings'].includes(action?.kind)) throw Error('Invalid local project action');
    return transaction(['projects', 'files'], 'readwrite', (tx, result, fail) => {
      const projects = tx.objectStore('projects'), store = tx.objectStore('files'), request = projects.get(project.id);
      request.onsuccess = () => {
        const current = request.result;
        if (!current || (current.structure || 0) !== (project.structure || 0)) return fail('Another tab changed this project. Reload before changing files or settings.');
        const all = store.index('workspace').getAll(project.id);
        all.onsuccess = () => {
          try {
            const previous = all.result;
            const revisions = new Map(expected.map(file => [file.path, file.revision])), previousFiles = new Map(previous.map(file => [file.path, file]));
            if (previous.length !== expected.length || previous.some(file => revisions.get(file.path) !== file.revision)) throw Error('Source changed. Reload before changing project files.');
            let files = previous, folders = new Set(current.folders || []);
            const next = { ...current, structure: (current.structure || 0) + 1, deleted: [...(current.deleted || [])] };
            const inside = name => name === action.from || name.startsWith(action.from + '/');
            if (['relocate', 'remove'].includes(action.kind)) {
              if (!path(action.from) || (!folders.has(action.from) && !files.some(file => file.path === action.from))) throw Error('Local file or folder is missing');
              if (action.kind === 'remove') {
                if (inside(current.main)) throw Error('Choose another main document before deleting this one');
                next.deleted.push({ id: crypto.randomUUID(), files: files.filter(file => inside(file.path)), folders: [...folders].filter(inside), removedAt: Date.now() });
                files = files.filter(file => !inside(file.path)); folders = new Set([...folders].filter(name => !inside(name)));
              } else {
                if (!path(action.to) || inside(action.to)) throw Error('Choose a different valid destination outside this folder');
                const parent = action.to.split('/').slice(0, -1).join('/');
                if (parent && !folders.has(parent)) throw Error('The destination folder is missing');
                if (folders.has(action.to) || files.some(file => file.path === action.to)) throw Error('A file or folder with this name already exists');
                const rename = name => inside(name) ? action.to + name.slice(action.from.length) : name;
                files = files.map(file => inside(file.path) ? { ...file, path: rename(file.path), revision: file.revision + 1 } : file);
                folders = new Set([...folders].map(rename)); next.main = rename(current.main);
              }
            } else if (action.kind === 'put') {
              const file = action.file;
              if (!path(file?.path) || (typeof file.content === 'string') === (typeof file.data === 'string')) throw Error('Invalid uploaded file');
              if (typeof file.content === 'string' && (file.content.length > 2000000 || !file.content.isWellFormed() || file.content.includes('\0'))) throw Error('Unsupported text file');
              if (files.some(old => old.path === file.path) || folders.has(file.path)) throw Error('A file or folder with this name already exists; rename it before uploading');
              files = [...files, { path: file.path, ...(typeof file.content === 'string' ? { content: file.content, doc: crypto.randomUUID().replaceAll('-', '').slice(0, 24), base: { text: file.content, version: 0 } } : { data: file.data }), workspace: current.id, revision: 0, localOnly: true }];
            } else if (action.kind === 'restore') {
              const entry = next.deleted.find(entry => entry.id === action.id);
              if (!entry) throw Error('Deleted copy is missing');
              for (const file of entry.files) if (files.some(old => old.path === file.path) || folders.has(file.path)) throw Error('Rename the existing file before restoring this copy');
              for (const name of entry.folders) if (files.some(file => file.path === name)) throw Error('A file blocks this restored folder');
              files = [...files, ...entry.files.map(file => ({ ...file, revision: file.revision + 1 }))];
              entry.folders.forEach(name => folders.add(name)); next.deleted = next.deleted.filter(saved => saved.id !== action.id);
            } else {
              if (action.main !== undefined) next.main = action.main;
              if (action.compiler !== undefined) next.compiler = action.compiler;
              if (action.name !== undefined) {
                if (typeof action.name !== 'string' || !action.name.trim() || action.name.length > 200 || /[\x00-\x1f\x7f]/.test(action.name)) throw Error('Enter a project name of 1–200 characters');
                next.name = action.name.trim();
              }
              if (action.preferences !== undefined) {
                if (!action.preferences || typeof action.preferences !== 'object' || Array.isArray(action.preferences) || JSON.stringify(action.preferences).length > 65536) throw Error('Invalid editor preferences');
                const native = structuredClone(current.native), meta = native.meta.find(item => item.name === 'ol-userSettings');
                if (!meta) throw Error('Editor settings are unavailable');
                meta.content = JSON.stringify({ ...JSON.parse(meta.content), ...action.preferences }); next.native = native;
              }
            }
            if (!['pdflatex', 'xelatex', 'lualatex'].includes(next.compiler) || !files.some(file => file.path === next.main && file.doc)) throw Error('Choose an existing text main document and supported compiler');
            const names = new Set(); let bytes = 0, deletedBytes = 0;
            for (const file of files) {
              if (!path(file.path) || names.has(file.path)) throw Error('Conflicting local file paths'); names.add(file.path);
              const parts = file.path.split('/'); parts.pop();
              while (parts.length) { folders.add(parts.join('/')); parts.pop(); }
              bytes += typeof file.content === 'string' ? new TextEncoder().encode(file.content).length : atob(file.data).length;
            }
            for (const entry of next.deleted) for (const file of entry.files) deletedBytes += typeof file.content === 'string' ? new TextEncoder().encode(file.content).length : atob(file.data).length;
            if ([...folders].some(name => !path(name) || names.has(name)) || names.size + folders.size + next.deleted.reduce((n, entry) => n + entry.files.length + entry.folders.length, 0) > 1000 || bytes + deletedBytes > 64 * 1024 * 1024) throw Error('Project and recovery copies exceed local file or size limits');
            next.bytes = bytes; next.deletedBytes = deletedBytes; next.folders = [...folders];
            for (const file of previous) if (!names.has(file.path)) store.delete([current.id, file.path]);
            for (const file of files) if (previousFiles.get(file.path) !== file) store.put(file);
            projects.put(next); result({ project: next, files });
          } catch (error) { fail(error.message); }
        };
      };
    });
  }
  async function viewPdf(project, pdf) {
    if (!(pdf instanceof Blob) || pdf.size > 16 * 1024 * 1024 || await pdf.slice(0, 5).text() !== '%PDF-') throw Error('Choose a PDF of at most 16 MB');
    const pdfDigest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await pdf.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return transaction(['projects'], 'readwrite', (tx, result, fail) => {
      const store = tx.objectStore('projects'), request = store.get(project.id);
      request.onsuccess = () => {
        const current = request.result;
        if (!current || (current.structure || 0) !== (project.structure || 0)) return fail('Another tab changed this project. Reload before opening the PDF.');
        const next = { ...current, pdf, pdfImported: true, pdfDigest, synctex: undefined, outputDigest: undefined };
        store.put(next); result(next);
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
          if ((request.result.structure || 0) !== (project.structure || 0)) return fail('Project settings or files changed during compilation. Compile again.');
          const next = { ...request.result, pdf, synctex, outputDigest: digest, pdfImported: false, pdfDigest: undefined };
          tx.objectStore('projects').put(next); result(next);
        };
      };
    });
  }
  globalThis.overleafLocalProjects = Object.freeze({ create, read, save, list, output, blank, local, add, change, viewPdf });
})();
