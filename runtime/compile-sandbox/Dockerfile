FROM --platform=linux/arm64 rust:1.90-slim-bookworm AS worker
WORKDIR /work
COPY worker/ .
RUN cargo build --release --locked
FROM --platform=linux/amd64 overleafcep-local/sharelatex-preamble:20261115
COPY --from=worker /lib/aarch64-linux-gnu/libgcc_s.so.1 /lib/aarch64-linux-gnu/libgcc_s.so.1
COPY --from=worker /usr/share/doc/libgcc-s1/copyright /usr/share/doc/overleaf-compile-sandbox-libgcc/copyright
COPY --from=worker /work/target/release/overleaf-compile-sandbox /opt/overleaf-native-tex/bin/overleaf-compile-sandbox
COPY LocalCommandRunner.js /overleaf/services/clsi/app/js/LocalCommandRunner.js
