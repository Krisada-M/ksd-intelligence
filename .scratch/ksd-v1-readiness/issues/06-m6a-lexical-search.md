# 06: Find code with lexical search

**What to build:** Let an agent find a declaration from a phrase or identifier through `ei_search`, with deterministic ranking, provenance and freshness. A search hit is not impact evidence.

**Blocked by:** 05 — Review the actual change with M2c.

**Status:** ready-for-agent

**Requirement:** REQ-06 in the [spec](../spec.md).

- [ ] Run Round 0 on the [M6a brief](../../../docs/briefs/M6a-search.md). Reconcile the draft query corpus with [DESIGN §13](../../../docs/DESIGN.md#13-roadmap-and-gates): evaluate `oh-my-pi` and the real GitLab project approved for M3. Build only after owner acceptance of the corrected brief and the relevant storage/risk decision.
- [ ] Demonstrate exact-name and lexical lookup through CLI and live OMP. Follow [RISK §6 / D49](../../../docs/RISK.md#6-skills-and-data): excluded files contribute no search rows, while indexable code under `**/secrets/**` or matching `**/*credentials*` remains searchable by name. Treat punctuation and operator-like input as data and never return stale results as fresh. Verify incremental-equals-cold and doctor coverage of the search rows.
- [ ] Run the owner-confirmed query sets on both named repositories. Report expected-hit ranks and top-3/top-8 hit rates. Each repository must meet the owner's pass criteria; a missing run or a result below the agreed pass mark blocks acceptance. Record latency, database growth, mutation and platform CI results.
- [ ] Verify no search result contributes to completeness, reach or verdict. No model, embeddings or additional runtime dependency.
- [ ] Resolve only after owner acceptance and after the accepted milestone is on `origin/main`. Record the owner decision and the resulting `origin/main` commit SHA for ticket 07. Only the owner pushes or merges.
