// TG-01: server-side offline preparation limits in the native snapshot reader (no server or database).
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const project = 'b'.repeat(24), user = 'a'.repeat(24), mainId = 'c'.repeat(24), childId = 'd'.repeat(24);

async function load({ resources, docs, documents }) {
  const calls = { documentUpdater: 0 };
  const context = vm.createContext({ Buffer, setTimeout, clearTimeout, fetch: () => { throw Error('Unexpected network read'); }, AbortSignal });
  const subject = new vm.SourceTextModule(readFileSync(new URL('../runtime/incremental-preview/host.mjs', import.meta.url), 'utf8'), { context });
  await subject.link(async name => {
    let exports;
    if (name === '@overleaf/logger') exports = { default: { warn() {}, error() {}, info() {} } };
    else if (name.endsWith('/ProjectEntityHandler.mjs')) exports = { default: { promises: { getAllDocs: async () => docs } } };
    else if (name.endsWith('/ClsiManager.mjs')) exports = { default: { promises: { buildDocumentConversionRequest: async () => ({ compile: { rootResourcePath: 'main.tex', compiler: 'pdflatex', resources: structuredClone(resources) } }) } } };
    else if (name.endsWith('/SessionManager.mjs')) exports = { default: { getLoggedInUserId: () => user } };
    else if (name.endsWith('/DocumentUpdaterHandler.mjs')) exports = { default: { promises: { getDocument: async (_, id) => { calls.documentUpdater++; return structuredClone(documents[id]); } } } };
    else exports = await import(name);
    return new vm.SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value); }, { context });
  });
  await subject.evaluate();
  return { snapshot: subject.namespace.snapshot, calls };
}

function fixture(overrides = {}) {
  return {
    resources: [{ path: 'main.tex', content: 'stale compile copy' }, { path: 'chapter.tex', content: 'stale child' }, { path: 'figure.png', url: 'unused' }].slice(0, 2),
    docs: { '/main.tex': { _id: mainId }, '/chapter.tex': { _id: childId } },
    documents: { [mainId]: { version: 7, lines: ['latest', 'main'] }, [childId]: { version: 3, lines: ['latest child'] } },
    ...overrides,
  };
}
const body = (extra = {}) => ({ docId: mainId, text: 'latest\nmain', version: 7, line: 1, ...extra });

test('offline snapshot uses the latest document-updater text and records exact versions', async () => {
  const { snapshot, calls } = await load(fixture());
  const result = JSON.parse(JSON.stringify(await snapshot(project, user, body(), true, true)));
  assert.deepEqual(result.resources.map(r => [r.path, r.content]), [['main.tex', 'latest\nmain'], ['chapter.tex', 'latest child']]);
  assert.deepEqual(result.documents.sort((a, b) => a.path.localeCompare(b.path)), [{ path: 'chapter.tex', id: childId, version: 3 }, { path: 'main.tex', id: mainId, version: 7 }]);
  assert.equal(calls.documentUpdater, 2);
});

test('non-offline snapshots never read the document updater', async () => {
  const { snapshot, calls } = await load(fixture());
  const result = await snapshot(project, user, body(), true, false);
  assert.equal(result.documents, undefined); assert.equal(calls.documentUpdater, 0);
});

test('active document changed during preparation is refused (version or text)', async () => {
  const { snapshot } = await load(fixture());
  await assert.rejects(snapshot(project, user, body({ version: 6 }), true, true), /Active source changed during preparation/);
  await assert.rejects(snapshot(project, user, body({ text: 'older text' }), true, true), /Active source changed during preparation/);
});

test('invalid document versions or lines are refused', async () => {
  for (const bad of [{ version: -1, lines: [] }, { version: 1.5, lines: [] }, { version: 2, lines: 'not lines' }]) {
    const { snapshot } = await load(fixture({ documents: { ...fixture().documents, [childId]: bad } }));
    await assert.rejects(snapshot(project, user, body(), true, true), /Document version unavailable/);
  }
});

test('a document over 2,000,000 characters is refused', async () => {
  const { snapshot } = await load(fixture({ documents: { ...fixture().documents, [childId]: { version: 1, lines: ['x'.repeat(2_000_001)] } } }));
  await assert.rejects(snapshot(project, user, body(), true, true), /Document exceeds offline limit/);
});

test('a project whose latest text exceeds 64 MiB in total is refused', async () => {
  const docs = { '/main.tex': { _id: mainId } }, documents = { [mainId]: { version: 7, lines: ['latest', 'main'] } }, resources = [{ path: 'main.tex', content: 'm' }];
  for (let i = 0; i < 35; i++) {
    const id = i.toString(16).padStart(24, 'e'); docs[`/part${i}.tex`] = { _id: id };
    documents[id] = { version: 1, lines: ['y'.repeat(1_999_999)] }; resources.push({ path: `part${i}.tex`, content: 'small' });
  }
  const { snapshot } = await load({ resources, docs, documents });
  await assert.rejects(snapshot(project, user, body(), true, true), /Offline project exceeds limits/);
});

test('active document absent from the project, or oversized request text, is refused before reading documents', async () => {
  const { snapshot, calls } = await load(fixture());
  await assert.rejects(snapshot(project, user, body({ docId: 'f'.repeat(24) }), true, true), /Document is not in this project/);
  await assert.rejects(snapshot(project, user, body({ text: 'z'.repeat(2_000_001) }), true, true), /Invalid document/);
  await assert.rejects(snapshot(project, user, body({ docId: '../main' }), true, true), /Invalid document/);
  assert.equal(calls.documentUpdater, 0);
});
