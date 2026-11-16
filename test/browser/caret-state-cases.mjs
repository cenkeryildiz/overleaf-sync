import assert from 'node:assert/strict';
export async function checkCaretState(page, requirePass) {
  const results = await page.evaluate(() => {
    const api = globalThis.__caretFieldTest;
    if (!api) throw Error('Native caret field test adapter unavailable');
    const State = document.querySelector('[aria-label^="Source Editor"]').cmView.view.state.constructor;
    const cases = [
      { name: 'text after advertised end', doc: 'abc\nend', caret: [0, 4], changes: [[3, 3, 'x', true]], expected: 4 },
      { name: 'row reflow', doc: 'abcdef\nend', caret: [1, 2], changes: [[3, 3, '\n', true]], expected: 6 },
      { name: 'future line', doc: 'abc', caret: [1, 1], changes: [[3, 3, '\nx', true]], expected: 5 },
      { name: 'backspace', doc: 'abcd\nend', caret: [0, 3], changes: [[3, 4, '', true]], expected: 3 },
      { name: 'local edit before deferred position', doc: 'abc\nend', caret: [0, 4], changes: [[0, 0, 'Q', false], [4, 4, 'x', true]], expected: 5 },
      { name: 'keep local transforms', doc: 'abcdef', caret: [0, 3], changes: [[0, 0, 'Q', false], [7, 7, 'z', true]], expected: 4 },
      { name: 'explicit caret move before insertion', doc: 'abc', caret: [0, 3], changes: [[3, 3, 'x', true]], expected: 3 },
      { name: 'local newline before future line', doc: 'abc', caret: [1, 1], changes: [[0, 0, 'Q\n', false], [5, 5, '\nx', true]], expected: 7 },
      { name: 'local deletion before deferred position', doc: 'Qabc\nend', caret: [0, 6], changes: [[0, 1, '', false], [3, 3, 'xy', true]], expected: 5 },
    ];
    return cases.map(sample => {
      let state = State.create({ doc: sample.doc, extensions: [api.field] });
      state = state.update({ effects: api.effect.of([{ cursor: { row: sample.caret[0], column: sample.caret[1] }, label: 'Fixture', hue: 1 }]) }).state;
      for (const [from, to, insert, remote] of sample.changes) state = state.update({ changes: { from, to, insert }, annotations: remote ? api.remote.of(true) : [] }).state;
      let actual; state.field(api.field).between(0, state.doc.length, from => { actual = from; });
      return { name: sample.name, actual, expected: sample.expected, passed: actual === sample.expected };
    });
  });
  const failed = results.filter(r => !r.passed);
  console.log(JSON.stringify({ nativeCaretFieldCases: results.length, failed }));
  if (requirePass) assert.equal(failed.length, 0, JSON.stringify(failed));
}
