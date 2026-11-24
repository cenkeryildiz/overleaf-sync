// SPDX-License-Identifier: AGPL-3.0-only
// Stage 3 (LAN-COMPILE-01): participants who opted in compile shared jobs with the TeX installation they chose; the owner
// only schedules and needs no TeX. The job lifecycle is runtime/participant-compile/coordinator's (FIFO queue, one lease per
// worker, renewable leases, bounded attempts, latest-generation-only results, exact result identity), run here in the owner's
// page because a LAN owner has no server process to host that coordinator. Every message travels sealed through lan-room.mjs:
//   participant -> owner  {t:'work', k:'ready'|'off'|'beat'|'blob'|'done'|'fail'} (needs the owner's copy grant: TeX writes
//                         temporary files on the helping computer)   {t:'compile', k:'req'|'cancel'} (view)
//   owner -> participant  {t:'work', k:'joined'|'job'|'in'|'stop'|'accepted'|'refused'}  {t:'compiled', req, k:'queued'|'started'|
//                         'blob'|'done'|'failed'}  {t:'pool', workers, engines}
// Inputs and results are verified transfers (lan-transfer.mjs): every file's SHA-256 is checked before anything is used.
import { streamFiles, SnapshotReceiver, MAX_TOTAL } from './lan-transfer.mjs';

export const LEASE = 30000, BEAT = 8000, DEADLINE = 180000, ATTEMPTS = 2, ENGINES = Object.freeze(['pdflatex', 'xelatex', 'lualatex']);
export const LOCAL = 'owner';
const MAX_PDF = 16 * 1024 * 1024, MAX_SYNCTEX = 8 * 1024 * 1024, ID = /^[a-f0-9]{24}$/, DIGEST = /^[a-f0-9]{64}$/;
const hex = buffer => [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async bytes => hex(await crypto.subtle.digest('SHA-256', bytes));
const randomId = () => hex(crypto.getRandomValues(new Uint8Array(12)));
const clip = (value, n = 300) => String(value ?? '').slice(-n);
const isPdf = b => b.length > 5 && String.fromCharCode(...b.subarray(0, 5)) === '%PDF-';
const isGzip = b => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
const lanes = () => { const tails = new Map(); return (key, task) => { const run = (tails.get(key) ?? Promise.resolve()).then(task); tails.set(key, run.catch(() => {})); return run; }; };

/** Workspace file ({path, content} or {path, data: base64}) -> {path, bytes}. */
export const bytesOf = file => ({ path: file.path, bytes: typeof file.content === 'string' ? new TextEncoder().encode(file.content) : Uint8Array.from(atob(file.data), c => c.charCodeAt(0)) });
/** The immutable identity of one compile input: main file, engine and every file's path, size and SHA-256. */
export async function identity(main, compiler, files) {
  const list = await Promise.all(files.map(async f => [f.path, f.bytes.length, await sha256(f.bytes)]));
  list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256(new TextEncoder().encode(JSON.stringify([main, compiler, list])));
}

/**
 * Owner side. room: {sendTo(peer, m), broadcast(m)}; current(): Promise<[{path, bytes}]> the owner's files right now.
 * onChange({workers, engines}) whenever the set of helping computers changes. Returns the hooks lan-host.mjs calls.
 */
export function ownerGroup({ room, current, now = Date.now, onChange = () => {}, timer = true }) {
  const jobs = new Map(), latest = new Map(), workers = new Map(), queue = [], receivers = new Map(), lane = lanes();
  let serial = 0, turn = 0, stopped = false, kicked = false;
  const send = (peer, m) => room.sendTo(peer, m).catch(() => {});
  const engines = () => [...new Set([...workers.values()].flatMap(w => w.engines))];
  const changed = () => { const info = { workers: workers.size, engines: engines() }; onChange(info); room.broadcast({ t: 'pool', ...info }).catch(() => {}); };
  const reply = (job, m) => job.requester === LOCAL ? job.local(m) : send(job.requester, { t: 'compiled', req: job.req, ...m });
  const kick = () => { if (!kicked) { kicked = true; queueMicrotask(() => { kicked = false; dispatch(); }); } };
  const end = (job, m) => { // terminal: the job leaves every table, so a late or repeated result finds nothing to complete
    jobs.delete(job.id); if (latest.get(job.requester) === job.id) latest.delete(job.requester);
    const w = workers.get(job.worker); if (w?.job === job.id) w.job = null;
    const at = queue.indexOf(job.id); if (at >= 0) queue.splice(at, 1);
    if (m) reply(job, m);
    kick();
  };
  const cancel = (job, m) => { if (job.state === 'leased') send(job.worker, { t: 'work', k: 'stop', job: job.id }); end(job, m); };
  /** The worker was lost, opted out or lost its grant: the job goes back to the front of the queue once, then fails visibly. */
  const release = (job, reason) => {
    const w = workers.get(job.worker); if (w?.job === job.id) w.job = null;
    if (job.attempts >= ATTEMPTS) return end(job, { k: 'failed', reason: `Shared compilation failed: ${reason}. Your files and previous PDF are retained.` });
    Object.assign(job, { state: 'queued', worker: null }); queue.unshift(job.id);
    reply(job, { k: 'queued', retry: true, reason }); kick();
  };
  function dispatch() {
    if (stopped) return;
    for (let i = 0; i < queue.length; i++) {
      const job = jobs.get(queue[i]);
      if (!job || job.state !== 'queued') { queue.splice(i--, 1); continue; }
      if (!engines().includes(job.compiler)) { // nobody can run it: say so now instead of waiting for the deadline
        queue.splice(i--, 1);
        end(job, { k: 'failed', reason: workers.size ? `No helping computer has ${job.compiler}. Turn off "Compile my PDFs with the group's TeX" to compile in this browser.` : 'Shared compilation is unavailable: no computer is helping. Your files and previous PDF are retained.' });
        continue;
      }
      const idle = [...workers.values()].filter(w => !w.job && w.engines.includes(job.compiler)).sort((a, b) => a.turn - b.turn)[0]; // least recently used first
      if (!idle) continue;
      queue.splice(i--, 1);
      Object.assign(job, { state: 'leased', worker: idle.peer, lease: ++serial, until: now() + LEASE, started: now() }); job.attempts++;
      Object.assign(idle, { job: job.id, turn: ++turn });
      reply(job, { k: 'started', by: idle.name });
      const lease = job.lease;
      room.sendTo(idle.peer, { t: 'work', k: 'job', job: job.id, lease, digest: job.digest, main: job.main, compiler: job.compiler })
        .then(() => streamFiles(m => room.sendTo(idle.peer, { t: 'work', k: 'in', job: job.id, m }), { files: job.files, main: job.main }))
        .catch(() => { if (jobs.get(job.id) === job && job.lease === lease && job.state === 'leased') release(job, 'the helping computer could not receive the files'); });
    }
  }
  function tick() {
    const t = now();
    for (const job of [...jobs.values()]) {
      if (job.queued + DEADLINE <= t) cancel(job, { k: 'failed', reason: 'Shared compilation timed out. Your files and previous PDF are retained.' });
      else if (job.state === 'leased' && job.until <= t) { send(job.worker, { t: 'work', k: 'stop', job: job.id }); release(job, 'the helping computer stopped answering'); }
    }
  }
  const clock = timer ? setInterval(tick, 2000) : null; clock?.unref?.(); // Node tests: a room never stopped must not keep the process alive
  async function enqueue(requester, req, m, files, local) {
    if (stopped) throw Error('Sharing stopped');
    if (!ID.test(String(req)) || !ENGINES.includes(m?.compiler) || typeof m.main !== 'string' || !files.some(f => f.path === m.main)) throw Error('Malformed compile request');
    const bytes = files.reduce((n, f) => n + f.bytes.length, 0), digest = await identity(m.main, m.compiler, files);
    const job = { id: randomId(), requester, req, digest, main: m.main, compiler: m.compiler, files, bytes, state: 'queued', attempts: 0, queued: now(), worker: null, local };
    if (requester !== LOCAL && m.digest !== digest) return reply(job, { k: 'failed', retry: true, reason: 'Your copy is not yet in step with the owner' });
    if (bytes > MAX_TOTAL || jobs.size >= 64) return reply(job, { k: 'failed', reason: 'Shared compilation is busy or the project is too large' });
    const old = jobs.get(latest.get(requester)); if (old) cancel(old, { k: 'failed', reason: 'Superseded by a newer compile' }); // one live job per person: fair FIFO
    jobs.set(job.id, job); latest.set(requester, job.id); queue.push(job.id);
    reply(job, { k: 'queued', position: queue.length }); kick();
  }
  /** One worker's result, checked against the lease it was given; anything else is refused and never published. */
  async function result(peer, w, m) {
    const upload = receivers.get(peer)?.result; if (receivers.get(peer)) receivers.get(peer).result = null;
    const job = jobs.get(m.job);
    if (!job || job.state !== 'leased' || job.worker !== peer || m.lease !== job.lease || latest.get(job.requester) !== job.id || m.digest !== job.digest || m.compiler !== job.compiler)
      return send(peer, { t: 'work', k: 'refused', job: typeof m.job === 'string' ? m.job : null, reason: 'Stale, foreign or repeated result' });
    w.job = null;
    if (m.k === 'fail' && m.lost === true) return release(job, 'its TeX helper stopped'); // S3-05: a crashed helper is a lost worker, not a TeX error
    if (m.k === 'fail') return end(job, { k: 'failed', reason: `${clip(m.error, 200)} (on ${w.name}'s computer). Your files and previous PDF are retained.`, log: clip(m.log, 32000) });
    const pdf = upload?.xfer === m.xfer ? upload.files.get('output.pdf') : null, synctex = upload?.files.get('output.synctex.gz');
    if (!pdf || !synctex || upload.files.size !== 2 || !isPdf(pdf) || !isGzip(synctex) || pdf.length > MAX_PDF || synctex.length > MAX_SYNCTEX) {
      send(peer, { t: 'work', k: 'refused', job: job.id, reason: 'Invalid compiler output' }); return release(job, 'its output was invalid');
    }
    job.state = 'complete'; w.done++;
    const stats = { by: w.name, waitMs: job.started - job.queued, runMs: now() - job.started, inBytes: job.bytes, outBytes: pdf.length + synctex.length };
    send(peer, { t: 'work', k: 'accepted', job: job.id });
    const log = clip(m.log, 32000);
    if (job.requester === LOCAL) return end(job, { k: 'done', pdf, synctex, log, stats });
    end(job); // later results for this job are now refused; delivery below cannot be superseded
    const { xfer } = await streamFiles(x => room.sendTo(job.requester, { t: 'compiled', req: job.req, k: 'blob', m: x }), { files: [{ path: 'output.pdf', bytes: pdf }, { path: 'output.synctex.gz', bytes: synctex }] });
    await send(job.requester, { t: 'compiled', req: job.req, k: 'done', digest: job.digest, compiler: job.compiler, xfer, log, stats });
  }
  function leave(peer, reason) {
    const w = workers.get(peer);
    if (w) {
      workers.delete(peer); receivers.get(peer)?.abort(); receivers.delete(peer);
      const job = jobs.get(w.job);
      if (job?.state === 'leased' && job.worker === peer) { if (reason !== 'gone') send(peer, { t: 'work', k: 'stop', job: job.id }); release(job, reason === 'off' ? 'the helping computer stopped helping' : reason === 'grant' ? 'the owner no longer allows that computer to compile' : 'the helping computer left'); }
      if (reason === 'grant') send(peer, { t: 'work', k: 'refused', job: null, reason: 'The owner no longer allows this computer to compile for the group' });
      changed();
    }
    if (reason === 'gone') for (const job of [...jobs.values()]) if (job.requester === peer) cancel(job);
  }
  return {
    get workers() { return [...workers.values()].map(({ name, engines, job, done }) => ({ name, engines, busy: !!job, done })); },
    get queued() { return queue.length; },
    tick,
    /** A participant's 'work' or 'compile' message; the room already checked the grant this message type needs. */
    onMessage(peer, name, m) {
      if (stopped) return;
      if (m.t === 'compile') {
        if (m.k === 'cancel') { const job = jobs.get(latest.get(peer)); if (job && job.req === m.req) cancel(job, { k: 'failed', reason: 'Canceled' }); return; }
        if (m.k !== 'req') throw Error('Unknown compile request');
        return lane(peer, async () => enqueue(peer, m.req, m, await current()).catch(() => send(peer, { t: 'compiled', req: String(m.req).slice(0, 32), k: 'failed', reason: 'Malformed compile request' })));
      }
      if (m.k === 'ready') {
        const list = Array.isArray(m.engines) ? ENGINES.filter(e => m.engines.includes(e)) : [];
        if (!list.length) throw Error('Malformed contribution');
        const w = workers.get(peer); if (w) w.engines = list; else workers.set(peer, { peer, name, engines: list, job: null, turn: 0, done: 0 });
        send(peer, { t: 'work', k: 'joined' }); changed(); kick(); return;
      }
      if (m.k === 'off') return leave(peer, 'off');
      const w = workers.get(peer);
      if (!w) return send(peer, { t: 'work', k: 'refused', job: typeof m.job === 'string' ? m.job : null, reason: 'This computer is not helping' });
      if (m.k === 'beat') {
        const job = jobs.get(m.job);
        if (job?.state === 'leased' && job.worker === peer && job.lease === m.lease) job.until = now() + LEASE;
        else send(peer, { t: 'work', k: 'stop', job: typeof m.job === 'string' ? m.job : null });
        return;
      }
      if (m.k === 'blob') return lane(peer, async () => {
        const r = receivers.get(peer) ?? receivers.set(peer, new SnapshotReceiver()).get(peer);
        r.result = null; r.result = await r.accept(m.m).catch(() => null) ?? null;
      });
      if (m.k === 'done' || m.k === 'fail') return lane(peer, () => result(peer, w, m));
      throw Error('Unknown contribution message');
    },
    /** The owner's own compile: resolves {pdf, synctex, log, stats} or rejects with the visible reason. */
    request({ main, compiler, files }, onStatus = () => {}, signal) {
      const req = randomId();
      return new Promise((resolve, reject) => {
        const local = m => { if (m.k === 'done') resolve(m); else if (m.k === 'failed') reject(Object.assign(Error(m.reason), { log: m.log })); else onStatus(m); };
        signal?.addEventListener('abort', () => { const job = jobs.get(latest.get(LOCAL)); if (job?.req === req) cancel(job, { k: 'failed', reason: 'Compilation canceled. Source files are retained.' }); }, { once: true });
        enqueue(LOCAL, req, { main, compiler }, files, local).catch(reject);
      });
    },
    /** Tell one newly joined participant whether anyone is helping. */
    announce: peer => send(peer, { t: 'pool', workers: workers.size, engines: engines() }),
    leave,
    grant(peer, grant) { if (grant !== 'copy') leave(peer, 'grant'); },
    stop() { stopped = true; if (clock) clearInterval(clock); for (const job of [...jobs.values()]) cancel(job, { k: 'failed', reason: 'Sharing stopped' }); workers.clear(); },
  };
}

/**
 * Participant side. send(m): the sealed session's send. tex: texHost() (or a test double) for this computer's chosen TeX.
 * onChange(state) after every change of {workers, engines, helping, status, done}. handle(m) takes the owner's messages.
 */
export function participantGroup({ send, tex, onChange = () => {}, now = Date.now }) {
  const pending = new Map(), state = { workers: 0, engines: [], helping: false, status: 'Off', done: 0 };
  let active = null, beat = null;
  const update = changes => { Object.assign(state, changes); onChange({ ...state }); };
  const stopActive = () => { clearInterval(beat); beat = null; if (active) { active.receiver.abort(); active.cancelled = true; tex?.cancel().catch(() => {}); } active = null; };
  async function work(m) {
    if (m.k === 'joined') return update({ status: 'Waiting for compile jobs' });
    if (m.k === 'refused' && m.job === null) { stopActive(); return update({ helping: false, status: String(m.reason ?? 'The owner refused this computer').slice(0, 200) }); }
    if (m.k === 'accepted') return update({ done: state.done + 1, status: `Waiting for compile jobs (${state.done + 1} compiled)` });
    if (m.k === 'refused') return update({ status: `The owner refused a result: ${String(m.reason ?? '').slice(0, 120)}` }); // never cancels the job in progress
    if (m.k === 'stop') { if (active && (m.job === active.job || m.job === null)) { stopActive(); if (state.helping) update({ status: 'Waiting for compile jobs' }); } return; }
    if (m.k === 'job') {
      if (!state.helping) return send({ t: 'work', k: 'off' }).catch(() => {}); // opted out meanwhile: the owner gives the job to someone else
      if (active || !ID.test(String(m.job)) || !DIGEST.test(String(m.digest)) || !ENGINES.includes(m.compiler)) return send({ t: 'work', k: 'fail', job: m.job, lease: m.lease, digest: m.digest, compiler: m.compiler, error: 'This computer is busy' }).catch(() => {});
      active = { ...m, receiver: new SnapshotReceiver(), started: now() };
      const { job, lease } = active;
      beat = setInterval(() => send({ t: 'work', k: 'beat', job, lease }).catch(() => {}), BEAT);
      return update({ status: 'Receiving a compile job' });
    }
    if (m.k === 'in' && active && m.job === active.job) {
      const job = active, received = await job.receiver.accept(m.m).catch(error => { job.broken = error; return null; });
      if (job.broken && !job.reported) { job.reported = true; return finish(job, { error: 'The job files did not arrive intact' }); }
      if (!received) return;
      const files = [...received.files].map(([path, bytes]) => ({ path, bytes }));
      if (await identity(job.main, job.compiler, files) !== job.digest) return finish(job, { error: 'The job files do not match the job' });
      update({ status: 'Compiling for the group' });
      try { const out = await tex.compile(files, job.main, job.compiler); if (!job.cancelled) await finish(job, out); }
      catch (error) { if (!job.cancelled) await finish(job, { error: error.message, log: error.log, lost: error.lost === true }); }
    }
  }
  async function finish(job, out) {
    if (active !== job) return;
    const base = { t: 'work', job: job.job, lease: job.lease, digest: job.digest, compiler: job.compiler };
    // Free this computer before the final message: the owner hands over the next queued job the moment it arrives.
    const release = () => { if (active !== job) return false; clearInterval(beat); beat = null; active = null; update({ status: out.error ? `Last job failed: ${out.error}`.slice(0, 200) : 'Sending the PDF' }); return true; };
    try {
      if (out.error) { release(); await send({ ...base, k: 'fail', error: out.error, log: clip(out.log, 32000), ...(out.lost && { lost: true }) }); }
      else {
        const { xfer } = await streamFiles(m => send({ t: 'work', k: 'blob', m }), { files: [{ path: 'output.pdf', bytes: out.pdf }, { path: 'output.synctex.gz', bytes: out.synctex }] });
        if (release()) await send({ ...base, k: 'done', xfer, log: clip(out.log, 32000) });
      }
    } catch {}
    release();
  }
  function compiled(m) {
    const p = pending.get(m.req); if (!p) return;
    if (m.k === 'queued') return p.onStatus(m.retry ? `Retrying on another computer (${m.reason})…` : `Waiting for a helping computer (position ${m.position})…`);
    if (m.k === 'started') return p.onStatus(`Compiling on ${String(m.by).slice(0, 32)}’s computer…`);
    if (m.k === 'blob') { p.last = p.receiver.accept(m.m).then(r => { if (r) p.upload = r; }, () => { p.upload = null; }); return p.last; }
    if (m.k === 'failed') { pending.delete(m.req); return p.reject(Object.assign(Error(String(m.reason ?? 'Shared compilation failed')), { retry: m.retry === true, log: m.log })); }
    if (m.k === 'done') {
      return p.last.then(() => { // the last chunk is verified first
        pending.delete(m.req);
        const pdf = p.upload?.xfer === m.xfer ? p.upload.files.get('output.pdf') : null, synctex = p.upload?.files.get('output.synctex.gz');
        if (m.digest !== p.digest || m.compiler !== p.compiler || !pdf || !synctex || !isPdf(pdf)) return p.reject(Error('The shared result did not match this compile; your previous PDF is retained'));
        p.resolve({ pdf, synctex, log: clip(m.log, 32000), stats: m.stats });
      });
    }
  }
  return {
    get state() { return { ...state }; },
    async handle(m) {
      if (m.t === 'pool') return update({ workers: Number.isSafeInteger(m.workers) ? m.workers : 0, engines: Array.isArray(m.engines) ? ENGINES.filter(e => m.engines.includes(e)) : [] });
      if (m.t === 'compiled') return compiled(m);
      if (m.t === 'work') return work(m);
      if (m.t === 'denied' && m.request === 'work') { stopActive(); return update({ helping: false, status: 'The owner must allow “Can keep a copy” before this computer can compile for the group' }); }
    },
    /** Opt in (needs a chosen, ready TeX installation) or out; opting out releases any job in progress. */
    async help(on) {
      if (!on) { stopActive(); update({ helping: false, status: 'Off' }); return send({ t: 'work', k: 'off' }).catch(() => {}); }
      const info = await tex.status();
      if (!info.directory || !info.sandbox || !info.engines?.length) throw Error('Choose a TeX installation first');
      update({ helping: true, status: 'Joining the group…' });
      await send({ t: 'work', k: 'ready', engines: info.engines });
    },
    /** One shared compile of exactly these files; retries briefly while this copy catches up with the owner. */
    async request({ main, compiler, files }, onStatus = () => {}, signal) {
      const digest = await identity(main, compiler, files);
      for (let attempt = 0; ; attempt++) {
        const req = randomId();
        try {
          return await new Promise((resolve, reject) => {
            pending.set(req, { resolve, reject, onStatus, digest, compiler, receiver: new SnapshotReceiver(), upload: null, last: Promise.resolve() });
            const abort = () => { if (pending.delete(req)) { send({ t: 'compile', k: 'cancel', req }).catch(() => {}); reject(Error('Compilation canceled. Source files are retained.')); } };
            if (signal?.aborted) return abort();
            signal?.addEventListener('abort', abort, { once: true });
            send({ t: 'compile', k: 'req', req, main, compiler, digest }).catch(error => { pending.delete(req); reject(error); });
          });
        } catch (error) {
          if (!error.retry || attempt >= 10 || signal?.aborted) throw error;
          onStatus('Waiting for your edits to reach the owner…'); await new Promise(r => setTimeout(r, 300));
        }
      }
    },
    /** The connection was lost: in-flight requests fail visibly and contribution stops until the participant opts in again. */
    lost() { for (const [req, p] of pending) { pending.delete(req); p.reject(Error('The connection to the owner was lost; your previous PDF is retained')); } stopActive(); update({ helping: false, workers: 0, engines: [], status: 'Off' }); },
  };
}

const RAW = 270000; // native frame: base64 chunk of at most 360,000 characters
/** Client for this computer's TeX helper (native/src/main.rs). One compile at a time; cancel() stops it. */
export function texHost(connectNative = (...a) => chrome.runtime.connectNative(...a), name = 'com.cenker.latex_local') {
  let port = null, next = 1;
  const pending = new Map();
  const open = () => {
    if (port) return port;
    port = connectNative(name);
    port.onMessage.addListener(m => {
      const p = pending.get(m?.id); if (!p) return;
      if (m.part) { (p.parts[m.part] ??= []).push(Uint8Array.from(atob(m.data), c => c.charCodeAt(0))); return; }
      pending.delete(m.id);
      if (m.error) p.reject(Object.assign(Error(m.error), { log: m.log }));
      else p.resolve(m.done ? { parts: p.parts, log: m.log } : m.result);
    });
    port.onDisconnect.addListener(() => { port = null; for (const p of pending.values()) p.reject(Object.assign(Error('The TeX helper is not installed or stopped. Install the helper once, then reopen the browser.'), { lost: true })); pending.clear(); });
    return port;
  };
  const call = (op, args = {}) => new Promise((resolve, reject) => {
    const id = next++; pending.set(id, { resolve, reject, parts: {} });
    try { open().postMessage({ id, op, ...args }); } catch (error) { pending.delete(id); reject(error); }
  });
  const join = list => { const out = new Uint8Array(list.reduce((n, b) => n + b.length, 0)); let at = 0; for (const b of list) { out.set(b, at); at += b.length; } return out; };
  const b64 = bytes => { let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(text); };
  return {
    status: () => call('status'), select: path => call('select', { path }), choose: () => call('choose'), cancel: () => call('cancel'),
    async compile(files, main, compiler) {
      const manifest = await Promise.all(files.map(async f => ({ path: f.path, size: f.bytes.length, digest: await sha256(f.bytes) })));
      for (let attempt = 0; ; attempt++) { // the previous compile's thread may still be exiting just after it sent its result
        try { await call('begin', { files: manifest }); break; }
        catch (error) { if (error.message !== 'Compilation already running' || attempt >= 10) throw error; await new Promise(r => setTimeout(r, 100)); }
      }
      for (const f of files) for (let at = 0; at < f.bytes.length; at += RAW) await call('chunk', { path: f.path, offset: at, data: b64(f.bytes.subarray(at, at + RAW)) });
      const { parts, log } = await call('compile', { main, compiler });
      return { pdf: join(parts.pdf ?? []), synctex: join(parts.synctex ?? []), log };
    },
    close() { port?.disconnect(); port = null; },
  };
}
