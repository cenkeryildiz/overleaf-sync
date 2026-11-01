# Phase evidence

All application phases remain unpassed. Do not fabricate sample passing reports.

A passed phase references `docs/validation/phase-RN/report.json` in the schema-3 phase state. Reports contain `phase`, `result: passed`, tested `sourceCommit`, ISO `testedAt`, zero `blockingDefects` and `checks` covering the plan's gate table for that phase.

Each check records `id`, `result: passed`, `skipped: false`, the actual `command`, `environment`, and a sanitized nonempty `log` beneath the phase directory with its `sha256`. Repeat a gate for native targets as needed. A report indexes real evidence; it cannot replace actual server or installed-host checks.

R0 feasibility evidence records supported, unsupported or inconclusive outcomes and the resulting go/no-go decision. A conclusive negative capability probe may complete the investigation, but never passes a dependent live-feature gate. Missing required local/read/auth/version evidence blocks its gate. An explicitly unresolved live-only proof holds R2 without blocking a proven R0/R1 scope; it is never recorded as a passing live test. Include the actual CE+ distribution/image/version/cookie capability matrix, review result and R1 local-buffer/disk + remote-change + reconnect regression; redact all cookies.

Keep reports concise. Reuse early fixtures and run affected regressions; no blanket security/performance gates, fixed scenario counts or mandatory multi-day runs. `RELEASE-CHECK` covers actual artifacts and the changed workflow for each release.

State `releasePhase` is null for planning/development and R0–R7 for candidate/production. Releases require passed prerequisites through that target. Earlier increments do not wait for later ones. Preserve historical evidence when reopening a phase, reset dependents and reevaluate release claims.

## Planning revision verification — 1 November 2026

In a temporary checkout outside Kod, `npm ci`, `npm run typecheck`, `npm test`
(17 passed), `npm run validate`, `npm run build` and `npm run test:package` passed.
The build reopened/verified six planning assets from committed source. The gate-
assignment regression now identifies `R1-MIRROR` by gate ID rather than old prose.
No VSIX, live CE+/Workshop/auth/review experiment, deployment or publication was
performed; all application phases remain `not_started`.
