# Index techniques in the reference projects — review and decisions

> **Date:** 2026-11-11. **Purpose:** record what was learned from the reference projects' indexing code, what ksd-intelligence adopts, and what it deliberately does not. Decisions are in force as D21–D26 in `docs/DESIGN.md`; rows marked D28 were brought forward by the owner the same day.
> **Method:** shallow clone of each repository at the commit below; key indexing files read; nothing executed. This is a targeted read, not a full audit. **Ideas only: no code was copied.** Headroom, Caveman and Ponytail do not build code indexes and were not part of this review.

| Project | Commit read | License | Parser | Store |
|---|---|---|---|---|
| CodeGraph (`colbymchenry/codegraph`) | `f72c9d2e` | MIT | tree-sitter | Node built-in SQLite + FTS5 |
| CodeGraphContext | `6ed71a9f` | MIT | tree-sitter, optional SCIP | Kuzu / FalkorDB / Neo4j |
| GitNexus (`abhigyanpatwari/GitNexus`) | `4cfd3e4c` | PolyForm Noncommercial | tree-sitter | embedded graph DB |
| Trail-Code (`trailhq/Trail-Code`) | `b22055dc` | MIT | tree-sitter, optional LSP | JSON files |

## 1. How each one indexes

**CodeGraph.** Scan (git-visible files, ignore rules) → per-file tree-sitter extraction in a worker pool → nodes plus an `unresolved_refs` table → a resolution pass turns refs into edges (import resolver, name matcher, framework resolvers) → synthesizers add heuristic edges for dynamic dispatch. Sync is a filesystem reconcile: a `(size, mtime)` stat pre-filter, then a content-hash confirm, then re-extraction. Cross-file consistency is kept by patching: edges into a changed or removed file are turned back into pending refs and re-resolved ("resurrection"), driven by a delta of defined names. Edges carry `provenance`. A manual `EXTRACTION_VERSION` tells users to re-index after extractor changes. Sources: `src/extraction/index.ts`, `src/db/schema.sql`, `src/extraction/extraction-version.ts`, `AGENTS.md`.

**CodeGraphContext.** Discover files → a pre-scan builds a repo-wide `imports_map` (name → defining files) → parallel parse → ordered graph writes → linking passes for calls and inheritance. Each call edge gets a resolution tier with a numeric confidence from 1.00 (explicit `this`/`self`) down to 0.25 ("alphabetical-first of multiple candidates") and 0.08 (same-file fallback), labelled EXTRACTED / INFERRED / AMBIGUOUS. Optional SCIP indexers give compiler-grade results. The watcher re-parses the changed file plus its caller and inheritance-neighbour files and relinks them. Sources: `tools/indexing/pipeline.py`, `resolution/calls.py`, `core/watcher.py`.

**GitNexus.** A DAG of 19 phases with declared dependencies (scan → structure → parse → routes → cross-file → scope resolution → MRO → DI → communities → processes) builds a graph in memory, then loads it into an embedded graph DB. Parse results are cached per file by content hash and parser identity; cross-file resolution "still runs from all current facts". The graph is staged, verified (persisted relationship counts against produced counts) and then published; a failed check keeps the previous index and records `incompleteReasons`. Staleness is commit-based: indexed commit against `HEAD` (`current / behind / diverged / unknown`), reported in every tool response. Sources: `ARCHITECTURE.md`, `GUARDRAILS.md`, `src/core/git-staleness.ts`.

**Trail-Code.** Walk → per-file extraction memoised by content hash (`extract-cache.ts`) → everything after extraction runs over the whole node set, so an incremental build is byte-identical to a cold one, pinned by a test. Freshness lives in the query path: every retrieval call runs a stat-only probe against a small fingerprint file (reported at about 3 ms for 280 files), hashes only files whose stat differs, and rebuilds before answering; the rebuild itself always reads and hashes every file. The cache is stamped with a hash of the extraction code itself. A lock prevents concurrent rebuilds; a failed refresh falls back to the graph on disk. Structural invariants (`invariants.ts`) gate every built graph. Optional LSP enrichment adds compiler-grade call edges because, per its comments, name-guessing halved precision. Sources: `src/graph/build.ts`, `fingerprint.ts`, `refresh.ts`, `extract-cache.ts`, `invariants.ts`, `lsp/enrich.ts`.

## 2. Review: adopt, adapt, or not

| # | Technique | From | Verdict | Why, for this project |
|---|---|---|---|---|
| 1 | Cache only file-local extraction; redo cross-file work rather than patch edges | Trail, GitNexus | **Adopt (D21)** | Makes incremental == full true by construction. CodeGraph's edge patching works but its code carries many issue-referenced special cases; too much surface for a solo project |
| 2 | Limit the cross-file redo to an exact affected set | (TypeScript itself) | **Adopt (D21)** | Our resolver is the type checker, so "redo everything" costs seconds (§3). TypeScript's builder program reports affected files by exported-shape change; verified in a sandbox (§3) |
| 3 | Stat probe per query, hash-confirm mismatches; full hash on rebuild | Trail, CodeGraph | **Adapt (D22)** | Cheap freshness in the query path. The mtime blind spot is accepted for ordinary queries only; the review gate (`ei_changes`), rebuilds and `ei doctor` always hash |
| 4 | Stamp the cache with a hash of the extractor code | Trail | **Adopt (D23)** | Removes a manual version bump that someone forgets |
| 5 | Keep unresolved references as records with reasons | CodeGraph | **Adopt (D23)** | Feeds `unresolved-import` and the scan summary; nothing disappears silently |
| 6 | Record per-file extraction failures with a reason | CodeGraph, CGC | **Adopt (D23)** | CGC notes a run with parse failures used to be indistinguishable from a clean one |
| 7 | Structural invariants + produced-vs-persisted counts before publishing; keep the old index on failure | Trail, GitNexus | **Adopt** (VERIFY/PUBLISH) | Matches the stage-verify-publish design; adds the count check and `incompleteReasons` |
| 8 | Disk is the truth; git only lists files | CodeGraph | **Adopt (D25)** | `git status` cannot see a pull or checkout that leaves a clean tree |
| 9 | One builder under a lock; a failed refresh must not break the query | Trail | **Adapt (D25)** | Adopted, but the fallback answer is marked `partial` + `stale-index` instead of being served as current |
| 10 | Success-shaped responses for expected conditions | CodeGraph | **Adapt (D24)** | Their maintainers report agents abandon a tool after one or two errors. Applied to the impact tools; `ei_workflow` unchanged; watched in the dogfood log because it is their observation, not our measurement |
| 11 | Small fingerprint file separate from the big cache | Trail | **Adopt** | The probe never loads the index |
| 12 | Phases with declared order and per-phase timing | GitNexus | **Adapt** | Five fixed phases with timings in `ei_status`; no general DAG runner |
| 13 | Built-in SQLite as the only backend | CodeGraph | **Adopt, M2a (D28)** | Good evidence it works on Node ≥ 22.5; primary store once OMP's runtime is checked, JSON fallback otherwise |
| 14 | Seed a git worktree's index from the parent checkout | Trail | **Adopt, M5 (D28)** | Owner decision |
| 15 | Framework route detection (Next.js, Expo Router, …) | CodeGraph, GitNexus | **Adopt, M4 (D28)** | Next.js, Expo Router and Hono first; config globs remain as an override |
| 16 | Name-guess resolution tiers | CGC, CodeGraph | **Not adopted (D26)** | Conflicts with "evidence or unknown". Trail measured the precision cost and added LSP to escape it |
| 17 | Synthesized heuristic edges across dynamic dispatch | CodeGraph | **Adopt, M4 (D28)** | As clearly separated `heuristic` bridges that never upgrade completeness (DESIGN §6.9) |
| 18 | In-place edge patching on sync | CodeGraph | **Not adopted (D26)** | See #1 |
| 19 | Commit-based staleness | GitNexus | **Not adopted (D26)** | Our agent edits uncommitted code; freshness must follow the working tree |
| 20 | File watchers | CodeGraph, CGC | **Adapt, M5 (D28)** | In-session optimisation only; the probe and full hash remain the authority. No daemon |
| 21 | Embeddings | GitNexus, CGC | **Adapt, M6 (D28)** | Optional local model for code search only; never evidence |
| 22 | Graph DB server, community detection | CGC, GitNexus | **Not adopted (D26)** | Not needed at this scale |

## 3. Experiments run for this review

Scripts are in `docs/research/experiments/` (run with a TypeScript install on `NODE_PATH`). Sandbox: 2 cores, Node 22, TypeScript 6.0.3.

**A. Does TypeScript report the right affected files?** (`ts-affected.cjs`; four tiny files: `b` imports `a`, `d` imports `b`, `c` unrelated)

| Change | Files reported affected |
|---|---|
| Cold build | a, b, c, d |
| No change | none |
| First edit to `a` (body only) | a, b, d (conservative: no stored shapes yet) |
| `a`: add an optional parameter | a, b (`b`'s exported shape unchanged, so `d` is not touched) |
| `a`: change the return type | a, b, d |
| New file `e` importing `a` | e |
| Delete unrelated `c` | none |

Result: usable as the affected-set oracle. Not yet tested: project references, `paths` aliases, JS files, persistence across sessions. M2 must re-verify.

**B. What does a cold whole-repo resolve cost?** (`ts-extract-cost.cjs`; create a program, then resolve every identifier with the checker)

| Codebase | Files | Lines | Create program | Resolve pass | Identifiers | Peak RSS |
|---|---|---|---|---|---|---|
| CodeGraph `src/` | 327 | 201,279 | 1.9 s | 7.0 s | 351,921 | 611 MB |
| GitNexus `gitnexus/src/` | 1,130 | 387,897 | 2.8 s | 8.9 s | 505,580 | 818 MB |

Caveat: neither checkout had `node_modules`, so external types did not resolve (4% and 13% of identifiers unresolved). Real projects load library types and will be slower and use more memory. Reading: cold builds are seconds-to-tens-of-seconds and need most of a gigabyte, which confirms the worker thread, the memory budget, and the value of warm updates.

## 4. Open items this review creates for M2

1. Re-verify experiment A on the fixture monorepo (project references, `paths`, JS).
2. Evaluate persisting TypeScript build info so a new session with a few changed files avoids a cold resolve. Until proven, that case is a cold resolve.
3. Re-measure experiment B on a project **with** `node_modules`, and set the worker memory cap from that number.
4. `ei doctor --deep`: full rebuild diffed against the active index, as the standing check that incremental == full.
