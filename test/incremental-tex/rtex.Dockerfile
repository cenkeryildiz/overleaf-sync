FROM --platform=linux/amd64 overleafcep-local/texpresso-trial:20261115
RUN tlmgr install luatexbase ctablestack && tlmgr install --no-depends luahbtex.aarch64-linux luatex.aarch64-linux && fmtutil-sys --byfmt lualatex
COPY bin/rtex /opt/rtex/bin/rtex
COPY share/rtex/ /opt/rtex/share/rtex/
COPY LICENSE /opt/rtex/LICENSE
RUN mkdir -p /opt/rtex-texlive && printf '%s\n' '#!/bin/sh' 'exec /usr/local/texlive/2026/bin/aarch64-linux/luahbtex --fmt=lualatex "$@"' > /opt/rtex-texlive/lualatex && chmod 755 /opt/rtex-texlive/lualatex && /opt/rtex-texlive/lualatex --version
ENV RTEX_TEXLIVE_BIN=/opt/rtex-texlive
ENV PATH="/opt/rtex-texlive:${PATH}"
