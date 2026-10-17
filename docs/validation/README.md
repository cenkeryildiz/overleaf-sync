# Phase evidence

All application phases start unpassed. Do not add fabricated sample passing reports.

A passed phase must reference `docs/validation/phase-RN/report.json` from `docs/phase-status.json`. The report contains:

- `phase`: the phase ID, R0 through R7; `result`: `passed`.
- `sourceCommit`: the full commit actually tested; `testedAt`: an ISO timestamp.
- `blockingDefects`: zero.
- `checks`: results covering every mandatory gate ID in plan section 17. Each includes `id`, `result: passed`, `skipped: false`, the actual `command`, `environment`, and `log` path beneath that phase's evidence directory.

Logs must be committed synthetic/redacted evidence, with a `sha256` field in each check. Include independent observations and artifact/server hashes in the report and supporting files. Repeat a gate ID for separate native platforms when needed. A JSON report is an index to real testing, not a replacement for it.

An unavailable required runner, environment or test blocks the current phase. Preserve old reports when reopening a phase; reset dependent phases before advancing again. CI checks sequence, required gate coverage and log integrity. Application CI must also execute the actual tests before publication.

State schema 2 requires eight ordered phases. The ranked gate index in the plan is parsed directly by validation. Every phase requires SEC-REGRESSION and PERF-REGRESSION; INDEPENDENT-REVIEW applies only to R1, R4 and R7. Native R0 security checks cannot wait until packaging. Review logs identify the separate review pass, tested commit and independent upstream/server evidence.

Use `development` while implementation has passed gates but has no distributable candidate; `candidate` requires R0–R4. `planning` is reserved for zero passed application phases. Reopening an earlier phase resets all dependents and can require downgrading the release stage.
