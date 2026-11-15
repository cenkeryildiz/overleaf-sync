# Introduced upstream source

| Component | Exact source / license | Changes and distribution |
|---|---|---|
| CE+ OIDC manager/controller | `yu-i-i/overleaf-cep@ae07e781ab20dac2378420e5cf7a47f7d8bccbb5`, matches image `6.3.0-ext-v5.1`; AGPL-3.0-only | Two source files and license under `integrations/ce-plus-oidc/`; verified identity, non-replacing native account linking, and local session logout. Preserve upstream authors/notices and source availability for modified deployments; see that directory’s README for hashes and corresponding-source reference. |

No new runtime package or service is introduced. Existing installed Passport OpenID Connect 0.1.2 and CE+ native helpers remain in use. Focused tests use Node’s built-in test/VM facilities; the existing browser tool runtime is not a shipped dependency.
