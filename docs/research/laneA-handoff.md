# Lane A handoff

Base: `v1.0.0` (`f2b0f5a5fa6ffa392683fcd92dfb38414ceef9a1`). Policy: D69 from `origin/main`. No push, tag, merge, or publish.

| Module | Branch | Done | In progress |
| --- | --- | --- | --- |
| UI polish | `ui-polish` | Rounds 0–1 complete; Round 2 OMP and KSD display, 769 tests, live OMP terminal proof | **BLOCKED** at Round 2 eval: the isolated home has no Codex login; zero cases scored |
| V2a | `v2a-context` | Not started | Waits for UI polish completion |
| V2e | `v2e-compression` | Not started | Waits for V2a completion; confirm the installed OMP result hook before building |

Next: authorize a dedicated `EI_EVAL_HOME` using the isolated Codex login in `docs/release-checklist.md`, then run `EI_EVAL_MODEL=openai-codex/gpt-6.2-sol node evals/run.mjs` in this worktree. Resume Round 3 only after at least 9 of 10 cases pass. Then run the final gates, rebase the completed module onto current `origin/main`, and rerun the gates. Do not start V2a or V2e while UI polish is blocked.
