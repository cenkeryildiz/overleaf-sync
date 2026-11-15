// SPDX-License-Identifier: AGPL-3.0-only
// Cenker YILDIZ, 2026. Native SyncTeX remains the fallback for ambiguous math.
(() => {
  function refineMath(view, position, selected, mathAncestor) {
    const content = mathAncestor(view.state, position)?.getChild('Content');
    if (!content || content.to - content.from > 32768) return null;
    const text = view.state.doc.sliceString(content.from, content.to);
    const eligible = new Uint8Array(text.length), cursor = content.cursor(); let visited = 0;
    do {
      if (++visited > 5000) return null;
      if (['Normal','MathChar','Number','MathSpecialChar','Whitespace'].some(type => cursor.type.is(type))) eligible.fill(1,cursor.from-content.from,cursor.to-content.from);
    } while (cursor.next());
    let offset = -1, match = null;
    while ((offset = text.indexOf(selected, offset + 1)) !== -1) {
      const end = offset + selected.length;
      if (/^[\p{L}\p{N}]/u.test(selected) && /[\p{L}\p{N}]/u.test(text[offset-1] || '')) continue;
      if (/[\p{L}\p{N}]$/u.test(selected) && /[\p{L}\p{N}]/u.test(text[end] || '')) continue;
      if (!eligible.subarray(offset,end).every(Boolean)) continue;
      if (match) return null;
      match = { from: content.from + offset, to: content.from + end };
    }
    return match;
  }
  function refine(view, position, selected, mathAncestor) {
    const doc = view.state.doc, line = doc.lineAt(position);
    const label = typeof selected === 'string' && selected.match(/^\u0000question:(\d+)$/);
    if (label) {
      const before = doc.sliceString(0, line.from + line.text.length), start = before.lastIndexOf('\\begin{questions}');
      if (start < 0 || before.lastIndexOf('\\end{questions}') > start) return null;
      const section = before.slice(start);
      if (/\\(?:setcounter|addtocounter|input|include)\b/.test(section)) return null;
      const questions = [...section.matchAll(/^[ \t]*\\question\b/gm)];
      const question = questions.at(-1);
      if (!question || questions.length !== Number(label[1])) return null;
      const from = start + question.index + question[0].indexOf('\\question');
      return { from, to: from + '\\question'.length };
    }
    if (typeof selected !== 'string' || !selected.trim() || selected.length > 80 || /[\r\n\0]/.test(selected)) return null;
    const math = refineMath(view, position, selected, mathAncestor);
    if (math) return math;
    const sameLine = line.text.indexOf(selected);
    if (sameLine >= 0 && sameLine === line.text.lastIndexOf(selected)) return null;
    if (position > 2000000) return null;
    // Text inside an imported PDF belongs to its inclusion, not to editable chart text.
    const graphic = line.text.match(/\\includegraphics\*?(?:\[[^\]]*\])?\{[^}]+\}/);
    if (graphic && !line.text.slice(0, graphic.index).includes('%')) return { from: line.from + graphic.index, to: line.from + graphic.index + graphic[0].length };
    const prefix = doc.sliceString(0, line.from + line.text.length);
    const figures = [...prefix.matchAll(/\\begin\{figure\*?\}/g)];
    const figure = figures.at(-1);
    if (figure) {
      const region = doc.sliceString(figure.index, figure.index + 32768);
      const end = region.match(/\\end\{figure\*?\}/);
      if (end && position <= figure.index + end.index + end[0].length) {
        const graphics = [...region.slice(0, end.index).matchAll(/\\includegraphics\*?(?:\[[^\]]*\])?\{[^}]+\}/g)];
        if (graphics.length === 1) {
          const candidate = graphics[0], from = figure.index + candidate.index;
          const sourceLine = doc.lineAt(from);
          if (!sourceLine.text.slice(0, from - sourceLine.from).includes('%')) return { from, to: from + candidate[0].length };
        }
      }
    }
    return null;
  }
  globalThis.overleafSynctexSelection = Object.freeze({ refine });
})();
