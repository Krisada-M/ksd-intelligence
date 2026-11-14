# M2b — `ei_impact` (agent brief)

Read `AGENTS.md` first. Then `docs/TOOLS.md` §1, §4, §8, §10; `docs/DESIGN.md` §6.2, §7.2, §7.4, §7.9, §12 and decisions D32, D35, D50–D52; `docs/adr/0002-stable-keys.md`; `docs/adr/0003-indexed-declarations.md`; `docs/RISK.md` §3.2; and all of `tests/golden/M2-impact-cases.md`.

M2a is accepted and merged. This brief covers M2b only. **Do it in the three steps below, in order. Stop and report after step 3.**

**Model:** Claude Opus 5.5 at effort `xhigh`. State the exact model in the report. Live OMP checks: `omp -p --no-extensions --model claude-haiku-4-5 -e dist/adapters/omp/extension.js …`.

**Branch:** `m2b-impact` from the current `origin/main`. Never commit to `main`. Commit locally with `dist/`; do not push.

## Goal

An agent calls `ei_impact` before changing a symbol and gets, in one text block: who depends on it, how far the change reaches, which tests reach it, whether the picture is complete, and one verdict. The oracle is `tests/golden/M2-impact-cases.md`: cases C01–C26 and F01–F06. The text contract is `docs/TOOLS.md` §4.

A wrong `low` is the worst possible result of this milestone. When in doubt, the picture is `partial`.

## Step 1 — index additions (changes the extractor)

These change what the index holds, so they come first and the M2a checks must stay green after them.

### 1.1 Key access through `keyof` (D52)

Today `get(u, "cost")` with `K extends keyof Usage` stores no edge to `Usage.cost`, so its impact silently misses that reader.

- A string literal whose contextual type is a key of a type with declared properties (`keyof T`, a type parameter constrained to it, or a union of such literals), and whose property resolves to exactly one indexed declaration: store a `REFERENCES` edge from the enclosing symbol to that property.
- When the literal is a key but the property cannot be resolved to one indexed declaration (a non-literal key expression of type `keyof T`, a union of several owners): store a gap site with reason `computed-member-access` scoped to the owner type, so every member of that type reports `partial` (golden P4: "affects values stored in the accessed object").
- Fixture-copy tests for both. Do not edit the base fixture or the golden file.

### 1.2 Anything a golden case needs that the index does not hold yet

Run through C01–C26 against the current index before writing query code. If a case needs data the index lacks (for example boundary markers for C24, package privacy for `public-export-surface`, test adjacency for C20), add it here and list each addition in the report. Prefer deriving at query time from what is stored; add to the extractor only when that is impossible.

### Step 1 checks

`npm test` green, including the randomised incremental == cold runs, `update-soundness`, the fixture differential (exact counts updated only where 1.1 legitimately changes them; explain each changed number) and the mutation smoke.

## Step 2 — query core (no agent tool yet)

Location: `src/core/impact/`. Pure functions over `Graph` and the published index; no TypeScript program is created to answer a query.

### 2.1 Targets

Accept each form in `docs/TOOLS.md` §4: bare name, qualified `Owner.member`, `path#name`, `path:line`, `path`.

| Input | Outcome |
|---|---|
| One declaration | `ImpactResult` |
| Several declarations | guidance `ambiguous-target`, candidates as `path#name`, sorted |
| None | guidance `target-not-found`, up to 5 closest names |
| Path excluded, secret or not indexable | guidance `NOT INDEXED <path> — <reason from the census>` |
| `path:line` inside a local function | the nearest indexed declaration enclosing the line; the result says so |
| A member of an anonymous object type (`Usage.cost.input`, D51) | the result for the nearest indexed parent, marked `partial` with reason `outside-index-scope: member of an anonymous object type is not indexed; reads through an alias of the parent type or a generic key may be missing`, and line 1 names both the asked member and the parent |
| `path` | per §4: exported declarations of the file that have users outside it, plus a count of the rest |

### 2.2 Result

Build `ImpactResult` exactly as in `tests/golden/M2-impact-cases.md` "Result contract" (types already in `src/core/kernel/types.ts`).

- **Traversal:** full depth (cap 10) always; `depth` only limits what is listed. Hitting the cap with unvisited nodes adds `depth-limit`.
- **Completeness:** from gap sites and unresolved records, scoped per golden P4. A gap that applies to the target or to any impacted symbol counts. Reasons are `code: detail` with `path:line`.
- **Reach:** per DESIGN §7.2, over compiler-grade edges only.
- **Factors:** per golden P2. `route` comes from `impact.routes` globs only (route detection is M4a). Boundaries per `docs/RISK.md` §3.2.
- **Tests:** files reached through `TESTS` edges and test files among the impacted symbols.
- **Verdict:** golden P1, rules 1–3 only. `zones` is always `[]` and no risk zone logic is written (that is M2c). `basis` lists the reasons and factors that produced the level.
- **Name cross-check:** `unresolved-name-match` and `string-name-match` records for the target's name make the picture `partial` (C22, C23).
- **`bridged`:** always `[]`.

### 2.3 Freshness (D50, D52)

Every query starts with the stat probe.

| State | Behaviour |
|---|---|
| No drift | Answer from the published index. No child process |
| No index yet | Build (engine child). Block up to 60 s with streamed progress; then answer. Past 60 s: guidance `index-building`; the build continues and the next call uses it |
| Drift, this session can take the lock | Update (engine child), block up to 60 s with progress, then answer; footer `index updated (n files)` |
| Drift, update still running at 60 s, or another session holds the lock | Answer from the published index: line 2 is `ACTION check-gaps · level unknown · picture partial (stale index)`, reason `stale-index` lists the drifted files (first 10, then a count). The update continues in the background |
| Update failed, older index exists | Same stale answer, plus the failure message under `Gaps` |
| Engine failure with no index | `isError`, `index-failed: …` per TOOLS §8 |

A stale answer is never `low`, `medium` or `complete`.

### Step 2 checks

- One executable test per golden case C01–C26, named with the case id, asserting what the case states and nothing weaker. Temp-copy cases build their own copy.
- F01–F06 at query level.
- A test that walks every golden case whose expected level is `unknown` and asserts the result is not `low` or `medium` under any `depth` from 1 to 10.
- If a golden expectation looks wrong, do not change it: report it and leave the test failing.

## Step 3 — tool, CLI, rendering

### 3.1 Rendering

`src/core/impact/render.ts`: text exactly per `docs/TOOLS.md` §4, including the three guidance shapes, batches of up to 5 targets, and the budgets (4,000 characters per target, 12,000 in total) with the over-budget rules. Same input → identical bytes. One verdict: no level word outside the `ACTION` line.

Snapshots under `tests/snapshots/impact/` for C01, C06, C11, C13, C14, C15, C26, a batch of 3, an over-budget case, the D51 parent case and a stale-index answer. They are **PROPOSED** until the owner reviews them; list them in the report with their paths. After acceptance they are frozen like golden expectations.

### 3.2 Tool and CLI

- Register `ei_impact` in the single extension entry, description and input exactly as TOOLS §4, `approval: 'read'`. `details` carries `ImpactResult[]` (and guidance objects). `EI_DISABLED=1` removes it with the other `ei_*` tools. Every `execute` is wrapped: nothing throws into OMP.
- `ei impact <target…> [--depth n] [--json]` prints the same text, or the typed result with `--json`.
- Do not register `ei_changes`, do not write the audit log (M2c).

### Step 3 checks

- Rendering, budget (property test), determinism, one-verdict and guidance-shape tests from TOOLS §10.
- **Live, on this repository:** build the index of `ksd-intelligence` itself, then through `omp -p` have the agent call `ei_impact` with a bare name (`Graph.incoming`) and with an ambiguous name; paste both outputs. Label the OS.
- **Latency on oh-my-pi** (index already built, no drift): 20 targets of mixed size, report p50 and p95 for the whole call. Target p95 < 300 ms. Also one call with drift from a one-file body edit; report the wall time and which row of 2.3 it took.
- Mutation smoke extended to the query core: at least these must be killed — a gap ignored in completeness; a factor dropped; `depth` changing the verdict; stale answer rendered as complete; heuristic edge counted in reach; ambiguous target answered as the first candidate.

## Acceptance

1. `npm test`, typecheck, lint, format and `check:dist` green on the machine used; CI on macOS and Linux green after the owner pushes.
2. All golden cases C01–C26 and F01–F06 pass at query level, or each failing case is listed with the reason and left failing.
3. No golden case with expected level `unknown` can be rendered `low` or `medium`.
4. Step 1 leaves the M2a checks green; `ei doctor --deep --differential 300` on oh-my-pi exits 0 after 1.1.
5. Snapshots listed as PROPOSED for owner review.
6. Live OMP output pasted; latency numbers in `docs/research/m2b-measurements.md`.
7. Report in the `AGENTS.md` template. **Stop.** Do not start M2c or M3.

## Do not

- Edit `tests/golden/**`, `src/policy/**`, or weaken any M2a equality check.
- Implement risk zones, `ei_changes`, the audit log, route detection, heuristic bridges or search.
- Add a completeness reason, factor, guidance or failure code that is not in DESIGN §7.2. If one seems needed, stop and ask.
- Use the network, install or change OMP plugins, or edit `~/.omp/**`.
- Push, or commit to `main`.
