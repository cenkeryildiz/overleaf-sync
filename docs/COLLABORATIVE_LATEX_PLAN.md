# Collaborative LaTeX — Incremental Release Plan

Design revision: 3 November 2026. Planning/tooling only; no application or deployment is implemented.

## 1. Product and boundaries

Build a small Windows/macOS VS Code companion around existing tools. Its added value over Overleaf Workshop is **safe offline recovery, an explicit per-window Local only / Connect to server choice, and no silent overwrite of local work**. Do not rebuild the server, LaTeX editor, compiler integration or collaboration protocol merely to own the whole stack.

Use the previously selected [yu-i-i/overleaf-cep, branch `ext-ce`](https://github.com/yu-i-i/overleaf-cep/tree/ext-ce), an extended Community Edition distribution, as the intended self-hosted server. Its README advertises comments and real-time tracked changes, alongside SSO methods. **CE+ is not plain CE:** do not remove review from scope solely because official CE lacks it. Pin and probe the actual CE+ build. Keep that chosen distribution and its browser UI unmodified; no new server patches, fork maintained by us, or Premium-account dependency.

Reuse Overleaf Workshop for supported connection/project/protocol behavior, and LaTeX Workshop for local compile, PDF preview, diagnostics and SyncTeX. First prove a companion can use their existing interfaces safely. Workshop is AGPL-3.0; this repository is proprietary. Prefer invoking the installed extension's available commands/filesystem interfaces. Reading source and sanitized wire traces informs probes; copying or deriving implementation code requires an explicit compatible licensing decision and notices. Do not assume an upstream API exists or that a separate process resolves licensing. If safe integration is unavailable, record that R0 result and choose a smaller read-only/browser route before writing a replacement engine.

Preserve local buffers/files, original assets, review identities and permissions. Never silently overwrite divergence or mistake a transport acknowledgement for a confirmed edit. Targets remain Windows x64 and Intel/Apple Silicon macOS. Remote SSH/WSL/containers/browser VS Code, Windows ARM64, custom installers, Rust engines, shared daemons and compute pools are outside early scope.

## 2. Release strategy

R0–R7 remain independently scoped increments with the existing gate IDs and schema-3 status. **Ship R1 as soon as R0 and R1's actual gates pass; expanded R2 write/OT qualification may continue afterward.** Do not hold a useful no-write mirror for a custom outbox, review panel or full collaboration engine. No required R1 check is waived to ship early.

| Phase / version | Minimum useful delivery | Shortcut / deferred work |
|---|---|---|
| R0 / 0.1 | Local/Connect choice with only local operation enabled; existing LaTeX Workshop/toolchain integration; early capability report | No server deployment framework or custom editor/compiler |
| R1 / 0.2 | Cookie-first login, project selection, safe read-only mirror and browser handoff | No remote writes; ship independently of R2 live-readiness |
| R2 / 0.3 | Narrow live text editing through a proven reusable operation path; durable pending intent and safe reconnect | No new OT algorithm; unsupported formats/review combinations remain read-only |
| R3 / 0.4 | Recover offline candidates and offer explicit built-in diff/manual reconciliation | Automatic offline merge/replay is deferred unless upstream proves safe semantics |
| R4 / 0.5 | Optional existing review/presence integration or read-only/browser handoff, according to R0 | No custom review panel by default; chat is optional |
| R5 / 0.6 | Optional project conveniences with a demonstrated personal use | Reuse mirror files/LaTeX Workshop/browser for bibliography, assets, history, settings and tree operations |
| R6 / 0.7 | Optional small-team CE+ setup/backup instructions when deployment is actually needed | Reuse CE+ Toolkit and existing compile service; no custom coordinator or compiler service |
| R7 / 0.8 | Parked unless measured compile contention creates a concrete need | No pool/worker/cache implementation is currently scheduled |

Version numbers describe scope, not dates. Later optional phases cannot block an earlier release. Before starting R4–R7, name the user's concrete workflow and show why existing tools/browser handoff are insufficient. Otherwise defer it. The sequential status validator is unchanged: a later phase is not marked started/passed before prerequisites; exploratory findings can be recorded without claiming a phase has begun or passed.

## 3. First work: feasibility before substantial implementation

Use disposable synthetic projects against a pinned CE+ build. Reuse a pinned Overleaf Workshop revision as a debugging/reference client on that same server: compare cookie handling, project listing, socket framing, join/catch-up and local-replica behavior with the unchanged browser/server responses. Trace headers, payload identities and errors with credentials removed. Avoid constructing a protocol framework before these short probes answer the integration questions.

| Priority | Probe | Required decision |
|---|---|---|
| 1 | **Cookie login first:** logged-in browser cookie, account/project identity, logout/expiry/revocation, supported SSO/captcha browser flow; then secondary password login only where supported. Check actual distribution/version/image digest and available Workshop interfaces. | A working primary login and read path on an exact tested server. Password-only success does not prove cookie/SSO deployments work. No captcha solver or SSO reimplementation. |
| 2 | **Review capability beside the OT experiment:** on the selected CE+ build inspect comments, tracking controls, existing tracked insertions/hidden deletions, IDs/authorship/anchors and actual route/permission behavior; exercise minimal two-client-plus-browser text operations with Unicode. | Record review separately as supported, unsupported or inconclusive. CE+ advertised support is a probe premise, not acceptance. Official plain CE restrictions are a comparator, not a verdict about CE+. |
| 3 | Accept an operation, lose its application confirmation and reconnect with a new identity; inspect authoritative version/history/deduplication. | Can the reused adapter distinguish committed intent? Otherwise hold uncertain edits; never blind replay. R2 stays blocked for that write path. |
| 4 | Minimal crash-before/after-intent/send experiment and local typing raced with a remote patch. | Can the reused path preserve the exact local candidate and a proven base? Choose a small durable outbox only if writes need one; no journal platform upfront. |
| 5 | Read-only discovery of compile/preview, SyncTeX, cursor/presence, optional chat and existing browser/project operations. | Fill the reuse/defer checklist below; do not implement every available feature. |

Run the early probes before dependent feature construction. The R0 report records each executed probe's command, pinned source/image, sanitized trace, outcome and feature consequence. Missing required local/read/auth/version evidence blocks the corresponding R0/R1 gate. A conclusive absent review capability reduces scope; an inconclusive write proof stays an explicit **R2 hold**, not a passing live test. R0 local delivery and subsequently proven R1 reads do not require all expanded R2 write proofs to be green. No unexecuted required check is relabeled passed.

**R0 deliverable: tested compatibility matrix.** Record CE+ repository/source commit, image digest, server-reported base version, architecture, configuration, auth method, document format and per-feature results; pin the Workshop reference commit too. Keep planned, upstream-reported and actually tested entries distinct. Workshop's current README reports CE **3.5, 4.1, 4.2.4 and 5.0.4** (the earlier three-version list omitted 4.2.4). Those reports do not certify our CE+ target or client. Our tested list is initially empty. Unknown distribution/version/digest combinations refuse connection with a clear explanation until an explicit compatibility-probe run qualifies them; a probe is not ordinary connected use. A moving image tag is not a pin, and version discovery must not leak credentials to another origin.

| Workflow | Default reuse decision | Add our own code only for |
|---|---|---|
| Account/project access and wire protocol | Workshop's compatible existing interface; browser for SSO/captcha | Session choice, validated cookie storage/origin and a narrow adapter proven in R0 |
| Open Locally / local mirror | Use read APIs or an isolated provider only after R1's regression; never delegate an unsafe overwrite path | Own local-candidate protection, staging and explicit divergence hold |
| Compile, diagnostics and PDF preview | LaTeX Workshop locally; existing CE+ browser/server compile remotely | Routing/status needed to preserve the correct source/PDF identity |
| SyncTeX/reverse SyncTeX | LaTeX Workshop's existing commands; probe remote support in R0 | Proven project-path/source-generation mapping, not a new SyncTeX engine |
| Cursor/presence indicators | Existing Workshop/browser capability | Safe session/coordinate plumbing if it is useful and available |
| Comments/tracked changes | Existing CE+ browser or proven Workshop interface | Preservation and an explicit read-only/handoff state; custom actions only on demonstrated need |
| Chat | Existing Workshop/browser; optional | Nothing scheduled |
| Assets, bibliography, file tree, history/settings | Existing tools and browser; preserve mirrored source bytes | A specific missing workflow, separately justified in R5 |

### Upstream references for probes

- [CE+ README](https://github.com/yu-i-i/overleaf-cep/tree/ext-ce#readme) and [CE+ configuration/release wiki](https://github.com/yu-i-i/overleaf-cep/wiki): intended distribution, claimed capabilities and image configuration. Resolve and record an immutable server commit/image before testing.
- [Workshop README](https://github.com/overleaf-workshop/Overleaf-Workshop/blob/835a488a7eac760fa2d74685cf1072f95393b30d/README.md): cookie guidance, features and upstream compatibility list, inspected at this reference commit. Revalidate before changing the compatibility matrix.
- Workshop source at that same revision: `src/api/base.ts`, `src/api/extendedBase.ts`, `src/api/socketio.ts`, `src/api/socketioAlt.ts`, `src/core/remoteFileSystemProvider.ts`, `src/scm/localReplicaSCM.ts`. Use their actual server interactions to shorten probes; no new dependency/source incorporation is claimed.
- [Workshop issue #353](https://github.com/overleaf-workshop/Overleaf-Workshop/issues/353) reports intermittent local overwrite after local and remote edits. It motivates R1's reconnect regression; it is not proof that every Workshop deployment loses data or that we reproduced the bug.
- [Official edition permissions](https://docs.overleaf.com/on-premises/user-and-project-management/roles-and-permissions) distinguish plain CE from Server Pro; inspect CE+ directly rather than applying that restriction to its extensions.
- [LaTeX Workshop](https://github.com/James-Yu/LaTeX-Workshop): reuse its supported compiler, viewer and SyncTeX integration. Record the installed version and commands actually tested.

## 4. Implementation choices

### Verified reuse limits — 3 November 2026

Read-only source inspection at Workshop commit `835a488a7eac760fa2d74685cf1072f95393b30d` found the following. These are source findings, not installed-host or live-server acceptance:

| Boundary | Actual upstream behavior | Smallest safe next step |
|---|---|---|
| Extension interface | `src/extension.ts::activate` returns no API object. `src/core/remoteFileSystemProvider.ts` registers the `overleaf-workshop` filesystem and the internal `remoteFileSystem.prefetch` command, which returns a mutable VFS. | Prefer standard `workspace.fs` reads for an isolated probe; do not couple the companion to internal VFS objects or claim a supported authentication/project API. Prove activation side effects before connected use. |
| Cookie storage | `src/api/base.ts::Identity` contains cookies; `src/utils/globalStateManager.ts::loginServer` persists that identity in `context.globalState`. The cookie input in `src/core/projectManagerProvider.ts` does not request password masking. | Unmodified upstream login does not satisfy our SecretStorage/masked-input boundary. Do not delegate our login to it, import its persisted credentials or claim SecretStorage in our companion fixes upstream storage. Use browser handoff until a compatible secure adapter is proven. |
| Mirror direction | `src/scm/localReplicaSCM.ts` writes local hydration/merged content and can call `workspace.fs.writeFile` on the remote URI. The filesystem provider also exposes create/write/delete/rename. | Do not invoke Open Locally or attach its replica settings for R1. Probe read operations in a fresh disposable profile/project, preserve candidates in our staging area, and independently prove zero remote writes. Calling a read method alone is not proof of read-only session behavior. |
| Local-only activation | `package.json` activates Workshop for its URI scheme or `.overleaf/settings.json`; `activate` can initialize a saved replica. | Use a clean local-only workspace/profile without replica settings for the first isolation test. Later exercise saved-settings/restart cases explicitly; our Local only choice cannot promise to disable an independently installed extension. |

Pinned source references: [activation](https://github.com/overleaf-workshop/Overleaf-Workshop/blob/835a488a7eac760fa2d74685cf1072f95393b30d/src/extension.ts), [manifest](https://github.com/overleaf-workshop/Overleaf-Workshop/blob/835a488a7eac760fa2d74685cf1072f95393b30d/package.json), [filesystem](https://github.com/overleaf-workshop/Overleaf-Workshop/blob/835a488a7eac760fa2d74685cf1072f95393b30d/src/core/remoteFileSystemProvider.ts), [credential persistence](https://github.com/overleaf-workshop/Overleaf-Workshop/blob/835a488a7eac760fa2d74685cf1072f95393b30d/src/utils/globalStateManager.ts), [identity](https://github.com/overleaf-workshop/Overleaf-Workshop/blob/835a488a7eac760fa2d74685cf1072f95393b30d/src/api/base.ts), [login input](https://github.com/overleaf-workshop/Overleaf-Workshop/blob/835a488a7eac760fa2d74685cf1072f95393b30d/src/core/projectManagerProvider.ts), [replica](https://github.com/overleaf-workshop/Overleaf-Workshop/blob/835a488a7eac760fa2d74685cf1072f95393b30d/src/scm/localReplicaSCM.ts).

**Result:** reuse the unchanged CE+ browser and LaTeX Workshop workflows first. Workshop remains a source/protocol reference and a candidate read provider, not an accepted secure/read-only adapter. Do not respond to these limits by building another synchronization engine. No upstream source is copied, no licensing decision is made and no existing safety gate is weakened.

### Minimum implementation

Keep the first implementation TypeScript-only and as small as possible. Prefer the existing VS Code extension, editor, diff UI, filesystems and platform storage before dependencies or vendoring. Reuse only APIs/operations proven on the pinned server; a missing upstream interface triggers a scope decision rather than automatic construction of a second client.

R1 needs safe staging and a recoverable confirmed mirror, not a live-write journal. Before R2 sends, verify one maintained durable store on supported hosts; SQLite is a candidate only if an existing upstream mechanism is insufficient. No native/Rust engine, shared daemon, custom installer, dual-engine benchmark or broad package inventory is a prerequisite. One local editing owner per project is enough; another window observes or explicitly takes over after reconciliation. Client-owned children terminate on shutdown; closing a client never stops the independent server.

Intended locations only: `src/extension.ts` / `src/config.ts` (session choice), `src/server/*` (narrow auth/capability adapter), `src/mirror/*` (R1 safety), `src/sync/*` and `src/store/*` only if proven necessary for R2/R3. Add feature-specific tests with implementation. No application files or dependencies are introduced by this revision.

## 5. Session, authentication and mirror safety

Each window explicitly chooses Local only or Connect to server. Local only makes no server calls or presence/job submissions through this companion; test upstream integration for unintended activation/contact. Connected use pins one normalized origin/account and reconciles divergence before any send. R1 is read-only remotely, including reconnect, and defaults to browser handoff for collaboration.

**Cookie login is primary; password login is secondary.** Use an already authenticated browser for SSO/captcha deployments, then import only the required cookie through a secret input. Warn before storage that **the cookie gives full access as that account**, not just to this project. Store it only in VS Code SecretStorage, scoped by validated origin/account; never settings, workspace files, telemetry, trace logs, source archives or test evidence. Expired/revoked cookies visibly disconnect and preserve local work; logout removes the stored secret. No browser-profile scraping or automatic R0 credential collection.

Parse URLs and validate scheme, hostname and effective port as an exact origin before saving or sending credentials. Reject userinfo (including `https://host@evil.com`), misleading/lookalike hosts, origin mismatches and redirects to another origin; do not use string-prefix checks. Normal deployed connections use HTTPS. Scope cookies to the validated origin and do not forward them across redirects. Read back the account/project identity after login and permission after reconnect; failures retain local candidates. Record negative origin/secret-redaction cases in R1, not just the happy login.

Mirror into an extension-owned dedicated folder. Hydrate through staging; never replace an existing user folder silently. Remote changes are candidates until local dirty buffers, disk state and the last confirmed base have been compared. Preserve all three states on divergence, offer VS Code diff/copy/browser choices, and never infer a remote delete/rename from a local file's absence. Reject path escapes, symlink/reparse escapes and case collisions. External editors can change even a nominally read-only mirror; uncertainty causes a hold, not an overwrite. No claim of universal filesystem compare-and-swap.

**R1 mirror data-loss regression:** hydrate a synthetic project; dirty a VS Code buffer and independently change its on-disk mirror; change the same file remotely in the browser; disconnect/reconnect and trigger refresh (also restart with retained local state). Prove local-buffer, local-disk and remote candidates remain recoverable, conflicts are visible, no local candidate is silently replaced, and no remote mutation was submitted. Include dirty-at-initial-hydration and remote delete/rename. Use the upstream issue as a reproduction pattern, not an unsupported allegation. This is an R1 release gate, not deferred to R2/R3.

## 6. Minimum safety before live writes

R2 uses a proven upstream operation path; do not implement a new OT/review algorithm. Before any remote send, persist identity, exact intent, confirmed base/version, tracking decision and stable operation ID. Atomically record confirmation/base advancement. Distinguish durable, submitted, confirmed, ambiguous and held states. Storage failure stops sends and retains the editor candidate. Resolve one outstanding submitted operation before dependent work; loss of confirmation is not permission to replay. Use authoritative server evidence; text equality is insufficient. If proof is unavailable or expired, preserve the candidate and hold for explicit resolution.

Review gates follow the R0 capability record. If CE+ exposes review, prove concurrent text/review preservation, hidden deletions, IDs/authorship/anchors and legitimate metadata transformations on disposable projects. If review is conclusively absent, R2's review gate narrows to **preserve existing state**, do not synthesize/strip review metadata, and refuse writes to any document whose state/format cannot be safely understood. Unknown or partially readable review state stays read-only. This reduction never waives text, identity, concurrency or recovery tests. Do not advertise review actions in R2; R4 defaults to existing read-only/browser capability.

Exercise Unicode/UTF-16, line endings, IME, undo/redo, multi-cursor/format-on-save and remote edits against editor revisions in the real host. Suppress only the exact observed echo. Preserve dirty buffer/disk/remote candidates, permission-revoked work and original assets. R2 needs baseline crash/disconnect safety; R3 may reuse built-in diff and explicit manual choices rather than automatic offline merge. Never claim Workshop's existing behavior is safe without the regression.

## 7. Compilation and later conveniences

Use LaTeX Workshop and installed TeX/latexmk for local build, preview, diagnostics, bibliography recipes and SyncTeX. Missing tools or compile failure leave usable source and an actionable status. No automatic tool/package installation. For connected compilation, prefer the existing CE+ compile/browser path; preserve source/PDF identity and show stale output rather than inventing a new service.

Keep `.bib` text/keys/comments/order, original figures (including PDF inputs), styles and data unchanged. Do not run figure generators. Browser tree/history/settings/review operations remain the default until a real need justifies a small native command. R6 may later document a pinned existing Toolkit/compiler deployment, private endpoints and tested backup/restore; it is not a custom CLSI rewrite. R7 has no scheduled architecture or implementation. Reconsider only if measured queue/compile contention and actual users justify it.

## 8. Proportionate testing policy

Reuse disposable upstream/browser scenarios and fixtures; test only the feature or failure boundary introduced. No fixed test quotas, mandatory multi-day pilots, blanket performance/security certifications or dual engines.

- R0: cookie-first auth/version/integration probes, review/OT capability discovery and installed local-only behavior; preserve inconclusive live findings as R2 holds.
- R1: real cookie/project reads, strict origins/secret storage, expiry/revocation, safe hydration and the local-edit + remote-change + reconnect data-loss regression, proving zero remote writes.
- R2: real-server text fidelity, capability-scoped existing review preservation, ambiguous/dropped confirmations, durable recovery and installed editor races.
- R3: actual offline recovery/manual reconciliation, restart/sleep and expired-history conflicts.
- R4–R7: only justified shipped conveniences or their truthful browser/read-only fallback; do not build speculative tests for parked systems.

Install real VSIXs on declared Windows/macOS targets and exercise changed behavior before claiming an application release. Record exact source/artifacts and supported rollback. Missing server/host evidence remains missing; mocks/skips cannot satisfy a gate requiring reality. A shorter plan never waives no-data-loss checks. All application phases currently remain `not_started`.

## 9. Delivery order and release gates

This is the sole machine-parsed gate registry. Keep gate IDs and eight ordered phase records stable. An earlier usable release requires its own actual gates/prerequisites, not all later features. `RELEASE-CHECK` covers each shipped increment. A later read-only/browser fallback must itself be exercised; a parked feature is not falsely marked passed.

<!-- gate-index:start -->
| Rank | Category | Gate | Phase | Acceptance |
|---|---|---|---|---|
| 1 | feasibility | `R0-FEASIBILITY` | R0 | Execute required local/read/auth/version probes; record pinned CE+ image/source, tested compatibility list, Workshop reference and explicit review/OT/write outcomes. Unresolved live-only proofs remain R2 holds, not passing write checks; required read evidence cannot be missing. |
| 2 | local | `R0-LOCAL` | R0 | Actual installed companion uses local LaTeX Workshop compile/PDF commands on declared targets without server contact; missing tools/build failure preserve source. |
| 3 | mirror | `R1-MIRROR` | R1 | Cookie-first login/project hydration and reconnect work with exact-origin SecretStorage/redaction/expiry checks. Local-buffer + disk edits + browser change + reconnect retain all candidates without overwrite or remote writes; path/permission failures preserve work. |
| 4 | fidelity | `R2-LIVE` | R2 | Proven upstream text path passes pinned-server concurrent text and real-host Unicode/edit races; preserve existing review state according to R0 capability, fully test exposed CE+ review semantics and refuse unknown states/formats before writes. |
| 5 | durability | `R2-RECOVERY` | R2 | Persist before send and atomically confirm; crash/storage/revoke/reconnect preserve intent and hold lost/duplicate-confirmation ambiguity without replay or dropped edits. |
| 6 | offline | `R3-OFFLINE` | R3 | Local candidates survive restart/sleep and concurrent remote change; built-in diff/manual recovery or proven upstream reconciliation preserves all candidates when history expires. |
| 7 | review | `R4-REVIEW` | R4 | Only useful proven upstream review/presence integration is exposed; otherwise exercise read-only/browser handoff with retained state. No bespoke panel or unsupported actions; chat is optional. |
| 8 | project | `R5-PROJECT` | R5 | Only explicitly useful conveniences are added; existing tools/browser preserve bibliography/assets and tree/history/settings behavior; conditional binary/tree writes are not invented where safety is unproven. |
| 9 | server | `R6-SERVER` | R6 | If a shared deployment is needed, reuse pinned CE+ Toolkit/compiler with source/PDF identity, private endpoints and isolated backup/restore/rollback checks; no custom service required. |
| 10 | scale | `R7-POOL` | R7 | Park until measured contention and actual demand justify a separate scoped proposal; no pool readiness claim without real worker/isolation/failure evidence. |
| 11 | release | `RELEASE-CHECK` | R0, R1, R2, R3, R4, R5, R6, R7 | Run affected regressions, install exact artifacts on declared targets and exercise changed workflow; verify source/hash/download provenance and supported rollback. |
<!-- gate-index:end -->

### Phase R0 — Feasibility and local companion / 0.1

Run the short probes, populate the compatibility/reuse/capability report and ship local-only integration with real VSIX packaging. Required local/read findings must be recorded; unresolved live findings hold R2. No new server or synchronization engine. Exit: actual R0 gates, with connected features unavailable in this local release.

### Phase R1 — Read-only server mirror / 0.2

Cookie-first login, project selection, protected mirror and browser handoff only. Prove the mirror data-loss regression and secret/origin checks. Exit: R0/R1 gates pass with zero remote writes. Ship now for real feedback while expanded R2 experiments continue; no outbox/full OT/review implementation dependency.

### Phase R2 — Safe live text editing / 0.3

Use the proven upstream path, add only missing durable-intent/confirmation and editor-revision protection. Text/review qualification follows the actual CE+ capabilities, preserving existing state when review is absent. Exit: R2 gates pass on disposable projects and installed hosts. An ambiguous write or unknown review format blocks that write path; R1 remains usable.

### Phase R3 — Offline work and recovery / 0.4

Protect offline candidates and provide explicit built-in diff/manual reconciliation first. Add automatic replay/merge only if proven upstream semantics and a concrete need justify it. Exit: real recovery checks pass without silent overwrite.

### Phase R4 — Optional review/presence handoff / 0.5

Default to existing CE+/Workshop review/presence or a read-only/browser handoff. R0 decides availability on the selected build; absence on plain CE is not evidence against CE+. Add native actions only for a demonstrated use. No new panel or chat requirement. Exit: truthful chosen fallback/integration passes its gate; defer the phase if unused.

### Phase R5 — Optional project conveniences / 0.6

Keep browser/LaTeX Workshop/mirror workflows unless a specific missing command is valuable. Preserve source inputs; unsafe binary/tree mutation stays browser-only. No broad project manager, history viewer or SyncTeX rewrite. Defer if unused.

### Phase R6 — Optional existing-server operations / 0.7

Only when a real shared deployment is needed: document the pinned upstream Toolkit/compiler, TLS/private endpoints and a tested backup restore/upgrade rollback. Do not build a coordinator or duplicate compiler service. No speculative deployment platform.

### Phase R7 — Parked scaling / 0.8

No current implementation work. Reopen only after measured demand warrants a separately scoped proposal; all earlier supported releases remain valid without it.

## 10. Status, publication and evidence

Current status: plan/repository tooling only. All R0–R7 remain `not_started`; no live probe, compatibility certification, VSIX or deployment was executed by this plan revision. Today’s source inspection is not a server experiment. Changes authorize planning/tooling only.

Retain schema 3, ordered phases and `releasePhase`: null in planning/development, target R0–R7 in candidate/production. Actual evidence is required through the target; later phases cannot block an earlier release. Keep unresolved write probes in the capability report without marking R2 implementation started/passed prematurely. Reopen invalidated prerequisites and reset dependents; preserve historical evidence and known-good artifacts.

Each passed phase references one concise `docs/validation/phase-RN/report.json`: exact tested commit/time, zero blocking defects and its actual command/environment/hash-verified sanitized gate logs. Never put credentials/cookies in evidence. Record capability reductions and actual tested versions explicitly; absent/inconclusive is not supported. Planning package checks do not prove an application works.

The current CI/builder/publisher remain planning-only. R0 adds actual VSIX packaging, native installed-host checks and immutable candidate/versioned artifacts with source/checksum verification. Publication stays CI-gated; Marketplace needs explicit authorization. No publication or deployment is requested here.

### Current checkpoint — 2026-11-03 23:01 CET

- Objective/scope: finish the reuse feasibility assessment before application construction; preserve the browser/local-tool shortcuts and data/secret boundaries. Application implementation, extension/tool installation and server deployment remain excluded from this planning continuation.
- Project: `/Users/macc/Desktop/Kod/Projects/overleaf-sync`, branch `main`, starting HEAD `05b0c4e99e173d0bff6794aeabe66bfb084bfb78`. Initial project tree clean; unrelated parent-repository edits are outside scope. This continuation changes this plan and its existing parent mirror only.
- Last completed action: inspected the pinned Workshop entry point, manifest, credential identity/persistence, filesystem and replica paths through GitHub. Source findings and concrete reuse limits are recorded in section 4; all application phases remain `not_started`.
- Environment discovery: `code --list-extensions --show-versions` reports neither Overleaf Workshop nor LaTeX Workshop installed in the default profile. Docker, `latexmk` and `pdflatex` are absent from PATH; Tectonic is present. No test-server origin, account or immutable CE+ image is supplied in this plan. Do not infer that no remote server exists or install tools automatically.
- Pace: one bounded source-inspection pass replaced an assumed integration with specific findings; do not repeat it without an upstream revision/change. No runtime latency, throughput or resource result exists. Timebox the next installed-host probe to 30 minutes once prerequisites exist; a failed auth/isolation premise stops dependent work and returns to browser handoff.
- Next action (`R0-DISCOVERY`, pending; no phase gate passed): obtain an explicitly designated disposable CE+ origin/source/image and safe test account, then identify the exact installed extension versions in an isolated profile. From this project run `code --list-extensions --show-versions` and `command -v docker latexmk tectonic pdflatex`; missing prerequisites are discovery failures, not passing/skipped application checks. Do not collect cookies in commands/logs. Test masked secret input/origin validation before credentials, then filesystem read activation and the local-only/restart boundary on synthetic data. Expected result: sanitized capability/compatibility findings with no source-data changes or remote mutations. If prerequisites or a safe reusable interface remain unavailable, retain browser handoff and hold connected implementation; do not silently replace the backend.
- Recovery/ownership: no test server, extension-host process, worktree or lock was started. No user credentials were accessed. Tooling verification runs in a disposable checkout outside Kod; retain unfinished files on failure, and remove completed generated assets/checkouts only after the private remote snapshot is independently verified. Planning test results are recorded below when available.
