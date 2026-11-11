# ksd-intelligence — Risk Containment Design

> **Status:** IN FORCE. Decisions R1–R9 confirmed 2026-11-11 by the owner's delegation to the design review of that date (DESIGN D37); R5 amended by D30 (bundled TypeScript by default). The verdict contract here follows DESIGN §7.2 (D32): one derived level and action, no separate engine "risk" value. Golden cases for this document are P01–P05 and X01–X03 in `tests/golden/M2-impact-cases.md`.
> **Scope:** how the library limits the damage from (a) its own wrong answers, (b) what it cannot see, (c) dangerous code areas, (d) skill text, (e) agent behaviour, (f) integration failures, (g) data leaks, (h) being built by an agent.

---

## 1. The core idea

The library is advisory and read-only, so it cannot stop a bad edit. It limits risk in three ways:

1. **Never overstate what it knows.** Two independent methods must agree before a result is called complete (§3.1).
2. **Turn knowledge into a required action.** Every impact answer carries one verdict: a level and one of four actions, from "proceed" to "ask the owner first" (§2). The base verdict comes from completeness and factors; risk zones can only raise it.
3. **Leave a trail.** Every tool call is logged without source text, so the owner can see afterwards what the agent checked and catch any wrong `low` (§5).

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

The agent cannot override a verdict. The owner can, by saying so in the session; the library does not track acknowledgements (it is stateless), the audit log records the verdict that was given.

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
| review / ship | "Call `ei_changes` and include its `policy` verdict and `unindexedChanges` in your report." |

## 3. Limiting the library's own wrong answers

### 3.1 Name cross-check (two methods must agree)

The main danger is a result marked `complete` that silently misses a caller. After the semantic traversal, the engine runs an independent lexical pass for the target's name over the index scope:

1. Collect every identifier token and string literal equal to the target's name (TS scanner; comments excluded).
2. Drop tokens already accounted for: the declaration, resolved references in the result, and identifiers the checker resolves to a **different** declaration.
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

- **Freshness on every query** by content hash (already in DESIGN).
- **Version stamp** in every result: engine version and TypeScript version used.
- **TypeScript source (R5, amended by DESIGN D30):** the library's bundled, pinned `typescript` by default, so no code from the analysed repository runs inside OMP and results do not vary by repo. A project can opt in to its own copy with `impact.useWorkspaceTypescript: true`. Syntax the bundled version cannot parse is reported as `unsupported-syntax`.
- **`ei doctor` canary:** runs the golden fixture against the TypeScript version in use; a failing case marks the engine `degraded` in `ei_status`, and every impact result then carries status `partial` with reason `engine-self-check-failed`.
- **False-low stop rule** (already in DESIGN §13): one wrong `low` on a real change halts the roadmap until fixed and a regression case is added to the golden file.

## 4. Limiting integration and runtime risk

| Risk | Mechanism |
|---|---|
| Index work freezes the OMP session | Impact engine runs in a **worker thread** (one long-lived worker, no per-call subprocess). Main thread only posts requests. To be verified on OMP's runtime in M2 (R6) |
| A query hangs | Per-call budget (default 5 s impact, 15 s cold index). On expiry: terminate worker, return `index-failed`, restart lazily. Session continues |
| Memory growth on a large repo | Worker `resourceLimits` cap (default 1.5 GB; a sandbox cold build of 200k–390k lines without library types peaked at 0.6–0.8 GB, so M2 sets the real default after measuring with `node_modules`); on exceed, same as timeout, plus `ei_status` advice to narrow `impact.include` |
| Library must be turned off fast | `EI_DISABLED=1` → extension registers no tools. Per-capability `enabled` flags in config. Either works without uninstalling |
| Work in progress breaks daily use | **Stable channel:** daily OMP loads the extension from a git worktree checked out at the last accepted milestone tag (`m0`, `m1`, …). Development builds are loaded only with an explicit `--extension` path |
| OMP upgrade changes the extension API | `ei_status` compares the running OMP version with the last smoke-verified version recorded in the repo and warns on mismatch; re-run the M1 scenarios |
| KSD and library disagree | Precedence header (KSD wins) stays first in every result; the library never injects per-turn text |

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

- `sources check --write` prints a **content lint** for each SKILL.md about to be pinned: shell pipes to interpreters (`curl … | sh`), instructions to skip tests or approvals, "ignore previous" phrasing, external URLs, references to scripts. It is a reading aid for the owner; it does not block, and it is never described as detecting prompt injection.
- Updating a pin always goes: pull → read the diff of changed SKILL.md files → lint → `--write` → commit the lock.
- `ei_status` shows lock state; any `HASH_MISMATCH` or `COMMIT_MISMATCH` is shown at the top.

**Data:**

- Default index excludes: `**/.env*`, `**/*.pem`, `**/*.key`, `**/*credentials*`, `**/secrets/**`, `**/node_modules/**`, `**/dist/**`, `**/.git/**`. Excluded files still count for zone matching by path, never by content.
- Cache holds symbol tables and edges, not file contents (beyond what TypeScript keeps in memory).
- Cache and audit directories are created `0700`. `ei cache clear` removes everything for a repo.
- GitLab token: env only, never logged, never cached; responses cached only as verification reports with status, not bodies.
- No telemetry, no network from library code except the GitLab adapter when enabled.

## 7. Limiting the risk of an agent building this library

The prototype already showed the failure mode: a test whose name claimed a branch it never executed.

1. **Owner-owned oracle.** Golden expectations and policies are edited only by the owner. The agent reports disagreements; it does not resolve them.
2. **Tests must be able to fail.** Each milestone's acceptance includes a **mutation smoke**: the agent applies listed one-line breaks (e.g. invert the risk policy, drop barrel resolution, skip the name cross-check) and shows that named tests fail for each, then reverts. A mutation no test catches is reported as a gap.
3. **Independent review.** Each milestone report is reviewed by someone other than the implementing agent before the tag is cut.
4. **One milestone at a time, tagged.** Accepted work gets a tag; the stable channel only moves on a tag.
5. **Evidence labels** (`VERIFIED / MOCK-ONLY / NOT VERIFIED`) on every claim, with commands and output.
6. **Gated growth.** V2 modules start only when their dogfood-log gate is met (DESIGN §13).

## 8. Risk register

| # | Risk | Main mechanism | Lands in | Residual risk |
|---|---|---|---|---|
| 1 | Result marked complete but misses a caller | Name cross-check §3.1; golden + freshness tests; canary | M2 | Callers with a different name reached only at runtime (reflection, DI containers) |
| 2 | Stale answer | Content-hash freshness per query; incremental == full test | M2 | None known within index scope |
| 3 | Agent trusts `low` in a dangerous area | Risk zones + action table §2 | M2b | Zone globs wrong or missing for a project |
| 4 | Schema / native change analysed as safe | Boundary factors; `unindexedChanges`; migration zone → `ask-owner` | M2b | Column-level effects still not analysed, only flagged |
| 5 | Review misses what the diff affects | `ei_changes` §2.4 | M2b | Agent does not call it (visible in audit) |
| 6 | Agent ignores the verdict | Verdict first in result; stage protocol; audit trail | M2b | Advisory only; OMP approvals and owner are the real stop |
| 7 | Tampered or changed skill text | sha256 + commit lock; lint on re-pin | Done / M2b | Malicious text present at first pin and not noticed by the owner |
| 8 | Library freezes or crashes OMP | Worker thread, budgets, wrapped execute, kill switch | M2 | Worker support on OMP runtime unverified until M2 |
| 9 | Dev build breaks daily work | Stable channel on tags | M1 | Owner loads a dev build by hand |
| 10 | Secrets in cache or logs | Excludes, no-content cache, redacted audit, env-only token | M2 | Secrets hard-coded in ordinary source files are indexed as code |
| 11 | Vacuous tests, self-graded work | Owner oracle, mutation smoke, independent review | M2 onward | Mutations list is finite |
| 12 | OMP upgrade breaks the adapter | Version check in `ei_status`; re-run smoke | M1 | Silent behavioural change with same API |
| 13 | Scope creep for a solo owner | V2 gates; out-of-scope list | Now | Owner overrides the gates |

Added with the owner's decision to bring six items forward (DESIGN D28):

| # | Risk | Main mechanism | Lands in | Residual risk |
|---|---|---|---|---|
| 14 | A heuristic bridge edge is read as proof, or hides a real gap | Bridged edges live in a separate `bridged` list and `Possible (heuristic)` section; a bridge never upgrades completeness or lowers a level; literal-only matching | M4 | A wrong literal match (two routes with the same path in different apps) shown as a candidate |
| 15 | Half-bridged flow makes the agent read more, not less | Bridge ships only with an end-to-end fixture flow; per-bridge config switch | M4 | Flows that mix a supported and an unsupported framework |
| 16 | Watcher misses an event and an answer is stale | Watcher is never the authority: probe on overflow/error/start/interval; `ei_changes` and rebuilds full-hash; identical-results test with watcher on and off | M5 | Up to one probe interval of extra latency, never a wrong answer |
| 17 | Semantic search hit taken as fact | `semantic` label on every such hit; search never feeds risk or completeness | M6 | Agent edits the wrong function suggested by similarity; `ei_impact` on it still shows real callers |
| 18 | Embedding model adds a heavy dependency, a download, or a licence problem | Optional; owner-run install only; local and replaceable; lexical tier works without it; choice made in M6 after measuring | M6 | Model quality on mixed Thai/English identifiers unknown until tried |
| 19 | Built-in SQLite unavailable or different on OMP's runtime | Checked first in M2a; storage interface with sharded-JSON fallback | M2a | Two storage paths to maintain if the fallback is needed |
| 20 | Scope growth overwhelms a solo owner | M4–M6 are separate milestones with their own exit gates; dogfooding starts after M2b and can reorder them | Now | Review load: six more milestone reports to check |

**Not addressed by design:** concurrency and runtime bugs, business-logic correctness, effects on external consumers of public packages (flagged, not analysed), and anything the agent does outside these tools.

## 9. Decisions (confirmed)

| ID | Decision | Outcome (2026-11-11) |
|---|---|---|
| R1 | One verdict (level + four actions) derived from completeness and factors, raised by risk zones | Confirmed (as reframed by DESIGN D32) |
| R2 | Ship the four default risk zones (payments, auth, migrations, prod-config), editable per project | Confirmed |
| R3 | Add `ei_changes`; base defaults to merge-base with the default branch | Confirmed |
| R4 | Name cross-check with new reason codes `unresolved-name-match`, `string-name-match`, and `engine-self-check-failed` | Confirmed |
| R5 | `typescript` becomes a runtime dependency: **bundled and pinned by default, workspace copy by opt-in** (amended) | Confirmed as amended |
| R6 | Impact engine in a worker thread with time and memory budgets | Confirmed |
| R7 | Audit log as specified (no source text), with `ei audit` | Confirmed |
| R8 | Stable channel: daily OMP loads from the last accepted tag | Confirmed |
| R9 | Mutation smoke in every milestone's acceptance from M2 on | Confirmed |

Also confirmed: route patterns in `impact.routes` accept globs.

## 10. Where each mechanism lands

| Milestone | Mechanisms |
|---|---|
| M1 | `ei_status` OMP version check noted for M2a; stable channel set up after acceptance |
| M1b | Worker, memory and runtime facts measured |
| M2a | Worker + budgets, kill switch, default excludes, version stamp, canary, differential and randomised tests |
| M2b | Name cross-check, boundary factors, route globs, reach and base verdict, mutation smoke |
| M2c | Risk zones, `ei_changes`, stage-protocol lines in workflow header, audit log + `ei audit`, skill content lint |
| M3 | Dogfood with audit summaries; false-low stop rule in force |

## Appendix A. Golden cases

The cases first drafted here are now confirmed in `tests/golden/M2-impact-cases.md`: C21–C26 (engine, M2b) and P01–P05, X01–X03 (policy and changes, M2c).
