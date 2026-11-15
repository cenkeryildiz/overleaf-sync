// SPDX-License-Identifier: AGPL-3.0-only
// Cenker YILDIZ, 2026. Native SyncTeX remains the fallback for ambiguous math.
(() => {
  function refine(view, position, selected, mathAncestor) {
    if (typeof selected !== 'string' || !selected.trim() || selected.length > 80 || /[\r\n\0]/.test(selected)) return null;
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
  globalThis.overleafSynctexSelection = Object.freeze({ refine });
})();
