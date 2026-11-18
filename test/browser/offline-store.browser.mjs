// TG-02/TG-03/TG-04 (adapter part): real Chrome IndexedDB, no server, no accounts, no network.
// Serves runtime/browser-recovery from an intercepted loopback origin; the BusyTeX SDK and native bundles are stubs.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = 'http://127.0.0.1:9';
const dir = new URL('../../runtime/browser-recovery/', import.meta.url);
const served = new Set(['offline-toolbar.js', 'project-store.js', 'native-workspace.mjs', 'project-compile.mjs', 'project-zip.mjs', 'client-zip.mjs', 'synctex-parser.mjs']);
const shell = (script, module = false) => `<!doctype html><meta charset="utf-8"><meta name="ol-user" content='{"_id":"${'a'.repeat(24)}","email":"x@example.test"}'>
<div id="local-bar"><div id="local-status"></div></div>${[].map(n => `<button id="local-${n}"></button>`).join('')}
<script src="/recovery/offline-toolbar.js"></script><script src="/recovery/project-store.js"></script>${script ? `<script ${module ? 'type="module" ' : ''}src="${script}"></script>` : ''}`;
const results = {};
// Test helpers installed in the page; re-run after each reload.
const setup = () => {
    const hex = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
    const id = () => crypto.randomUUID().replaceAll('-', '').slice(0, 24);
    globalThis.t = {
      account: 'a'.repeat(24), id,
      native: { meta: [{ name: 'ol-projectName', content: 'Fixture' }], scripts: ['/js/editor.js'], styles: ['/stylesheets/main.css'], projectMeta: {} },
      async create(resources, documents, extra = {}) {
        const project = id(), snapshot = { main: 'main.tex', compiler: 'pdflatex', resources };
        snapshot.digest = await hex(JSON.stringify(snapshot));
        return overleafLocalProjects.create({ user: t.account, project, source: snapshot, documents }, t.account, project, extra.pdf, extra.native, extra.options);
      },
      async refusal(promise) { try { await promise; return null; } catch (e) { return e.message; } },
    };
};
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const timer = setTimeout(() => browser.close(), 120000);
try {
  const context = await browser.newContext();
  const outside = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { outside.push(url.origin); return route.abort(); }
    const name = url.pathname.replace(/^\/recovery\//, '');
    if (url.pathname === '/recovery/store.html') return route.fulfill({ contentType: 'text/html', body: shell() });
    if (url.pathname === '/recovery/native-workspace.html') return route.fulfill({ contentType: 'text/html', body: shell('/recovery/native-workspace.mjs', true) });
    if (name === 'busytex-sdk.mjs') return route.fulfill({ contentType: 'text/javascript', body: 'export class BusyTexRunner{terminate(){}};export class PdfLatex{};export class XeLatex{};export class LuaLatex{};' });
    if (url.pathname.startsWith('/recovery/js/') || url.pathname.startsWith('/recovery/stylesheets/')) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: '' });
    if (served.has(name)) return route.fulfill({ contentType: name.endsWith('.js') || name.endsWith('.mjs') ? 'text/javascript' : 'text/plain', body: readFileSync(new URL(name, dir)) });
    return route.fulfill({ status: 404, body: '' });
  });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/recovery/store.html');
  await page.evaluate(setup);

  // TG-02: additions, structure CAS, missing parent, duplicates, atomicity, empty folder persistence.
  results.creation = await page.evaluate(async () => {
    const api = overleafLocalProjects, mainDoc = t.id();
    const ws = await t.create([{ path: 'main.tex', content: 'main' }, { path: 'figure.png', data: 'AAEC/w==' }], [{ path: 'main.tex', id: mainDoc, version: 4 }]);
    let { project } = await api.read(ws); const stale = project;
    const folder = await api.add(project, 'folder', 'chapters'); project = folder.project;
    const doc = await api.add(project, 'doc', 'chapters/a.tex'); project = doc.project;
    const refused = {
      missingParent: await t.refusal(api.add(project, 'doc', 'missing/b.tex')),
      duplicateFolder: await t.refusal(api.add(project, 'doc', 'chapters')),
      duplicateFile: await t.refusal(api.add(project, 'folder', 'main.tex')),
      staleTab: await t.refusal(api.add(stale, 'doc', 'other.tex')),
      unsafe: await t.refusal(api.add(project, 'doc', 'a/../b.tex')),
      kind: await t.refusal(api.add(project, 'file', 'c.tex')),
    };
    const empty = await api.add(project, 'folder', 'empty'); project = empty.project;
    return { ws, refused, structure: project.structure, file: { path: doc.file.path, content: doc.file.content, localOnly: doc.file.localOnly, version: doc.file.base.version } };
  });
  const c = results.creation;
  assert.match(c.refused.missingParent, /parent folder is missing/);
  assert.match(c.refused.duplicateFolder, /already exists/); assert.match(c.refused.duplicateFile, /already exists/);
  assert.match(c.refused.staleTab, /Another tab changed the project files/);
  assert.match(c.refused.unsafe, /Invalid local/); assert.match(c.refused.kind, /Invalid local/);
  assert.deepEqual(c.file, { path: 'chapters/a.tex', content: '', localOnly: true, version: 0 });
  assert.equal(c.structure, 3);
  await page.reload();
  const reopened = await page.evaluate(async ws => { const { project, files } = await overleafLocalProjects.read(ws); return { folders: project.folders, structure: project.structure, files: files.map(f => f.path) }; }, c.ws);
  assert.deepEqual(reopened.files, ['chapters/a.tex', 'figure.png', 'main.tex'], 'Refused additions must leave files unchanged');
  assert.deepEqual([...reopened.folders].sort(), ['chapters', 'empty'], 'Empty folder must persist after reopening');
  assert.equal(reopened.structure, 3);

  // TG-02: 1000 file+folder limit.
  await page.evaluate(setup);
  results.limit = await page.evaluate(async () => {
    const api = overleafLocalProjects, resources = [{ path: 'main.tex', content: 'm' }];
    for (let i = 1; i < 999; i++) resources.push({ path: `f${i}.tex`, content: '' });
    const ws = await t.create(resources, [{ path: 'main.tex', id: t.id(), version: 0 }]);
    let { project } = await api.read(ws);
    project = (await api.add(project, 'doc', 'last.tex')).project;
    const over = await t.refusal(api.add(project, 'folder', 'one-more'));
    const tooMany = [...resources, { path: 'x.tex', content: '' }, { path: 'y.tex', content: '' }];
    return { over, files: (await api.read(ws)).files.length, createOver: await t.refusal(t.create(tooMany, [])) };
  });
  assert.match(results.limit.over, /file and folder limit/); assert.equal(results.limit.files, 1000);
  assert.match(results.limit.createOver, /Invalid offline project/);

  // Saves and outputs: non-BMP/oversized refusal, stale revision, stale compile output, invalid PDF, unsafe native metadata.
  results.saves = await page.evaluate(async () => {
    const api = overleafLocalProjects, doc = t.id();
    const ws = await t.create([{ path: 'main.tex', content: 'one' }], [{ path: 'main.tex', id: doc, version: 1 }]);
    const file = (await api.read(ws)).files[0];
    const refused = { nonBmp: await t.refusal(api.save(file, 'emoji 😀')), oversized: await t.refusal(api.save(file, 'x'.repeat(2000001))), nul: await t.refusal(api.save(file, 'a\0b')) };
    const saved = await api.save(file, 'two'); refused.staleRevision = await t.refusal(api.save(file, 'three'));
    const { project, files } = await api.read(ws);
    const pdf = new Blob(['%PDF-1.5 synthetic'], { type: 'application/pdf' }), synctex = new Uint8Array([1]), digest = 'f'.repeat(64);
    refused.staleOutput = await t.refusal(api.output(project, [{ path: 'main.tex', revision: 0 }], pdf, synctex, digest));
    refused.notPdf = await t.refusal(api.output(project, files, new Blob(['HTML']), synctex, digest));
    refused.badDigest = await t.refusal(api.output(project, files, pdf, synctex, 'nope'));
    const good = await api.output(project, files, pdf, synctex, digest);
    refused.createBadPdf = await t.refusal(t.create([{ path: 'main.tex', content: 'x' }], [], { pdf: new Blob(['not a pdf']) }));
    refused.createSecretMeta = await t.refusal(t.create([{ path: 'main.tex', content: 'x' }], [], { native: { ...t.native, meta: [{ name: 'ol-csrfToken', content: 'secret' }] } }));
    refused.createForeignScript = await t.refusal(t.create([{ path: 'main.tex', content: 'x' }], [], { native: { ...t.native, scripts: ['https://evil.test/x.js'] } }));
    const after = (await api.read(ws)).files[0];
    return { refused, content: after.content, revision: after.revision, savedRevision: saved.revision, outputDigest: good.outputDigest };
  });
  const s = results.saves;
  for (const key of ['nonBmp', 'oversized', 'nul']) assert.match(s.refused[key], /Unsupported local source edit/, key);
  assert.match(s.refused.staleRevision, /Another tab saved this file/);
  assert.match(s.refused.staleOutput, /Source changed during compilation/);
  assert.match(s.refused.notPdf, /Invalid compiled output/); assert.match(s.refused.badDigest, /Invalid compiled output/);
  assert.match(s.refused.createBadPdf, /Invalid saved PDF/);
  assert.match(s.refused.createSecretMeta, /Invalid native editor metadata/); assert.match(s.refused.createForeignScript, /Invalid native editor metadata/);
  assert.equal(s.content, 'two'); assert.equal(s.revision, 1); assert.equal(s.savedRevision, 1); assert.equal(s.outputDigest, 'f'.repeat(64));

  // R3: a storage quota failure refuses the whole project; nothing partial is kept, and a later attempt succeeds.
  // Chrome applies a quota override only to storage opened afterwards, so this uses a fresh context.
  const quotaContext = await browser.newContext();
  await quotaContext.route('**/*', route => new URL(route.request().url()).origin === origin
    ? (new URL(route.request().url()).pathname === '/recovery/store.html' ? route.fulfill({ contentType: 'text/html', body: shell() }) : route.fulfill({ contentType: 'text/javascript', body: readFileSync(new URL('project-store.js', dir)) }))
    : route.abort());
  const quotaPage = await quotaContext.newPage(); await quotaPage.goto(origin + '/recovery/store.html');
  const cdp = await quotaContext.newCDPSession(quotaPage);
  await cdp.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 512 * 1024 }); await quotaPage.evaluate(setup);
  results.quota = await quotaPage.evaluate(async () => {
    const big = Array.from({ length: 48 }, () => Array.from(crypto.getRandomValues(new Uint8Array(32768)), b => b.toString(16).padStart(2, '0')).join('')).join(''); // incompressible 3 MiB
    const refused = await t.refusal(t.create([{ path: 'main.tex', content: 'm' }, { path: 'big.tex', content: big }], []));
    return { refused, stored: (await overleafLocalProjects.list()).length };
  });
  await cdp.send('Storage.overrideQuotaForOrigin', { origin }); await quotaPage.close();
  const retryPage = await quotaContext.newPage(); await retryPage.goto(origin + '/recovery/store.html'); await retryPage.evaluate(setup);
  results.quotaRecovered = await retryPage.evaluate(async () => ({ stored: (await overleafLocalProjects.list()).length,
    content: (await overleafLocalProjects.read(await t.create([{ path: 'main.tex', content: 'after quota' }], []))).files[0].content }));
  await quotaContext.close();
  assert.match(results.quota.refused || '', /Local storage failed|quota/i, 'Quota failure must be reported');
  assert.equal(results.quota.stored, 0, 'A refused project must not be partly stored');
  assert.deepEqual(results.quotaRecovered, { stored: 0, content: 'after quota' });

  // TG-03 + TG-04: native adapter tree copy, creation events, local-only refusals and preserved files.
  const ws = await page.evaluate(async () => {
    const doc = t.id();
    return t.create([{ path: 'main.tex', content: 'native main' }, { path: 'figure.png', data: 'AAEC/w==' }], [{ path: 'main.tex', id: doc, version: 2 }], { native: t.native });
  });
  await page.goto(origin + '/recovery/native-workspace.html#' + ws);
  await page.waitForFunction(() => document.querySelector('#local-status').textContent.startsWith('Native editor — Local only'));
  results.adapter = await page.evaluate(async () => {
    const clientProject = document.querySelector('meta[name="ol-project_id"]').content, transport = io.connect(), events = [];
    const joined = await new Promise(resolve => { transport.on('joinProjectResponse', resolve); transport.connect(); });
    transport.on('reciveNewDoc', (parent, entity) => events.push(['doc', parent, entity.name]));
    transport.on('reciveNewFolder', (parent, entity) => events.push(['folder', parent, entity.name]));
    const tree = joined.project.rootFolder[0];
    const joinedDoc = await new Promise(resolve => transport.emit('joinDoc', tree.docs[0]._id, {}, (...args) => resolve(args)));
    const post = (path, body) => fetch(`/project/${clientProject}${path}`, { method: 'POST', body: JSON.stringify(body) });
    const created = await post('/doc', { parent_folder_id: tree._id, name: 'new.tex' });
    const duplicate = await post('/doc', { parent_folder_id: tree._id, name: 'new.tex' });
    const folder = await post('/folder', { parent_folder_id: tree._id, name: 'notes' });
    const badParent = await post('/doc', { parent_folder_id: 'f'.repeat(24), name: 'x.tex' });
    const slash = await post('/doc', { parent_folder_id: tree._id, name: 'a/b.tex' });
    const unknownPost = await fetch(`/project/${clientProject}/rename`, { method: 'POST', body: '{}' });
    const external = await fetch('https://example.test/x');
    const flush = await fetch(`/project/${clientProject}/flush`, { method: 'POST' });
    const session = await fetch(`/editingSession/${clientProject}`, { method: 'PUT' });
    const stopped = await fetch(`/project/${clientProject}/compile/stop`, { method: 'POST' });
    const syncBeforeCompile = await fetch(`/project/${clientProject}/sync/code?file=main.tex&line=1&column=0`);
    const asset = tree.fileRefs.find(f => f.name === 'figure.png');
    const bytes = [...new Uint8Array(await (await fetch(`/project/${clientProject}/file/${asset._id}`)).arrayBuffer())];
    const emitted = await new Promise(resolve => transport.emit('renameEntity', 'x', 'doc', 'y', error => resolve(error?.message)));
    // Native CE+ reuses one editor for every document: exports must not take another file's text from it.
    const saved = await overleafLocalProjects.read(location.hash.slice(1)), mainDoc = saved.files.find(f => f.path === 'main.tex').doc, newDoc = saved.files.find(f => f.path === 'new.tex').doc;
    let showing = 'native main';
    const facade = { getValue: () => showing }, container = (id, snapshot) => ({ doc_id: id, flush() {}, doc: { hasBufferedOps: () => false, ...(snapshot ? { getSnapshot: () => snapshot } : {}) } });
    overleafOfflineNative.attach(facade, container(mainDoc, 'native main with unsaved edit')); showing = '% typed into new.tex\n'; overleafOfflineNative.attach(facade, container(newDoc));
    const blobs = []; URL.createObjectURL = blob => { blobs.push(blob); return 'blob:captured'; };
    HTMLAnchorElement.prototype.click = () => {};
    document.querySelector('#local-export').click();
    await new Promise(resolve => setTimeout(resolve, 200));
    const exportedJson = JSON.parse(await blobs[0].text());
    const exportedTexts = Object.fromEntries(exportedJson.files.map(f => [f.path, f.content]));
    const stored = await overleafLocalProjects.read(location.hash.slice(1));
    return {
      deliveredTreeDocs: tree.docs.map(d => d.name), deliveredTreeFolders: tree.folders.map(f => f.name), events,
      status: { created: created.status, duplicate: duplicate.status, folder: folder.status, badParent: badParent.status, slash: slash.status,
        unknownPost: unknownPost.status, external: external.status, flush: flush.status, session: session.status, stopped: stopped.status, syncBeforeCompile: syncBeforeCompile.status },
      duplicateMessage: (await duplicate.json()).message, bytes, emitted,
      stored: stored.files.map(f => [f.path, f.content ?? f.data, f.localOnly === true]), folders: stored.project.folders, rootId: tree._id,
      exportedTexts, joinedRanges: joinedDoc[4],
    };
  });
  const a = results.adapter;
  assert.deepEqual(a.joinedRanges, { changes: [], comments: [] }, 'Native source join must carry valid empty ranges');
  assert.deepEqual(a.deliveredTreeDocs, ['main.tex'], 'The tree delivered to the native editor must be a copy, or creations appear twice');
  assert.deepEqual(a.deliveredTreeFolders, []);
  assert.deepEqual(a.events, [['doc', a.rootId, 'new.tex'], ['folder', a.rootId, 'notes']], 'Each creation is announced exactly once');
  assert.deepEqual(a.status, { created: 200, duplicate: 409, folder: 200, badParent: 409, slash: 409, unknownPost: 503, external: 503, flush: 204, session: 204, stopped: 200, syncBeforeCompile: 409 });
  assert.match(a.duplicateMessage, /already exists/);
  assert.deepEqual(a.bytes, [0, 1, 2, 255]);
  assert.match(a.emitted, /requires a connection/);
  assert.deepEqual(a.stored, [['figure.png', 'AAEC/w==', false], ['main.tex', 'native main', false], ['new.tex', '', true]], 'Refused server actions keep local files exactly');
  assert.deepEqual(a.folders, ['notes']);
  assert.equal(a.exportedTexts['main.tex'], 'native main with unsaved edit', 'Export must use main.tex\'s own text when the shared editor shows another file');
  assert.equal(a.exportedTexts['new.tex'], '% typed into new.tex\n');
  assert.deepEqual(outside, [], 'No request may leave the test origin');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ offlineStorePassed: true, creationCasAndAtomicity: true, emptyFolderPersists: true, fileFolderLimit: true,
    saveAndOutputGuards: true, quotaFailureAtomic: true, nativeTreeCopied: true, localOnlyRefusalsKeepFiles: true }));
} finally { clearTimeout(timer); await browser.close(); }
