// SPDX-License-Identifier: AGPL-3.0-only
import { BusyTexRunner, PdfLatex, XeLatex, LuaLatex } from './busytex-sdk.mjs?v=1.4.1-cancel1';
const original = globalThis.overleafParticipantFetch;
const project = location.pathname.match(/^\/project\/([a-f0-9]{24})/)?.[1];
let runner, worker, stopped = false, timer, active, lastJob, ready, generation = 0, queueing, carry;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// A latched wake: notify() ends the current wait (or the next one) early; otherwise wait() ends after `ms`.
function latch(ms) {
  let pending = false, wake;
  return {
    notify() { pending = true; wake?.(); },
    async wait() {
      if (pending) { pending = false; return; }
      await new Promise(resolve => {
        const deadline = setTimeout(done, ms);
        function done() { clearTimeout(deadline); wake = undefined; resolve(); }
        wake = done;
      });
      pending = false;
    },
  };
}
// Claims poll every 750 ms and status every 250 ms; this page's own queue or result ends the wait at once.
const work = latch(750), finished = latch(250), notifyWork = work.notify, waitForWork = work.wait;
const status = document.createElement('span');
status.setAttribute('role', 'status'); status.style.cssText = 'padding:4px 8px;font:12px system-ui';
status.textContent = 'Preparing device compilation…';
function show(message) {
  status.textContent = message;
  const controls = document.querySelector('.recovery-controls');
  if (controls && !status.isConnected) controls.append(status);
}
function csrf() {
  const value = document.querySelector('meta[name="ol-csrfToken"]')?.content;
  try { return JSON.parse(value); } catch { return value; }
}
async function request(body, binary, keepalive = false) {
  const headers = { 'X-CSRF-Token': csrf(), 'Content-Type': binary ? 'application/octet-stream' : 'application/json' };
  if (binary) headers['X-Participant-Job'] = JSON.stringify(body);
  const response = await original(`/project/${project}/participant-compile`, {
    method: 'POST', credentials: 'same-origin', headers, body: binary || JSON.stringify(body), keepalive,
  });
  if (!response.ok) throw Error('Participant request refused');
  return response.json();
}
async function initialize() {
  runner = new BusyTexRunner({
    busytexBasePath: '/participant/busytex', engineMode: 'combined', initRetries: 0,
    preloadDataPackages: ['/participant/busytex/texlive-basic.js'],
    catalogDataPackages: ['/participant/busytex/texlive-recommended.js', '/participant/busytex/texlive-extra.js'],
    onDownloadProgress: p => show(`Preparing device compilation: ${Math.floor(p.percent)}%`),
  });
  performance.mark('participant:initialize'); // measurement only (OPT-01)
  await runner.initialize(true);
  performance.mark('participant:initialized');
  worker = (await request({ op: 'join' })).worker;
  show('Sharing compilation with this project');
  void contribute();
}
async function contribute() {
  try {
    while (!stopped) {
      // Claim after this page's own queue lands: it supersedes an older job of ours (e.g. one queued just before a reload) that would otherwise be compiled first and refused.
      // shortcut: bounded 1 s so a page whose editor never appears cannot stall other users' jobs; a slower first queue may still lose this race.
      if (queueing) await Promise.race([queueing, pause(1000)]);
      const job = await request({ op: 'claim', worker });
      if (stopped) break;
      if (!job.job) { await waitForWork(); continue; }
      active = job; performance.mark('participant:claimed');
      let lost = false;
      timer = setInterval(() => request({ op: 'heartbeat', worker, job: job.job, lease: job.lease })
        .catch(() => { lost = true; runner.terminate(); }), 8000);
      const deadline = setTimeout(() => { lost = true; runner.terminate(); }, 120000);
      try {
        const files = job.source.resources.map(file => ({ path: file.path, content: file.content ??
          Uint8Array.from(atob(file.data), c => c.charCodeAt(0)) }));
        const root = files.find(file => file.path === job.source.main);
        if (!root || typeof root.content !== 'string') throw Error('Root source unavailable');
        const Tool = { pdflatex: PdfLatex, xelatex: XeLatex, lualatex: LuaLatex }[job.source.compiler];
        if (!Tool) throw Error('Unsupported compiler');
        // Only this user's own jobs reuse auxiliary files from its previous compile (never another member's); sources win.
        const key = job.own ? [job.source.main, job.source.compiler].join('\n') : null;
        const carried = key && carry?.key === key ? carry.files.filter(file => !files.some(source => source.path === file.path)) : [];
        const run = extra => new Tool(runner).compile({ input: root.content, mainTexPath: job.source.main,
          additionalFiles: [...files.filter(f => f !== root), ...extra], rerun: true, shellEscape: false,
          // No source-derived public lookup endpoint: only pinned same-origin package catalogs.
          remoteEndpoint: '', shellHandlerScripts: [],
        }).catch(error => { lost = true; throw error; });
        let result = await run(carried);
        if (carried.length && !lost && !(result.success && result.pdf && result.synctex)) { carry = undefined; result = await run([]); }
        const next = key && result.success ? result.logs?.at(-1)?.carry : null;
        if (key) carry = next ? { key, files: Object.entries(next).map(([path, content]) => ({ path, content })) } : undefined;
        performance.mark('participant:compiled');
        if (lost || stopped || !result.success || !result.pdf || !result.synctex) throw Error('Compilation failed');
        await request({ op: 'finish', worker, job: job.job, lease: job.lease, digest: job.digest, pdfLength: result.pdf.length },
          new Blob([result.pdf, result.synctex], { type: 'application/octet-stream' }));
        performance.mark('participant:finished'); show('Device compilation complete');
        if (job.job === lastJob) finished.notify();
      } catch {
        clearInterval(timer); clearTimeout(deadline);
        if (!lost && !stopped) await request({ op: 'fail', worker, job: job.job, lease: job.lease, digest: job.digest }).catch(() => {});
        if (job.job === lastJob) finished.notify();
        show(lost ? 'Compilation interrupted; reconnecting device' : 'Compilation failed; source remains saved');
        if (lost && !stopped) {
          runner.terminate();
          await request({ op: 'leave', worker }).catch(() => {});
          await runner.initialize(true);
          worker = (await request({ op: 'join' })).worker;
          show('Sharing compilation with this project');
        }
      } finally { clearInterval(timer); clearTimeout(deadline); active = null; }
    }
  } catch { stopped = true; show('Device compilation disconnected; reload to retry'); }
}
ready = project ? initialize() : Promise.reject(Error('Project unavailable'));
// The compile request reports initialization failure; keep an early failure from being unhandled.
ready.catch(() => { stopped = true; show('Device compilation unavailable; reload to retry'); });

export async function compile(signal, automatic = false) {
  const sequence = generation;
  let settle; const pending = queueing = new Promise(resolve => { settle = resolve; });
  const deadline = Date.now() + 180000;
  let editor, text, queued;
  try {
    // An automatic compile may be answered with a stored result, which needs no local compiler; ask before waiting for it.
    if (!automatic) await ready;
    if (sequence !== generation) throw Error('Compilation canceled');
    while (!globalThis.overleafParticipantEditor && Date.now() < deadline && !signal?.aborted) await pause(100);
    editor = globalThis.overleafParticipantEditor;
    if (!editor || stopped || signal?.aborted) throw Error('Compilation unavailable');
    text = editor.facade.getValue(); const docId = String(editor.docId);
    if (lastJob) await request({ op: 'cancel', job: lastJob }).catch(() => {});
    performance.mark('participant:queue');
    queued = await request({ op: 'queue', docId, text, ...(automatic ? { reuse: true } : {}) });
  } finally { settle(); if (queueing === pending) queueing = undefined; }
  if (queued.result && sequence === generation) {
    // The host already holds this exact snapshot's PDF; no device needs to compile it again.
    lastJob = null; performance.mark('participant:complete');
    document.dispatchEvent(new CustomEvent('overleaf:participant-result', { detail: { job: null, digest: queued.digest } }));
    return Response.json(queued.result);
  }
  if (automatic) { try { await ready; } catch (error) { await request({ op: 'cancel', job: queued.job }).catch(() => {}); throw error; } }
  if (sequence !== generation) {
    await request({ op: 'cancel', job: queued.job }).catch(() => {}); throw Error('Compilation canceled');
  }
  lastJob = queued.job;
  notifyWork();
  show('Waiting for a project device…');
  try {
    while (Date.now() < deadline && !signal?.aborted && lastJob === queued.job && !stopped) {
      if (editor.facade.getValue() !== text) throw Error('Source changed');
      const result = await request({ op: 'status', job: queued.job });
      if (result.state === 'complete') {
        performance.mark('participant:complete');
        document.dispatchEvent(new CustomEvent('overleaf:participant-result', { detail: { job: queued.job, digest: queued.digest } }));
        return Response.json(result.result);
      }
      if (['failed', 'missing', 'superseded'].includes(result.state)) throw Error('Compilation unavailable');
      await finished.wait();
    }
    throw Error('Compilation canceled');
  } catch (error) { await request({ op: 'cancel', job: queued.job }).catch(() => {}); throw error; }
}
export async function cancel() {
  generation++;
  const job = lastJob; lastJob = null;
  if (job) await request({ op: 'cancel', job }).catch(() => {});
  if (active?.job === job) runner.terminate();
  show('Compilation stopped; source remains saved');
  return Response.json({ stopped: true });
}
addEventListener('pagehide', () => {
  stopped = true; clearInterval(timer); work.notify(); runner?.terminate();
  // Nobody will wait for this page's queued job; left queued, the next page load or another device would compile it first.
  if (lastJob) request({ op: 'cancel', job: lastJob }, undefined, true).catch(() => {});
  if (worker) request({ op: 'leave', worker }, undefined, true).catch(() => {});
});
