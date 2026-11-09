# Collaborative LaTeX / Overleaf Sync

[![Build and release](https://github.com/cenkeryildiz/overleaf-sync/actions/workflows/build.yml/badge.svg)](https://github.com/cenkeryildiz/overleaf-sync/actions/workflows/build.yml)

Planned self-hosted collaborative LaTeX **web application** for browser use on Windows/macOS, retaining nearly all capabilities of the selected CE+, Overleaf Workshop and LaTeX Workshop repositories and adding safe local/offline recovery, explicit Local only / Connect to server sessions, and multi-user server job distribution. No VS Code extension or Premium account is required.

**Current status: planning/tooling only. No working web application is delivered by this repository.**

- [Authoritative plan and capability contract](docs/COLLABORATIVE_LATEX_PLAN.md)
- [Upstream capability inventory and early discovery](docs/COLLABORATIVE_LATEX_PLAN.md#3-capability-baseline-and-discovery)
- [Required shared job distribution](docs/COLLABORATIVE_LATEX_PLAN.md#5-compilation-and-required-shared-job-distribution)
- [Release order and gates](docs/COLLABORATIVE_LATEX_PLAN.md#9-release-gates-and-phase-execution)
- [Machine-readable phase status](docs/phase-status.json)
- [Rolling planning prerelease](https://github.com/cenkeryildiz/overleaf-sync/releases/tag/latest)
- [Release contract](docs/RELEASE.md)

Use [yu-i-i/overleaf-cep](https://github.com/yu-i-i/overleaf-cep) as the intended web/server foundation. Reuse its editor, collaboration, review, project and compilation machinery. Workshop repositories supply capability references and potentially reusable components; extension APIs do not automatically run in browsers. Useful extension-only features require web equivalents. Exact licensing, browser/local-file support and integration paths remain discovery prerequisites.

Reuse reduces implementation effort, not product scope. No feature is silently removed or made optional. Record every upstream capability as inherited, requiring integration, deferred to a phase, blocked, or excluded by explicit user decision. A read-only early release is not completion of live editing or review. External integrations remain available/configurable without authorizing account linking, data transfers or paid use.

| Phase / version | Useful increment |
|---|---|
| R0 / 0.1 | Web foundation, local-workspace and capability/scheduling feasibility |
| R1 / 0.2 | Protected authenticated server project access |
| R2 / 0.3 | Safe browser live editing and durable recovery |
| R3 / 0.4 | Offline web workspace and reconciliation |
| R4 / 0.5 | Review, presence and chat |
| R5 / 0.6 | Web editing aids, project workflows and upstream integrations |
| R6 / 0.7 | Shared server compilation, administration and backup/restore |
| R7 / 0.8 | Required multi-user job distribution, fairness and worker recovery |

Earlier accurately labelled partial releases need their own gates and prerequisites; later required phases remain part of complete-project acceptance. Local only must avoid remote-server contact. A possible loopback helper for local files/compilation is unresolved and must be justified by browser feasibility checks. Rust is intended for missing custom backend functions; reuse browser editor/engine code in its existing language.

The existing builder produces **planning assets only**, not a web application or VSIX. All application phases remain unstarted. The archived extension-based experiment is historical evidence, not the delivery architecture or browser acceptance. R0 must implement actual web/service packaging, browser smoke checks and rollback. No deployment or release is authorized by this documentation revision.

Repository checks (Node 22; committed tests can be retrieved into a temporary checkout outside Kod):

```sh
npm ci
npm run typecheck
npm test
npm run validate
npm run build
npm run test:package
```

Build from a clean committed snapshot. These commands verify planning/tooling consistency, not application behavior.
