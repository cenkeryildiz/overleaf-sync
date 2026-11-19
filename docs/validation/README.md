# Phase evidence

R0–R2 are verified for the declared offline Chrome/macOS arm64 target; see their actual browser/artifact reports. R3–R7 remain unpassed. Do not fabricate sample passing reports.

A passed phase references `docs/validation/phase-RN/report.json` in the schema-3 phase state. Reports contain `phase`, `result: passed`, tested `sourceCommit`, ISO `testedAt`, zero `blockingDefects` and `checks` covering the plan's gate table for that phase.

Each check records `id`, `result: passed`, `skipped: false`, the actual `command`, `environment`, and a sanitized nonempty `log` beneath the phase directory with its `sha256`. Repeat a gate for declared browsers/hosts as needed. A report indexes real evidence; it cannot replace actual browser, server or worker checks. Earlier VS Code extension experiment results are historical, not web acceptance; the current standalone Chrome delivery is exercised as an actual browser application.

R0–R2 follow the current offline-only stage1 gate table: native create/import/edit/autocompile/current PDF/export, exact transactional integrity/recovery, installable artifact, provenance/license/security checks and declared device limits. Missing system TeX or a native connector must not block this workflow. Online authentication, upstream review/remote-change reconciliation, LAN transport and scheduler/contributor proof belong to the later stages that own them; prior server-first descriptions do not add those prerequisites to the current offline release. Actual source/image/browser identities and unqualified targets stay explicit. A conclusive negative probe never passes its dependent live gate. R7 still requires actual multi-user fairness, capacity, worker-loss/restart and result-ownership evidence. Redact all credentials/session cookies.

Keep reports concise. Reuse early fixtures and run affected regressions; no blanket security/performance gates, fixed scenario counts or mandatory multi-day runs. `RELEASE-CHECK` covers actual artifacts and the changed workflow for each release.

State `releasePhase` is null for planning/development and R0–R7 for candidate/production. Releases require passed prerequisites through that target. Earlier increments do not wait for later ones. Preserve historical evidence when reopening a phase, reset dependents and reevaluate release claims.

## Planning revision verification — 1 November 2026

In a temporary checkout outside Kod, `npm ci`, `npm run typecheck`, `npm test`
(17 passed), `npm run validate`, `npm run build` and `npm run test:package` passed.
The build reopened/verified six planning assets from committed source. The gate-
assignment regression now identifies `R1-MIRROR` by gate ID rather than old prose.
No VSIX, live CE+/Workshop/auth/review experiment, deployment or publication was
performed; all application phases remain `not_started`.
