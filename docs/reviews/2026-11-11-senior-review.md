# Senior review — ksd-intelligence design set

> **Date:** 2026-11-11. **Reviewed:** `docs/DESIGN.md` (D01–D28), `docs/TOOLS.md`, `docs/RISK.md`, `tests/golden/M2-impact-cases.md`, `AGENTS.md`, briefs M0–M1, `docs/research/index-techniques.md`.
> **Reviewer stance:** written as a critical second pass over the whole set, including decisions the same assistant recommended earlier. Where an earlier recommendation is judged wrong, this says so.
> **Outcome:** the direction is sound and M0/M1 can proceed. **M2a should not start until the four blockers are resolved.** Document drift found during the review was fixed in the same pass (§6).

---

## 1. What holds up

- Evidence-or-unknown as the organising rule, with scoped completeness gaps. It is the one thing none of the reference projects does consistently.
- The skill router: small, tested against real sources, verified live. No findings.
- Cache file-local work, re-resolve only the compiler-reported affected set. Re-tested in this review on harder cases (§5): it also handles a new file that fixes a broken import, deletion of an imported file, and global declarations.
- Stage → verify → publish with the old index kept on failure.
- Owner-owned golden expectations, mutation smoke, and milestone-by-milestone review of an agent-built system.

## 2. Blockers (resolve before M2a)

### B-1. The design depends on runtime facts nobody has checked

Worker threads, a built-in SQLite module, how `typescript` is resolved from an extension loaded by path, and available memory all depend on the runtime OMP uses for extensions (the M0 report calls OMP a "binary"). Storage choice, the worker model and the dependency story hang on the answers, yet the check sits as the first bullet of M2a, after the design is fixed.

**Recommendation:** a short spike with its own gate, **M1b**, before any M2a code: inside a loaded extension, report runtime name and version; start a worker and terminate it; import `typescript`; open the built-in SQLite and run an FTS5 query; allocate and report memory limits. One page of facts. Then adjust §6.2.1 and §11 once, instead of carrying "if available" branches through the build.

### B-2. Two "pending" risk decisions are actually prerequisites, and one recommendation was wrong

`docs/RISK.md` lists R5 (`typescript` as a runtime dependency) and R6 (engine in a worker) as open choices. The impact engine cannot exist without R5, and §6.2.1's own measurements make R6 mandatory. They should move into DESIGN as decided.

R5's recommended default, "use the workspace's own `typescript` first", should be reversed. Loading a compiler from the repository being analysed executes that repository's code inside the OMP process. That is acceptable in the owner's own projects and not acceptable by default for a cloned third-party repo (M3 plans to index oh-my-pi and a GitLab project). It also makes results depend on whatever version each repo has, which undermines the canary.

**Recommendation:** bundled, pinned `typescript` by default (the canary tests exactly that version); `impact.useWorkspaceTypescript: true` as an explicit per-project opt-in; a newer syntax the bundled version cannot parse is reported as `unsupported-syntax`, never guessed.

### B-3. Memory and program lifetime are unspecified for a monorepo

Measurements: 0.6–0.8 GB for 200k–390k lines **without** library types. A real Next.js or React Native workspace loads `node_modules` types and will be larger. The design keeps "one TypeScript project per tsconfig" alive for incremental updates, so memory is the sum over projects, per OMP session, on top of the in-memory graph. A 1.5 GB cap could make the engine fail on exactly the projects it is meant for.

**Recommendation:** M1b measures on one real project with `node_modules`. Then choose explicitly: (a) keep builder state only for projects touched in this session and drop the rest after publishing; (b) build projects sequentially and release each program; (c) a single merged program. Write the choice and the measured ceiling into §6.2.1. Also decide what a second concurrent session does (see M-7).

### B-4. Two core definitions are missing

1. **Stable key grammar.** `<path>#<qualified name>` is not enough: arrow functions assigned to `const`, object-literal methods, anonymous default exports, class expressions, declarations merged across namespace/function, and two same-named local functions in different scopes all need a rule. So does "the enclosing symbol of a call site" when the call is at module top level or inside an anonymous callback (C03 sidesteps this with "a symbol in checkout.ts").
2. **Which uses are indexed.** "Resolve every identifier" produced 350k–500k resolutions in the measured repos. Locals and parameters must be excluded; the rule for what counts as an indexable declaration (module-level, exported, class and interface members, object-literal members of exported values?) decides index size, speed and what `ei_impact` can target.

Both must be written down (an ADR each) before the extractor is built, because they are baked into every record and every golden expectation.

## 3. Major findings

### M-1. "RISK low" conflates two different things

Engine risk is derived only from completeness and surface. A private function with fifty callers across six packages is `complete` and has no factor, so it reads `RISK low`. What that means is "the picture is complete", but an agent will read it as "safe to change". This came from a policy the assistant recommended and the owner confirmed (P1), so changing it needs the owner.

**Recommendation:** separate the two ideas in the contract and in the text. Keep completeness as is. Replace engine `risk` with (or add beside it) a **reach** summary: direct callers, files, packages crossed, routes reached. Let the level use reach thresholds (for example, callers in another package → at least `medium`). Tool text leads with reach, not with a word that sounds like a safety verdict. Golden expectations for `risk` would be re-confirmed.

### M-2. The correctness oracle is too thin for the claim being made

Twenty-five hand-written cases on a toy fixture are the only proof that the engine never returns a false "complete". Two inexpensive, independent oracles are available and need no labelling by the owner:

1. **Differential test against TypeScript's own find-references.** For a few hundred sampled declarations in real repositories, the set of referencing sites from the language service must be a subset of the index's edges. Any miss is a bug with a reproducer.
2. **Randomised incremental-equals-full.** Apply random sequences of edits, renames, adds and deletes to the fixture; after each, the incremental index must equal a cold build. Five scripted freshness cases cannot cover the interaction space.

Both belong in M2a/M2b acceptance and in `ei doctor --deep`.

### M-3. Principles and scope drifted apart

Principles 6 and 7 said "only on evidence" and "no daemons, zero dependencies" while D28 added six ungated items, a watcher, and two runtime dependencies. The text is now reconciled (§6), but the substance remains: the plan is nine milestones for one owner reviewing an agent's work, which is the effort the original export estimated at 22–33 person-weeks.

**Recommendation (order, not scope):** M1 → M1b → M2a → M2b → start M3 → **M4a** (B1–B2 route detection: these are file-convention facts, not heuristics, and directly reduce `unknown`) → M2c → **M6a** (lexical search only) → **M4b** (B3–B6, one flow at a time, each justified by dogfood entries) → M5 → M6b (embeddings). The watcher is last because the stat probe already costs milliseconds; embeddings are last because their value on mixed Thai/English identifiers is unknown.

### M-4. `docs/RISK.md` in limbo makes other documents conditional

TOOLS.md carries `[policy]` branches, the roadmap has a conditional M2c, and the name cross-check (R4), which is the main defence against false "complete", is "proposed". An implementing agent cannot build against "maybe".

**Recommendation:** the owner decides R1–R4 and R7–R9 in one sitting; R5/R6 move to DESIGN (B-2). R4 should be treated as part of the engine's correctness, not as an optional risk feature.

### M-5. First-call experience does not match the measured cost

A query waits "up to its budget" (5 s) and then returns `index-building`, but a cold build measured about 10 s on a mid-size repo. The first call in every new repository would therefore always return guidance, and agents retry immediately rather than wait.

**Recommendation:** the first call blocks for up to roughly a minute while streaming progress through the tool's update callback (the verified `execute` signature has one), and returns the real answer. `index-building` is reserved for builds that exceed that.

### M-6. The freshness probe is underspecified

"One stat per file" over the fingerprint cannot see **new** files; detecting them needs a directory or git listing on every query, whose cost on a large repo is unmeasured. Separately, the freshness golden cases edit files and query again within milliseconds, which is exactly the probe's blind spot, so they would be flaky.

**Recommendation:** define the probe as listing + stat and measure it in M2a; run the freshness cases with `freshness: "hash"` and add one explicit test that documents the blind spot.

### M-7. Multiple sessions on one repository

The lock stops two builders, but each OMP session (or sub-agent) that sees drift needs its own compiler program to update, so memory and cold-resolve time are paid per session.

**Recommendation:** only the lock holder updates; other sessions read the published index and, if it is behind, answer with `stale-index` and the drift list rather than building their own.

### M-8. Tool text has two verdict lines and a tight batch budget

With the policy layer on, `ACTION … level high` sits above `RISK medium`. Two levels on adjacent lines invite the agent to pick the lower. And 6,000 characters across five targets leaves about 1,200 each, which cannot hold a caller list.

**Recommendation:** one verdict line (`ACTION run-tests · high (zone payments) · picture complete`), with reach on the next; budget per target (about 4,000) with a total cap, and overflow guidance as designed.

### M-9. The golden file no longer matches the contract around it

Its contract block predates `bridged`, the guidance outcome, and `stale-index`; its code list says "error codes". Expectations themselves are still valid. Because the file is owner-owned, it was not edited in this review.

**Recommendation:** the owner approves a contract-header refresh (no expectation changes) at the same time as the M-1 decision, since M-1 would change `risk` expectations anyway.

## 4. Minor findings

| # | Finding | Suggestion |
|---|---|---|
| m-1 | `<repo-id>` for the cache dir is undefined; no size report or pruning | Hash of the real path of the repo root; `ei cache list` with sizes; prune caches unused for 30 days |
| m-2 | `Evidence` (§7.1) is defined but `ImpactNode` does not carry extractor or revision | Either use it or delete it |
| m-3 | A global `.d.ts` edit re-affects every file (§5) | Expected; say so in §6.2.1 so a slow update there is not reported as a bug |
| m-4 | `ei_workflow` returns errors for missing skills while impact tools return guidance | Keep as decided; add the "did the agent stop calling tools after an error" check to the M1 scenarios |
| m-5 | B3 path matching across several apps in one monorepo can match the wrong app's route | Scope a match to the caller's app/package unless a base URL says otherwise; otherwise list all as candidates |
| m-6 | The embedding model, its runtime and licence are undecided | Fine for now; M6b starts with a written comparison, not code |
| m-7 | No statement of what happens to the index on `git checkout` of a branch with very different content | It is ordinary drift; note that a large switch is effectively a cold resolve |

## 5. Checked during this review

Re-ran the affected-set experiment on cases the first run did not cover (`docs/research/experiments/ts-affected-add-delete-global.cjs`, TypeScript 6.0.3):

| Change | Files reported affected | Reading |
|---|---|---|
| Add a file that satisfies a previously broken import | new file, importer, importer's importer | Correct |
| Add a global declaration file | every file | Correct and expected (m-3) |
| Delete a file that others import | its importer and that importer's importer | Correct |
| Restore it | the file and both importers | Correct |
| Add a new export to an imported file | the file and its direct importer | Correct, stops when the importer's shape is unchanged |
| Internal-only edit once shapes are known | the file alone | Correct |

Still unverified: project references, `paths` aliases, JS files, behaviour with library types loaded, and persistence across sessions.

## 6. Fixed in this pass (document drift, no design change)

DESIGN.md: label legend; principles 3, 6 and 7 reconciled with D28; layer diagram and layout (bridges, search, watch, storage); §6.2 bullets that still described the language service and hash-every-query; milestone tags for `ei_status` (M2a), `ei_impact` (M2b), `ei_changes` and `ei audit` (M2c) in §6.2, §8.1 and the CLI list; config example gained `freshness`, `watch`, `bridges`, `search`, `riskZones`; storage table headings; notes on D09, D10, D14, D15, D19; public API gained `index`, `changes`, `search` and the outcome wrapper; open questions updated. TOOLS.md: milestone tags.

## 7. Decisions needed from the owner

| # | Decision | Reviewer's recommendation |
|---|---|---|
| 1 | Add **M1b runtime spike** before M2a (B-1, B-3) | Yes |
| 2 | Bundled TypeScript by default; workspace copy opt-in (B-2) | Yes |
| 3 | Move R5/R6 into DESIGN as decided; decide R1–R4, R7–R9 now (M-4) | Confirm all, with R4 treated as core |
| 4 | Replace the single "risk" word with completeness + reach (M-1); re-confirm affected golden expectations | Yes; it is the finding most likely to cause a real mistake |
| 5 | Add the differential and randomised tests to M2a/M2b acceptance (M-2) | Yes |
| 6 | Milestone order in M-3 | Yes, or keep the current order knowingly |
| 7 | First call blocks with progress (M-5); single-builder rule for sessions (M-7); one verdict line and per-target budget (M-8) | Yes to all three |
| 8 | Refresh the golden file's contract header (M-9) | Yes, together with decision 4 |

## 8. Resolution (2026-11-11)

The owner delegated all eight decisions to this review's recommendations. Applied the same day:

| # | Decision | Where it landed |
|---|---|---|
| 1 | M1b runtime spike gates M2a | DESIGN D29, §13; `docs/briefs/M1b-runtime-spike.md` |
| 2 | Bundled TypeScript by default, workspace copy opt-in; worker mandatory | DESIGN D30; RISK §3.3, R5 amended |
| 3 | RISK R1–R9 confirmed; name cross-check is engine correctness (M2b) | DESIGN D37; RISK status "in force" |
| 4 | Completeness + reach + factors; one derived verdict; no engine "risk" word | DESIGN D32, §7.2, §7.4; TOOLS §4–5; golden file contract and every expectation restated |
| 5 | Differential and seeded randomised tests in acceptance | DESIGN D36, §13 (M2a), §14 |
| 6 | Milestone order | DESIGN D33, §13; AGENTS.md table |
| 7 | First call blocks 60 s with progress; lock holder is the only builder; one verdict line; per-target budget | DESIGN D35, §6.2.1; TOOLS §4, §8 |
| 8 | Golden contract header refreshed; new cases C21–C26, F06, P01–P05, X01–X03 confirmed | `tests/golden/M2-impact-cases.md` |

Blocker B-4 is closed by ADR 0002 (stable keys) and ADR 0003 (indexed declarations). B-3 is decided provisionally (DESIGN D31) and finalised by M1b's measurements. Minor findings m-1, m-2, m-3, m-5 are applied in DESIGN; m-4 became scenario S8 in the M1 brief; m-6 and m-7 are noted for M6b and §6.2.1.

A finding made while applying these: an import of a package that is not installed must not be treated as a completeness gap, or every repository without `node_modules` would answer `unknown` everywhere. ADR 0003 separates unresolved relative/workspace imports (a gap) from unresolved bare package imports (counted and warned about, not a gap).
