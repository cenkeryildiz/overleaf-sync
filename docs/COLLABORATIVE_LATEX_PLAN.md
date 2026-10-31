# Collaborative LaTeX — Incremental Release Plan

Design revision: 24 October 2026. This is a delivery plan, not implemented functionality.

## 1. Product and boundaries

Build a Windows/macOS VS Code extension for native LaTeX editing, with an explicit per-window choice of **Local only** or **Connect to server**. Connected collaborators use one independent, self-hosted Overleaf CE+ server and its unchanged browser UI, with individual accounts. No Premium account dependency, server patches or upstream fork.

Preserve local work, original assets, review identities and server permissions. Never silently overwrite divergent content or advertise a transport acknowledgement as a confirmed edit. Unsupported operations remain held/read-only or open the browser with a clear explanation.

Targets: Windows x64, Intel macOS and Apple Silicon macOS. Remote SSH, WSL, containers, browser VS Code and Windows ARM64 are deferred. The project remains proprietary; retain LICENSE, third-party notices and provenance for incorporated dependencies.

## 2. Release strategy

Each phase R0–R7 produces a usable, independently releasable increment. A release needs its own gates and completed prerequisites, not the entire roadmap. Version numbers below are intended feature milestones, not promised dates. Patch releases fix defects within an already delivered scope.

| Phase / version | What the user receives | Deliberately deferred |
|---|---|---|
| R0 / 0.1 | Installable local LaTeX companion: local session, existing toolchain detection, compile/PDF commands through LaTeX Workshop; early feasibility findings | Server connection and custom installers |
| R1 / 0.2 | Login, project selection and a safe read-only local mirror; browser link for collaboration | Remote writes |
| R2 / 0.3 | Concurrent native text editing for proven document formats, durable pending edits and safe reconnect | Offline automatic replay, review actions, tree mutations |
| R3 / 0.4 | Offline editing/reconciliation and recovery workflow, sleep/restart handling | Broad review and project-management UI |
| R4 / 0.5 | Comments/tracked-change tools and presence for supported server capabilities | Distributed compilation |
| R5 / 0.6 | Bibliography/assets, explicit file operations, supported history/settings and SyncTeX integration | Custom toolchain installation and compute pool |
| R6 / 0.7 | Dedicated server compilation and a supported small-team server deployment/backup bundle | Multi-worker scheduling |
| R7 / 0.8 | Optional compile pool, cache and failover, if measured demand justifies it | No obligation to implement unused scaling features |

All releases retain earlier supported behavior. Early versions can be supported releases within their stated scope; “production” does not mean full Overleaf parity. A failed probe can reduce a documented capability, never justify an unsafe write or a false passing feature gate.

## 3. First work: feasibility before substantial implementation

R0 starts with disposable-project probes against one pinned CE+ image/source revision. Do these before building a custom synchronization engine, elaborate UI, recovery platform or coordinator. Prefer short executable experiments and sanitized traces over extensive framework construction. Use upstream source and independently read server/browser state as the oracle.

| Priority | Experiment | Decision before larger work |
|---|---|---|
| 1 | Authenticate distinct accounts; discover actual wire framing, document formats, versions, join/catch-up and permission revocation | Can an unchanged server support a narrow client? Which formats/routes work? |
| 2 | Two clients plus browser: simultaneous insert/delete, Unicode, comments, tracked insertions and hidden deletions; compare authoritative text and review IDs/authorship/anchors | Is the existing upstream JS/TS OT/review implementation reusable? Which documents can safely be edited? |
| 3 | Accept an operation, drop its application confirmation, reconnect with a new identity; inspect history/deduplication evidence | Can committed versus uncommitted intent be distinguished? If not, require a visible recovery hold; never blind replay |
| 4 | Force a crash before/after a minimal durable intent record and send; restart and recover the exact local candidate; race a remote patch with local typing | Is the proposed write/recovery boundary viable before a full journal and editor bridge are built? |
| 5 | Probe server capabilities for presence/review actions, conditional asset replacement and configuration-only separate CLSI routing | Which later features are available, require browser/one-way fallback, or cannot proceed? |

The first three experiments are the critical path. Keep priority 5 to capability probes, not implementations or load testing. Record source/image IDs, commands, observed outcome and feature consequence in the R0 report. Distinguish supported, unsupported and inconclusive; an unavailable probe stays unresolved. A negative conclusive result is a completed feasibility investigation, not a passing live-editing test.

Before continuing beyond the probes, record a go/no-go decision: reusable adapter and safe write path; reduced read-only route; or required architectural reconsideration. Stop work on a disproven feature and revise its scope before spending on dependent implementation. R0 local-only delivery can proceed after a conclusive negative result; connected releases still require their actual capability gates. Missing required probe evidence blocks R0 completion.

## 4. Implementation choices

Start with TypeScript in VS Code and reuse the pinned upstream JS/TS operation implementation where compatible. Rust is deferred until profiling identifies a specific problem that justifies a native engine. Do not build two production engines or run a language-comparison project as a prerequisite.

Use an extension-owned process initially. Enforce one editing owner per linked project on a machine; a second window is an observer or explicitly takes ownership after reconciliation. Do not build a shared daemon/lease system until a demonstrated need requires it. Closing the client never stops the independent server. Client-owned children must terminate on shutdown/crash recovery.

Choose a maintained transactional local store before R2, verifying durability, supported platforms and packaging with the minimal crash experiment. SQLite is the preferred starting point, not a reason to introduce Rust. Record the selected binding, bundled version, license and durability settings. Avoid a large upfront package inventory; add locked dependencies when their release needs them.

| Area | Intended location | Introduced |
|---|---|---|
| Activation, session choice, configuration | `src/extension.ts`, `src/config.ts` | R0 |
| Local compilation integration | `src/compile/*` | R0; extended R6 |
| Login, server adapter, capability records | `src/server/*`, `test/fixtures/protocol/*` | R0 probes / R1 runtime |
| Safe hydration and file mapping | `src/mirror/*` | R1 |
| Text/review operations and editor bridge | `src/sync/*`, `src/documents.ts` | R2 |
| Journal, pending intents, recovery | `src/store/*`, `src/recovery/*` | R2; extended R3 |
| Review and presence | `src/review/*`, `src/views/*` | R4 |
| Explicit assets/tree/history operations | `src/project/*` | R5 |
| Deployment and server compilation | `server/*` | R6 |
| Optional scheduler and workers | `coordinator/*`, `worker/*` | R7 only |
| Actual tests and evidence | `test/*`, `docs/validation/phase-RN/*` | With owning feature |

These are intended paths, not existing implementation claims. Keep user settings short and limited to genuine choices; internal queue sizes, RPC details and algorithm knobs belong in code.

## 5. Session and server contract

Local only performs local editing/compilation and cached viewing without server contact, presence or shared jobs. Connect to server authenticates the selected endpoint/account and reconciles local divergence before any send. R0 exposes only the usable local path; connection becomes available with R1.

Pin the actual server image/source and supported deployment combination. Individual credentials belong in VS Code SecretStorage scoped to normalized origin/account. Reject cross-origin credential forwarding. Recheck permissions after reconnect and when revoked; retain local edits when access ends. Use TLS for deployed connections, bounded messages/queues and validated project paths. Keep databases and internal compiler/control endpoints private.

R1 uses disposable development staging and documents the connection prerequisites. It does not require a production deployment platform. R6 supplies the supported production deployment bundle; administrators may supply an existing compatible server for earlier connected releases.

## 6. Minimum safety before live writes

The hub owns confirmed shared state. The journal preserves outstanding local intent. Neither overwrites the other just because a connection resumes.

Before R2 remote sends, persist document/account identities, exact operation, base/version, tracking decision and stable local operation ID. Persist confirmation and advancement of the confirmed base atomically. Separate captured, durable, submitted, confirmed, ambiguous and held states. On storage failure, stop sends and stop claiming durability; keep the editor content and report the problem.

Resolve at most one submitted unresolved operation per document before dependent work. Prove confirmation, catch-up and deduplication against the pinned server. After a lost confirmation, use authoritative evidence; text equality alone is insufficient. If evidence has expired or cannot distinguish the outcome, preserve the candidate and hold it for resolution. R2 detects disconnects and holds unsent work; R3 adds deliberate offline/rebase workflows. Basic crash safety is mandatory in R2.

Use the upstream format's apply/transform/review semantics. Verify UTF-16 coordinates, emoji, combining marks, Turkish text, line endings and boundary edits. Never infer hidden tracked deletions from visible text. Preserve IDs, authorship, anchors and legitimate metadata transformations; counts alone are insufficient. R2 need not expose review actions, but it must preserve existing review state. Restrict unsupported documents before writes; do not classify them as safe from a stale or text-only observation.

Apply remote changes against the expected editor revision. Suppress only the observed echo of that exact patch, never “the next edit.” Exercise undo/redo, IME, multi-cursor edits and format-on-save in the real host. A second local editor must not silently replace the owner buffer. Preserve dirty buffer, disk and remote candidates on divergence.

Never infer a remote delete/rename from a missing local file. Reject path escapes, symlink/reparse escapes and case collisions. Closed-file writes use temporary files and supported atomic replacement, with recoverable prior content and a declared single-writer boundary. Arbitrary external programs do not provide universal file compare-and-swap; uncertainty causes a hold. Mirror into a dedicated folder and never overwrite an existing user folder without reconciliation.

## 7. Compilation and project inputs

R0 delegates recipes, PDF viewing and diagnostics to existing LaTeX Workshop/toolchains. Detect installed TeX and latexmk; missing dependencies receive actionable status. No automatic distribution/package installer is required. Local source remains usable when compilation fails. Do not silently install packages or external tools.

R5 preserves `.bib` text, keys, comments and order, original figure bytes, plot data and custom styles. Include PDF figures when they are source inputs; exclude generated outputs by role/path. Do not run figure generators. Delegate BibTeX/Biber recipes and SyncTeX where the existing integration suffices.

R6 uses a separate, restricted CLSI/compiler service; synchronization services never execute TeX. First ship one compatible dedicated worker and configuration-only routing established by the early probe. Preserve requester/project/build identities, bound jobs and clean build directories. Keep secrets outside the TeX job and enforce timeout, path and process limits. Capture the source generation and label stale PDFs. Probe actual browser refresh behavior; do not promise cross-user refresh without evidence.

R7 is demand-driven. First measure queue wait and compile contention on R6. Only then add authenticated scheduling, project-scoped cache, worker compatibility, leases and failover. Validate signed/authorized results if untrusted worker transport requires them. Never enable client CPU contribution without an explicit choice. A pool distributes independent jobs; it does not inherently speed up a single TeX run.

## 8. Proportionate testing policy

Keep tests that establish feasibility, prevent source/review loss, or verify shipped behavior. Run focused checks while developing and the affected regression suite before release. Reuse R0 fixtures in later feature tests; do not rebuild the same oracle or repeat every exploratory experiment unchanged at each phase.

- R0 gets the critical server/OT/ambiguity/crash probes first, plus installed local startup/build checks.
- R1 adds authentication, revocation, path safety, reconnect and divergent-file mirror checks.
- R2 adds real-server concurrent editing and review-fidelity tests, dropped/duplicate messages, crash/journal failpoints, storage failures and real-host edit races.
- R3 adds offline/rebase, restart/sleep, expired history and recovery conflicts.
- R4–R7 add tests only for the features they introduce and affected earlier behavior.

For each distributable release, install the actual VSIX on declared targets and exercise the changed workflow. Use one representative realistic project and a larger fixture where size affects the change. Measure startup/typing/queue behavior when that path changes; investigate visible regressions against the recorded baseline. Set numeric budgets only after measuring the supported workload/hardware. An artificial timing threshold on a shared CI runner is not an automatic blocker.

Removed requirements: fixed 50-gate quotas and tiers, blanket security/performance reruns in every phase, obligatory separate reviewer at fixed phases, fixed scenario counts, mandatory fuzz/benchmark frameworks, dual-engine benchmarking, PGO/LTO tuning, dedicated daemon/RPC security infrastructure before it exists, strict synthetic CPU profiles, eight-hour load runs and a mandatory 48–72-hour pilot. Security checks remain attached to actual authentication, paths, persistence, compilation and distribution boundaries. Use a short multi-user session before the first live release; extend load/soak testing only for an observed failure or an explicit deployment workload.

Do not remove a regression that guards a real defect to make a release pass. No skipped/mocked-only check can satisfy a gate needing a real server or installed host. Fix defects before advancing; a missing required environment remains missing evidence.

## 9. Delivery order and release gates

The table below is the sole machine-parsed gate registry. Each criterion is scoped to its owning release. Earlier safety tests run again when the changed code can invalidate them. `RELEASE-CHECK` applies to every release; it is one reusable packaging/changed-workflow check, not a duplicate full certification program.

<!-- gate-index:start -->
| Rank | Category | Gate | Phase | Acceptance |
|---|---|---|---|---|
| 1 | feasibility | `R0-FEASIBILITY` | R0 | Run all five early probe groups; save pinned source/server evidence, supported/unsupported conclusions and go/no-go decisions before substantial feature work; unresolved required probes block completion. |
| 2 | local | `R0-LOCAL` | R0 | Actual installed extension offers local-only editing/build/PDF integration on declared targets without contacting a server; missing TeX and compile failure preserve usable source. |
| 3 | mirror | `R1-MIRROR` | R1 | Real server login, project hydration and reconnect work; credentials, permissions, divergent content, path escapes and case collisions are handled without overwrite or remote mutations. |
| 4 | fidelity | `R2-LIVE` | R2 | Supported formats pass pinned-server concurrent text/review differential tests, Unicode and installed-host edit races; unknown formats/review interactions block writes before submission. |
| 5 | durability | `R2-RECOVERY` | R2 | Persist before send, atomically confirm, recover crash/storage failures, retain permission-revoked work and hold lost/duplicate-confirmation ambiguity without blind replay or dropped edits. |
| 6 | offline | `R3-OFFLINE` | R3 | Offline edits survive restart/sleep; reconcile concurrent remote edits and expired history; preserve all conflict candidates with an actionable resolution workflow. |
| 7 | review | `R4-REVIEW` | R4 | Supported comment/change actions preserve IDs, authorship, hidden deletion content and permissions; presence coordinates survive edits; unsupported actions open browser or remain held. |
| 8 | project | `R5-PROJECT` | R5 | Bibliography/assets retain source fidelity; ID-based tree operations and conditional replacement handle conflicts; history/settings/SyncTeX work where supported with visible fallbacks. |
| 9 | server | `R6-SERVER` | R6 | Dedicated compiler routing, cancellation, source/PDF identity and job isolation work; deployed TLS/private endpoints, backup restore and upgrade rollback are exercised on staging. |
| 10 | scale | `R7-POOL` | R7 | Measured R6 demand justifies pool; authorized compatible workers, project cache isolation, bounded queues and failover pass representative concurrent-job tests without harming editing. |
| 11 | release | `RELEASE-CHECK` | R0, R1, R2, R3, R4, R5, R6, R7 | Run affected regressions, install actual artifacts on declared Windows/macOS targets, exercise changed workflow and verify exact source/hash/download provenance plus supported rollback. |
<!-- gate-index:end -->

### Phase R0 — Feasibility and local companion / 0.1

Run section 3 first; record hard limits and adapter/store decisions. Then implement only local session/configuration, toolchain detection and existing compile/PDF integration. Add real VSIX packaging and native installation checks now. Exit: R0 gates pass; publishable local companion, with connected features visibly unavailable. No custom engine or installer.

### Phase R1 — Read-only server mirror / 0.2

Implement individual login, project picker, safe hydration, read-only review display where available and browser handoff. Use the pinned server and dedicated mirror folder. Exit: R1 gates pass; usable connected viewing without remote writes. Do not wait for the write journal or full OT engine to ship this release.

### Phase R2 — Safe live text editing / 0.3

Reuse the proven operation adapter; build the minimal durable outbox and revision-bound editor bridge. Support only proven document formats/review interactions. Include baseline crash, revoke and ambiguous-send handling before the first write. Exit: R2 gates pass and a short Windows/Mac/browser co-edit session preserves authoritative source and review state. A failed fidelity proof blocks live delivery; read-only releases remain available.

### Phase R3 — Offline work and recovery / 0.4

Extend R2 with offline capture, reconcile/rebase, recovery inspection and conflict choices. Exercise restart, sleep, history expiry, server restart and dirty buffer/disk divergence. Exit: R3 gates pass; deliberate offline editing can recover without silent overwrites. Do not weaken R2's baseline durability to defer it here.

### Phase R4 — Review and presence / 0.5

Add supported comment threads, tracking controls/change actions and remote carets. Retain browser fallbacks when server capability is absent. Exit: R4 gates pass; review UI and permissions match observed upstream semantics. Chat is optional future scope, not a release blocker.

### Phase R5 — Project workflow / 0.6

Add explicit tree/upload commands, safe asset replacement, bibliography/source input handling and supported history/settings. Integrate existing SyncTeX support. Two-way binary replacement requires demonstrated conditional-write safety; otherwise ship one-way mirroring and browser upload. Exit: R5 gates pass; supported project workflows work without altering original sources. No custom TeX/package installer.

### Phase R6 — Server compilation and operations / 0.7

Deliver one dedicated server compiler and pinned server deployment configuration. Add TLS/private endpoints, job limits/cleanup, backups with isolated restore, upgrade/rollback and administrator instructions. Measure editing responsiveness during representative compile load. Exit: R6 gates pass on staging; no requirement for a scheduler or multi-worker pool. Backup cadence explicitly determines acceptable unbacked-up state; a daily backup permits up to 24 hours of loss after server failure.

### Phase R7 — Optional shared compilation / 0.8

Start only when R6 measurements and actual usage justify distribution. Add minimal queue/cache/worker scheduling and failure recovery; client contribution is opt-in. Exit: R7 gates pass for the declared deployment workload. If no need exists, leave R7 not_started; R0–R6 releases remain valid and releasable.

## 10. Status, publication and evidence

Current status: plan and repository/release tooling only. No extension, server deployment, coordinator or pool is implemented. All R0–R7 phases remain `not_started`. This revision authorizes planning/tooling changes only, not application implementation or deployment.

`docs/phase-status.json` schema 3 retains eight ordered phase records and adds `releasePhase`: null for planning/development, or the target R0–R7 for candidate/production. Candidate and production require all gates through that target, not later features. Planning permits no passed application phases. A phase may pass only with actual recorded evidence. Reopen invalidated phases and dependent implementation status; retain historical evidence and previous known-good artifacts.

Each passed phase references one report with the tested commit, time, blocking-defect count and its gate results. Each result includes the executed command/environment and hashed sanitized log. Reuse existing fixtures and concise evidence; no duplicate status document, mandatory screenshots or large prose dossiers. Record capability decisions in R0's report and update them when probes change.

Current CI/build/publisher continue to produce planning assets only and must not claim application readiness. R0 must extend the actual pipeline to build/test/install real target VSIXs, verify the exact source and checksums, and support candidate and immutable versioned releases. CI remains a publication prerequisite; do not activate Marketplace publishing without explicit authorization. A schema change alone never enables application publication.

For each release, keep a known-good VSIX and state backup. Exercise upgrades and rollback for state/schema changes; never erase newer local intent to downgrade. Reopening or invalidating an earlier gate requires reevaluating dependent release claims. Production deployment values belong to the administrator; keep synthetic tests isolated and do not touch user projects or unrelated containers.
