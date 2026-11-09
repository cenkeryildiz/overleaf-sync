# Release contract

## Current planning pipeline

The existing workflow checks repository tooling on Linux, macOS and Windows, builds planning assets from exact committed source, and reopens the source archive to verify hashes. Only successful main-branch CI updates the rolling `latest` planning prerelease. The publisher checks source identity and re-downloads assets. PR jobs have no publication permission.

The package is tooling, not an application. Editing phase names/status cannot produce or authorize a web release. The 9 November documentation revision uses a work branch because pushing main triggers publication; it does not deploy or publish a release.

## Web application releases

The product is a browser-based collaborative LaTeX application, not a VS Code extension. R0 must establish the actual web/source/service artifact pipeline, exact supported browsers and host/runtime requirements, smoke checks, source/checksum provenance and rollback. No VSIX, installed VS Code or Marketplace step is required. If a local helper is needed, its artifacts, loopback authentication/origin boundary and lifecycle require their own qualification; do not assume browser APIs provide local filesystem/compile durability.

Retain nearly all selected upstream capabilities through web workflows; extension-only features require web equivalents. Missing integration remains an explicit gap. R0–R7 are eight incremental releases; a candidate/production target requires actual evidence through its target, not later phases. R4 review/chat, R5 workflows, R6 shared server compilation and R7 multi-user job distribution remain required for complete-project acceptance even though earlier partial releases can ship first.

Use versioned web assets and required service/container/configuration artifacts with notices, immutable runtime/source identities, checksums and rollback instructions. Exercise exact artifacts in declared real browsers, with authenticated server and worker tests where applicable. Missing required scripts/runners/artifacts or unexecuted required gates block distribution. Never substitute planning checks, mock-only tests or extension experiment results for web acceptance.

Schema 3 uses eight ordered phases. `releasePhase` is null in planning/development and R0–R7 for candidate/production. Both release stages require passed prerequisites through the target. Planning permits no passed application phases. Preserve historical evidence, reopen invalidated prerequisites, reset dependents and reassess release claims after failures.

Versions 0.1–0.8 identify increments, not delivery dates. Source commits/pushes do not authorize deployment, changing visibility, license changes, external-account activation or publishing releases. Follow explicit authorization for those actions.
