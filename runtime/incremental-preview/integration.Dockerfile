FROM --platform=linux/arm64 rust:1.90-slim-bookworm AS worker
WORKDIR /work
COPY worker/ .
RUN cargo build --release --locked
FROM overleafcep-local/texpresso-hybrid-builder:20261115 AS renderer
COPY texpresso/src/frontend/ /src/texpresso/src/frontend/
COPY texpresso/src/dvi/ /src/texpresso/src/dvi/
RUN cd /src/texpresso && rm -rf build/frontend && make -C src/frontend texpresso
FROM overleafcep-local/sharelatex-hybrid:20261115
COPY --from=renderer /src/texpresso/build/texpresso /opt/texpresso/bin/texpresso
COPY --from=worker /work/target/release/overleaf-live-preview /opt/texpresso/bin/overleaf-live-preview
