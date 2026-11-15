FROM overleafcep/sharelatex@sha256:3077cb674adff9155d5f7f3ddbb52c384565adbb1011f610706e7ae3dfd8d962

# Required document classes, styles and fonts; preserve the base image's TeX Live options.
RUN tlmgr update --self && tlmgr install \
    exam foreign mathtools bbm bbm-macros subdepth stackengine siunitx \
    float booktabs threeparttable caption xcolor jknapltx rsfs doublestroke \
    enumitem setspace cleveref tcolorbox dashrule mathpazo palatino \
    xpunctuate listings listingsutf8 pdfcol tikzfill incgraph ifmtarg
