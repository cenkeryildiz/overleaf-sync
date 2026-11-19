# Collaborative LaTeX / Overleaf Sync

[![Build and release](https://github.com/cenkeryildiz/overleaf-sync/actions/workflows/build.yml/badge.svg)](https://github.com/cenkeryildiz/overleaf-sync/actions/workflows/build.yml)

Self-hosted collaborative LaTeX **web application candidate** for browser use on Windows/macOS, retaining nearly all capabilities of the selected CE+, Overleaf Workshop and LaTeX Workshop repositories and adding safe local/offline recovery, explicit Local only / Connect to server sessions, and multi-user server job distribution. No VS Code extension or Premium account is required.

**Current status: R0 is in progress. The local service and public-source image candidate have passed synthetic browser workflows and encrypted restore checks; Google login/logout/repeat login was user-confirmed locally. No application release or independent public host is active yet.**

## Use an existing instance

Ask the operator for their site address and an individual account or supported sign-in method. Open that address, sign in, and accept the project invitation. Joining an existing instance requires no server setup or OAuth client of your own. Sharing this repository does not grant access to any installation. An account or invitation on one instance grants no access to another instance.

The application and its backend are served together at each operator's address. There is no central server list or automatic cross-server collaboration. To move a project, export its source ZIP and explicitly import it on the destination instance; browser recovery copies remain scoped to the original site and browser profile.

## Host your own instance

Follow the [independent hosting guide](runtime/participant-compile/hosting/README.md). Each operator provides their own host/domain, HTTPS, login-provider configuration, private secrets, persistent storage and backups. Their installation runs independently of this repository owner's server. Only authorized project members receive compilation jobs; their browsers perform the TeX work while the backend coordinates identities, collaboration, storage and jobs.

The guide includes configuration, administrator creation, individual accounts/invitations and encrypted backup/restore. Keep private configuration outside Git. Public hosting, registration restrictions, mail delivery and off-host restore must be checked for the chosen host before public exposure. No public instance is supplied by this repository yet.

## Languages

| Component | Language |
|---|---|
| Reused Overleaf editor, application server and collaboration | JavaScript / TypeScript |
| Participant-job coordinator | Rust |
| Browser compilation, native-editor/offline adapters, and server snapshot/result integration | JavaScript |
| Layout and styling | HTML / CSS |
| Packaging and instance configuration | Dockerfile / YAML; Node.js setup helpers |

This is a mixed-language integration. It preserves the upstream application's host language and uses Rust for the separate job coordinator; it is not an all-Rust rewrite.

## Implementation status and development

The current first-version direction shares compilation among authorized participants' browsers, while CE+ retains authentication, storage and live collaboration. The [self-hosting candidate](runtime/participant-compile/hosting/README.md) builds from pinned public images/resources and includes the selected editor/recovery/navigation overlays. The [encrypted cold-backup procedure](runtime/participant-compile/BACKUP.md) has passed an isolated source/assets/accounts/invitation restore drill. This is preparation for independent hosting; no public host or application release is active. The work-order checkpoint in the plan supersedes the older server-compilation roadmap below.

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

Earlier accurately labelled partial releases need their own gates and prerequisites; later required phases remain part of complete-project acceptance. Local only must avoid remote-server contact. A possible loopback helper for local files/compilation is unresolved and must be justified by browser feasibility checks. Rust and JavaScript are used where they fit the integration; reused browser/editor code retains its existing language.

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

Free-account projects can be transferred through source ZIP download/upload; Premium Git access is not required. ZIP imports are separate projects, and returning changes to the original shared online project needs deliberate file updates and conflict review. The candidate supports operator-configured Google sign-in and native local accounts. Project identities and permissions remain local to each installation; collaborators enter provider passwords only at the provider. A public login callback remains unqualified.

The opt-in live browser check is `test/browser/free-account.mjs` (retrieve it into a temporary checkout). It requires the existing synthetic Alice/Bob accounts, their passwords supplied privately as `OVERLEAF_TEST_ALICE_PASSWORD` and `OVERLEAF_TEST_BOB_PASSWORD`, and an installed Playwright runtime. Run `PLAYWRIGHT_MODULE=/absolute/path/to/playwright CHROME_PATH=/absolute/path/to/chrome node test/browser/free-account.mjs` on macOS. It creates a uniquely named synthetic project and reports its URL for scoped cleanup; it never uses real Overleaf accounts, imports browser cookies, exposes a port or uploads to overleaf.com. Page traffic is restricted to loopback; server/container egress is unchanged.

The approved [CE+ identity/logout patch](integrations/ce-plus-oidc/README.md) is installed on the local instance. It validates verified provider identities, prevents replacing an existing linked identity, and logs out locally without provider tokens in redirect URLs. Google login is active in a separate local staging instance: the user confirmed initial login, logout and repeat login; private credentials stay outside Git. The final public HTTPS callback and Google audience settings still need validation before publication. These two upstream-derived files retain AGPL-3.0-only licensing.

The local setup also includes the [required TeX package image](runtime/texlive-course/README.md) and [faster collaboration/preview overlay](runtime/fast-preview/README.md). Existing editor tabs need a hard reload; choose Auto compile → On if that project previously saved Off. Local comparison: shared-text p95 143 → 50 ms, plain-PDF median 1.00 → 0.82 seconds; plain-PDF tail latency stayed near 1.07 seconds. These are small local samples, not instantaneous or remote-performance guarantees. Non-BMP characters (including emoji) remain unsupported by the pinned upstream editor/history path.

FAST-02 same-machine comparison: overlapping-pair arrival p95 44 → 27 ms (32 pairs/profile), sustained 204-character streams 1,329/1,314 ms, and native outgoing edit frames 168 → 215 (+28%) for the complete identical workload. This is a latency/traffic tradeoff, not proven throughput/memory improvement. Input→send/peer receipt samples were 21.0/36.7 ms before and 10.5/27.1 ms after. Both profiles passed convergence, per-user undo/redo, cross-user review/chat, simultaneous PDFs, history/reload and exact synthetic job-group loss/failure/retry. Peak memory, large-project throughput and internet latency remain unmeasured.

[Browser recovery and Local only](runtime/browser-recovery/README.md) provides per-tab candidates and side-by-side review against current shared text. Reconnect never applies changes automatically. Prepared projects now open the same native CE+ editor/file tree/PDF viewer offline, with local compilation, exact ZIP export and saved reload verified in Chrome. Local file/folder/project creation is implemented; broader navigation/recovery, project compatibility, installation and final delivery checks remain in progress. The separate recovery prototype is retained as test/support tooling, not the offline project interface.

[Native pdfLaTeX](runtime/native-tex/README.md) and its native Perl/latexmk wrapper avoid emulation for those processes on the current ARM VM. The resumed continuous-typing check displayed its first changed PDF in 354 ms and final text 292 ms after typing ended; this single repeat is not a tail-latency or load guarantee. [Math PDF-to-source selection](runtime/synctex-selection/README.md) resolves unique literal terms within the mapped math block, retaining coarse SyncTeX behavior for repeated/unsupported terms. Hard-reload after installation; this is not Word-like instantaneous PDF delivery.

Live insertion carets use the existing presence path with the qualified scheduling changes. See [caret timing](runtime/live-caret/README.md) and the isolated [same-Wi-Fi testing configuration](runtime/local-network/README.md). The user confirmed the original full two-device LAN checklist and later reported participant compilation worked. A reported one-character caret gap was reproduced as the separate other-participant marker while the local thin caret remained correct; physical acknowledgement of that explanation and WAN behavior remain unverified.


## Standalone offline candidate

The stage1 Chrome candidate keeps the native editor, file tree and PDF viewer on this device. Create/import a project and write LaTeX: the bundled compiler updates the real PDF automatically. The native compile menu provides On/Off, Stop and Recompile; Off persists across reloads. Unsupported packages and compile errors retain the source and previous PDF. Download source ZIPs and PDFs before removing the extension or clearing its data. No account, server, separate TeX installation or native registration is required.

This remains a development candidate, not a published release. Packaging uses `node runtime/chrome-extension/package.mjs <fresh-output-directory>` with the immutable local image pinned in that file; it creates only a stopped extraction container. Load the unpacked folder through Chrome's extension developer controls for isolated testing. The compiler resources add substantial disk space; final distribution/licensing, physical-device/accessibility checks and other browsers remain separate gates in the plan.
