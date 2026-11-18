// SPDX-License-Identifier: AGPL-3.0-only
import { BusyTexRunner, PdfLatex, XeLatex, LuaLatex } from './busytex-sdk.mjs';
import { parseSyncTex } from './synctex-parser.mjs';
export async function fingerprint(project, files) {
  const source = { main: project.main, compiler: project.compiler, resources: [...files].sort((a, b) => a.path.localeCompare(b.path)).map(file => ({ path: file.path, ...(typeof file.content === 'string' ? { content: file.content } : { data: file.data }) })) };
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(source))))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export class LocalCompiler {
  runner;
  stop() { this.runner?.terminate(); this.runner = undefined; }
  async compile(project, resources, progress, signal) {
    if (signal.aborted) throw Error('Compilation canceled. Source files are retained.');
    const runner = this.runner ||= new BusyTexRunner({ busytexBasePath: '/recovery/busytex', engineMode: 'combined', initRetries: 0,
      preloadDataPackages: ['/recovery/busytex/texlive-basic.js'],
      catalogDataPackages: ['/recovery/busytex/texlive-recommended.js', '/recovery/busytex/texlive-extra.js'],
      onDownloadProgress: p => progress(`Loading local compiler: ${Math.floor(p.percent)}%`) });
    let deadline, abort;
    try {
      return await Promise.race([(async () => {
        if (!runner.initialized) await runner.initialize(true);
        if (signal.aborted) throw Error('Compilation canceled');
        const files = resources.map(file => ({ path: file.path, content: file.content ?? Uint8Array.from(atob(file.data), c => c.charCodeAt(0)) }));
        const root = files.find(file => file.path === project.main);
        if (typeof root?.content !== 'string') throw Error('Main source is missing');
        const Tool = { pdflatex: PdfLatex, xelatex: XeLatex, lualatex: LuaLatex }[project.compiler];
        if (!Tool) throw Error('Unsupported compiler');
        const result = await new Tool(runner).compile({ input: root.content, mainTexPath: project.main,
          additionalFiles: files.filter(file => file !== root), rerun: true, shellEscape: false, remoteEndpoint: '', shellHandlerScripts: [] });
        if (!result.success || !result.pdf || !result.synctex) throw Error('Compilation failed. A package, font or source may be unsupported. Your files and previous PDF are retained.');
        return result;
      })(), new Promise((_, reject) => {
        abort = () => { this.stop(); reject(Error('Compilation canceled. Source files are retained.')); };
        signal.addEventListener('abort', abort, { once: true });
        deadline = setTimeout(() => { this.stop(); reject(Error('Compilation exceeded two minutes. Source files are retained.')); }, 120000);
      })]);
    } catch (error) { this.stop(); throw error; }
    finally { clearTimeout(deadline); signal.removeEventListener('abort', abort); }
  }
}
export async function navigation(bytes, project, files) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 8 * 1024 * 1024) throw Error('Invalid navigation data');
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 32 * 1024 * 1024) throw Error('Navigation data exceeds limits'); chunks.push(value); } }
  finally { await reader.cancel(); }
  const text = await new Blob(chunks).text();
  if (!text.startsWith('SyncTeX Version:1\n') || !text.includes('\nContent:\n')) throw Error('Unsupported navigation data');
  const data = parseSyncTex(text); if (!data) throw Error('Navigation data could not be read');
  const known = new Set(files.filter(file => file.doc).map(file => file.path));
  const root = project.main.includes('/') ? project.main.slice(0, project.main.lastIndexOf('/') + 1) : '';
  const nodes = [];
  function add(block) {
    if (block.elements !== undefined || block.type === 'k' || block.type === 'r') return;
    let path = block.file?.path?.replace(/^\/home\/web_user\/project_dir\//, '').replace(/^\.\//, '');
    if (!known.has(path) && known.has(root + path)) path = root + path;
    if (known.has(path) && Number.isSafeInteger(block.line) && block.line > 0 && block.page > 0 &&
        [block.left, block.bottom, block.height || 0, block.width || 0].every(Number.isFinite)) nodes.push({ path, line: block.line, page: block.page,
      x: block.left + data.offset.x, y: block.bottom - (block.height || 0) + data.offset.y, width: Math.max(0, block.width || 0), height: Math.max(0, block.height || 0) });
  }
  for (const lines of Object.values(data.blockNumberLine)) for (const pages of Object.values(lines)) for (const blocks of Object.values(pages)) for (const block of blocks) add(block);
  if (!nodes.length) throw Error('No project source locations were found');
  return nodes;
}
export function forward(nodes, path, line) {
  if (!Number.isSafeInteger(line) || line < 1) return undefined;
  const best = nodes.filter(node => node.path === path).reduce((best, node) => !best || Math.abs(node.line - line) < Math.abs(best.line - line) ? node : best, undefined);
  if (!best) return;
  let count = 0, x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const node of nodes) if (node.path === path && node.line === best.line && node.page === best.page) {
    count++; x = Math.min(x, node.x); y = Math.min(y, node.y); right = Math.max(right, node.x + node.width); bottom = Math.max(bottom, node.y + node.height);
  }
  return count === 1 ? best : { ...best, x, y, width: right - x, height: bottom - y };
}
export function backward(nodes, page, x, y) {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  // Reuse LaTeX Workshop's leaf-box containment/centre rule; parent boxes can point at \input instead of its child.
  const contains = (a, b) => a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height;
  const distance = node => Math.hypot(node.x + node.width / 2 - x, node.y + node.height / 2 - y);
  return nodes.filter(node => node.page === page).reduce((best, node) => !best || contains(best, node) ||
    (distance(node) < distance(best) && !contains(node, best)) ? node : best, undefined);
}
