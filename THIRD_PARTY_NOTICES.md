# Third-party notices

The proprietary license applies only to original materials whose rights are held by Cenker YILDIZ. It does not relicense dependencies or upstream server software.

This repository contains documentation, release tooling, and modified CE+ source in `integrations/ce-plus-oidc/`, `runtime/fast-preview/` `runtime/browser-recovery/` and `runtime/synctex-selection/`. Those directories and their modifications are licensed under AGPL-3.0-only with their included license and provenance; the proprietary notice does not apply to them. This Git repository does not contain compiler binaries or a full Overleaf distribution. The standalone offline artifact separately includes the pinned browser compiler and CE+ UI, their bundled licenses, upstream source references and exact build/patch recipes in SOURCE.txt.

The release pattern was inspected in [data-file-viewer](https://github.com/cenkeryildiz/data-file-viewer/blob/48510a0aa3ef762101d6db53267ca6843cd6dc16/.github/workflows/build.yml). Its application code has not been copied. GitHub Actions used by CI retain their respective upstream licenses.

Before adding dependencies or vendored code, record the exact revision, license, copyright notice, modifications, distribution location and any source-delivery obligations in `docs/dependencies.md`. In particular:

- Overleaf CE+ is separately licensed upstream; preserve its applicable AGPL terms and distribution/source obligations.
- Overleaf Workshop is AGPL-3.0; this proprietary companion currently incorporates none of its source. Prefer existing extension interfaces; resolve distribution/licensing scope explicitly before any source-derived integration.
- Audit upstream OT/reference-code reuse before copying or deriving implementation code. A separate process is not automatic proof of license compatibility.
- Preserve the MIT notice if any jujuleaf code is reused.
- Include required notices for compiler binaries, fonts and packages in the artifacts containing them.

The TeX package image recipe in `runtime/texlive-course/` derives from the pinned CE+ image and uses individually licensed TeX Live packages; revisions/licenses are recorded there. No private document, source ZIP or PDF is included in the recipe, source archive or tests. The image itself is not published.

The local recovery comparison includes the unchanged jsdiff 5.2.2 browser bundle (BSD-3-Clause); see runtime/browser-recovery/DIFF-LICENSE.txt and docs/dependencies.md for attribution and exact provenance.

Offline PDF rendering reuses the pinned CE+ PDF.js5.1.91 distribution under Apache-2.0; the built UI ships its full license and individual CMap/font notices. runtime/browser-recovery/synctex-parser.mjs reuses LaTeX Workshop10.20.0's MIT SyncTeX parser with the original Thomas Durieux notice preserved; only its module exports are adapted for the browser. BusyTeX/CodeMirror licenses above continue to apply unchanged.

runtime/browser-recovery/client-zip.mjs is client-zip2.5.1, Copyright2020David Junger, MIT; full terms are in CLIENT-ZIP-LICENSE.txt and shipped with the offline static assets. It supplies streaming ZIP container generation only; this application makes no upstream performance claim.

Standalone packaging modifies the pinned CE+ CodeMirror bundle's input sanitizer to use Unicode regular-expression mode, preserving valid astral characters while replacing NUL and lone surrogates. The native editor, OT implementation and their original license/notices remain applicable. This patch does not change or resolve the application's existing distribution-license boundary.
