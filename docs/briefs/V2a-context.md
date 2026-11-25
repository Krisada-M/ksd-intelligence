# V2a — Context packs, `ei_context` (agent brief, DRAFT)

Start with Round 0 (`README.md`). Read `docs/briefs/V2-README.md`, then `docs/DESIGN.md` §6.3, §7.5, §6.11; `docs/TOOLS.md` §1, §7, §8; `docs/RISK.md` §6.

**Branch:** `v2a-context` from `v1.0.0`.

## Goal

At the start of a task the agent asks "what should I read?" and gets the smallest set of spans worth reading, each with the reason it was chosen, within a token budget. **Suggest only:** nothing is injected into the prompt, and the agent decides what to open.

## Round 1 — selection core (`src/core/context/`)

- Input: `task` (1–2,000 characters), optional `targets` (any `ei_impact` target form), `budgetTokens` (default 6,000, max 20,000).
- Candidates from what already exists: exact symbol matches of identifiers in the task; `ei_search` hits; for each resolved target its declaration, its direct callers and its tests from the impact graph; files changed since the merge-base (from the `ei_changes` base logic, read-only).
- Score with fixed, documented weights (exact target > direct caller > test of target > search hit > recent edit); ties by stable key. Spans are whole declarations, never cut mid-declaration; a declaration longer than the remaining budget is listed under `omitted` with its size.
- Token estimate: characters / 4, stated as an estimate in the output.
- `ContextPack` per DESIGN §7.5. `completeness` is copied from the impact answers for the resolved targets; when no target resolves it is `partial` with reason `outside-index-scope` or `target-not-found` as appropriate.
- Freshness: same probe and stale rules as `ei_impact`; a stale pack says so on line 1.

Risky cases, one test each:
- A task naming no symbol and matching nothing → the no-match line, not an empty "complete" pack.
- A target that is ambiguous → the ambiguous guidance from `ei_impact`, no pack.
- Budget smaller than the first span → that span in `omitted`, and line 1 says the budget was too small.
- A secret-rule file never appears as a span, even when its name matches.
- Same input twice → identical bytes.
- No span text from outside the index scope.

## Round 2 — tool, CLI, rendering, value check

- `ei_context` in the OMP extension and the AGY MCP server (`approval: 'read'`), CLI `ei context "<task>" [--target …] [--budget N] [--json]`. Text: one line per span `path:start-end  why  ~tokens`, then `Omitted`, then the footer. The span text itself is **not** included; the agent reads the files. (A pack with inline text is a later option, behind config, after the value check.)
- Update `docs/TOOLS.md` with a new section in the same style as §4; tool discovery text (§9).
- Disabled by default: with `context.enabled: false` the tool is not registered. Test: V1 snapshots unchanged.
- **Value check:** 10 tasks (from `docs/dogfood-log.md` plus tasks written for this repository and the M3 work repository), each with the files a reviewer judged necessary. Report recall (necessary files in the pack) and precision (pack files that were necessary) at the default budget, and how many tokens the pack lists versus the files the agent read in the logged run. Through `omp -p`, run 3 of the tasks with the module on and off; report files opened and tokens used.

## Round 3 — review, then fix (`README.md`)

**Review focus:** span text or secret files leaking; a pack presented as complete when targets did not resolve; non-determinism; budget accounting; any effect on V1 tools.

## Do not

- Inject anything into the prompt or add an OMP hook.
- Feed pack scores into any verdict.
