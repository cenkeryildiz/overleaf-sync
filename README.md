# Overleaf Sync

[![Build and release](https://github.com/cenkeryildiz/overleaf-sync/actions/workflows/build.yml/badge.svg)](https://github.com/cenkeryildiz/overleaf-sync/actions/workflows/build.yml)

Planned Windows and macOS VS Code extension for local LaTeX editing with simultaneous collaboration through an independent self-hosted Overleaf-compatible server. No Premium Overleaf account is required by the planned architecture.

Implementation status is recorded in the [plan](docs/COLLABORATIVE_LATEX_PLAN.md#21-implementation-status).

- [Collaborative LaTeX — Architecture and Delivery Plan](docs/COLLABORATIVE_LATEX_PLAN.md)
- [Eight risk-first phases](docs/COLLABORATIVE_LATEX_PLAN.md#17-eight-risk-first-implementation-phases-and-mandatory-completion-gates)
- [Machine-readable phase status](docs/phase-status.json)
- [Rolling latest release](https://github.com/cenkeryildiz/overleaf-sync/releases/tag/latest)
- [Release process and validation](docs/RELEASE.md)

## Implementation phases

| Phase | Deliverable | Initial status |
|---|---|---|
| R0 | Security and architecture baseline | Not started |
| R1 | Fidelity and engine selection | Not started |
| R2 | Durability and recovery | Not started |
| R3 | Read-only mirror | Not started |
| R4 | Native editing, presence and packaging | Not started |
| R5 | Compilation pool, TeX and assets | Not started |
| R6 | Deployment, hardening and compile load | Not started |
| R7 | Pilot and release | Not started |

Each phase is implemented, tested, repaired and documented by the implementing agent before the next begins. Required checks cannot be skipped. See the status file and evidence reports for subsequent updates; this table records the initial state.

## Selected design

TypeScript integrates with VS Code; the Rust/Tokio engine and upstream JS/TS adapter option are evaluated for fidelity and speed. Every run offers Local only or Connect to server. Connected work uses unchanged CE+, with a separate CLSI web compiler and a fair compile pool; local sessions keep editing and compilation on that computer.

Planned support includes native `.bib` editing, BibTeX and biblatex/Biber recipes, figures, TikZ/PGFPlots sources, plot data and custom styles. Assets mirror from the server; bidirectional transfers require proven conditional replacement, otherwise uploads stay disabled. Bibliography and graphics tests are required within the existing eight phases.

Native client targets are Apple Silicon Mac, Intel Mac and Windows x64. Windows ARM64 is planned but not promised before native validation. The server remains available when a client closes VS Code.

## Releases

As in data-file-viewer, successful main-branch CI updates the rolling `latest` GitHub release. At this stage its assets are a **planning prerelease**: the plan, license, phase status, source archive, provenance manifest and SHA-256 checksums. These are not a VSIX or a functioning collaboration server.

R0 proves security and server feasibility; R1 proves review/OT fidelity before feature work. R4 supplies actual VSIX builds and installed-host checks. Candidates require R0–R4 passed; production requires R0–R7 passed. A failed fidelity proof cannot be relabelled a successful live editor. GitHub Actions artifacts are supplementary; release assets are the permanent download route. VS Code Marketplace publication is not enabled.

## Repository checks

Developer tooling uses Node 22 in CI. The initial tooling has no npm dependencies.

```sh
npm ci
npm run typecheck
npm test
npm run validate
npm run build
npm run test:package
```

Commit the intended source before building; the package includes the exact tracked commit. These commands validate repository/phase/release tooling only. They do not run application tests that have not been implemented.

## License

**Proprietary — all rights reserved.** See [LICENSE](LICENSE). Public visibility is not an open-source license. Third-party rights are described in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
