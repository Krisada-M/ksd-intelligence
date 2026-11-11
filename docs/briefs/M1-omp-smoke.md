# M1 — Live OMP smoke test of the TS adapter (agent brief)

Read `AGENTS.md` first. M0 is accepted. This brief covers M1 only. Stop and report when done.

## Goal

Prove that the compiled TS adapter (`dist/adapters/omp/extension.js`) works in the owner's installed OMP (`omp/18.18.2`, WSL2) the same way the prototype did on 2026-11-09, including its error paths, and that it coexists with the plugins already installed. No new features.

## Context

- The prototype `omp/extension.mjs` was already verified live by the owner: loaded with `omp --extension`, tool registered via `pi.zod` + `pi.registerTool`, the OMP agent called `ei_workflow` on its own and received real SKILL.md text.
- M0 found the installed type source is `@oh-my-pi/pi-coding-agent` 18.14.0 while the binary is 18.18.2, and that `execute(toolCallId, params, signal, onUpdate, ctx)` is the documented signature. The adapter's 3-argument use is compatible; do not change it unless a live run fails.

## Who runs what

An interactive OMP session cannot be driven from inside another one. So:

1. **Agent:** check `omp --help` for a non-interactive / print / one-shot mode. If one exists and accepts `--extension`, use it for the scenarios below and record the exact commands and output.
2. If none exists, **prepare** `scripts/m1-smoke.sh` (bash, runnable from fish via `bash scripts/m1-smoke.sh <scenario>`) that sets env vars and launches OMP for each scenario, plus a checklist the owner follows. Then stop and report `PARTIAL — owner run required`. Do not mark interactive scenarios VERIFIED yourself.

## Scenarios

Each scenario: the setup, the prompt to give the OMP agent, and what must be observed. Record the observed tool result text (first ~30 lines) per scenario.

| # | Setup | Prompt to the OMP agent | Must observe |
|---|---|---|---|
| S1 | `npm run build`; all three `EI_*` roots set; lock hashes present | `Call ei_workflow with task "fix login bug", stage "investigate". Show me the raw tool result header.` | Tool is listed and called; result starts with the precedence header; contains `matt:diagnosing-bugs`, `classifiedBy`, and `sha256 … (matches lock)` |
| S2 | as S1 | `Call ei_workflow with task "แก้บั๊กการชำระเงิน", stage "investigate", type "bug".` | `classifiedBy: caller`; `matt:diagnosing-bugs` |
| S3 | as S1 | `Call ei_workflow with task "add OAuth login", stage "review", risk "high".` | Two skills: `matt:code-review`, `poteto:blast-radius` |
| S4 | unset `EI_MATT_ROOT` | same prompt as S1 | Tool returns an error result (not a crash, session continues); text names `PROVIDER_ROOT_MISSING` / `SKILLS_UNAVAILABLE` for `matt` |
| S5 | temp copy of the matt checkout with one byte appended to `diagnosing-bugs/SKILL.md`; point `EI_MATT_ROOT` at the copy | same prompt as S1 | Error result naming `HASH_MISMATCH`; no skill text delivered |
| S6 | as S1 | `Call ei_workflow with task "fix login bug", stage "deploy".` | Validation error from the schema or `INVALID_INPUT`; session continues |
| S8 | directly after S4 or S5, same session, roots restored | `Call ei_workflow with task "fix login bug", stage "investigate".` | Does the agent still call the tool after having received an error result from it? Record yes/no and what it said. (A reference project reports agents abandon a tool after early errors; this is our first measurement) |
| S7 | as S1 | none. Inspect the session | KSD indicator still shown (`🛡 KSD: …`); no second automatic skill router active (`ask-matt`, `poteto-mode`, `using-agent-skills` not auto-loaded). Record `omp plugin list` output |

S5 must never modify the real checkout under `~/ei-skill-sources`. Use a copy in the OS temp directory.

## Also record (read-only)

- `omp --version`, `omp plugin list`.
- How OMP can load this extension **persistently** (config key or directory) according to the installed version's docs (`omp://extensions.md`). Write it as a proposal in the report. **Do not** change `~/.omp/**` or any OMP config.
- Whether a GitNexus plugin or index is active for this repo (`.gitnexus/` exists untracked). Report only; do not remove or disable it.

## Acceptance criteria

1. S1–S8 each have recorded evidence, labelled `VERIFIED` (run and observed) or `NOT VERIFIED` (prepared, owner must run).
2. If any scenario fails: report the exact error, the OMP doc or type that explains it, and the smallest fix. Apply the fix only if it is inside `src/adapters/omp/` and keeps M0 tests green; re-run `npm test` and paste the summary.
3. Adapter file header updated to the real status (`VERIFIED live OMP 18.18.2 <date>` only if S1–S6 were actually observed).
4. README "OMP adapter" section updated with the verified load command and the persistence proposal.
5. Report in the `AGENTS.md` template.

## Do not

- Start M2 or create any indexing/graph code.
- Change OMP config, installed plugins, KSD, or `~/.omp/**`.
- Modify `~/ei-skill-sources/**`.
- Commit or push (owner commits after review).
