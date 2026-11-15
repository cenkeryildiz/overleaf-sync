# Introduced upstream source

| Component | Exact source / license | Changes and distribution |
|---|---|---|
| CE+ OIDC manager/controller | `yu-i-i/overleaf-cep@ae07e781ab20dac2378420e5cf7a47f7d8bccbb5`, matches image `6.3.0-ext-v5.1`; AGPL-3.0-only | Two source files and license under `integrations/ce-plus-oidc/`; verified identity, non-replacing native account linking, and local session logout. Preserve upstream authors/notices and source availability for modified deployments; see that directory’s README for hashes and corresponding-source reference. |

No new runtime package or service is introduced. Existing installed Passport OpenID Connect 0.1.2 and CE+ native helpers remain in use. Focused tests use Node’s built-in test/VM facilities; the existing browser tool runtime is not a shipped dependency.

The `runtime/fast-preview/` CE+ compile-manager/source-timing overlay retains AGPL-3.0-only terms and uses existing Redis/OT/PDF.js/compiler services. No new runtime package/service is introduced. The `runtime/texlive-course/` image adds 36 required TeX packages/dependencies and the required TeX Live infrastructure self-update; `packages.csv` records the exact installed revisions and individual licenses. The base image and original user data are preserved. Non-BMP support remains blocked by upstream editor/history validation, not silently accepted by these timing changes.

Browser recovery adds no installed package/service. It reuses native CodeMirror state 6.5.4/view 6.38.6/commands 6.10.1 (MIT; exact upstream tag licenses included in runtime/browser-recovery/CODEMIRROR-LICENSES.txt), the existing webpack runtime and browser localStorage/CacheStorage/Service Worker facilities. The wrapper and minimal CE+ source hooks are AGPL-3.0-only. Public asset digests, source provenance, per-profile privacy and rollback are documented in that directory. No private source/authenticated HTML is in its cache or build context.
