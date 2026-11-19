// SPDX-License-Identifier: AGPL-3.0-only
export function readProject(files) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./zip-worker.mjs', import.meta.url), { type: 'module' });
    const deadline = setTimeout(() => { worker.terminate(); reject(Error('Project import timed out; existing projects were kept')); }, 30000);
    const finish = () => { clearTimeout(deadline); worker.terminate(); };
    worker.onmessage = ({ data }) => { finish(); data.error ? reject(Error(data.error)) : resolve(data); };
    worker.onerror = event => { event.preventDefault(); finish(); reject(Error('Project import failed; existing projects were kept')); };
    worker.postMessage([...files]);
  });
}
