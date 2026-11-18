FROM --platform=linux/amd64 rust@sha256:4f572135209e89d488fadb81d8a07309857f9b9c5280b54c85a44b71629e8cca AS coordinator
WORKDIR /work
COPY runtime/participant-compile/coordinator/ .
RUN cargo build --release --locked

FROM --platform=linux/amd64 overleafcep/sharelatex@sha256:3077cb674adff9155d5f7f3ddbb52c384565adbb1011f610706e7ae3dfd8d962
COPY runtime/browser-recovery/ /tmp/source/runtime/browser-recovery/
COPY runtime/fast-preview/ /tmp/source/runtime/fast-preview/
COPY runtime/live-caret/ /tmp/source/runtime/live-caret/
COPY runtime/session-revocation/ /tmp/source/runtime/session-revocation/
COPY runtime/synctex-selection/ /tmp/source/runtime/synctex-selection/
COPY runtime/participant-compile/apply.mjs runtime/participant-compile/client.mjs runtime/participant-compile/editor.js runtime/participant-compile/bootstrap.js runtime/participant-compile/worker.js runtime/participant-compile/sdk-patch.mjs /tmp/source/runtime/participant-compile/
COPY runtime/participant-compile/hosting/provision.mjs runtime/participant-compile/hosting/output-auth.mjs /tmp/source/runtime/participant-compile/hosting/
RUN node /tmp/source/runtime/participant-compile/hosting/provision.mjs && rm -rf /tmp/source
COPY --from=coordinator /work/target/release/overleaf-participant-coordinator /opt/participant/overleaf-participant-coordinator
COPY runtime/participant-compile/host.mjs /overleaf/services/web/app/src/Features/Compile/ParticipantCompile.mjs
COPY runtime/session-checkpoint/host.mjs /overleaf/services/web/app/src/Features/Compile/SessionCheckpoint.mjs
COPY runtime/participant-compile/artifacts.mjs /overleaf/services/web/app/src/Features/Compile/ParticipantArtifacts.mjs
COPY runtime/incremental-preview/host.mjs /overleaf/services/web/app/src/Features/Compile/LivePreview.mjs
COPY runtime/fast-preview/CompileManager.mjs /overleaf/services/web/app/src/Features/Compile/CompileManager.mjs
COPY integrations/ce-plus-oidc/OIDCAuthenticationManager.mjs /overleaf/services/web/modules/authentication/oidc/app/src/OIDCAuthenticationManager.mjs
COPY integrations/ce-plus-oidc/OIDCAuthenticationController.mjs /overleaf/services/web/modules/authentication/oidc/app/src/OIDCAuthenticationController.mjs
RUN cp /etc/overleaf/settings.js /etc/overleaf/participant-base.cjs
COPY runtime/participant-compile/hosting/settings.cjs /etc/overleaf/settings.js
