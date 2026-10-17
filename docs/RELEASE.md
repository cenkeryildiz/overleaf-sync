# Repository and rolling release contract

## Reference and scope

The delivery model follows data-file-viewer's live workflow at commit `48510a0aa3ef762101d6db53267ca6843cd6dc16`: public repository, main-branch publication, Node 22, Linux checks, native macOS/Windows jobs, publisher `cenker-local`, GitHub Actions artifacts and a permanent rolling `latest` release.

This repository currently contains the plan and setup tooling. Its three-OS jobs check that tooling, not nonexistent extension code. `package.json` is currently a tooling package, not a finished VS Code extension manifest.

## Current workflow

1. Pushes, pull requests and manual dispatch run syntax checks, phase/document validation and meaningful negative-path tests on Linux, macOS and Windows.
2. Linux builds an archive directly from the checked-out commit and prepares the plan, license, phase status, release manifest and SHA-256 checksums. Package verification reopens the archive and checks every asset.
3. All three OS checks and the package check must pass before the release job runs.
4. Only a push/manual run on `main` may publish. An outdated run whose commit is no longer main is ignored.
5. Publish/update the `latest` tag at the tested commit and its GitHub release, explicitly marked **Planning prerelease — no extension yet**. The release body includes source SHA and CI run link.
6. Re-download release assets and compare SHA-256 values before reporting success. Keep the stable release URL in README.

The release job alone receives `contents: write`. PR checks never receive publication permission. Release operations are serialized; ordinary validation of superseded branch pushes may be cancelled. There is no Marketplace token or `vsce publish` invocation.

## Application pipeline added across R0–R4

R0 adds native security test harnesses; R4 completes packaging and installed-host verification. Extend the actual workflow to run the application's type checks, unit/stress tests, Rust tests and native builds, then package `darwin-arm64`, `darwin-x64`, and `win32-x64` VSIXs. Use explicit runner architecture; do not infer it from `macos-latest`.

Run actual installed-host and browser tests, inspect each native binary and VSIX, and publish only platform-distinguished assets from the tested commit. Required checks must fail closed if their script or artifact is absent. Do not replace the bootstrap checks with no-op scripts using the expected application test names.

Keep candidates prerelease until all eight phases pass. R7 adds immutable versioned releases alongside `latest`, a verified server deployment bundle, rollback evidence and production status. Changing `releaseStage` alone cannot activate a missing binary pipeline: the current planning builder rejects non-planning stages and any completed application phase.

Phase state schema 2 uses IDs R0–R7. `planning` permits no completed application phase; `development` records gated implementation before distribution; `candidate` requires R0–R4 passed; `production` requires all eight. The planning builder rejects every non-planning stage until an actual application pipeline replaces it. The `latest` planning assets continue to report zero completed application phases.
