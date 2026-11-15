# Browser recovery and Local only workspace

This increment keeps exact text candidates in browser storage before local CodeMirror transactions can reach CE+'s collaboration engine. It adds **Local only** and **Recovery copies** to the existing editor. Local only opens the cached document workspace; **Connect to server** opens a fresh authenticated shared project. Candidates never replay automatically. The local editor reuses the installed native CodeMirror engine, undo/redo and keymaps. No installed package, backend, OT algorithm or compiler is added. The offline workspace includes the unchanged jsdiff 5.2.2 browser distribution (17,530 bytes, BSD-3-Clause) from the pinned CE+ image; its notice is DIFF-LICENSE.txt.

The extension, source hooks and generator retain **AGPL-3.0-only**; see `LICENSE`. Modifications: Cenker YILDIZ, 15 November 2026. Original CE+ source is `yu-i-i/overleaf-cep@ae07e781ab20dac2378420e5cf7a47f7d8bccbb5`, matching image 6.3.0-ext-v5.1. CodeMirror state 6.5.4, view 6.38.6 and commands 6.10.1 are pinned in that image's yarn.lock; they retain MIT terms and Marijn Haverbeke/contributor copyright in `CODEMIRROR-LICENSES.txt`. The original upstream application and its other dependency notices remain required; this folder is not a complete Overleaf distribution.

Use the controls after a hard reload. Initial Local only preparation needs the running server to cache public application files. Afterwards the local workspace can refresh with the network unavailable. Opened text documents and independent tab candidates are supported; offline project assets, PDF compilation, complete editing aids and review reconciliation remain unfinished. Connecting does not apply the local text: compare/export the retained copy and deliberately reconcile it with the shared source. Local text cannot yet contain non-BMP characters/emoji, matching the pinned upstream limitation; an unsupported local edit is refused visibly.

Copies are scoped by origin, account, project, document and independent writer identity. The baseline/version and native review ranges are kept separately from candidate text. Duplicate baseline text is omitted from the raw snapshot: `contentInBaseText: true` means restore its `content` from `base.text` if a future reviewed importer needs the native raw object. No importer/replayer is implemented. Full-storage/readback failure refuses the transaction rather than sending an unretained edit. Candidates are not cleared on acknowledgements; this increment does not claim atomic server-confirmation recovery.

Copies stay in this browser profile until explicitly deleted. Offline storage does not authenticate or encrypt them against another person using the same profile. Browser clearing/eviction/private-mode limits can remove copies; export important work. The service worker caches a digest-pinned list of **public static files only** with credentials omitted. It never caches authenticated HTML, tokens, source API responses or private PDFs. Its `/recovery/` scope serves cached local-workspace requests without a network fallback; explicit Connect navigates out to the normal authenticated project. The native shared editor retains its existing session/authorization/CSRF boundaries.

For this pinned installation, extract the original editor bundle from the retained unmodified image (not from the already patched running container):

```sh
docker create --name recovery-source sha256:3077cb674adff9155d5f7f3ddbb52c384565adbb1011f610706e7ae3dfd8d962
docker cp recovery-source:/overleaf/services/web/public/js/codemirror-editor-57ce7aa576296ae31fad.js /tmp/codemirror-editor.original.js
docker rm recovery-source
node runtime/browser-recovery/apply.mjs /tmp/codemirror-editor.original.js "$HOME/overleaf-ws1/patches/browser-recovery"
```

The generator requires original editor SHA-256 `9a78a0a8b867dec0d7e54357f4d78343fd9311e9fadc791950f25e263adedd24`, exactly one occurrence of each hook, and a dedicated output directory with no unrelated files/symlinks. It prepends only the recovery extension and inserts the native editor hooks and passes its existing filename; `frontend-recovery.patch` is the typed preferred-source equivalent. The native dependency modules are 13591/19472/78147 from the pinned webpack assets; the worker checks their whole-file digests before installation. Do not apply this to another release without updating/verifying both source and asset identities.

Keep existing authentication, timing, data and loopback settings and add these read-only Toolkit volume mounts:

```yaml
- /Users/macc/overleaf-ws1/patches/browser-recovery:/overleaf/services/web/public/recovery:ro
- /Users/macc/overleaf-ws1/patches/browser-recovery/codemirror-editor-57ce7aa576296ae31fad.js:/overleaf/services/web/public/js/codemirror-editor-57ce7aa576296ae31fad.js:ro
```

Recreate only sharelatex using the existing Toolkit command in `../texlive-course/README.md`; atomic file replacement needs a remount. Roll back by removing only these two mounts and recreating the service. Retain browser copies and the old static cache so they remain exportable; do not clear browser site data as a rollback. The generator's public output is a required runtime asset, not a disposable test output.

Focused checks are `test/recovery.test.mjs`; the opt-in actual-browser check is `test/browser/recovery.browser.mjs`, with the same existing synthetic password/Playwright/Chrome environment as `test/browser/native-workflows.mjs`. They use synthetic projects and report exact IDs for cleanup. A real Windows browser, Safari, browser eviction/power-loss guarantees, whole-project offline parity and untrusted shared deployment are not qualified by these local checks. The preferred TypeScript patch applies cleanly to pinned source; a full upstream frontend rebuild is not yet qualified.

Cache-only enforcement covers requests handled by the local-workspace worker. Browser-managed service-worker update checks have not been qualified as zero-contact while the network is available; do not count the full no-contact R1/R3 gates as passed. Browser restart checks cover a normal close/reopen, not abrupt power loss.

**Review before reconnecting:** choose a recovery copy and click **Compare changes**. Added/removed lines compare the editor text against the saved baseline when that copy began, not against the current shared document. Comparing never saves, sends or merges source. Editing/undo or selecting another copy hides the old comparison; click again to refresh it. Export text preserves the exact current bytes. Comparison runs only on request, with 500,000 combined UTF-16 code units, a 75 ms library timeout and a 2,000-edit-distance limit; unavailable/large comparisons leave editing/export usable. These are work limits, not a guaranteed browser latency bound. Source is rendered as text, including any HTML-looking content.

The synthetic actual-browser check is test/browser/local-comparison.browser.mjs. Run with the installed PLAYWRIGHT_MODULE/CHROME_PATH environment against the existing loopback service; no login, server project, external URL or user data is used. Disposable browser profiles seed their own recovery records. Previous/candidate routes are optional for the same-machine check pass; the default exercises installed public assets, service-worker/offline reload, source/export fidelity and unchanged storage.
