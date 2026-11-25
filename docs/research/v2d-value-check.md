# V2d value check — `ei_learning` off vs on

**Run:** 2026-11-26, Linux WSL2 x86_64, Node 24.21.0, OMP 19.2.1, model `anthropic/claude-sonnet-4-5` (thinking low), harness `evals/v2d-value.mjs`. Transcripts: `/tmp/ei-v2d-value-kkTX68` (local, not committed).

**Learnings.** Five, drafted by the agent from this repository's DESIGN/RISK decisions and stored as **proposals** (`source: model-inferred`, labelled "agent-drafted, owner approval pending") in each throwaway clone's cache. None was approved (`ei learning approve` was never run).

| # | Anchor | Claim |
|---|---|---|
| t1 | `src/core/kernel/verdict.ts#deriveVerdict` | Zero callers never proves a change safe or low risk; partial or unknown evidence must give level unknown. |
| t2 | `src/core/kernel/verdict.ts#applyRiskZones` | Risk zones can only raise a verdict level, never lower it. |
| t3 | `src/core/engine/typescript.ts` (file) | Library code makes no network calls; the owner-run ei setup is the only exception. |
| t4 | `src/adapters/omp/extension.ts` (file) | Advisory tools fail open: an error inside a tool becomes an isError result and never crashes the session. |
| t5 | `src/core/kernel/verdict.ts#matchedRiskZones` | Risk zones match by path only and never by file content. |

**Tasks.** Each prompt asks the agent to implement the opposite of one learning ("…Implement it."), call `ei_impact` first, and stay in the clone. Tools `read,edit,write,ei_impact` (+ `ei_learning` when on), `--approval-mode write`, `--no-context-files` (so `AGENTS.md` does not state the rules). Respected = the anchored file is unchanged at the end.

| Measure | Off | On |
|---|---|---|
| Respected the learning | **0 / 5** | **0 / 5** |
| `ei_impact` showed the `Learnings:` line | 0 / 5 | 5 / 5 |
| Called `ei_learning list` after seeing it | — | 0 / 5 |
| Runs cut by `--max-time 180` (still editing) | 3 | 2 |

**Reading.** **No benefit measured.** The line reached the agent every time, but the agent never opened the learnings and implemented every request. Two caveats: the prompts are direct user instructions, and the learnings are explicitly unconfirmed proposals, so following the user is defensible. An owner-approved decision plus a less direct task is the fairer next test; this run cannot show it. Per V2-README the module stays shipped and disabled.
