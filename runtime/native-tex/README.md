# Native pdfLaTeX and latexmk on this ARM Linux VM

This optional derived image keeps CE+ and TeX Live 2026, its existing packages/fonts/formats, latexmk, review and synchronization. The application remains amd64. `pdflatex` resolves to official ARM pdfTeX and latexmk uses a hash-checked native Perl interpreter, avoiding Rosetta for those processes. XeLaTeX/LuaLaTeX and other tools keep their prior paths. This requires an ARM64 Linux kernel able to execute native ARM and the existing amd64 application; it is specific to the current Apple Silicon/Colima installation, not a cross-platform image.

The exact required local base is `sha256:cdea3445e3ac4173671c1cc5edd0f91d7f8c8e240ad69cce1abe88d2770c69be`, tagged `overleafcep-local/sharelatex-course:6.3.0`. Verify that ID before building. The Ubuntu ARM64 libc stage is digest-pinned; the required libc/libm/loader, native Perl modules and libcrypt are copied with their copyright notices. Perl stays off the global PATH. Local/HOME latexmkrc files and explicit `-r` configuration keep the original interpreter/module environment. Official `pdftex.aarch64-linux` revision 78082 is installed without unrelated platform packages; its binary SHA-256 is checked at build time. Existing TeX package licenses and the copied Ubuntu libc LGPL/copyright/source notices remain applicable. The wrapper changes no document or font.

```sh
docker image inspect overleafcep-local/sharelatex-course:6.3.0 --format '{{.Id}}'
docker build -t overleafcep-local/sharelatex-native-latexmk:20261115 runtime/native-tex
```

Select the image in the existing Toolkit compose override, preserving all volumes and loopback binding:

```yaml
services:
  sharelatex:
    image: overleafcep-local/sharelatex-native-latexmk:20261115
```

Recreate only the existing sharelatex service with the GNU-tool PATH and `PULL_BEFORE_UPGRADE=false` command in `../texlive-course/README.md`. Roll back by removing that image override and recreating sharelatex; the original image and data remain. Do not prune the base image.

The outside-workspace `test/native-tex/` build check compares four synthetic body revisions, compile failures, memory and SyncTeX availability. All four complete PDF files matched byte-for-byte across all three profiles (12 outputs). For the 20,637-byte/four-page fixture, warm latexmk was 518–521 ms before, 444–445 ms with native pdfTeX only, and 337–338 ms with native pdfTeX and Perl; peak child RSS about 33,236 versus 28,416 KiB. This is a modest engine improvement, not an instantaneous preview or a production-load/whole-app-memory guarantee. Browser input-to-visible-PDF timings are recorded in the project plan separately.

The current wrapper also reuses an owned, hash-keyed preamble format through the installed `mylatexformat` package. Changed preambles invalidate it; local styles, custom latexmk settings and dynamic preambles use the full compiler. Format failures retain a native fallback. Font preloading is disabled after an actual-project raster mismatch; the corrected build matched all 12 page rasters and 3,588 word boxes in the same-engine comparison. `OutputFileFinder.js` keeps the internally owned cache out of published output files, while preserving a source resource with that name. The installed sample improved visible updates from 1,050–1,184 ms to 634–717 ms, which still misses the requested immediate preview. Preamble-format compatibility with arbitrary projects remains unqualified.
