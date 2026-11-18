// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import SessionManager from '../Authentication/SessionManager.mjs';
import AsyncLocalStorage from '../../infrastructure/AsyncLocalStorage.mjs';
import AuthorizationManager from '../Authorization/AuthorizationManager.mjs';
import TokenAccessHandler from '../TokenAccess/TokenAccessHandler.mjs';
import ProjectEntityHandler from '../Project/ProjectEntityHandler.mjs';
import ProjectGetter from '../Project/ProjectGetter.mjs';
import DocumentUpdaterHandler from '../DocumentUpdater/DocumentUpdaterHandler.mjs';
import HistoryManager from '../History/HistoryManager.mjs';
import { getLatestSnapshot } from '../History/HistoryOTContentManager.mjs';
import HistoryBlobStore from '../History/HistoryBlobStore.mjs';
import { safePath } from './ParticipantArtifacts.mjs';

const active = new Set();
const hash = text => createHash('sha256').update(text).digest('hex');
function refuse(statusCode = 409) { throw Object.assign(Error('Session checkpoint unavailable.'), { statusCode }); }
async function authorize(req, { project, user }) {
  if (typeof req.sessionID !== 'string' || !req.sessionID || !req.sessionStore?.get) refuse(401);
  const session = await new Promise((resolve, reject) => req.sessionStore.get(req.sessionID, (error, value) => error ? reject(error) : resolve(value)));
  if (String(SessionManager.getLoggedInUserId(session) || '') !== user) refuse(401);
  // Native authorization caches project membership per request; completion must observe mid-request revocation.
  const scope = AsyncLocalStorage.storage.getStore();
  if (scope) delete scope['projectAccess:' + project];
  if (!await AuthorizationManager.promises.canUserWriteProjectContent(user, project, TokenAccessHandler.getRequestToken(req, project))) refuse(403);
}
async function readDocuments(project, expected) {
  const docs = Object.entries(await ProjectEntityHandler.promises.getAllDocs(project));
  if (docs.length > 1000) refuse();
  const paths = new Map(docs.map(([path, doc]) => [String(doc._id), path.replace(/^\//, '')]));
  const documents = [];
  for (const item of expected) {
    const path = paths.get(item.id);
    if (!safePath(path)) refuse();
    const doc = await DocumentUpdaterHandler.promises.getDocument(project, item.id, -1);
    if (!Number.isSafeInteger(doc.version) || doc.version < 0 || !Array.isArray(doc.lines) || doc.lines.some(line => typeof line !== 'string')) refuse();
    const text = doc.lines.join('\n');
    if (text.length > 2000000 || hash(text) !== item.hash) refuse();
    documents.push({ id: item.id, hash: item.hash, version: doc.version, path });
  }
  return documents;
}

// Native history supplies immutable revisions; this receipt does not claim an off-host backup.
export async function checkpoint(req, identity, body) {
  const { project, user } = identity;
  if (!/^[a-f0-9]{24}$/.test(project) || !/^[a-f0-9]{24}$/.test(user)) refuse(401);
  if (Buffer.isBuffer(req.body) || !body || body.op !== 'checkpoint' || Object.keys(body).some(key => !['op', 'docs'].includes(key)) ||
      !Array.isArray(body.docs) || body.docs.length < 1 || body.docs.length > 32 || Buffer.byteLength(JSON.stringify(body)) > 8192 ||
      body.docs.some(doc => !doc || typeof doc.id !== 'string' || typeof doc.hash !== 'string' || Object.keys(doc).length !== 2 || !/^[a-f0-9]{24}$/.test(doc.id) || !/^[a-f0-9]{64}$/.test(doc.hash)) ||
      new Set(body.docs.map(doc => doc.id)).size !== body.docs.length) refuse(400);
  await authorize(req, identity);
  if (active.size >= 2 || active.has(project)) refuse(429);
  active.add(project);
  try {
    const before = await readDocuments(project, body.docs);
    await authorize(req, identity);
    await DocumentUpdaterHandler.promises.flushProjectToMongo(project);
    await HistoryManager.promises.flushProject(project);
    const native = await ProjectGetter.promises.getProject(project, { overleaf: true });
    if (!native?.overleaf?.history?.id) refuse();
    const { snapshot, version } = await getLatestSnapshot(native.overleaf.history.id);
    if (!Number.isSafeInteger(version) || version < 0) refuse();
    const blobs = new HistoryBlobStore(native.overleaf.history.id);
    for (const document of before) {
      const file = snapshot.getFile(document.path);
      if (!file) refuse();
      // Latest-chunk files are hash references until loaded, as in native ProjectFileAgent.
      await file.load('eager', blobs);
      if (!file.isEditable()) refuse();
      const text = file.getContent({ filterTrackedDeletes: true });
      if (typeof text !== 'string' || text.length > 2000000 || hash(text) !== document.hash) refuse();
    }
    const after = await readDocuments(project, body.docs);
    if (after.some((doc, index) => doc.path !== before[index].path || doc.version !== before[index].version)) refuse();
    await authorize(req, identity);
    return { ...identity, version, documents: after.map(({ id, hash, version }) => ({ id, hash, version })), durable: true };
  } finally { active.delete(project); }
}
