# Live insertion carets

CE+ already broadcasts each collaborator's text insertion position and draws a colored vertical caret with an identity tooltip. This change removes the native resettable 500-ms presence wait. The editor's existing animation-frame scheduling still coalesces movements; document transforms, authentication, permissions and compiler scheduling remain unchanged. A solo editor retains the existing five-minute idle interval until a peer joins. This does not promise zero network/rendering latency.

`frontend.patch` is the preferred change against CE+ ae07e781ab20dac2378420e5cf7a47f7d8bccbb5. `apply.mjs INPUT OUTPUT` applies the same two edits to the pinned, already-installed timing-overlay bundle, refuses mismatched hashes/anchors and never overwrites its input. Preserve the previous bundle before installing the generated asset; reload editor tabs. Restore that bundle to roll back. Source retains AGPL-3.0-only.

The focused test checks scheduling and refusal boundaries. `test/browser/live-cursors.browser.mjs` uses two synthetic identities, verifies both visible carets, peer movement, actual concurrent edits, the final peer position against source coordinates and reload convergence. The plan records exact measured timings and LAN limits. These checks do not establish instantaneous updates, WAN performance or cross-platform application acceptance.
