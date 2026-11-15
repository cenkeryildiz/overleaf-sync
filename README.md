# Collaborative LaTeX / Overleaf Sync

[![Build and release](https://github.com/cenkeryildiz/overleaf-sync/actions/workflows/build.yml/badge.svg)](https://github.com/cenkeryildiz/overleaf-sync/actions/workflows/build.yml)

Planned self-hosted collaborative LaTeX **web application** for browser use on Windows/macOS, retaining nearly all capabilities of the selected CE+, Overleaf Workshop and LaTeX Workshop repositories and adding safe local/offline recovery, explicit Local only / Connect to server sessions, and multi-user server job distribution. No VS Code extension or Premium account is required.

**Current status: R0 is in progress. A separately configured local CE+ instance has passed a synthetic browser import/edit/compile/share/export check. This repository does not yet deliver a distributable web application.**

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

The existing builder produces **planning assets only**, not a web application or VSIX. No application phase has passed; R0 is in progress. The archived extension-based experiment is historical evidence, not the delivery architecture or browser acceptance. R0 must implement actual web/service packaging, browser smoke checks and rollback. No deployment or release is authorized by this documentation revision.

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

Free-account projects can be transferred through source ZIP download/upload; Premium Git access is not required. ZIP imports are separate projects, and returning changes to the original shared online project needs deliberate file updates and conflict review. Central login will use an external identity provider; project identities/permissions remain local, but collaborators need not give this application their provider passwords. External login is not activated.

The opt-in live browser check is `test/browser/free-account.mjs` (retrieve it into a temporary checkout). It requires the existing synthetic Alice/Bob accounts, their passwords supplied privately as `OVERLEAF_TEST_ALICE_PASSWORD` and `OVERLEAF_TEST_BOB_PASSWORD`, and an installed Playwright runtime. Run `PLAYWRIGHT_MODULE=/absolute/path/to/playwright CHROME_PATH=/absolute/path/to/chrome node test/browser/free-account.mjs` on macOS. It creates a uniquely named synthetic project and reports its URL for scoped cleanup; it never uses real Overleaf accounts, imports browser cookies, exposes a port or uploads to overleaf.com. Page traffic is restricted to loopback; server/container egress is unchanged.

The approved [CE+ identity/logout patch](integrations/ce-plus-oidc/README.md) is installed on the local instance. It validates verified provider identities, prevents replacing an existing linked identity, and logs out locally without provider tokens in redirect URLs. It remains inactive for Google until a web OAuth client is registered and its credentials are supplied privately. These two upstream-derived files retain AGPL-3.0-only licensing.

The local setup also includes the [required TeX package image](runtime/texlive-course/README.md) and [faster collaboration/preview overlay](runtime/fast-preview/README.md). Existing editor tabs need a hard reload; choose Auto compile → On if that project previously saved Off. Local comparison: shared-text p95 143 → 50 ms, plain-PDF median 1.00 → 0.82 seconds; plain-PDF tail latency stayed near 1.07 seconds. These are small local samples, not instantaneous or remote-performance guarantees. Non-BMP characters (including emoji) remain unsupported by the pinned upstream editor/history path.

FAST-02 same-machine comparison: overlapping-pair arrival p95 44 → 27 ms (32 pairs/profile), sustained 204-character streams 1,329/1,314 ms, and native outgoing edit frames 168 → 215 (+28%) for the complete identical workload. This is a latency/traffic tradeoff, not proven throughput/memory improvement. Input→send/peer receipt samples were 21.0/36.7 ms before and 10.5/27.1 ms after. Both profiles passed convergence, per-user undo/redo, cross-user review/chat, simultaneous PDFs, history/reload and exact synthetic job-group loss/failure/retry. Peak memory, large-project throughput and internet latency remain unmeasured.

[Browser recovery and Local only](runtime/browser-recovery/README.md) adds durable per-tab text candidates and a cached local document workspace. Explicit Connect reads the shared project without applying local candidates automatically. Copies stay in this browser profile until deleted; offline assets/PDF/compile and complete review reconciliation remain unfinished.
