# Practical V1 roadmap review — 2026-11-12

**Decision status:** PROPOSED in this PR (D48). This is a source-grounded prioritisation, **not** evidence that competitors' implementations are faster or that KSD already has their features.

## Baseline from KSD source

- Implemented: `src/workflow/{router,loader,sources,render}.ts` routes allowlisted/pinned skills with read-only semantics; `src/adapters/omp/extension.ts` registers `ei_workflow` and the migrated policy; `src/core/workspace/init.ts` creates private per-repo cache/config and discovers initial project layout.
- **Not yet implemented in product source:** the whole-scope TS graph index, `ei_impact`, `ei_changes`, `ei_search`, the M2a child engine/store and the M4 bridges. Their behavior in `docs/DESIGN.md`, `docs/TOOLS.md` and briefs is a contract, not a live capability.
- M1b has macOS-only runtime/TypeScript memory experiments. It does not establish Linux correctness; it also found that Bun worker `resourceLimits` did not enforce its cap on that measured version (hence D45 process isolation).

## What to learn, not copy wholesale

| Reference | Useful design lesson | KSD decision |
|---|---|---|
| [GitNexus](https://github.com/abhigyanpatwari/GitNexus) | Navigation and relation-centric questions are useful to an agent only when query results are discoverable and bounded | Keep a small `ei_impact` / `ei_changes` surface, visible completeness, stable symbol identity |
| [Graft / Trail-code](https://github.com/trailhq/Trail-Code) | Change tracing and accumulated context are valuable in ongoing work | Prioritise actual-diff review first; postpone learning/session memory until real repeated friction is recorded |
| [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) | Searchable graph relationships and agent query interfaces offer broad exploration | Keep KSD's TS compiler as semantic authority for TS/JS; ship lexical search before any embeddings or broad-language support |

These references are **directional**. No upstream code is ported in this PR; the design does not claim parity, benchmark wins or verified feature coverage across all upstream versions. License/provenance review is required before adapting code.

## Priority changes

| Priority | Keep / add / defer | Concrete gate |
|---|---|---|
| **P0** | Add M1d macOS/Linux CI baseline before M2a | Both OS families run typecheck, lint, tests and `check:dist`; record architecture; separate live OMP evidence |
| **P0** | Keep M2a whole-scope index, SQLite, TypeScript checker, process isolation and crash-safe publish | Census accounts for gaps; interrupted build preserves previous published index; bounded memory and recovery verified |
| **P0** | Keep M2b exact symbol impact and evidence-based completeness | Golden, differential and incremental==full tests pass; unknown never becomes an unjustified low risk |
| **P0** | Dogfood M3 on at least two actual repositories | >=10 tasks over two weeks; latency, missing callers, false-low, useful actions recorded |
| **P1** | Move M2c risk/actual-diff analysis ahead of route bridges; then M6a lexical search | Every changed file is indexed or disclosed as unindexed; fixed search-query evaluation on real repos |
| **P1** | Framework route detection M4a only after representative app examples | Correct positive/negative route fixtures for each framework |
| **P2** | Gate M4b bridges individually | Each bridge justified by a missed real flow and never silently mixed with compiler edges |
| **P2** | M5 watcher/worktree seeding only if measured; M6b semantic by separate owner approval | Correctness invariant unchanged; measured benefit exceeds complexity/operational cost |

## Operating rules

1. Do not introduce a graph DB server, vector service, generic agent harness, OS-specific engine fork or extra automatic skill router.
2. Keep stable repo-relative IDs and canonical filesystem paths distinct. Compare semantic graph results across OS families, not absolute cache paths or file modification times.
3. Keep failure/uncertainty explicit. “No callers found” is not proof of safety if indexing or resolution is incomplete.
4. Track performance on the **same repository snapshot, runtime and hardware class** before claiming a regression or improvement; M1b timings are a measured macOS baseline only.
5. No unreviewed third-party code migration. Any adopted implementation must pass provenance, license and differential tests.

**What this PR changes:** governance, milestones, the M2a prerequisite, documentation and a cross-platform CI baseline. **What it does not change:** shipped OMP policy, runtime code, index implementation, tests/golden data or user configuration. M1d and later milestones require separate acceptance evidence.
