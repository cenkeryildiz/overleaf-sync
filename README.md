# Overleaf Sync

[![Build and release](https://github.com/cenkeryildiz/overleaf-sync/actions/workflows/build.yml/badge.svg)](https://github.com/cenkeryildiz/overleaf-sync/actions/workflows/build.yml)

Planned Windows/macOS VS Code extension for local LaTeX editing and collaboration through an independent self-hosted Overleaf-compatible server. No Premium account dependency.

**Current status: planning/tooling only. No working extension or deployed server.**

- [Authoritative incremental release plan](docs/COLLABORATIVE_LATEX_PLAN.md)
- [Early feasibility experiments](docs/COLLABORATIVE_LATEX_PLAN.md#3-first-work-feasibility-before-substantial-implementation)
- [Release order and gates](docs/COLLABORATIVE_LATEX_PLAN.md#9-delivery-order-and-release-gates)
- [Machine-readable phase status](docs/phase-status.json)
- [Rolling latest release](https://github.com/cenkeryildiz/overleaf-sync/releases/tag/latest)
- [Release process](docs/RELEASE.md)

| Phase / version | Usable increment |
|---|---|
| R0 / 0.1 | Early feasibility findings and installable local compile/PDF companion |
| R1 / 0.2 | Cookie-first, protected read-only mirror; release before live writes |
| R2 / 0.3 | Safe live text editing with baseline crash recovery |
| R3 / 0.4 | Offline reconciliation and recovery workflow |
| R4 / 0.5 | Optional upstream review/presence or browser handoff |
| R5 / 0.6 | Only useful project conveniences; reuse existing tools |
| R6 / 0.7 | Optional existing CE+ deployment/backup workflow |
| R7 / 0.8 | Parked scaling; no implementation scheduled |

Each release needs its own gates and completed prerequisites. Earlier supported releases do not wait for the pool. R0 probes server compatibility, review fidelity and ambiguous writes before substantial implementation. Unsafe or unproven live operations stay held/read-only.

Use [yu-i-i/overleaf-cep](https://github.com/yu-i-i/overleaf-cep) as the intended server; probe its actual review capabilities rather than assuming plain CE restrictions. Start as a thin TypeScript companion to Overleaf Workshop and LaTeX Workshop. Workshop is AGPL-3.0; prefer existing extension interfaces, and resolve licensing before copying implementation code. Reuse LaTeX Workshop and installed local toolchains. Rust, custom installers and distributed compilation are deferred. Each window explicitly chooses local or connected use; local sessions make no server contact. Targets are Windows x64 and Intel/Apple Silicon macOS.

The added value is safe offline recovery, per-window Local/Connect choice and no silent overwrite. R0 probes cookie login and pins an actually tested server/version matrix. R1 must reproduce local edits + remote change + reconnect without losing any candidate or sending remote writes. R4–R7 stay optional and need a concrete use.

The current rolling release is a **planning prerelease** containing documentation, license, phase status, source archive and checksums. The planning builder cannot produce application releases. R0 must add real VSIX packaging and installed-host checks. Marketplace publication is not enabled.

Repository checks (Node 22, no npm runtime dependencies yet):

```sh
npm ci
npm run typecheck
npm test
npm run validate
npm run build
npm run test:package
```

Build from committed inputs, optionally in an isolated temporary Git snapshot for local verification. These commands check the current tooling, not future application behavior.

**Proprietary — all rights reserved.** See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
