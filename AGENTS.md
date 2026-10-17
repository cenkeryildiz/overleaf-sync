# Repository instructions

Read and follow the full applicable global, parent-directory and repository instruction chain before acting. Delegated agents must do the same before starting work.

- The authoritative plan is `docs/COLLABORATIVE_LATEX_PLAN.md`. Implement only the active authorized phase in section 17.
- There are exactly eight phases, R0–R7. Finish implementation, tests, repairs and evidence for the current phase before starting the next. Do not ask the user to perform routine tests or approve routine successful phase transitions.
- Keep `docs/phase-status.json` accurate. Never mark a phase passed for mocked, skipped, unavailable or unexecuted required checks. Reopen an invalidated phase and reset its dependents.
- Preserve native Windows/macOS behavior, review metadata, local edits and server identities. Do not introduce a Premium-account dependency.
- Repository setup is not R0 completion. Planning releases contain no working extension. Extend the actual build/test pipeline before publishing any VSIX; never create passing placeholder application tests.
- Maintain the existing LICENSE, THIRD_PARTY_NOTICES.md and dependency inventory.
- Before edits, inspect the affected context and define a scoped change and validation approach. Do not modify adjacent projects.
- Run `npm ci`, `npm run typecheck`, `npm test`, `npm run validate`, `npm run build`, and `npm run test:package` for repository/release changes. Build/package requires a commit containing the intended inputs. Application phases must add and run their own actual tests.
- Keep release publication gated on CI and verify downloaded assets, source commit and checksums. Do not publish to the VS Code Marketplace without explicit authorization.

- Follow Stage D fast/strict/compile profiles and separate Stage N sync/compile resources. Keep CE+ and its web UI unmodified; use synthetic test data and isolated heavy runners.
- Every phase requires SEC-REGRESSION and PERF-REGRESSION. Independent review applies only to R1, R4 and R7. The plan ranked gate index is authoritative. Native security runners are required from R0.
- Keep all design, assumptions, ranked gates and implementation status in the same plan Markdown file; do not create a separate STATUS.md.
