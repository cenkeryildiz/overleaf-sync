// SPDX-License-Identifier: AGPL-3.0-only
// Modification to TeXlyre BusyTeX1.4.1: terminating a worker must settle its pending compile immediately.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
export function patchSdk(source) {
  assert.equal(createHash('sha256').update(source).digest('hex'), '765465562107443abb3f4c2ee88fd88a90443ec9faa8e0eded099410b70d8442');
  function once(from, to) { assert.equal(source.split(from).length - 1, 1); source = source.replace(from, to); }
  once("            const timeout = setTimeout(() => {\n                reject(new Error('Compilation timeout'));\n            }, 180000);", "            const timeout = setTimeout(() => {\n                this.cancelCompilation = null;\n                reject(new Error('Compilation timeout'));\n            }, 180000);\n            this.cancelCompilation = () => { clearTimeout(timeout); reject(new Error('Compilation canceled')); };\n            this.worker.onerror = event => { event.preventDefault(); this.terminate(); };");
  once("                else if (data.pdf !== undefined) {\n                    clearTimeout(timeout);", "                else if (data.pdf !== undefined) {\n                    this.cancelCompilation = null;\n                    clearTimeout(timeout);");
  // Other SDK operations also handle exceptions; patch only the compile handler that follows the PDF branch.
  const start = source.indexOf('    async compileWithWorker('), end = source.indexOf('    async compileDirect(', start);
  assert(start > 0 && end > start);
  let section = source.slice(start, end);
  const before = "                else if (data.exception) {\n                    clearTimeout(timeout);";
  assert.equal(section.split(before).length - 1, 1);
  section = section.replace(before, "                else if (data.exception) {\n                    this.cancelCompilation = null;\n                    clearTimeout(timeout);");
  source = source.slice(0, start) + section + source.slice(end);
  once('    terminate() {\n        if (this.worker)', '    terminate() {\n        this.cancelCompilation?.();\n        this.cancelCompilation = null;\n        if (this.worker)');
  return source;
}
// TikZ and other styles need not declare themselves with plain \\ProvidesPackage.
export function patchPackageCatalog(source) {
  const before = 'new Set(Array.from(data_package_js_script.matchAll(this.regex_providespackage)).map(groups => groups[1].toLowerCase().trim()))';
  const after = 'new Set([...Array.from(data_package_js_script.matchAll(this.regex_providespackage)), ...Array.from(data_package_js_script.matchAll(/"filename":\\s*"[^"\\n]*\\/([^/"\\\\]+)\\.sty"/g))].map(groups => groups[1].toLowerCase().trim()))';
  assert.equal(source.split(before).length - 1, 1, 'Pinned package catalog anchor changed');
  return source.replace(before, after);
}
// A pdflatex pass that needs no rerun and changed nothing TeX reads back (latexmk's fixed point) is final; the pinned
// pipeline always typeset it once more in nonstopmode. Other drivers and every changed .aux/.toc/.bbl keep that final pass.
export function patchPasses(source) {
  function once(from, to) { assert.equal(source.split(from).length - 1, 1, 'Pinned pass anchor changed'); source = source.replace(from, to); }
  once('    _needs_rerun(log_text) {', `    _reread_snapshot(FS, PATH, skip) {
        const files = new Map();
        const walk = dir => {
            for (const name of FS.readdir(dir)) {
                if (name === '.' || name === '..') continue;
                const path = PATH.join(dir, name), stat = FS.stat(path);
                if (FS.isDir(stat.mode)) walk(path);
                else if (!skip.has(path) && !/\\.(?:log|blg|ilg)$|\\.synctex(?:\\.gz)?(?:\\(busy\\))?$/.test(name))
                    files.set(path, stat.size <= 4194304 ? FS.readFile(path) : stat.size + ':' + (+stat.mtime));
            }
        };
        walk(this.project_dir);
        return files;
    }

    _carry_files(FS, PATH) {
        const carry = {}; let size = 0;
        const walk = dir => {
            for (const name of FS.readdir(dir)) {
                if (name === '.' || name === '..') continue;
                const path = PATH.join(dir, name), stat = FS.stat(path);
                if (FS.isDir(stat.mode)) walk(path);
                else if (/\\.(?:aux|bbl|toc|lof|lot|out)$/.test(name)) { size += stat.size; carry[path.slice(this.project_dir.length + 1)] = FS.readFile(path); }
            }
        };
        walk(this.project_dir);
        return size <= 4194304 ? carry : null;
    }

    _reread_unchanged(before, after) {
        if (before.size !== after.size) return false;
        for (const [path, value] of before) {
            const other = after.get(path);
            if (other === undefined || typeof value !== typeof other) return false;
            if (typeof value === 'string' ? value !== other : value.length !== other.length || value.some((byte, i) => byte !== other[i])) return false;
        }
        return true;
    }

    _needs_rerun(log_text) {`);
  once(`                    ({ exit_code, log: last_log } = run(cmd, error_messages));

                    if (exit_code != 0)
                        break;

                    if (!this._needs_rerun(last_log)) {
                        if (cmd !== final_cmd) {`, `                    const reread_skip = new Set([pdf_path, log_path].map(path => PATH.join(source_dir, path)));
                    const reread_before = driver === 'pdftex_bibtex8' && cmd !== final_cmd ? this._reread_snapshot(FS, PATH, reread_skip) : null;
                    const pass_started = Date.now();
                    ({ exit_code, log: last_log } = run(cmd, error_messages));

                    if (exit_code != 0)
                        break;

                    if (!this._needs_rerun(last_log)) {
                        const fixed_point = reread_before !== null && FS.analyzePath(pdf_path).exists && +FS.stat(pdf_path).mtime >= pass_started &&
                            !this.error_messages_all.some(err => last_log.includes(err)) && this._reread_unchanged(reread_before, this._reread_snapshot(FS, PATH, reread_skip));
                        if (fixed_point) this.print('$ # no rerun needed and nothing TeX reads changed; this pass is final');
                        if (cmd !== final_cmd && !fixed_point) {`);
  // With .aux/.bbl carried from the caller's previous compile, a first pass that changed nothing TeX reads is final too.
  once('        ({ exit_code, log: last_log } = run(initial, this.error_messages_fatal));', `        const initial_skip = new Set([pdf_path, log_path].map(path => PATH.join(source_dir, path)));
        const initial_before = driver === 'pdftex_bibtex8' ? this._reread_snapshot(FS, PATH, initial_skip) : null;
        const initial_started = Date.now();
        ({ exit_code, log: last_log } = run(initial, this.error_messages_fatal));
        const initial_log = last_log;`);
  once(`        const rerun_enabled = rerun === null ? true : rerun;
        if (exit_code == 0) {`, `        const rerun_enabled = rerun === null ? true : rerun;
        const initial_final = initial_before !== null && exit_code == 0 && !this._needs_rerun(initial_log) && FS.analyzePath(pdf_path).exists &&
            +FS.stat(pdf_path).mtime >= initial_started && !this.error_messages_all.some(err => initial_log.includes(err)) &&
            this._reread_unchanged(initial_before, this._reread_snapshot(FS, PATH, initial_skip));
        if (initial_final) this.print('$ # carried auxiliary files were already final; this first pass is final');
        if (exit_code == 0 && !initial_final) {`);
  once('        return { pdf: pdf, synctex: synctex, log: logcat, exit_code: exit_code, logs: logs };', `        if (exit_code == 0 && logs.length) logs[logs.length - 1].carry = this._carry_files(FS, PATH);
        return { pdf: pdf, synctex: synctex, log: logcat, exit_code: exit_code, logs: logs };`);
  return source;
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [input, output, kind = 'sdk'] = process.argv.slice(2); assert(input && output && input !== output);
  assert(['sdk', 'catalog', 'pipeline'].includes(kind));
  const patch = { sdk: patchSdk, catalog: patchPackageCatalog, pipeline: source => patchPasses(patchPackageCatalog(source)) }[kind];
  writeFileSync(output, patch(readFileSync(input, 'utf8')), { flag: 'wx' });
}
