# Local TeX package image

This adds the document classes, styles and fonts needed by the imported coursework to the existing CE+ image. It uses TeX Live's installer and dependencies, rather than installing a full scheme or another compiler. No user documents, ZIPs, credentials or PDFs enter the build context; `.dockerignore` admits only the Dockerfile.

From the repository root:

```sh
docker build --force-rm --platform linux/amd64 --pull=false \
  -t overleafcep-local/sharelatex-course:6.3.0 runtime/texlive-course
```

The pinned base is `overleafcep/sharelatex@sha256:3077cb674adff9155d5f7f3ddbb52c384565adbb1011f610706e7ae3dfd8d962`. The tested derived image is `sha256:cdea3445e3ac4173671c1cc5edd0f91d7f8c8e240ad69cce1abe88d2770c69be`. It installs 36 packages/dependencies and the required `texlive.infra` self-update, preserving the base's disabled documentation/source-file installation options. Package revisions/licenses are recorded in `packages.csv`; packages retain their individual licenses. No image is uploaded or released by this recipe. A future rebuild uses the then-current TeX Live repository and is not promised to reproduce the same image; retain the tested local image and recheck compatibility when TeX Live's year changes.

Set only `OVERLEAF_IMAGE_NAME=overleafcep-local/sharelatex-course` in `$HOME/overleaf-ws1/toolkit/config/overleaf.rc`; keep `config/version` at `6.3.0`, existing source mounts, data and loopback binding. From that Toolkit directory, recreate the existing service:

```sh
env PATH="/opt/homebrew/opt/gnu-sed/libexec/gnubin:/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/opt/grep/libexec/gnubin:$PATH" \
  PULL_BEFORE_UPGRADE=false bin/up -d sharelatex
```

Rollback selects `OVERLEAF_IMAGE_NAME=overleafcep-local/sharelatex` and repeats that command; it preserves documents/accounts but removes the added TeX packages. The original image is retained. Source/auth/preview overlays are configured separately and are not baked into this package-only image.

The base image was 1,257,440,032 bytes; the candidate is 1,264,726,860 bytes: +7,286,828 bytes (6.95 MiB). The original document failed for missing `exam.cls`; the imported copy later produced a PDF without source edits. These are capability/footprint results, not a compiler speedup claim. The opt-in `node test/texlive-course.mjs`, retrieved into a temporary checkout, compiles a synthetic exam/styles/fonts/tcolorbox workload twice and removes its scratch files.
