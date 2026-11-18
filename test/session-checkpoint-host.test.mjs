import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { safePath } from '../runtime/participant-compile/artifacts.mjs';

const project = 'b'.repeat(24), user = 'a'.repeat(24), docId = 'c'.repeat(24), secondDoc = 'd'.repeat(24);
const hash = text => createHash('sha256').update(text).digest('hex');
const body = () => ({ op: 'checkpoint', docs: [{ id: docId, hash: hash('Exact\nsource') }] });
async function load(options = {}) {
  const calls = [], state = { session: { user }, allowed: true, doc: { version: 7, lines: ['Exact', 'source'] }, historyText: 'Exact\nsource', historyVersion: 42, ...options };
  const membershipCache = { ['projectAccess:' + project]: 'stale' };
  const context = vm.createContext({ Buffer });
  const subject = new vm.SourceTextModule(readFileSync(new URL('../runtime/session-checkpoint/host.mjs', import.meta.url), 'utf8'), { context });
  const tracked = (name, action) => async (...args) => { calls.push(name); await state.hook?.(name, args); return action(...args); };
  await subject.link(async name => {
    let exports;
    if (name.endsWith('/SessionManager.mjs')) exports = { default: { getLoggedInUserId: session => session?.user } };
    else if (name.endsWith('/AsyncLocalStorage.mjs')) exports = { default: { storage: { getStore: () => membershipCache } } };
    else if (name.endsWith('/AuthorizationManager.mjs')) exports = { default: { promises: { canUserWriteProjectContent: tracked('authorize', (_, id) => { assert.equal(membershipCache['projectAccess:' + id], undefined, 'Native per-request membership cache must be refreshed'); membershipCache['projectAccess:' + id] = 'cached'; return state.allowed; }) } } };
    else if (name.endsWith('/TokenAccessHandler.mjs')) exports = { default: { getRequestToken: () => undefined } };
    else if (name.endsWith('/ProjectEntityHandler.mjs')) exports = { default: { promises: { getAllDocs: tracked('paths', () => state.paths || { '/main.tex': { _id: docId }, '/second.tex': { _id: secondDoc } }) } } };
    else if (name.endsWith('/ProjectGetter.mjs')) exports = { default: { promises: { getProject: tracked('project', () => ({ overleaf: { history: { id: 'native-history' } } })) } } };
    else if (name.endsWith('/DocumentUpdaterHandler.mjs')) exports = { default: { promises: { getDocument: tracked('document', (_, id) => structuredClone(state.documents?.[id] || state.doc)), flushProjectToMongo: tracked('mongo-flush', () => {}) } } };
    else if (name.endsWith('/HistoryManager.mjs')) exports = { default: { promises: { flushProject: tracked('history-flush', () => {}) } } };
    else if (name.endsWith('/HistoryOTContentManager.mjs')) exports = { getLatestSnapshot: tracked('history-read', id => {
      assert.equal(id, 'native-history'); return { version: state.historyVersion, snapshot: { getFile: path => {
        if (state.missingHistoryFile || !['main.tex', 'second.tex'].includes(path)) return null;
        let loaded = false;
        return { load: async (mode, store) => { assert.equal(mode, 'eager'); assert.equal(store.historyId, 'native-history'); loaded = true; },
          isEditable: () => loaded && !state.binaryHistory, getContent: () => loaded ? state.historyText : undefined };
      } } };
    }) };
    else if (name.endsWith('/HistoryBlobStore.mjs')) exports = { default: class { constructor(historyId) { this.historyId = historyId; } } };
    else if (name.endsWith('/ParticipantArtifacts.mjs')) exports = { safePath };
    else exports = await import(name);
    return new vm.SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value); }, { context });
  });
  await subject.evaluate();
  const request = () => ({ sessionID: 'synthetic-session', sessionStore: { get(id, callback) { calls.push('session'); assert.equal(id, 'synthetic-session'); callback(state.sessionError, state.session); } } });
  return { calls, state, request, checkpoint: subject.namespace.checkpoint };
}
const json = value => JSON.parse(JSON.stringify(value));
const refuses = (api, req, input, status = 409) => assert.rejects(api.checkpoint(req, { project, user }, input), error => error.statusCode === status || (status === 409 && error.statusCode === undefined));

test('checkpoint pins matching durable native history and OT revisions; retry creates no backup engine or duplicate version', async () => {
  const api = await load(), input = body();
  const expected = { project, user, version: 42, documents: [{ id: docId, hash: input.docs[0].hash, version: 7 }], durable: true };
  assert.deepEqual(json(await api.checkpoint(api.request(), { project, user }, input)), expected);
  assert.deepEqual(api.calls, ['session', 'authorize', 'paths', 'document', 'session', 'authorize', 'mongo-flush', 'history-flush', 'project', 'history-read', 'paths', 'document', 'session', 'authorize']);
  assert.deepEqual(json(await api.checkpoint(api.request(), { project, user }, input)), expected);
  assert.equal(api.calls.filter(c => c === 'history-read').length, 2);
  assert.equal(api.calls.filter(c => c === 'document').length, 4, 'Only requested source is read twice; no per-edit history reconstruction');
});

test('malformed and oversized manifests fail before session, project reads or flush', async () => {
  for (const input of [null, {}, { ...body(), extra: true }, { op: 'checkpoint', docs: [] }, { op: 'checkpoint', docs: Array.from({ length: 33 }, (_, i) => ({ id: i.toString(16).padStart(24, '0'), hash: 'f'.repeat(64) })) }, { op: 'checkpoint', docs: [body().docs[0], body().docs[0]] }, { op: 'checkpoint', docs: [{ id: [docId], hash: hash('Exact\nsource') }] }, { op: 'checkpoint', docs: [{ id: docId, hash: 'bad' }] }]) {
    const api = await load(); await refuses(api, api.request(), input, 400); assert.deepEqual(api.calls, []);
  }
  const api = await load(), req = api.request(); req.body = Buffer.alloc(24); await refuses(api, req, body(), 400); assert.deepEqual(api.calls, []);
});

test('missing/ended/changed or failed stored sessions and read-only access cannot flush', async () => {
  for (const options of [{ session: null }, { session: { user: 'e'.repeat(24) } }, { sessionError: Error('store unavailable') }, { allowed: false }]) {
    const api = await load(options); await assert.rejects(api.checkpoint(api.request(), { project, user }, body()));
    assert(!api.calls.includes('mongo-flush')); assert(!api.calls.includes('document'));
  }
  const api = await load(), req = api.request(); delete req.sessionStore; await refuses(api, req, body(), 401); assert.deepEqual(api.calls, []);
});

test('stale, unknown, malformed or excessive source is refused without a flush', async () => {
  for (const options of [{ doc: { version: 7, lines: ['Other source'] } }, { paths: {} }, { doc: { version: -1, lines: ['Exact', 'source'] } }, { doc: { version: 7, lines: [null] } }, { doc: { version: 7, lines: ['x'.repeat(2000001)] } }]) {
    const api = await load(options); await refuses(api, api.request(), body()); assert(!api.calls.includes('mongo-flush'));
  }
});

test('flush/history failure, wrong immutable history and concurrent source/structure changes never issue a receipt', async () => {
  for (const stage of ['mongo-flush', 'history-flush', 'history-read']) {
    const api = await load({ hook(name) { if (name === stage) throw Error('synthetic failure'); } }); await assert.rejects(api.checkpoint(api.request(), { project, user }, body()));
    assert(!api.calls.slice(api.calls.indexOf(stage) + 1).includes('authorize'));
  }
  for (const options of [{ historyText: 'Wrong history' }, { historyVersion: -1 }, { historyVersion: 1.5 }, { missingHistoryFile: true }, { binaryHistory: true }]) {
    const api = await load(options); await refuses(api, api.request(), body());
  }
  for (const change of ['version', 'text', 'path', 'session', 'membership']) {
    const api = await load(); api.state.hook = name => {
      if (name !== 'history-read') return;
      if (change === 'version') api.state.doc.version++;
      if (change === 'text') api.state.doc.lines = ['newer'];
      if (change === 'path') api.state.paths = { '/moved.tex': { _id: docId } };
      if (change === 'session') api.state.session = null;
      if (change === 'membership') api.state.allowed = false;
    };
    await assert.rejects(api.checkpoint(api.request(), { project, user }, body()), change);
  }
});

test('at most two projects and one checkpoint per project hold native-history work; failure releases the slot', async () => {
  const api = await load(), releases = [];
  api.state.hook = name => name === 'mongo-flush' ? new Promise(resolve => releases.push(resolve)) : undefined;
  const running = api.checkpoint(api.request(), { project, user }, body());
  while (!releases.length) await new Promise(resolve => setImmediate(resolve));
  await refuses(api, api.request(), body(), 429);
  const secondProject = 'e'.repeat(24), second = api.checkpoint(api.request(), { project: secondProject, user }, body());
  while (releases.length < 2) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(api.checkpoint(api.request(), { project: 'f'.repeat(24), user }, body()), error => error.statusCode === 429);
  for (const resolve of releases) resolve(); await Promise.all([running, second]);
  api.state.hook = name => { if (name === 'mongo-flush') throw Error('flush failed'); };
  await assert.rejects(api.checkpoint(api.request(), { project, user }, body()));
  api.state.hook = () => {}; assert.equal((await api.checkpoint(api.request(), { project, user }, body())).durable, true);
});
