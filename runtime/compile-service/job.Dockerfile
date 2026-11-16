# Existing native TeX/packages/fonts; no new compiler is selected.
FROM --platform=linux/amd64 overleafcep-local/sharelatex-preamble:20261115
RUN ln -sf /opt/overleaf-native-tex/bin/pdflatex /usr/local/bin/pdflatex && ln -sf /opt/overleaf-native-tex/bin/latexmk /usr/local/bin/latexmk
ENV TEXMFVAR=/tmp/texmf-var TEXMFCONFIG=/tmp/texmf-config VARTEXFONTS=/tmp/texfonts
ENTRYPOINT []
CMD []
USER www-data
WORKDIR /compile
