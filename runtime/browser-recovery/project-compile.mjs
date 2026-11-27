// SPDX-License-Identifier: AGPL-3.0-only
import { BusyTexRunner, PdfLatex, XeLatex, LuaLatex } from './busytex-sdk.mjs';
import { parseSyncTex } from './synctex-parser.mjs';
export async function fingerprint(project, files) {
  const source = { main: project.main, compiler: project.compiler, resources: [...files].sort((a, b) => a.path.localeCompare(b.path)).map(file => ({ path: file.path, ...(typeof file.content === 'string' ? { content: file.content } : { data: file.data }) })) };
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(source))))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export class LocalCompiler {
  runner; ready; carry; progress = () => {};
  stop() { this.runner?.terminate(); this.runner = this.ready = undefined; }
  // Starts the one shared initialize (the SDK is unsafe to initialize concurrently); a failed start is retried by the next compile.
  warm() {
    const runner = this.runner ||= new BusyTexRunner({ busytexBasePath: '/recovery/busytex', engineMode: 'combined', initRetries: 0,
      preloadDataPackages: ['/recovery/busytex/texlive-basic.js'],
      catalogDataPackages: ['/recovery/busytex/texlive-recommended.js', '/recovery/busytex/texlive-extra.js'],
      onDownloadProgress: p => this.progress(`Loading local compiler: ${Math.floor(p.percent)}%`) });
    const ready = this.ready ||= runner.initialize(true).then(() => performance.mark('compile:initialized'));
    ready.catch(() => { if (this.ready === ready) this.stop(); });
    return ready;
  }
  async compile(project, resources, progress, signal) {
    if (signal.aborted) throw Error('Compilation canceled. Source files are retained.');
    performance.mark('compile:start'); // measurement only (OPT-01)
    this.progress = progress;
    let deadline, abort;
    try {
      return await Promise.race([(async () => {
        await this.warm(); const runner = this.runner;
        if (signal.aborted) throw Error('Compilation canceled');
        const files = resources.map(file => ({ path: file.path, content: file.content ?? Uint8Array.from(atob(file.data), c => c.charCodeAt(0)) }));
        const root = files.find(file => file.path === project.main);
        if (typeof root?.content !== 'string') throw Error('Main source is missing');
        const Tool = { pdflatex: PdfLatex, xelatex: XeLatex, lualatex: LuaLatex }[project.compiler];
        if (!Tool) throw Error('Unsupported compiler');
        // Auxiliary files from this project's previous compile let an unchanged structure finish in one pass; sources win.
        const key = [project.id, project.main, project.compiler].join('\n');
        const carried = this.carry?.key === key ? this.carry.files.filter(file => !files.some(source => source.path === file.path)) : [];
        const run = extra => new Tool(runner).compile({ input: root.content, mainTexPath: project.main,
          additionalFiles: [...files.filter(file => file !== root), ...extra], rerun: true, shellEscape: false, remoteEndpoint: '', shellHandlerScripts: [] });
        let result = await run(carried);
        if (carried.length && !(result.success && result.pdf && result.synctex)) { this.carry = undefined; result = await run([]); }
        const carry = result.success ? result.logs?.at(-1)?.carry : null;
        this.carry = carry ? { key, files: Object.entries(carry).map(([path, content]) => ({ path, content })) } : undefined;
        performance.mark('compile:result');
        if (!result.success || !result.pdf || !result.synctex) throw Object.assign(Error('Compilation failed. A package, font or source may be unsupported. Your files and previous PDF are retained.'), { log: result.log });
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
  const nodes = [], boxes = new Map(), filled = new Set(), { offset } = data;
  const finite = (...values) => values.every(Number.isFinite);
  function source(block) {
    let path = block.file?.path?.replace(/^\/home\/web_user\/project_dir\//, '').replace(/^\.\//, '');
    if (!known.has(path) && known.has(root + path)) path = root + path;
    return known.has(path) && Number.isSafeInteger(block.line) && block.line > 0 && block.page > 0 ? path : undefined;
  }
  // The hbox (typeset line) holding a record, with its depth: backward search resolves this box first.
  function box(block) {
    if (block?.type !== 'horizontal' || !finite(block.left, block.bottom, block.width, block.height, block.depth)) return undefined;
    if (!boxes.has(block)) boxes.set(block, { line: block.line, x: block.left + offset.x, y: block.bottom - block.height + offset.y,
      width: Math.max(0, block.width), height: Math.max(0, block.height + block.depth) });
    return boxes.get(block);
  }
  function add(block) {
    const path = block.elements === undefined && source(block);
    if (!path || !finite(block.left, block.bottom, block.height || 0, block.width || 0)) return;
    const line = box(block.parent); if (line) filled.add(line);
    nodes.push({ path, line: block.line, page: block.page, type: block.type, x: block.left + offset.x, y: block.bottom - (block.height || 0) + offset.y,
      width: Math.max(0, block.width || 0), height: Math.max(0, block.height || 0), box: line });
  }
  for (const lines of Object.values(data.blockNumberLine)) for (const pages of Object.values(lines)) for (const blocks of Object.values(pages)) for (const block of blocks) add(block);
  // An hbox without project records of its own (e.g. an included graphic) still resolves to the line that built it.
  const previous = new Map();
  for (const block of data.hBlocks) {
    const geometry = box(block); if (!geometry) continue;
    // The preceding line of the same paragraph or list: its last record dates a lone word on the next line.
    geometry.previous = previous.get(block.parent); previous.set(block.parent, geometry);
  }
  for (const block of data.hBlocks) {
    const geometry = box(block), path = geometry && !filled.has(geometry) && geometry.width > 0 && geometry.height > 0 && source(block);
    if (path) nodes.push({ path, line: block.line, page: block.page, type: 'box', ...geometry, box: geometry });
  }
  if (!nodes.length) throw Error('No project source locations were found');
  return nodes;
}
export function forward(nodes, path, line) {
  if (!Number.isSafeInteger(line) || line < 1) return undefined;
  // Kerns, rules and whole boxes serve backward search only; they would widen the highlighted region.
  const usable = node => node.path === path && !['k', 'r', 'box'].includes(node.type);
  const best = nodes.filter(usable).reduce((best, node) => !best || Math.abs(node.line - line) < Math.abs(best.line - line) ? node : best, undefined);
  if (!best) return;
  let count = 0, x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const node of nodes) if (usable(node) && node.line === best.line && node.page === best.page) {
    count++; x = Math.min(x, node.x); y = Math.min(y, node.y); right = Math.max(right, node.x + node.width); bottom = Math.max(bottom, node.y + node.height);
  }
  return count === 1 ? best : { ...best, x, y, width: right - x, height: bottom - y };
}
export function backward(nodes, page, x, y) {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  // Like SyncTeX's edit query: find the clicked typeset line first (smallest containing hbox, else the vertically
  // then horizontally nearest one), never the nearest record on the whole page, which often sits on another line.
  // Zero-width rules are struts, tagged with whatever input TeX was reading when a macro built them.
  const onPage = nodes.filter(node => node.page === page && !(node.type === 'r' && !node.width)), boxed = onPage.filter(node => node.box);
  const lines = new Map();
  for (const node of boxed.length ? boxed : onPage) { const box = node.box || node; lines.has(box) ? lines.get(box).push(node) : lines.set(box, [node]); }
  const gap = (from, size, at) => Math.max(0, from - at, at - from - size), near = (a, b) => Math.abs(a - b) <= 0.5;
  let records, rank, chosen;
  for (const [box, list] of lines) {
    const next = [gap(box.y, box.height, y), gap(box.x, box.width, x), box.width * box.height];
    if (!rank || next[0] < rank[0] && !near(next[0], rank[0]) || near(next[0], rank[0]) && (next[1] < rank[1] && !near(next[1], rank[1]) ||
      near(next[1], rank[1]) && next[2] < rank[2])) { records = list; rank = next; chosen = box; }
  }
  if (!records) return undefined;
  // pdfTeX tags the glue/kern that follows a word, placed at the next word's start, with the word's own line;
  // 'x' records lag one word behind, and a line's first one carries the paragraph's last line.
  if (records.some(node => node.type !== 'x')) records = records.filter(node => node.type !== 'x');
  const first = list => list.reduce((a, b) => b.x < a.x ? b : a), last = list => list.reduce((a, b) => b.x > a.x ? b : a);
  const right = records.filter(node => node.x > x), left = records.filter(node => node.x <= x);
  if (!right.length) return last(records);
  const after = first(right), earlier = lines.get(chosen.previous)?.filter(node => node.type !== 'x');
  // A preceding line that ended its own paragraph (final record tagged with its box line) says nothing about this one.
  const carried = earlier?.length && last(earlier).line !== chosen.previous.line ? last(earlier) : undefined;
  const before = left.length ? last(left) : carried;
  // Material closing a box (paragraph fill, cell glue) carries the line TeX read to end it, as does the box itself:
  // usually the blank line or the next row, so the record before the click dates the clicked text instead.
  return before && before.line !== chosen.line && right.every(node => node.line === chosen.line) ? before : after;
}
