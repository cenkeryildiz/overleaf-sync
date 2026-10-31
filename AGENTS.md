# Repository instructions

Read and follow the full applicable global, parent-directory and repository instruction chain before acting. Delegated agents must do the same before starting work.

- The authoritative plan is `docs/COLLABORATIVE_LATEX_PLAN.md`; release definitions and gates are in section 9. Implement only the active authorized scope. The current revision authorizes planning/tooling changes, not application implementation.
- R0–R7 are eight incremental releases. Finish the current phase's scoped implementation and actual checks before advancing; do not wait for later features to release an earlier usable increment. Do not ask for routine successful phase transitions.
- Run R0's feasibility experiments before substantial feature work. A conclusive unsupported result documents a limitation, not a passing live-feature test. Stop dependent feature work when its premise fails.
- Keep schema-3 `docs/phase-status.json` accurate. Candidate/production target `releasePhase` and require passed prerequisites through that phase, not the whole roadmap. Never pass mocked-only, skipped, unavailable or unexecuted required checks. Reopen invalidated phases and reset dependents.
- Preserve native Windows/macOS behavior, review metadata, local edits and server identities. No Premium dependency. Keep CE+ and its web UI unmodified. Use disposable synthetic projects for mutation tests.
- Add only tests for actual capabilities, relevant failure boundaries and affected regressions. No fixed test counts, blanket performance/security certifications, mandatory multi-day pilots or dual-engine benchmarks. The plan gate table is authoritative. Do not remove regressions guarding actual defects.
- Start with TypeScript and reusable upstream operation code. Rust, a shared daemon, custom installers and distributed compilation are not early-release prerequisites.
- Planning assets contain no working extension. R0 adds the actual VSIX build/install pipeline before application distribution; never create passing placeholder application checks.
- Maintain LICENSE, THIRD_PARTY_NOTICES.md and the inventory of dependencies actually introduced.
- Before edits, inspect affected context and define scoped changes and validation. Do not modify adjacent projects.
- Run `npm ci`, `npm run typecheck`, `npm test`, `npm run validate`, `npm run build`, and `npm run test:package` for repository/release changes. Build/package requires a commit containing the intended inputs; an isolated temporary Git snapshot is acceptable for local verification without committing the working checkout. Application phases add their actual tests.
- Keep publication gated on CI and verify downloaded assets/source/checksums. No Marketplace publication without explicit authorization.
- Keep design, assumptions, release gates and implementation status in the plan; do not create a separate STATUS.md. Evidence reports support the plan rather than duplicating it.
