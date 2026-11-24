// SPDX-License-Identifier: AGPL-3.0-only
// TEX-PKG-01: the TeX files a project asks for, from its sources (hints: macros can load files dynamically) and from a
// failed compile's log (what TeX actually could not find). Pure.
const strip = text => text.replace(/(?<!\\)%.*$/gm, '');
const list = arg => arg.split(',').map(s => s.trim()).filter(s => /^[A-Za-z0-9._@-]{1,80}$/.test(s));
const RULES = [[/\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g, '.cls'], [/\\(?:usepackage|RequirePackage|RequirePackageWithOptions)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g, '.sty'],
  [/\\use(|color|font|inner|outer)theme\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g, null], [/\\bibliographystyle\s*\{([^}]*)\}/g, '.bst']];
export function fromSources(files) {
  const out = new Set();
  for (const { path, content } of files) {
    if (typeof content !== 'string' || !/\.(?:tex|sty|cls|ltx|dtx)$/i.test(path)) continue;
    const text = strip(content);
    for (const [pattern, suffix] of RULES) for (const m of text.matchAll(pattern)) {
      if (suffix) for (const name of list(m[1])) out.add(name + suffix);
      else for (const name of list(m[2])) out.add(`beamer${m[1]}theme${name}.sty`);
    }
  }
  return [...out];
}
export function fromLog(log) {
  const out = new Set(), text = String(log ?? '');
  for (const m of text.matchAll(/LaTeX Error: File `([^']{1,120})' not found/g)) out.add(m[1].includes('.') ? m[1] : m[1] + '.tex');
  for (const m of text.matchAll(/I can't find file `([^']{1,120})'/g)) out.add(m[1].includes('.') ? m[1] : m[1] + '.tex');
  for (const m of text.matchAll(/Metric \(TFM\) file not found|Font \\[^=]+=([A-Za-z0-9_-]{1,60})(?: at [^ ]+)? not loadable: Metric \(TFM\) file not found/g)) if (m[1]) out.add(m[1] + '.tfm');
  return [...out].filter(name => /^[A-Za-z0-9._@-]+$/.test(name));
}
