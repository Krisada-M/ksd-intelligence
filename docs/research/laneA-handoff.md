# Lane A handoff

Base: `v1.0.0` (`f2b0f5a5fa6ffa392683fcd92dfb38414ceef9a1`). D69 governs the lane. No push, tag, merge, or publish.

| Module | Branch | Done | In progress |
| --- | --- | --- | --- |
| UI polish | `ui-polish` | Rounds 0–1 complete; Round 2 CLI/OMP/KSD work is also on `origin/main` as #42 (`2fa8e8a`). The Round 2 record reports 769 passing tests and a live OMP terminal check. | **BLOCKED** at the Round 2 strong-model eval. The prior run exited 2 before tool execution; 0 of 10 cases scored. No Round 3 AGY implementation or release bump in #42. |
| V2a | `v2a-context` | Not started | Waits for UI polish completion |
| V2e | `v2e-compression` | Not started | Waits for V2a completion; confirm the installed OMP result hook before building |

`git fetch origin --tags` succeeded. Before this handoff, local `ui-polish` was clean at `ac44334` and matched `origin/ui-polish`. `origin/main` was `2fa8e8a86af0410229c306e2fdac113a70d2e4cd`. Landing #42 does not establish the missing gate.

This session found OMP 19.2.1 and Node 24.22.0 on macOS arm64, no `bwrap` on `PATH`, and no `EI_EVAL_HOME` set. Docker reports a Linux daemon, but no dedicated KSD/eval container or volume was found. No eval was repeated with those prerequisites missing. The V1 and Lane B scores are not UI polish scores.

Next: on Linux with working Bubblewrap and a Codex login in a dedicated `EI_EVAL_HOME`, follow `docs/release-checklist.md` and run:

```sh
EI_EVAL_MODEL=openai-codex/gpt-6.2-sol node evals/run.mjs
```

Run this on the `ui-polish` worktree. Resume Round 3 only after at least 9 of 10 cases pass. Then run final gates, rebase onto the latest `origin/main`, and rerun gates. V2a and V2e remain unstarted.
