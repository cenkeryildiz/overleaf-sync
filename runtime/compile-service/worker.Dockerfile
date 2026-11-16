FROM --platform=linux/amd64 overleafcep-local/sharelatex-preamble:20261115
COPY LockManager.js /overleaf/services/clsi/app/js/LockManager.js
COPY worker.mjs /overleaf/services/clsi/worker.mjs
COPY settings.cjs /etc/overleaf/settings.js
COPY apply.mjs /tmp/compile-admission.mjs
RUN node /tmp/compile-admission.mjs compile /overleaf/services/clsi/app/js/CompileManager.js /tmp/CompileManager.js && mv /tmp/CompileManager.js /overleaf/services/clsi/app/js/CompileManager.js && node /tmp/compile-admission.mjs conversion /overleaf/services/clsi/app/js/ConversionManager.js /tmp/ConversionManager.js && mv /tmp/ConversionManager.js /overleaf/services/clsi/app/js/ConversionManager.js && node /tmp/compile-admission.mjs docker /overleaf/services/clsi/app/js/DockerRunner.mjs /tmp/DockerRunner.mjs && mv /tmp/DockerRunner.mjs /overleaf/services/clsi/app/js/DockerRunner.mjs && rm /tmp/compile-admission.mjs
USER www-data
WORKDIR /overleaf/services/clsi
ENTRYPOINT ["node", "/overleaf/services/clsi/worker.mjs"]
