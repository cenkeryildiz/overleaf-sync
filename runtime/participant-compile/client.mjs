// SPDX-License-Identifier: AGPL-3.0-only
import { BusyTexRunner, PdfLatex, XeLatex, LuaLatex } from './busytex-sdk.mjs?v=1.4.1-cancel1';
const original = globalThis.overleafParticipantFetch;
const project = location.pathname.match(/^\/project\/([a-f0-9]{24})/)?.[1];
let runner, worker, stopped = false, timer, active, lastJob, ready, generation = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let pendingWork = false, wakeClaim;
function notifyWork() { pendingWork = true; wakeClaim?.(); }
async function waitForWork() {
  if (pendingWork) { pendingWork = false; return; }
  await new Promise(resolve => {
    const deadline = setTimeout(done, 750);
    function done() { clearTimeout(deadline); wakeClaim = undefined; resolve(); }
    wakeClaim = done;
  });
  pendingWork = false;
}
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
async function request(body, binary) {
  const headers = { 'X-CSRF-Token': csrf(), 'Content-Type': binary ? 'application/octet-stream' : 'application/json' };
  if (binary) headers['X-Participant-Job'] = JSON.stringify(body);
  const response = await original(`/project/${project}/participant-compile`, {
    method: 'POST', credentials: 'same-origin', headers, body: binary || JSON.stringify(body),
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
        const result = await new Tool(runner).compile({ input: root.content, mainTexPath: job.source.main,
          additionalFiles: files.filter(f => f !== root), rerun: true, shellEscape: false,
          // No source-derived public lookup endpoint: only pinned same-origin package catalogs.
          remoteEndpoint: '', shellHandlerScripts: [],
        }).catch(error => { lost = true; throw error; });
        performance.mark('participant:compiled');
        if (lost || stopped || !result.success || !result.pdf || !result.synctex) throw Error('Compilation failed');
        await request({ op: 'finish', worker, job: job.job, lease: job.lease, digest: job.digest, pdfLength: result.pdf.length },
          new Blob([result.pdf, result.synctex], { type: 'application/octet-stream' }));
        performance.mark('participant:finished'); show('Device compilation complete');
      } catch {
        clearInterval(timer); clearTimeout(deadline);
        if (!lost && !stopped) await request({ op: 'fail', worker, job: job.job, lease: job.lease, digest: job.digest }).catch(() => {});
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

export async function compile(signal) {
  const sequence = generation;
  await ready;
  if (sequence !== generation) throw Error('Compilation canceled');
  const deadline = Date.now() + 180000;
  while (!globalThis.overleafParticipantEditor && Date.now() < deadline && !signal?.aborted) await pause(100);
  const editor = globalThis.overleafParticipantEditor;
  if (!editor || stopped || signal?.aborted) throw Error('Compilation unavailable');
  const text = editor.facade.getValue(), docId = String(editor.docId);
  if (lastJob) await request({ op: 'cancel', job: lastJob }).catch(() => {});
  performance.mark('participant:queue');
  const queued = await request({ op: 'queue', docId, text });
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
      await pause(250);
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
  stopped = true; clearInterval(timer); wakeClaim?.(); runner?.terminate();
  if (worker) request({ op: 'leave', worker }).catch(() => {});
});
