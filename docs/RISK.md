# ksd-intelligence — Risk Containment Design

> **Status:** IN FORCE. Decisions R1–R9 confirmed 2026-11-11 by the owner's delegation to the design review of that date (DESIGN D37); R5 amended by D30 (bundled TypeScript by default). The verdict contract here follows DESIGN §7.2 (D32): one derived level and action, no separate engine "risk" value. Golden cases for this document are P01–P05 and X01–X03 in `tests/golden/M2-impact-cases.md`.
> **Scope:** how the library limits the damage from (a) its own wrong answers, (b) what it cannot see, (c) dangerous code areas, (d) skill text, (e) agent behaviour, (f) integration failures, (g) data leaks, (h) being built by an agent.

---

## 1. The core idea

The library is advisory and read-only, so it cannot stop a bad edit. It limits risk in three ways:

1. **Never overstate what it knows.** Semantic traversal and the name cross-check expose gaps (§3.1); neither can prove runtime coverage.
2. **Turn knowledge into an action.** Every resolved impact answer carries a verdict (§2). Risk zones can only raise it.
3. **Leave a trail.** Calls across OMP, CLI and AGY are logged without source text (§5). Audit failures are advisory and do not stop analysis.

Enforcement stays where it already is: OMP approvals, KSD policy, and the owner.

## 2. Policy layer: from risk to action

### 2.1 Risk zones (answers DESIGN open question 5)

Path-based declarations of dangerous areas in `ei.config.json`. A zone can only **raise** the level, never lower it.

```jsonc
"riskZones": [
  { "zone": "payments",   "floor": "high",     "match": ["**/payments/**", "**/billing/**", "**/subscription*/**"] },
  { "zone": "auth",       "floor": "high",     "match": ["**/auth/**", "**/session*/**", "**/middleware.ts"] },
  { "zone": "migrations", "floor": "critical", "match": ["**/migrations/**", "**/*.sql", "**/schema.prisma", "**/drizzle/**"] },
  { "zone": "prod-config","floor": "critical", "match": ["**/.env*", "**/*production*.{json,ts,yaml,yml}"] }
]
```

A zone applies when the **target file, any impacted node's file, or any changed file** (`ei_changes`) matches. The four zones above ship as defaults (R2); the owner edits or removes them per project.

### 2.2 Verdict contract

Defined once in DESIGN §7.2:

```ts
type Level  = 'low' | 'medium' | 'high' | 'critical' | 'unknown';
type Action = 'proceed' | 'run-tests' | 'check-gaps' | 'ask-owner';   // ordered, weakest → strongest

interface Verdict { level: Level; action: Action; zones: string[]; requiredActions: string[]; basis: string[] }
```

`ImpactResult` and `ChangesResult` carry `verdict`, alongside `completeness`, `reach` and `factors`.

### 2.3 Derivation table

Base verdict (no zone): picture incomplete → `unknown`; complete with a factor → `medium`; complete without → `low`.

| Zone floor | Base level | Level | Action | Required actions |
|---|---|---|---|---|
| none | `low` | low | `proceed` | none |
| none | `medium` | medium | `run-tests` | Run every file in `tests`. If `tests` is empty, say so in the report |
| none | `unknown` | unknown | `check-gaps` | Open each site named in `completeness.reasons`, state what was found, then decide |
| high | `low` / `medium` | high | `run-tests` | As `run-tests`, plus: call `ei_workflow` with `risk: high` at verify and review; call `ei_changes` before reporting done |
| high | `unknown` | high | `ask-owner` | Present gaps and planned change to the owner **before editing** |
| critical | any | critical | `ask-owner` | Present the planned change to the owner **before editing**; never batch with other changes |

Several zones: take the strongest action. The verdict is the first line of the tool result.

The verdict is advisory. Agents are instructed to follow it; only host permissions and the owner can stop actual edits. The audit log records the verdict given, not approval acknowledgements.

### 2.4 `ei_changes`: impact of what was actually changed

Closes the review-stage gap: "what does my diff affect?"

```ts
interface ChangesResult {
  base: string;                                   // default: merge-base with the default branch; --base to override
  changedFiles: { path: string; status: 'A' | 'M' | 'D' | 'R'; indexed: boolean }[];
  changedSymbols: { symbol: string; change: 'added' | 'modified' | 'removed' | 'signature-changed' }[];
  unindexedChanges: string[];                     // changed files the engine cannot analyse (.sql, native, config…)
  impact: Pick<ImpactResult, 'byDepth' | 'tests' | 'completeness' | 'reach' | 'factors'>;      // union over changedSymbols
  verdict: Verdict;
  freshness: ImpactResult['freshness'];
}
```

- Changed symbols: map diff hunks to enclosing declarations in the working tree; removed and signature-changed symbols are found by comparing with the base version of the file.
- A removed or signature-changed symbol that still has callers is listed first, with those callers.
- `unindexedChanges` is never empty-by-omission: every changed file is either indexed or listed there. Any entry adds reason `outside-index-scope` (status `partial`).
- Includes staged, unstaged and untracked changes.

### 2.5 Stage protocol (text only, delivered by `ei_workflow`)

The workflow header gains one line per stage telling the agent which evidence to gather. It is instruction text; the router does not import the impact engine.

| Stage | Line added to the header |
|---|---|
| investigate / implement | "Before changing a symbol, call `ei_impact` on it and follow the verdict's action." |
| verify | "Run the tests listed by `ei_impact` / `ei_changes`; report real output." |
| review / ship | "Call `ei_changes` and include its verdict and `unindexedChanges` in your report." |

## 3. Limiting the library's own wrong answers

### 3.1 Name cross-check (two methods must agree)

The main danger is a result marked `complete` that silently misses a caller. After the semantic traversal, the engine runs an independent lexical pass for the target's name over the index scope:

1. Collect every identifier token and string literal equal to the target's name (TS scanner; comments excluded).
2. Drop tokens already accounted for: the declaration, resolved references in the result, identifiers the checker resolves to a **different** declaration, and string literals whose contextual type is a literal type or union not built from `keyof` (D55).
3. Anything left is a potential hidden reference:
   - identifier the checker cannot resolve (`any`, error type, untyped JS) → reason `unresolved-name-match: file:line`
   - string literal with the same text → reason `string-name-match: file:line`
4. Any such reason makes status `partial` (so level `unknown`, action `check-gaps`), and the sites are listed for the agent to inspect.

Cost is one scan plus checker lookups on matching tokens only. It trades some extra `unknown` results on common names for a strong guard against false `complete`. Two new reason codes (R4).

### 3.2 Boundaries the index cannot see

Code that talks to SQL, native modules or other out-of-index systems is flagged as a **risk factor**, not a completeness gap (the function's TS callers are still fully known; what is invisible is the data or native contract).

| Boundary | Detected by (defaults, configurable) | Effect |
|---|---|---|
| `boundary:sql` | file imports one of `pg, postgres, mysql2, better-sqlite3, drizzle-orm, @prisma/client, kysely, knex` (matched by specifier text, installed or not), or uses a `sql` tagged template | factor → at least `medium` |
| `boundary:native` | imports `NativeModules` / `TurboModuleRegistry` from `react-native`; paths under `android/`, `ios/` | factor → at least `medium` |
| changed non-TS file | `ei_changes` sees a changed file outside the index | listed in `unindexedChanges`; `outside-index-scope`; zone floors apply (migrations → `critical`) |

The tool result states the limit in plain words when a boundary factor is present: "This code reaches a database; column- or schema-level effects are not analysed."

### 3.3 Other correctness guards

- **Freshness:** stat probe by default; content hash for changes, explicit index/doctor operations, or `impact.freshness: "hash"`.
- **Version stamp:** engine and TypeScript versions on indexed analysis results.
- **TypeScript:** `ei setup` installs the pinned runtime. `impact.useWorkspaceTypescript: true` explicitly trusts the project copy. V1 reports parser failures as `parse-error`; `unsupported-syntax` detection is **PLANNED (V2)**.
- **PLANNED (V2): `ei doctor` canary** and `engine-self-check-failed`. V1 `ei doctor --deep [--differential N]` compares the published index with a cold build and optional compiler references; it does not run a golden canary or set persistent degradation.
- **False-low stop rule** (DESIGN §13): one wrong `low` on a real change stops release or roadmap work until fixed and covered by an owner-approved regression.

## 4. Limiting integration and runtime risk

| Risk | Mechanism |
|---|---|
| Index work freezes the OMP session | Engine in a **child process** (D45/D50); the OMP process sends requests. Bun ignored worker memory limits in M1b |
| A query hangs | Bounded index-build wait with progress and guidance or explicitly stale results. A hard **5 s query budget is PLANNED (V2)** |
| Memory growth on a large repo | `impact.maxMemoryMb` (default smaller of 8192 MiB and half of RAM); Node child heap flag, Bun RSS watchdog. Use `ei_status` to narrow `impact.include` or raise the limit |
| Library must be turned off fast | `EI_DISABLED=1` disables EI tools; `ENGINEERING_PROXY_DISABLED=1` controls policy injection and delegated review. General per-capability `enabled` flags are **PLANNED (V2)**; `search.enabled` already controls search |
| Work in progress breaks daily use | Stable OMP channel is the accepted `main` marketplace catalog (D40/D41); npm publishes only on matching version tags (D65) |
| OMP upgrade changes the extension API | Re-run M1 scenarios. An OMP-version warning in `ei_status` is **PLANNED (V2)** |
| KSD and library disagree | KSD policy outranks skill text; the workflow tool always puts the precedence header first |

Every `execute` is wrapped: any thrown error becomes an `isError` result with a code. Nothing propagates into OMP.

## 5. Audit trail

Append-only JSON Lines at `~/.cache/ksd-intelligence/<repo-id>/audit.jsonl`, directory mode `0700`.

```jsonc
{ "ts": "2026-11-11T08:30:00+07:00", "tool": "ei_impact", "target": "packages/payments/src/fee.ts#calculateFee",
  "risk": "medium", "completeness": "complete", "action": "run-tests", "zones": ["payments"],
  "codes": ["public-export-surface", "route"], "ms": 84, "engine": "0.3.0", "ts_version": "5.9.2" }
```

- Stores targets, codes, verdicts and timings. **Never** source text, skill text, diffs, env values or tokens. Task strings are truncated to 200 characters.
- Rotates at 5 MB, keeps 3 files.
- `ei audit [--since 7d]` summarises: calls per tool, verdict distribution, slowest calls, and **symbols changed without a prior `ei_impact` call** (from `ei_changes` results compared with earlier log lines). Feeds `docs/dogfood-log.md` and makes any false `low` traceable after the fact.

## 6. Skills and data

**Skills** (in addition to the trust chain in DESIGN §6.1):

- Skill content lint is included in local skill lifecycle checks (`ei skills …`). It is a reading aid, not prompt-injection detection.
- Review the updated local checkout before repinning it. `ei sources check` compares reviewed commits and hashes; `--write` explicitly updates the lock.
- Per-provider pin status in `ei_status` is **PLANNED (V2)**; use `ei sources check` in V1.

**Data:**

- Default index excludes, two classes (D49):
  - **Always excluded, any kind:** `**/.env*`, `**/*.pem`, `**/*.key`, `**/node_modules/**`, `**/dist/**`, `**/.git/**`.
  - **Excluded by name only when the file is not code:** `**/*credentials*`, `**/secrets/**`. Code kinds (`ts`, `tsx`, `js`, `jsx`, `mjs`, `cjs`, `d.ts`) are never excluded by these name patterns. Reason: on oh-my-pi the name patterns removed 17 real source files (credential and secret handling code), which is a blind spot exactly where a wrong impact answer costs most. Files of kind `json` and `other` matching these names stay excluded and their content is never read.
  - The owner can still exclude any path, code included, with `impact.exclude`.
  - Excluded files still count for zone matching by path, never by content. The scan summary and `ei_status` report the number of files excluded by the secret rules.
- SQLite stores symbol tables and edges, not full files. Accepted M6a exception (D60/D62): FTS5 stores whitespace-collapsed declaration signatures and the first JSDoc paragraph, each capped at 400 characters, from successful indexing only. Do not put secrets in ordinary source, signatures, or comments.
- Per-repository cache directory: `0700`; index and audit file: `0600`. `ei cache clear` removes that repository's index and audit, not the shared runtime.
- **PLANNED (V2):** GitLab adapter and its env-only token rules; standalone `ei symbol`.
- V1 has no telemetry. The owner-run `ei setup` can contact the package registry. The local MCP server does not listen on a network port.

## 7. Limiting the risk of an agent building this library

The prototype already showed the failure mode: a test whose name claimed a branch it never executed.

1. **Owner-owned oracle.** Golden expectations and policies are edited only by the owner. The agent reports disagreements; it does not resolve them.
2. **Tests must be able to fail.** Each milestone's acceptance includes a **mutation smoke**: the agent applies listed one-line breaks (e.g. invert the risk policy, drop barrel resolution, skip the name cross-check) and shows that named tests fail for each, then reverts. A mutation no test catches is reported as a gap.
3. **Independent review.** Each milestone report is reviewed by someone other than the implementing agent before the tag is cut.
4. **One milestone at a time, tagged.** Accepted work gets a tag; the stable channel only moves on a tag.
5. **Evidence labels** (`VERIFIED / MOCK-ONLY / NOT VERIFIED`) on every claim, with commands and output.
6. **Gated growth.** D64 replaced the original five V2 entry gates with disabled-by-default shipping and measured value checks. Conditional M4–M6 candidates still need separate evidence.

## 8. Risk register

| # | Risk | Main mechanism | Lands in | Residual risk |
|---|---|---|---|---|
| 1 | Result marked complete but misses a caller | Name cross-check, golden and freshness tests; canary **PLANNED (V2)** | M2 | Runtime reflection and DI |
| 2 | Stale answer | Stat probe, full-hash review, incremental == full | M2 | Same-size/restored-mtime edits can evade the stat probe |
| 3 | Agent trusts `low` in a dangerous area | Risk zones + action table §2 | M2b | Zone globs wrong or missing for a project |
| 4 | Schema / native change analysed as safe | Boundary factors; `unindexedChanges`; migration zone → `ask-owner` | M2b | Column-level effects still not analysed, only flagged |
| 5 | Review misses what the diff affects | `ei_changes` §2.4 | M2b | Agent does not call it (visible in audit) |
| 6 | Agent ignores the verdict | Verdict first in result; stage protocol; audit trail | M2b | Advisory only; OMP approvals and owner are the real stop |
| 7 | Tampered or changed skill text | sha256 + commit lock; lint on re-pin | Done / M2b | Malicious text present at first pin and not noticed by the owner |
| 8 | Library freezes or crashes OMP | Contained child, existing time/memory limits, wrapped execute, kill switch | M2 | Hard 5 s per-query budget **PLANNED (V2)** |
| 9 | Dev build breaks daily work | Stable marketplace `main` and matching npm tags | M1c/D65 | Owner loads a dev build by hand |
| 10 | Secrets in cache or logs | Excludes, no-content cache, redacted audit, env-only token | M2 | Secrets hard-coded in ordinary source files are indexed as code |
| 11 | Vacuous tests, self-graded work | Owner oracle, mutation smoke, independent review | M2 onward | Mutations list is finite |
| 12 | OMP upgrade breaks the adapter | Re-run live smoke; version check **PLANNED (V2)** | V1/V2 | Silent behavioural change with same API |
| 13 | Scope creep for a solo owner | V2 gates; out-of-scope list | Now | Owner overrides the gates |

The following are **PLANNED (V2)** conditional designs, except SQLite (D46 chose built-in SQLite and dropped the fallback):

| # | Risk | Main mechanism | Lands in | Residual risk |
|---|---|---|---|---|
| 14 | A heuristic bridge edge is read as proof, or hides a real gap | Bridged edges live in a separate `bridged` list and `Possible (heuristic)` section; a bridge never upgrades completeness or lowers a level; literal-only matching | M4 | A wrong literal match (two routes with the same path in different apps) shown as a candidate |
| 15 | Half-bridged flow makes the agent read more, not less | Bridge ships only with an end-to-end fixture flow; per-bridge config switch | M4 | Flows that mix a supported and an unsupported framework |
| 16 | Watcher misses an event and an answer is stale | Watcher is never the authority: probe on overflow/error/start/interval; `ei_changes` and rebuilds full-hash; identical-results test with watcher on and off | M5 | Up to one probe interval of extra latency, never a wrong answer |
| 17 | Semantic search hit taken as fact | `semantic` label on every such hit; search never feeds risk or completeness | M6 | Agent edits the wrong function suggested by similarity; `ei_impact` on it still shows real callers |
| 18 | Embedding model adds a heavy dependency, a download, or a licence problem | Optional; owner-run install only; local and replaceable; lexical tier works without it; choice made in M6 after measuring | M6 | Model quality on mixed Thai/English identifiers unknown until tried |
| 19 | Built-in SQLite unavailable or different across runtimes | Node ≥ 22.5 or OMP's compatible Bun host; version/status checks (D46) | M2a | An unsupported runtime must report degradation |
| 20 | Scope growth overwhelms a solo owner | M4–M6 are separate milestones with their own exit gates; dogfooding starts after M2b and can reorder them | Now | Review load: six more milestone reports to check |

**Not addressed by design:** concurrency and runtime bugs, business-logic correctness, effects on external consumers of public packages (flagged, not analysed), and anything the agent does outside these tools.

## 9. Decisions (confirmed)

| ID | Decision | Outcome (2026-11-11) |
|---|---|---|
| R1 | One verdict (level + four actions) derived from completeness and factors, raised by risk zones | Confirmed (as reframed by DESIGN D32) |
| R2 | Ship the four default risk zones (payments, auth, migrations, prod-config), editable per project | Confirmed |
| R3 | Add `ei_changes`; base defaults to merge-base with the default branch | Confirmed |
| R4 | Name cross-check with `unresolved-name-match` and `string-name-match`; `engine-self-check-failed` **PLANNED (V2)** | Confirmed; canary not shipped |
| R5 | Use pinned TypeScript provisioned by `ei setup`; workspace copy by opt-in (D44) | Confirmed as amended |
| R6 | Engine child process, not worker thread (D45/D50) | Confirmed as amended |
| R7 | Audit log as specified (no source text), with `ei audit` | Confirmed |
| R8 | Stable marketplace on accepted `main`; matching tags publish npm (D40/D41/D65) | Confirmed as amended |
| R9 | Mutation smoke in every milestone's acceptance from M2 on | Confirmed |

Also confirmed: route patterns in `impact.routes` accept globs.

## 10. Where each mechanism lands

| Milestone | Mechanisms |
|---|---|
| M1 / M1c | Marketplace stable channel; OMP version warning **PLANNED (V2)** |
| M1b | Runtime spike, including rejected worker memory limit |
| M2a | Child process, kill switch, default excludes, stamps, differential and randomized tests; canary **PLANNED (V2)** |
| M2b | Name cross-check, boundary factors, manual route globs, reach and base verdict |
| M2c / M6a | Risk zones, `ei_changes`, stage protocol, audit, and lexical search |
| M3 | Dogfood with audit summaries; false-low stop rule in force |

## Appendix A. Golden cases

The cases first drafted here are now confirmed in `tests/golden/M2-impact-cases.md`: C21–C26 (engine, M2b) and P01–P05, X01–X03 (policy and changes, M2c).
