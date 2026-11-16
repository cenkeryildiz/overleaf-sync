// SPDX-License-Identifier: AGPL-3.0-only
(() => {
  let dialog;
  globalThis.overleafRecoveryReview = async initial => {
    if (dialog?.open) { dialog.focus(); return; }
    const api = globalThis.overleafRecovery, scope = api.currentScope();
    const copies = api.list(scope.account, scope.project).filter(({ record }) => record.doc === scope.doc);
    if (!copies.length) throw Error('No retained local copies for this document');
    if (initial && !copies.some(copy => copy.key === initial)) throw Error('This recovery copy belongs to another account, project or document');
    if (!globalThis.Diff) await new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = '/recovery/diff.min.js';
      script.onload = resolve; script.onerror = () => { script.remove(); reject(Error('Comparison did not load; copies are kept')); }; document.head.append(script);
    });
    if (!document.querySelector('link[data-recovery-review]')) {
      const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = '/recovery/review.css?v=' + globalThis.overleafRecoveryBuild.version;
      style.dataset.recoveryReview = ''; document.head.append(style);
    }
    dialog = document.createElement('dialog'); dialog.className = 'recovery-review'; dialog.setAttribute('aria-label', 'Review local and shared changes');
    // Only fixed interface markup; document text is assigned with textContent/value below.
    dialog.innerHTML = `<h2>Review local and shared changes</h2><p>Your local copy stays separate until you apply the reviewed text. Applying uses the shared editor; later edits still use normal collaboration.</p>
      <label>Retained local copy <select aria-label="Retained local copy"></select></label>
      <div class="recovery-review-columns"><section><h3>Current shared version</h3><pre tabindex="0" aria-label="Current shared version"></pre></section>
      <section><h3>Local copy / resolved text</h3><textarea aria-label="Resolved text" spellcheck="false"></textarea></section></div>
      <details><summary>Line differences</summary><pre class="recovery-review-diff" aria-label="Line differences"></pre></details>
      <p role="status" aria-live="polite"></p><footer><button type="button" data-action="refresh">Refresh shared version</button><button type="button" data-action="apply">Apply reviewed text</button><button type="button" data-action="keep">Keep local copy</button><button type="button" data-action="close">Close</button></footer>`;
    const select = dialog.querySelector('select'), resolved = dialog.querySelector('textarea'), shared = dialog.querySelector('pre'), message = dialog.querySelector('[role=status]');
    let record, reviewed, resolution;
    const report = (text, error = false) => { message.textContent = text; message.dataset.error = error; };
    function differences() {
      const target = dialog.querySelector('.recovery-review-diff'); target.replaceChildren();
      if (reviewed.text.length + resolved.value.length > 500000) { target.textContent = 'Large comparison: use the two text columns or export your copy.'; return; }
      const parts = globalThis.Diff.diffLines(reviewed.text, resolved.value, { timeout: 75, maxEditLength: 2000 });
      if (!parts) { target.textContent = 'Line comparison exceeded its limit. Both text columns are retained.'; return; }
      for (const part of parts) {
        const span = document.createElement('span'); span.dataset.change = part.added ? 'added' : part.removed ? 'removed' : 'unchanged';
        span.textContent = part.value.replace(/^(?=[\s\S])/gm, part.added ? '+ ' : part.removed ? '- ' : '  '); target.append(span);
      }
    }
    function retain() {
      const next = { ...resolution, candidate: resolved.value, revision: resolution.revision + 1, updatedAt: Date.now() };
      const key = api.save(next); resolution = next; return key;
    }
    function refresh() {
      reviewed = api.reviewSnapshot(record); shared.textContent = reviewed.text; differences();
      report('Shared revision ' + reviewed.version + '. Review both columns before applying.');
    }
    function open() {
      const next = api.read(select.value); api.reviewSnapshot(next);
      if (record) retain(); record = next; resolution = api.fork(record); resolved.value = record.candidate; refresh();
    }
    for (const copy of copies) {
      const option = document.createElement('option'); option.value = copy.key; option.textContent = copy.record.name + ' · ' + new Date(copy.record.updatedAt).toLocaleString(); select.append(option);
    }
    select.value = initial || copies[0].key;
    try { open(); } catch (error) { dialog.remove(); throw error; }
    select.onchange = () => { try { open(); } catch (error) { report(error.message, true); } };
    resolved.oninput = () => { try { retain(); differences(); report('Resolution kept in this browser. Shared text has not changed.'); } catch { report('Browser storage failed. Keep this window open and copy your text before continuing.', true); } };
    dialog.querySelector('[data-action=refresh]').onclick = () => { try { retain(); refresh(); } catch (error) { report(error.message, true); } };
    dialog.querySelector('[data-action=apply]').onclick = () => {
      try { api.applyReviewed(record, reviewed, resolved.value); report('Applied through the shared editor. Retained copies remain available.'); }
      catch (error) { report(error.message, true); }
    };
    const close = () => { try { retain(); dialog.close(); } catch { report('Browser storage failed. Copy your resolution before closing.', true); } };
    dialog.querySelector('[data-action=keep]').onclick = close;
    dialog.querySelector('[data-action=close]').onclick = close;
    dialog.oncancel = event => { event.preventDefault(); close(); };
    dialog.onclose = () => dialog.remove(); document.body.append(dialog); dialog.showModal();
  };
})();
