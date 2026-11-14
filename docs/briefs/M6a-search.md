# M6a — `ei_search`, lexical (agent brief, DRAFT)

**Draft.** Start with Round 0 (`README.md`).

Read `docs/briefs/README.md` (common rules). Then `docs/DESIGN.md` §6.11, §11 and decision D46; `docs/TOOLS.md` §7, §8; `docs/RISK.md` §6; `docs/adr/0002-stable-keys.md`, `0003-indexed-declarations.md`.

**Branch:** `m6a-search` from `origin/main`.

## Goal

The agent asks "where is the code that does X?" in a few words and gets ranked declarations with `path:line`, instead of grepping. Lexical only: no embeddings, no model, no network, no new dependency (SQLite FTS5 was verified in OMP's runtime and in Node in M1b).

## Round 1 — search index

- An FTS5 table in the repository database, filled during publish and maintained by updates. Per indexed declaration: stable key, name split into identifier segments (`retryWebhook` → `retry webhook`, `HTTP_TIMEOUT_MS` → `http timeout ms`, `parseURL2` → `parse url 2`) plus the unsplit name, owner name, kind, the signature text, the first paragraph of its doc comment, path segments.
- It is part of the index: the extractor stamp covers it; incremental == cold includes it (canonical lines); `ei doctor --deep` compares it.
- **What is stored.** Signatures and doc comments are source text. Until now the cache held symbol tables and edges only (RISK §6). Storing them is a change to that rule: limit it to indexable code files (never secret or excluded files), cap each field (signature 400 characters, doc 400 characters), and record the change in RISK §6 and the decision log as PROPOSED for the owner. The cache stays `0700`/`0600`.
- Report database size before and after on the reference repositories.

Risky cases, one test each:
- Identifier splitting: camelCase, PascalCase, snake_case, kebab in paths, acronyms (`XMLHttpRequest`), digits, `$` and `_` prefixes, non-ASCII identifiers.
- A declaration in a secret-named code file is searchable by name (D49); a `.env` or excluded file contributes nothing.
- Update after a rename, a deleted file, an edited doc comment: incremental == cold for the search rows.
- A file that fails to parse contributes nothing and does not break the build.

## Round 2 — query, ranking, tool

- Input per TOOLS §7: `query` (1–200 characters), `limit` 1–20, default 8.
- **Query handling:** split the query like identifiers; every term is passed to FTS5 as a quoted literal. No FTS5 operator from the user's text is ever interpreted.
- **Ranking:** BM25 over the fields with weights (name > owner > signature > doc > path); then boosts: a query term equal to the whole name (`exact`), exported, number of users (log-scaled, from the edges table). Ties broken by stable key, so results are deterministic. Graph-proximity boosting from DESIGN §6.11 is left out unless the fixed query set shows a need; say which.
- **Output** exactly per TOOLS §7 (budget 4,000 characters): match kind `exact` or `lexical`, `path:line`, signature, at most two facts (exported, user count, route when M4a exists). Footer `search: lexical only`. No matches → the success-shaped line. `details` carries the typed hits.
- Freshness as in M2b: stat probe; drift → update within the budget, else answer from the published index and say `STALE INDEX` in the footer. A stale search result is still useful; it never claims to be fresh.
- Register `ei_search`; CLI `ei search <query> [--limit N] [--json]`; audit line (query truncated to 200 characters, no result text).

Risky cases, one test each:
- Query containing `"`, `*`, `-`, `(`, `:`, `NEAR`, `OR`, a column name, a trailing backslash, 200 characters of punctuation: no SQL or FTS error, no operator semantics.
- Empty query, whitespace only, one character, only words that match nothing, `limit` 0 and 21: error result or the no-match line, never a throw.
- A query equal to an exact name returns it first, labelled `exact`.
- Same query twice → identical bytes; result order independent of insertion order (cold vs incremental index).
- 50,000 declarations: p95 under 300 ms including the probe.
- Hits never include a `semantic` label, and no text suggests installing anything.
- No index yet → the same build-then-answer behaviour as `ei_impact`.

## Round 3 — fixed query set, live, measurements

- `tests/golden/search-queries.md`, **PROPOSED**: 20 queries for this repository and 20 for the M3 work repository (described without copying its code: query, the declaration that should appear, the rank it must reach). The agent drafts them from the dogfood log's "Missing" entries and real greps; the owner confirms. After confirmation it is frozen like the other golden files.
- Report: for each query, rank of the expected declaration; share in the top 3 and top 8. The owner sets the pass mark; the default is 80% in the top 8 and none of the confirmed ones missing entirely.
- **Live (label the OS):** through `omp -p`, ask the agent to find where something is implemented without naming the symbol; paste the `ei_search` call and output, and whether it followed with `ei_impact`.
- Latency p50/p95 on the reference repositories; database growth; `docs/research/m6a-measurements.md`.
- Mutation smoke: operators interpreted; secret file indexed; exact match not first; non-deterministic order; stale answered as fresh.

## Round 4 — review, then fix

Use the round types in `README.md`.

**Review focus**
1. Query text reaching FTS5 or SQL uninterpreted and safely.
2. Source text stored beyond the stated fields and caps; anything from secret or excluded files.
3. Incremental == cold for the search rows; determinism.
4. Ranking claims the tests do not actually check.
5. Text that differs from TOOLS §7; a `semantic` label or an install hint.
6. Search results used anywhere as evidence for completeness, reach or a verdict (forbidden: DESIGN §6.11).

## Acceptance

1. Tests green; incremental == cold and `ei doctor --deep` cover the search table.
2. The confirmed query set meets the owner's pass mark on both repositories.
3. Latency and size reported; live output pasted; mutation smoke clean.
4. RISK §6 change approved by the owner.
5. CI green on macOS and Linux after the owner pushes.

## Do not

- Add embeddings, a model, a vector store or any dependency (that is M6b, deferred, separate approval).
- Let a search hit influence a verdict.
- Store full file contents.
