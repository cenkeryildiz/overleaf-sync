# Release contract

LaTeX Local is distributed as a versioned GitHub Release. The stable download URL is https://github.com/cenkeryildiz/overleaf-sync/releases/latest/download/LaTeX-Local-Chrome-macOS-arm64.zip. The current v0.1.0 ZIP corresponds to source c21e067eb24d4e6d288127e796f5f944108ba5fd; main may include newer documentation or development work.

The supported qualification target is Chrome/macOS arm64. The release notes state tested scope and remaining development features. Other OS/browser targets require their own application checks. Repository CI on Linux/macOS/Windows does not establish browser qualification on those platforms.

For an explicitly authorized release:

1. Finish the scoped implementation and its real browser checks. Run npm ci, typecheck, test and validate, then build/test:package from exact committed source. Those build outputs are source snapshots, not the installable application.
2. Build the standalone folder with runtime/chrome-extension/package.mjs using the pinned existing asset image. Retain runtime assets, source/provenance references and third-party licences. Check the actual folder/ZIP and newly published history for private inputs, credentials, maps and unsafe paths; verify exact decoded asset bytes, extension identity and source commit.
3. After source CI and package/application checks pass, create a new versioned release draft with LaTeX-Local-Chrome-macOS-arm64.zip and SHA256SUMS. Keep existing tags/releases. Independently download and hash-check both draft assets, publish as latest with honest scope, then verify the anonymous stable download against the tested ZIP. Record results in the existing project plan and retain rollback until readback succeeds.

The former rolling planning publisher is disabled and must not replace the application release. PR jobs have read-only permissions; every action stays pinned and publication requires explicit authorization. A release does not authorize a website/server deployment, licence or repository-visibility change, account activation or paid usage.

Keep the same Chrome extension key/identity and preserve project storage. Users should export important work before an update, keep the installation folder in place, save work and reload the extension before reopening it. Do not reload or alter a real user's browser/profile from release tooling.

R0–R7 evidence and stage completion remain in the authoritative plan and phase-status file. Publishing a development download does not turn unexecuted checks or unfinished collaboration stages into accepted features.
