# Faster local editing and PDF refresh

The modified CE+ backend source, frontend source patch and timing overlay here retain **AGPL-3.0-only** licensing; see `LICENSE`. Original authors are Overleaf and the CE+ contributors. Modifications: Cenker YILDIZ, 15 November 2026. This directory is an explicit exception to the root proprietary notice. Upstream source is `yu-i-i/overleaf-cep@ae07e781ab20dac2378420e5cf7a47f7d8bccbb5`, matching the pinned 6.3.0-ext-v5.1 image. No editor, OT algorithm, compiler, renderer or service is replaced.

| Setting | Previous local profile | Candidate |
|---|---:|---:|
| Single/collaborating operation flush | 100 ms | 16 ms |
| Preview debounce / maximum wait | 300 / 1,200 ms | 50 / 500 ms |
| Per-user/project compile admission | 1 second | 100 ms, atomic Redis PX/NX |
| Global / standard auto-compiles per 20 seconds | 100 / 25 | 150 / 100 |
| Unset new-project auto-compile preference | Off | On; saved choices preserved |

Acknowledged-operation waiting, the 4-second recent-ack classification, inflight retries, fatal timeouts, one active client compile and bounded server rate limits are retained. Pending edits are coalesced by existing code; preview remains the actual compiled PDF. End-to-end timings still include network, document compilation, download and rendering. These local two-user limits are not production fairness/capacity qualification.

`frontend-timings.patch` is the preferred-source change to the existing TypeScript modules. The small generator avoids a full frontend rebuild for this pinned local installation and refuses unknown input, duplicate match sites or an unexpected output filename:

```sh
node runtime/fast-preview/apply.mjs \
  "$HOME/overleaf-ws1/patches/8607-0a5113f4c48f158e90d6.js.orig" \
  "$HOME/overleaf-ws1/patches/8607-0a5113f4c48f158e90d6.js"
```

Required original bundle SHA-256: `47dce31db1e1e52214e207bb334a0659837b9ded425d0b22ec042c49ea4d04ad`. Generation changes only the two send delays, preview debounce/max-wait and unset auto-compile default. Existing stored preferences are never rewritten. Keep the upstream source/notices and bundled third-party notices available with modified deployments. The full original source is identified above; this folder alone is not a complete Overleaf distribution.

Keep the existing read-only frontend bundle mount and add a read-only mount from this `CompileManager.mjs` to `/overleaf/services/web/app/src/Features/Compile/CompileManager.mjs`. Set the existing Toolkit `config/variables.env` fields `RATE_LIMIT_AUTO_COMPILE_EVERYONE=150` and `RATE_LIMIT_AUTO_COMPILE_STANDARD=100`. Recreate only sharelatex using the Toolkit command documented in `../texlive-course/README.md`; atomic asset replacement needs a remount. Hard-reload existing editor tabs to load the new bundle. Leave all authentication mounts, data and loopback settings intact.

For a stock-timing rollback, restore the `.orig` bundle to the mounted frontend filename, remove only the compile-manager override and the two rate fields, and recreate sharelatex. This restores upstream 2,000/500 ms send and 2,500/5,000 ms preview defaults; it does not remove the package image or authentication patches. To reproduce the previous local comparison profile instead, the original bundle's `.setFlushDelay(2e3)`/`.setFlushDelay(500)` sites were both 100 and `},2500,{maxWait:5e3})` was `},300,{maxWait:1200})`; its SHA-256 is `ca7d5757e1beb518cb65c79da876cf3cd478894ced0e81f85080a83d8dc29cef`.

The pinned upstream source editor and history engine reject non-BMP characters, including emoji. A server-only surrogate-normalization experiment was rejected and removed because it would not establish history-engine support. That remains an explicit failed/blocked R2 capability; this latency work does not enable it. Supported BMP text and TeX/math source remain in the browser comparison. `test/non-bmp-support-probe.cjs` is an opt-in expected-failure probe, not a passing acceptance gate.

Focused tests are `test/fast-preview.test.mjs`. The opt-in `test/live-preview.browser.mjs` uses existing synthetic Alice/Bob accounts with private environment passwords and an installed Playwright runtime. It measures key insertion to another editor and to matching PDF.js text-layer content, then checks exact source convergence/reload. It creates a uniquely named synthetic project, reports its URL for scoped cleanup and never uses a real overleaf.com account. Small loopback samples are not internet or arbitrary-document performance guarantees.

Measured on the same Apple M4 Mac (16 GiB host RAM; local Colima/Rosetta setup) with two independent Chrome 157 sessions and identical supported-text workloads: source p95 143 → 50 ms (18 samples/profile); plain PDF median 999.5 → 818.5 ms and p95 1,086 → 1,069 ms (6 samples/profile); math PDF p95 1,111 → 958 ms (2 samples/profile). Source convergence/reload passed and the candidate preserved an explicit Off choice across reload. The candidate narrowly missed the initial ≤1,000 ms plain-PDF p95 goal; tail improvement was only about 2%, so this is not instantaneous PDF delivery. Compilation request p95 remained 901/923 ms across the before/candidate runs, indicating remaining server work rather than only frontend timers. Small loopback samples, warmed compiles and sampled container memory are not a production or remote-network guarantee. End-of-run app-memory samples were about 2 GiB, not measured peaks.

For an existing browser project, hard-reload and choose the arrow beside Recompile → Auto compile → On if its saved choice is Off. New unset preferences default On.
