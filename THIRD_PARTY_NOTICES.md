# Third-party notices

The proprietary license applies only to original materials whose rights are held by Cenker YILDIZ. It does not relicense dependencies or upstream server software.

This repository contains documentation, release tooling, and modified CE+ source in `integrations/ce-plus-oidc/` and `runtime/fast-preview/`. Those directories and their modifications are licensed under AGPL-3.0-only with their included license and provenance; the proprietary notice does not apply to them. No compiler or full Overleaf distribution is bundled.

The release pattern was inspected in [data-file-viewer](https://github.com/cenkeryildiz/data-file-viewer/blob/48510a0aa3ef762101d6db53267ca6843cd6dc16/.github/workflows/build.yml). Its application code has not been copied. GitHub Actions used by CI retain their respective upstream licenses.

Before adding dependencies or vendored code, record the exact revision, license, copyright notice, modifications, distribution location and any source-delivery obligations in `docs/dependencies.md`. In particular:

- Overleaf CE+ is separately licensed upstream; preserve its applicable AGPL terms and distribution/source obligations.
- Overleaf Workshop is AGPL-3.0; this proprietary companion currently incorporates none of its source. Prefer existing extension interfaces; resolve distribution/licensing scope explicitly before any source-derived integration.
- Audit upstream OT/reference-code reuse before copying or deriving implementation code. A separate process is not automatic proof of license compatibility.
- Preserve the MIT notice if any jujuleaf code is reused.
- Include required notices for compiler binaries, fonts and packages in the artifacts containing them.

The TeX package image recipe in `runtime/texlive-course/` derives from the pinned CE+ image and uses individually licensed TeX Live packages; revisions/licenses are recorded there. No private document, source ZIP or PDF is included in the recipe, source archive or tests. The image itself is not published.
