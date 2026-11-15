ARG OVERLEAF_BASE=overleafcep-local/sharelatex-course:6.3.0
# The application remains amd64; only pdfLaTeX runs natively on the existing ARM VM.
FROM --platform=linux/arm64 ubuntu@sha256:c92376659a7f14cc1f51615d73c9f4b7d8e18d59f370e02b4ed683ab4485c66c AS native-libc
RUN apt-get update && apt-get install -y --no-install-recommends perl && rm -rf /var/lib/apt/lists/*

FROM --platform=linux/amd64 ${OVERLEAF_BASE}
COPY --from=native-libc /usr/lib/aarch64-linux-gnu/libc.so.6 /lib/aarch64-linux-gnu/libc.so.6
COPY --from=native-libc /usr/lib/aarch64-linux-gnu/libm.so.6 /lib/aarch64-linux-gnu/libm.so.6
COPY --from=native-libc /usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1 /lib/ld-linux-aarch64.so.1
COPY --from=native-libc /usr/share/doc/libc6/copyright /usr/share/doc/overleaf-native-libc/copyright
COPY --from=native-libc /usr/bin/perl /opt/overleaf-native-perl/bin/perl
COPY --from=native-libc /usr/lib/aarch64-linux-gnu/libcrypt.so.1 /lib/aarch64-linux-gnu/libcrypt.so.1
COPY --from=native-libc /usr/lib/aarch64-linux-gnu/perl-base /usr/lib/aarch64-linux-gnu/perl-base
COPY --from=native-libc /usr/lib/aarch64-linux-gnu/perl /usr/lib/aarch64-linux-gnu/perl
COPY --from=native-libc /usr/share/doc/perl/copyright /usr/share/doc/overleaf-native-perl/copyright
COPY --from=native-libc /usr/share/doc/libcrypt1/copyright /usr/share/doc/overleaf-native-libcrypt/copyright
RUN echo 'fb6349e1d854c8b832f46f456aeeb9060c6cbc27e4cfea8885766cef87e3db63  /opt/overleaf-native-perl/bin/perl' | sha256sum -c -
RUN tlmgr install --no-depends pdftex.aarch64-linux mylatexformat && echo 'cee621bf5fc41d15d44c0d00a837af5267a8a0f5170f5406da44fcee44d01459  /usr/local/texlive/2026/bin/aarch64-linux/pdftex' | sha256sum -c -
COPY pdflatex latexmk /opt/overleaf-native-tex/bin/
COPY OutputFileFinder.js /overleaf/services/clsi/app/js/OutputFileFinder.js
RUN chmod 755 /opt/overleaf-native-tex/bin/* && /opt/overleaf-native-tex/bin/pdflatex --version && /opt/overleaf-native-tex/bin/latexmk -v
ENV PATH="/opt/overleaf-native-tex/bin:${PATH}"
