FROM --platform=linux/arm64 rust:1.90-slim-bookworm AS worker
WORKDIR /work
COPY repository/runtime/incremental-preview/worker/ .
RUN cargo build --release --locked
FROM overleafcep-local/texpresso-hybrid-builder:20261115 AS renderer
COPY texpresso/src/frontend/ /src/texpresso/src/frontend/
COPY texpresso/src/dvi/ /src/texpresso/src/dvi/
COPY texpresso/src/common/ /src/texpresso/src/common/
RUN cd /src/texpresso && rm -rf build/frontend build/common build/dvi && make -C src/common && make -C src/frontend texpresso && make -C src/engine
FROM overleafcep-local/sharelatex-hybrid:20261115
RUN tlmgr install --no-depends kpathsea.aarch64-linux
COPY --from=renderer /src/texpresso/build/texpresso /src/texpresso/build/texpresso-xetex /opt/texpresso/bin/
COPY --from=worker /work/target/release/overleaf-live-preview /opt/texpresso/bin/overleaf-live-preview
