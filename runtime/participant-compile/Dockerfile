FROM --platform=linux/arm64 rust:1.90-slim-bookworm AS coordinator
WORKDIR /work
COPY runtime/participant-compile/coordinator/ .
RUN cargo build --release --locked
FROM --platform=linux/amd64 overleafcep-local/sharelatex-preamble:20261115
COPY --from=coordinator /lib/aarch64-linux-gnu/libgcc_s.so.1 /lib/aarch64-linux-gnu/libgcc_s.so.1
COPY --from=coordinator /usr/share/doc/libgcc-s1/copyright /usr/share/doc/overleaf-participant-libgcc/copyright
COPY --from=coordinator /work/target/release/overleaf-participant-coordinator /opt/participant/overleaf-participant-coordinator
COPY runtime/participant-compile/host.mjs /overleaf/services/web/app/src/Features/Compile/ParticipantCompile.mjs
COPY runtime/participant-compile/artifacts.mjs /overleaf/services/web/app/src/Features/Compile/ParticipantArtifacts.mjs
COPY runtime/incremental-preview/host.mjs /overleaf/services/web/app/src/Features/Compile/LivePreview.mjs
COPY runtime/participant-compile/apply.mjs /tmp/participant-apply.mjs
RUN node /tmp/participant-apply.mjs sync /overleaf/services/clsi/app/js/CompileManager.js /tmp/CompileManager.js && mv /tmp/CompileManager.js /overleaf/services/clsi/app/js/CompileManager.js && rm /tmp/participant-apply.mjs
COPY runtime/participant-compile/apply.mjs /tmp/participant-apply.mjs
RUN node /tmp/participant-apply.mjs email /overleaf/services/web/app/src/Features/Email/EmailSender.mjs /tmp/EmailSender.mjs && mv /tmp/EmailSender.mjs /overleaf/services/web/app/src/Features/Email/EmailSender.mjs && rm /tmp/participant-apply.mjs
