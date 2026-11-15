FROM overleafcep-local/texpresso-hybrid-builder:20261115 AS builder
COPY texpresso/src/dvi/dvi_resmanager.c /src/texpresso/src/dvi/dvi_resmanager.c
RUN cd /src/texpresso && make -C src/frontend texpresso
FROM overleafcep-local/sharelatex-preamble:20261115
COPY --from=builder /usr/lib/aarch64-linux-gnu/ /usr/lib/aarch64-linux-gnu/
COPY --from=builder /lib/ld-linux-aarch64.so.1 /lib/ld-linux-aarch64.so.1
COPY --from=builder /src/texpresso/build/texpresso /src/texpresso/build/texpresso-xetex /opt/texpresso/bin/
COPY --from=builder /src/texpresso/LICENSE /usr/share/doc/texpresso/LICENSE
COPY font-atlas/bbm10.tex /tmp/font-atlas/bbm10.tex
RUN mkdir -p /opt/texpresso/fonts && cd /tmp/font-atlas && /usr/local/texlive/2026/bin/aarch64-linux/pdftex -interaction=batchmode -halt-on-error bbm10.tex && cp bbm10.pdf /opt/texpresso/fonts/ && rm -rf /tmp/font-atlas
ENV TEXPRESSO_BITMAP_FONTS=/opt/texpresso/fonts
