# Lane A handoff

Base: `v1.0.0` (`f2b0f5a5fa6ffa392683fcd92dfb38414ceef9a1`). D69 governs the lane. No push, tag, merge, or publish.

| Module | Branch | Done | In progress |
| --- | --- | --- | --- |
| UI polish | `ui-polish` | Rounds 0–2 complete; the Round 2 isolated strong-model eval scored 10/10. Round 3 adds the AGY opt-in and release metadata. All Round 3 deterministic gates passed. | **BLOCKED:** AGY 1.5.17 did not complete either live probe. The strong-model follow-up reported `usage_limit_reached`. Round 3 live acceptance and final post-rebase eval remain open. |
| V2a | `v2a-context` | Not started | Waits for UI polish completion |
| V2e | `v2e-compression` | Not started | Waits for V2a completion; confirm the installed OMP result hook before building |

Round 2 rerun: `EI_EVAL_MODEL=openai-codex/gpt-6.2-sol node evals/run.mjs` on the archived `ui-polish` checkout (`6142e8cfcbb2`), Linux aarch64, Node 24.22.3, OMP 19.2.1, Bubblewrap 0.8.0, in a private eval home. Output: `Pass rate: 100.0% (10/10 scored); 0 not verified.` Transcripts remain in the isolated VM under `/tmp/ksd-eval-3uHK9S`.

Latest `origin/main` observed: `e2be8fa54b31`. Local and remote `v1.0.0` refs differ, but the remote annotated tag peels to the original authorized commit `f2b0f5a5fa6f`. No tag was changed.

Next: when the strong model is available, continue Round 3 with a live AGY plain/Markdown comparison and preserve the terminal captures. Rebase onto latest `origin/main`, rerun all gates, and run `EI_EVAL_MODEL=openai-codex/gpt-6.2-sol node evals/run.mjs` on the rebased artifact. V2a and V2e remain unstarted.
