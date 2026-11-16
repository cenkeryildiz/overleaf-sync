import assert from 'node:assert/strict';
export async function inspectLocalCaret(local, other) {
  const editor = page => page.getByRole('textbox', { name: /^Source Editor/ });
  const original = await editor(local).evaluate(e => e.cmView.view.state.doc.toString());
  const insertion = await editor(local).evaluate(e => {
    const v = e.cmView.view, at = v.state.doc.toString().indexOf('Bob line'); return v.state.doc.lineAt(at).to;
  });
  for (const page of [local, other]) await editor(page).evaluate((e, head) => {
    const v = e.cmView.view; v.dispatch({ selection: { anchor: head } }); v.focus();
  }, insertion);
  await local.bringToFront(); await editor(local).evaluate(e => e.cmView.view.focus());
  await local.waitForFunction(head => {
    const v = document.querySelector('[aria-label^="Source Editor"]').cmView.view;
    const mark = v.dom.querySelector('.ol-cm-cursorHighlight')?.getBoundingClientRect(), point = v.coordsAtPos(head);
    return mark && point && Math.abs(mark.left - point.left) < 1;
  }, insertion);
  await local.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  async function positions(page) {
    return page.evaluate(() => {
      const view = document.querySelector('[aria-label^="Source Editor"]').cmView.view;
      const head = view.state.selection.main.head, expected = view.coordsAtPos(head);
      const own = view.dom.querySelector('.cm-cursor-primary')?.getBoundingClientRect();
      const peer = view.dom.querySelector('.ol-cm-cursorHighlight')?.getBoundingClientRect();
      const selection = getSelection(); let domHead;
      try { domHead = view.posAtDOM(selection.focusNode, selection.focusOffset); } catch {}
      const peers = [];
      for (const field of view.state.values || []) if (typeof field?.between === 'function') {
        try { field.between(0, view.state.doc.length, (from, to, value) => { if (value?.highlight?.cursor) peers.push({ position: from, label: value.highlight.label }); }); } catch {}
      }
      return { head, domHead, ownLeft: own?.left, ownRight: own?.right, expectedLeft: expected?.left, peerLeft: peer?.left, peers,
        font: getComputedStyle(view.contentDOM).font, dpr: devicePixelRatio, visible: document.visibilityState,
        focused: view.hasFocus, primaryElements: view.dom.querySelectorAll('.cm-cursor-primary').length };
    });
  }
  const before = await positions(local);
  assert.equal(before.head, insertion, 'Setup must select the requested insertion point');
  const typed = process.env.CARET_LOCAL_ONE_CHAR === '1' ? 'h' : 'hXYZ123h';
  await local.keyboard.type(typed, { delay: 40 });
  await local.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const after = await positions(local);
  console.log(JSON.stringify({ localCaretGeometry: { before, after } }));
  const expectedText = original.slice(0, insertion) + typed + original.slice(insertion);
  assert.equal(await editor(local).evaluate(e => e.cmView.view.state.doc.toString()), expectedText);
  assert.equal(after.head, insertion + typed.length, 'The local model must end after the final character');
  assert.equal(after.domHead, after.head, 'The browser insertion point must match the editor model');
  assert(after.ownLeft != null && after.ownLeft <= after.expectedLeft + 0.25 && after.ownRight >= after.expectedLeft - 0.25,
    'The insertion point must lie within the local caret stroke');
  await other.waitForFunction(expected => document.querySelector('[aria-label^="Source Editor"]').cmView.view.state.doc.toString() === expected, expectedText);
  console.log(JSON.stringify({ localCaretInspection: { before, after, other: await positions(other) }, exactTypedText: true }));
}
