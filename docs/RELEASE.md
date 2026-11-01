# Release contract

## Current planning pipeline

The existing workflow checks repository tooling on Linux, macOS and Windows, builds planning assets from the exact committed source, and reopens the source archive to verify file hashes. Only successful main-branch CI can update the rolling `latest` planning prerelease. The publisher checks source identity and re-downloads uploaded assets. PR jobs have no publication permission; there is no Marketplace publication.

The package is still tooling, not an extension manifest. The builder/publisher remain planning-only: editing phase status never produces or authorizes an application release. This revision does not publish anything.

## Incremental application releases

R0 must extend the actual pipeline to build and install real VSIXs for Windows x64, Intel macOS and Apple Silicon macOS. Use explicit target architecture and inspect exact artifacts. With a TypeScript-only client, do not introduce native binaries merely to distinguish packages. Check each supported native host and any native store binding actually shipped.

Each R0–R7 phase has its own scoped release gates in the plan. A candidate or production release requires completed phases through its target, not later roadmap work. R4–R7 conveniences are optional; none block an earlier supported release. Ship R1 after its cookie/origin/mirror data-loss gates and R0 prerequisites pass, while expanded R2 live-write experiments continue. An unresolved live proof is not a passing write gate. “Production” applies only to the documented feature/platform scope.

Add immutable versioned application releases, an accurately labelled rolling latest release, source/artifact checksums, real installed-host checks and a retained rollback artifact when R0 adds distribution. Run affected regressions; recheck persistence migrations and rollback when state changes. A missing required script, runner or artifact blocks distribution; no passing placeholder checks.

`docs/phase-status.json` schema 3 uses eight ordered phases. Set `releasePhase` to null in planning/development, or the target phase ID for candidate/production. Both candidate and production require actual gate evidence through that target. Planning permits no completed application phases. Reset invalidated dependent phases and reassess release claims if an earlier gate fails.

Version numbers 0.1–0.8 identify the planned increments, not delivery dates. Later feature work may proceed while the last valid earlier release remains supported. Marketplace publication still requires explicit authorization.
