# Lane A handoff

Base: `v1.0.0` (`f2b0f5a5fa6ffa392683fcd92dfb38414ceef9a1`). D69 governs the lane. No push, tag, merge, or publish.

| Module | Branch | Done | In progress |
| --- | --- | --- | --- |
| UI polish | `ui-polish` | Rounds 0–2 complete; the Round 2 isolated strong-model eval scored 10/10. Round 3 adds the AGY opt-in and release metadata. All deterministic gates passed again after rebase. AGY ACP completed both live `ei_status` calls. | **BLOCKED:** `openai-codex/gpt-6.2-sol` still returns `usage_limit_reached`. Final strong-model eval and complete AGY display/guidance acceptance remain open. |
| V2a | `v2a-context` | Not started | Waits for UI polish completion |
| V2e | `v2e-compression` | Not started | Waits for V2a completion; confirm the installed OMP result hook before building |

Round 2 rerun: `EI_EVAL_MODEL=openai-codex/gpt-6.2-sol node evals/run.mjs` on the archived `ui-polish` checkout (`6142e8cfcbb2`), Linux aarch64, Node 24.22.3, OMP 19.2.1, Bubblewrap 0.8.0, in a private eval home. Output: `Pass rate: 100.0% (10/10 scored); 0 not verified.` Transcripts remain in the isolated VM under `/tmp/ksd-eval-3uHK9S`.

Latest `origin/main` observed: `e2be8fa54b31`. Local and remote `v1.0.0` refs differ, but the remote annotated tag peels to the original authorized commit `f2b0f5a5fa6f`. No tag was changed.

The Round 3 product commit rebased onto `e2be8fa54b31` as `dced6a35e2c4`. After that rebase, `npm ci`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test` (814/814), `npm run check:dist`, and `node --test tests/packaging/npm-tarball.test.js` (1/1) passed. The exact candidate is staged in the isolated Linux VM; `node --test evals/run.test.mjs` passed 7/7, including host-file isolation.

Owner decisions for the next modules:

- V2a may reuse the existing fixed read-only Git merge-base and changed-path helpers. This does not authorize caller-supplied Git commands, an index build by `ei_context`, or repository writes.
- V2e promises exact recovery of eligible payloads delivered to OMP's result hook, not of raw subprocess bytes upstream of the hook. Live hook replacement and exact retrieval round-trip still need evidence.

The isolated UI eval rerun used the previously verified rebased product commit `dced6a35e2c4`, not the uncommitted UI edits now in the local worktree. It exited 2: `desktop-status` stopped before tool execution, 0/10 cases scored, and the transcript contained the Codex quota error. The new approvals resolve the V2 design questions, not the separate UI eval gate.

Next: after the provider quota resets, run the staged candidate in the authorized VM with `lanea run` (invokes `EI_EVAL_MODEL=openai-codex/gpt-6.2-sol node evals/run.mjs`). Establish live AGY display/guidance acceptance and capture it at 80 columns. Do not start V2a or V2e until UI clears.
