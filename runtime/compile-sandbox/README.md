# Rejected local confinement attempt — not deployed

This prototype is failure evidence, not a supported compiler runner. Direct native-ARM file, environment, socket and signal restrictions worked, but the mixed ARM/amd64 installation needs Rosetta child processes to read `/proc/self/maps`. Broadening process access was rejected. The required sibling-container isolation is implemented instead in `runtime/compile-service`, reusing the installed CE+ DockerRunner.

The prototype's only Rust dependency is existing pinned libc 0.2.191. Its image copied native libgcc_s and the upstream copyright notice for loading; no binary or private input is committed. Preserve source/history for the recorded diagnostic result; do not install this image or enable the LocalCommandRunner overlay on the shared service.
