# Third-party notices

The proprietary license applies only to original materials whose rights are held by Cenker YILDIZ. It does not relicense dependencies or upstream server software.

This initial repository contains documentation and release tooling, not bundled Overleaf, Rust crates, compilers or application dependencies. Links in the implementation plan identify researched projects; linking to them does not incorporate their source into this repository.

The release pattern was inspected in [data-file-viewer](https://github.com/cenkeryildiz/data-file-viewer/blob/48510a0aa3ef762101d6db53267ca6843cd6dc16/.github/workflows/build.yml). Its application code has not been copied. GitHub Actions used by CI retain their respective upstream licenses.

Before adding dependencies or vendored code, record the exact revision, license, copyright notice, modifications, distribution location and any source-delivery obligations in `docs/dependencies.md`. In particular:

- Overleaf CE+ is separately licensed upstream; preserve its applicable AGPL terms and distribution/source obligations.
- Audit upstream OT/reference-code reuse before copying or deriving implementation code. A separate process is not automatic proof of license compatibility.
- Preserve the MIT notice if any jujuleaf code is reused.
- Include required notices for compiler binaries, fonts and packages in the artifacts containing them.
