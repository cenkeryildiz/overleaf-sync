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
    const original = selected, plain = text => text.replace(/[ﬀﬁﬂﬃﬄ]/g, c => ({ 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl' })[c]).normalize('NFC');
    const context = globalThis.overleafSynctexContext; globalThis.overleafSynctexContext = undefined;
    selected = plain(selected);
    const math = refineMath(view, position, selected, mathAncestor);
    if (math) return math;
    // A coarse SyncTeX line can start before an inline formula or its environment opener.
    let offset = -1, candidate = null, attempts = 0;
    const outsideMath = !mathAncestor(view.state, position)?.getChild('Content');
    while (outsideMath && (offset = line.text.indexOf(selected, offset + 1)) !== -1) {
      if (++attempts > 128) return null;
      const range = refineMath(view, line.from + offset, selected, mathAncestor);
      if (!range) continue;
      if (candidate && (candidate.from !== range.from || candidate.to !== range.to)) return null;
      candidate = range;
    }
    if (candidate) return candidate;
    if (/^\(?\d+[a-z]?\)?$/.test(selected) && !line.text.includes(selected)) {
      // Double-click selects the digits of a generated equation number, without its parentheses.
      for (let i = 0; i < Math.min(line.text.length, 1024); i++) {
        const content = mathAncestor(view.state, line.from + i)?.getChild('Content');
        if (content && content.to > content.from && content.to - content.from <= 32768) return { from: content.from, to: content.to };
      }
    }
    // Native uniqueness counts substrings, so "rate" in "corporate" or "\rate" made a unique word land at column 0.
    const comment = line.text.search(/(?<!\\)%/), body = comment < 0 ? line.text : line.text.slice(0, comment), words = [];
    for (let at = body.indexOf(selected); at !== -1 && words.length < 2; at = body.indexOf(selected, at + 1)) {
      const end = at + selected.length;
      if (/^[\p{L}\p{N}]/u.test(selected) && /[\p{L}\p{N}\\@]/u.test(body[at - 1] || '')) continue;
      if (/[\p{L}\p{N}]$/u.test(selected) && /[\p{L}\p{N}]/u.test(body[end] || '')) continue;
      words.push(at);
    }
    const sameLine = line.text.indexOf(selected);
    if (words.length === 1 && sameLine !== line.text.lastIndexOf(selected)) return { from: line.from + words[0], to: line.from + words[0] + selected.length };
    if (words.length > 1 && context?.word === original && (context.before || context.after) && /^[\p{L}\p{N}]+$/u.test(selected)) {
      // A truly repeated word: keep only the occurrence whose typeset neighbours match the PDF; never pick the first.
      const tokens = [...body.matchAll(/\\?[\p{L}\p{N}@]+/gu)].filter(token => token[0][0] !== '\\'), near = (i, word) => !word || tokens[i]?.[0] === plain(word);
      const hits = tokens.flatMap((token, i) => token[0] === selected && near(i - 1, context.before) && near(i + 1, context.after) ? [token.index] : []);
      if (hits.length === 1) return { from: line.from + hits[0], to: line.from + hits[0] + selected.length };
    }
    if (selected !== original && sameLine >= 0 && sameLine === line.text.lastIndexOf(selected) && !line.text.slice(0, sameLine).includes('%') && line.text[sameLine - 1] !== '\\') return { from: line.from + sameLine, to: line.from + sameLine + selected.length };
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
