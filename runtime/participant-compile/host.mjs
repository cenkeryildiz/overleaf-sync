// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import SessionManager from '../Authentication/SessionManager.mjs';
import { addOptionalCleanupHandlerBeforeStoppingTraffic } from '../../infrastructure/GracefulShutdown.mjs';
import { snapshot } from './LivePreview.mjs';
import { prepareSnapshot, prepareResult } from './ParticipantArtifacts.mjs';
import { checkpoint } from './SessionCheckpoint.mjs';

const jobs = new Map(), pending = new Map(), artifacts = new Map(), preparing = new Set();
let child, serial = 0, retainedBytes = 0, stopping = false;
addOptionalCleanupHandlerBeforeStoppingTraffic('participant coordinator', () => {
  stopping = true;
  child?.kill();
});
const token = () => randomBytes(24).toString('hex');
function start() {
  if (stopping) throw Error('Coordinator shutting down');
  if (child) return child;
  const process = spawn('/opt/participant/overleaf-participant-coordinator', [], { stdio: ['pipe', 'pipe', 'ignore'] });
  child = process;
  const stopped = () => {
    if (child !== process) return;
    child = null;
    for (const item of pending.values()) item.reject(Error('Coordinator stopped'));
    pending.clear(); jobs.clear(); retainedBytes = 0;
  };
  process.on('error', stopped); process.on('exit', stopped);
  createInterface({ input: process.stdout }).on('line', line => {
    if (line.length > 65536) return process.kill();
    try {
      const reply = JSON.parse(line), item = pending.get(reply.id);
      pending.delete(reply.id);
      if (reply.ok) item?.resolve(reply.value); else item?.reject(Error(reply.error));
    } catch { process.kill(); }
  });
  return process;
}
function ask(body) {
  const process = start(), id = ++serial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); process.kill(); reject(Error('Coordinator unavailable')); }, 3000);
    pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    process.stdin.write(JSON.stringify({ ...body, id, now: Date.now() }) + '\n', error => {
      if (error) { pending.get(id)?.reject(Error('Coordinator unavailable')); pending.delete(id); }
    });
  });
}
async function discard(id) {
  const job = jobs.get(id); if (!job) return;
  jobs.delete(id); retainedBytes -= job.bytes;
  await ask({ op: 'drop', job: id });
}
setInterval(() => {
  for (const [id, job] of jobs) if (job.expires <= Date.now()) discard(id).catch(() => {});
  for (const [path, expiry] of artifacts) if (expiry <= Date.now()) {
    artifacts.delete(path); rm(path, { recursive: true, force: true }).catch(() => {});
  }
}, 10000).unref();

// This handler is behind the native login, membership, CSRF and rate-limit middleware on every request.
export async function participantCompile(req, res) {
  res.set('Cache-Control', 'no-store');
  const user = SessionManager.getLoggedInUserId(req.session)?.toString(), project = String(req.params.Project_id);
  if (!/^[a-f0-9]{24}$/.test(user || '') || !/^[a-f0-9]{24}$/.test(project)) return res.sendStatus(401);
  let body;
  try { body = Buffer.isBuffer(req.body) ? JSON.parse(req.get('X-Participant-Job') || '{}') : req.body; }
  catch { return res.sendStatus(400); }
  if (!body || typeof body.op !== 'string') return res.sendStatus(400);
  try {
    const identity = { project, user };
    if (body.op === 'checkpoint') {
      try { return res.json({ checkpoint: await checkpoint(req, identity, body) }); }
      catch (error) { return res.status([400, 401, 403, 429].includes(error.statusCode) ? error.statusCode : 409).json({ error: 'Session checkpoint unavailable.' }); }
    }
    if (body.op === 'prepare-offline') {
      if (preparing.size >= 2 || preparing.has(user)) return res.sendStatus(429);
      preparing.add(user); let reading = true, closed = false;
      const release = () => { closed = true; if (!reading) preparing.delete(user); };
      res.once('finish', release); res.once('close', release);
      try {
        const raw = await snapshot(project, user, body, true, true);
        if (!closed) return res.json({ ...identity, source: prepareSnapshot(raw), documents: raw.documents });
      } finally { reading = false; if (closed) preparing.delete(user); }
      return;
    }
    if (body.op === 'queue') {
      if (jobs.size >= 32 || [...jobs.values()].filter(j => j.user === user).length >= 2) return res.sendStatus(429);
      const source = prepareSnapshot(await snapshot(project, user, body));
      const bytes = Buffer.byteLength(JSON.stringify(source));
      if (retainedBytes + bytes > 128 * 1024 * 1024) return res.sendStatus(429);
      const job = token();
      await ask({ op: 'queue', ...identity, job, digest: source.digest });
      jobs.set(job, { ...identity, source, bytes, expires: Date.now() + 180000 }); retainedBytes += bytes;
      return res.json({ job, digest: source.digest });
    }
    if (body.op === 'join') {
      const worker = token(); await ask({ op: 'join', ...identity, worker }); return res.json({ worker });
    }
    if (body.op === 'claim') {
      const next = await ask({ ...body, ...identity });
      const job = jobs.get(next.job);
      if (!job) return res.json({ job: null });
      return res.json({ ...next, source: job.source });
    }
    if (['heartbeat', 'leave'].includes(body.op)) return res.json(await ask({ ...body, ...identity }));
    const job = jobs.get(body.job);
    if (!job || job.project !== project) return res.sendStatus(404);
    if (body.op === 'status' || body.op === 'cancel') {
      if (job.user !== user) return res.sendStatus(404);
      if (body.op === 'cancel') { await discard(body.job); return res.json({ canceled: true }); }
      const state = await ask({ op: 'status', job: body.job });
      return res.json({ ...state, result: state.state === 'complete' ? job.result : undefined });
    }
    if (body.op === 'fail') return res.json(await ask({ ...body, ...identity }));
    if (body.op !== 'finish' || !Buffer.isBuffer(req.body)) return res.sendStatus(400);
    // Validate the lease before processing untrusted compressed data or writing an artifact.
    await ask({ op: 'heartbeat', ...identity, worker: body.worker, job: body.job, lease: body.lease });
    if (body.digest !== job.source.digest) return res.sendStatus(409);
    const name = `${project}-${job.user}`, base = `/var/lib/overleaf/data/compiles/${name}`;
    const result = prepareResult(req.body, body.pdfLength, job.source, base);
    const build = `${Date.now().toString(16)}-${randomBytes(12).toString('hex')}`;
    const parent = `/var/lib/overleaf/data/output/${name}/generated-files`;
    const stage = `${parent}/.participant-${build}`, destination = `${parent}/${build}`;
    await mkdir(parent, { recursive: true }); await mkdir(stage);
    try {
      await writeFile(`${stage}/output.pdf`, result.pdf);
      await writeFile(`${stage}/output.synctex.gz`, result.synctex);
      await writeFile(`${stage}/output.log`, 'Compiled on an authorized participant device.\n');
      await ask({ ...body, ...identity, op: 'finish' });
      await rename(stage, destination);
      try { await ask({ op: 'commit', job: body.job }); }
      catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
      job.result = { status: 'success', outputFiles: ['output.pdf', 'output.synctex.gz', 'output.log'].map(path => ({
        path, type: path === 'output.pdf' ? 'pdf' : path === 'output.log' ? 'log' : 'synctex.gz', build,
        url: `/project/${project}/user/${job.user}/build/${build}/output/${path}`,
        ...(path === 'output.pdf' ? { size: result.pdf.length, ranges: [], createdAt: new Date() } : {}),
      })), compileGroup: 'standard', stats: {}, timings: {}, outputFilesArchive: null };
      artifacts.set(destination, Date.now() + 60 * 60 * 1000);
      return res.json({ accepted: true });
    } finally { await rm(stage, { recursive: true, force: true }); }
  } catch {
    // Source, worker tokens and compiler logs must not enter server logs.
    return res.status(409).json({ error: 'Participant compilation unavailable or superseded.' });
  }
}
