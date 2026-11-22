# Ticket 05 (M2c) — Round 0 Reconciliation Report

- **Date:** 2026-11-22
- **Scope:** Read-only reconciliation of draft [`docs/briefs/M2c-changes.md`](../../../docs/briefs/M2c-changes.md) against current codebase (`release/0.2.0-unified-skills` @ `633f478` / `origin/main` `ac3caaa`), contracts (`docs/RISK.md`, `docs/TOOLS.md`, `docs/DESIGN.md`), golden cases (`tests/golden/M2-impact-cases.md`), and `docs/dogfood-log.md`.
- **Code / brief edits made:** **ZERO** (per Round 0 rules; awaiting owner approval before Round 1).
- **Status:** `PROPOSED` (all code citations `VERIFIED` by direct file inspection).

---

## 1. Mismatches Between `docs/briefs/M2c-changes.md` and Current Code / Contracts

| # | Brief Reference | Current Code / Contract (`file:line`) | Mismatch & Proposed Reconciliation |
|---|---|---|---|
| 1 | `M2c-changes.md:18` — *"Invalid entries fall back to the default for that section and are reported by `ei_status`."* | `src/core/kernel/config.ts:52–73, 280–310` | `DEFAULT_RISK_ZONES` and `parseRiskZones` already exist, **but** when `riskZones` is an array with invalid item(s) (`L292–309`), `parseRiskZones` currently drops bad items and returns `validZones` (which can silently become `[]`, turning off all zones!) instead of falling back to `'default'`. It also accepts empty `zone: ""` or empty `match: []`. **Fix in Round 1:** fall back to `'default'` when any entry in `riskZones` is invalid (keeping `[]` valid as explicit opt-out), validate non-empty `zone` and `match`, and keep error messages in `configErrors`. |
| 2 | `M2c-changes.md:19–20` — *"Line 2 of the `ei_impact` block shows the zone as in TOOLS §4."* | `src/core/impact/render.ts:292–300, 126–151`; `src/core/impact/session.ts:63–77` | Line 2 zone formatting (`(zone payments)` / `(zones ...)`) is **already implemented** at `render.ts:292–295`, **but two bugs would occur once zones are wired:** (a) `render.ts:296–297` and `session.ts:70–74` (`staleResult`) hardcode `level: 'unknown', action: 'check-gaps'` when stale, violating `RISK.md §2.3` when a `high` or `critical` zone applies (`high + unknown → high / ask-owner`; `critical + any → critical / ask-owner`); (b) `formatNext()` (`render.ts:126–151`) has no branch for `verdict.action === 'ask-owner'` and falls through to the `proceed` wording. **Fix in Round 1:** apply zone floors after staleness marking and add an explicit `ask-owner` branch to `formatNext()`. |
| 3 | `M2c-changes.md:21` — *"`ei_status` Config line lists the active zones."* | `src/core/engine/status.ts:80, 443–452`; `docs/TOOLS.md:181–183` | `WorkspaceStatus.config` (`status.ts:80`) currently holds only `{ path, errors }` and `renderStatus` (`status.ts:447`) prints `Config      ei.config.json ok` with no zone list. Also `TOOLS.md §6:181–183` shows draft `Skills`/`Versions` lines, whereas shipped M2a/M2b `status.ts:453–473` uses `Runtime`, `TypeScript`, `Store`, `Lock`, `Uses`. **Fix in Round 1:** extend `WorkspaceStatus.config` with resolved zone names and append ` · zones: payments, auth, migrations, prod-config` (or ` · zones: none`) to the existing `Config` line without disturbing existing lines/tests. |
| 4 | `M2c-changes.md:25` — *"Golden C01–C26 were confirmed without zones. Their tests must set `riskZones: []` explicitly"* | `src/core/impact/query.ts:1297–1303`; `tests/core/impact-golden.test.ts:31`; `tests/core/index-helpers.ts:64–67` | `ImpactQuery` currently takes only `(db, impact: ImpactConfig)` and hardcodes `zones: [], requiredActions: []` (`query.ts:1300–1301`). The golden fixture (`tests/fixtures/mono`) lives under `packages/payments/**`, which matches the default `payments` zone! **Fix in Round 1:** pass resolved `riskZones` into `ImpactQuery` (defaulting from `config.riskZones` in `ImpactSession` and defaulting to `[]` or explicit `riskZones: []` in `C01–C26` test harnesses + snapshot tests so all M2b C-cases and snapshots remain byte-identical). |
| 5 | `M2c-changes.md:40, 55` — *"compare declarations by stable key ... `signature-changed` (the type-stating text of `surface.ts` differs)"* | `src/core/indexing/surface.ts:34–165`; `src/core/indexing/declarations.ts:146–165, 497–500` | `declarations.ts` stores `sig_hash` in SQLite via `signatureText()`, which **always strips function bodies** even when return/param types are inferred. By contrast, `surface.ts` (`piece()`, `L40–91`) hashes the full body when return/param types are inferred, and currently computes only a **file-level** hash (`{ hash, observableKeys }`), not per-declaration hashes. **Fix in Round 2:** export a pure per-declaration helper from `src/core/indexing/surface.ts` (e.g. `declarationSurfaces(ts, sf, decls)`) so `ei_changes` uses the exact same type-stating semantics as `surface.ts` (meaning body edits on inferred-return functions classify as `signature-changed`, explicitly documented per `M2c-changes.md:55`). |
| 6 | `M2c-changes.md:46` — *"Register `ei_changes` in the extension entry; `EI_DISABLED=1` removes it."* | `AGENTS.md` (MAGY1 exception); `scripts/mcp/tools.mjs:17–59, 99–149` | Draft brief predates MAGY1 (the approved AGY stdio MCP bridge). `scripts/mcp/tools.mjs` currently registers only `ei_status`, `ei_impact`, and opt-in `ei_workflow`. **Fix in Round 2:** register `ei_changes` in CLI (`src/adapters/cli/main.ts`), OMP extension (`src/adapters/omp/extension.ts`), **and** AGY MCP (`scripts/mcp/tools.mjs`), respecting `EI_DISABLED=1` in all three. |
| 7 | `M2c-changes.md:76` — *"`ei cache clear` removes the log."* | `src/adapters/cli/main.ts` (full file) | `ei cache clear` is **not implemented yet** in `src/adapters/cli/main.ts` (only `setup`, `init`, `index`, `status`, `doctor`, `impact`, `workflow`, `sources`, `skills` exist). **Fix in Round 3:** add `ei cache clear [--root <path>]` (removing `index.sqlite`, staging/failure files, and `audit.jsonl*` inside the repo's cache directory) alongside `ei audit [--since 7d]`. |
| 8 | `M2c-changes.md:78` — *"the `ei_workflow` header gains the one line per stage ... Workflow snapshots that change are PROPOSED."* | `src/workflow/render.ts:17–54`; `docs/RISK.md:86–95`; `tests/snapshots/` | Three small reconciliations: (a) PR `#33` added `Orchestrator`, `Primary Pack`, `Secondary Packs`, `Opt-In Modes`, `Compliance Gate` lines to `src/workflow/render.ts:33–43` — stage protocol line should sit cleanly in the header right after `Stage:` (or after `Compliance Gate`), strictly below `PRECEDENCE_HEADER`; (b) `RISK.md §2.5:94` still says `"include its policy verdict and unindexedChanges"` (pre-D32 wording; confirm with owner whether to keep literal text or say `"verdict"`); (c) no workflow snapshot files exist under `tests/snapshots/` (only `tests/snapshots/impact/*.txt` exist; workflow text is tested in `tests/workflow/*.test.ts`). |
| 9 | `M2c-changes.md:29` — *"a malformed glob does not throw."* | `src/core/kernel/glob.ts:88–98` | Good news: `src/core/kernel/glob.ts` already handles unbalanced `{`, `,`, `}` as literals and escapes regex metacharacters (`L25–27`), so `matchGlob` never throws on malformed globs and already supports `{json,ts,yaml,yml}` and `**/.env*`. Round 1 just needs explicit regression tests for malformed patterns (unbalanced braces, `[`, `(`, `\\`, empty string). |

---

## 2. Index / Storage Data Check (`src/storage/sqlite.ts`)

Schema version `4` (`src/storage/sqlite.ts:22–148`) **already holds everything M2c needs without requiring a schema migration:**

- **Risk zones (Round 1):** Pure path matching on target file, impacted files (`declarations.file`), and changed paths (`git` output). No new tables/columns needed.
- **`ei_changes` changed-symbol comparison (Round 2):** Runs syntactically in the engine child via a new child op (e.g. `changes-diff`) comparing `git show <base>:<path>` vs the working-tree file using `extractDeclarations()` + the refactored per-declaration `surface.ts` helper + comment/whitespace-normalized token comparison (TS scanner) to detect whitespace/comment-only edits (`M2c-changes.md:54`). No extra SQLite table needed.
- **Removed symbols with live users (Round 2):** After updating the index to the working tree with full content hash, the published SQLite DB already contains `unresolved` (`reason IN ('unresolved-import', 'unresolved-name-match')`, indexed by `unresolved_name`) and `name_tokens` (indexed by `name_tokens_name`), plus `exports` (for re-export awareness).
- **Audit log (Round 3):** Separate append-only JSONL file at `<cache>/<repo-id>/audit.jsonl` (`0700` dir, `0600` file, 5 MB rotation × 3), outside SQLite so log writes never contend with SQLite locks or index builds.

---

## 3. Golden Cases `P01–P05` and `X01–X03` Status

All 8 cases are owner-confirmed in `tests/golden/M2-impact-cases.md:367–414` (Decision `G12`). **None have automated tests yet** (`grep` across `tests/` returns 0 matches):

| Case | Description | Current Status | Target Round |
|---|---|---|---|
| `P01` | `payments/src/fee.ts#localOnly` → `factors: []`, `complete`, `high`, `run-tests`, `zones: ['payments']` | Not implemented (returns `low`, `proceed`, `zones: []`) | Round 1 |
| `P02` | `payments/src/stripe.ts#StripeProcessor.charge` → `high`, `ask-owner`, `zones: ['payments']` | Not implemented (returns `unknown`, `check-gaps`, `zones: []`) | Round 1 |
| `P03` | `shared/src/money.ts#roundMoney` → `zones: ['payments']` via impacted symbols, `high`, `run-tests` | Not implemented (returns `medium`, `run-tests`, `zones: []`) | Round 1 |
| `P04` | `api/src/handlers/refund.ts#refund` → `zones: []`, `unknown`, `check-gaps` | Passes base verdict today; needs verification under `riskZones: "default"` | Round 1 |
| `P05` | Untracked `packages/api/migrations/001.sql` → `unindexedChanges`, `outside-index-scope`, `critical`, `ask-owner`, `zones: ['migrations']` | Not implemented (`ei_changes` does not exist) | Round 2 |
| `X01` | Modify bodies of `calculateFee` + `roundMoney` → union `byDepth[0]`, `tests` includes `fee.test.ts` | Not implemented | Round 2 |
| `X02` | Add required param to `calculateFee` → `signature-changed` listed first with callers | Not implemented | Round 2 |
| `X03` | Every changed path appears in `changedFiles` (`indexed: true`) or `unindexedChanges` | Not implemented | Round 2 |

Existing `C01–C26` and `F01–F06` all pass today (verified on `release/0.2.0-unified-skills`) and will keep `riskZones: []` explicitly so they and the M2b snapshots remain untouched.

---

## 4. Impact from `docs/dogfood-log.md` and M3 Supplemental Setup

- `docs/dogfood-log.md` currently has 1 resolved historical incident (2026-11-17, D57: `Graph.incoming` missed `tests/` prior to the `detectProjectLayout` + out-of-scope lexical scan fix; already fixed on `main`).
- **Gate note:** Real work-repository M3 setup, daily-use limits (`DESIGN §14`), and Task #1 in `docs/dogfood-log.md` are still pending owner input (Ticket 03). Per Ticket 03 / Ticket 05 sequencing, M2c Round 1 should wait until owner accepts both this Round 0 report and the Ticket 03 start gate (unless owner explicitly waives sequencing).
- **Supplemental observation from `docs/research/m3-ksd-intelligence-linux.md`:** Internal barrel re-exports (e.g. `src/index.ts:83` re-exporting `ReleaseSnapshot`) are tracked in `exports` rather than caller edges. In Round 2 (`ei_changes`), when a symbol is removed or renamed, checking `unresolved` + `exports` ensures broken barrel re-exports are surfaced cleanly (matching Review Focus #4).

---

## 5. Proposed Round 1–6 Implementation Plan (Branch `m2c-changes` from `origin/main`)

- **Round 1 — Risk Zones:** Fix `parseRiskZones` invalid-entry fallback (`src/core/kernel/config.ts`); add shared `applyRiskZones()` helper implementing `RISK.md §2.3` derivation table (monotone — never lowers); wire into `ImpactQuery`, `ImpactSession` (including `staleResult`), `renderImpact` (`formatNext` for `ask-owner`), and `renderStatus` (`Config` line); pin `riskZones: []` on `C01–C26` & M2b snapshot tests; add `P01–P04` + all Round 1 risky-case & property tests + PROPOSED snapshots for `P01` and `P02`.
- **Round 2 — `ei_changes`:** Export per-declaration surface helper from `src/core/indexing/surface.ts`; add syntax-only diff op in `src/core/engine/child.ts`; build `src/core/changes/` (safe `execFile('git', ...)` with `-z` and leading-`-` guard, forced `freshness: 'hash'`, symbol diffing, removed-symbol user lookup via `unresolved`/`name_tokens`, union impact + zone floors over target/impacted/changed paths, `X03` invariant, `planned` / `Not in plan` / `Planned, unchanged`, deterministic 8,000-char renderer); wire CLI (`ei changes`), OMP extension (`ei_changes`), and AGY MCP (`scripts/mcp/tools.mjs`); add `X01–X03`, `P05`, shared `X03` helper, and all 16 Round 2 risky-case tests.
- **Round 3 — Audit Log & Stage Protocol:** Add `src/core/audit/` (`audit.jsonl`, `0700`/`0600`, 5 MB rotation × 3, 200-char task truncation, secret/home-path guard, < 50 ms failure isolation + once-per-status warning, `EI_DISABLED=1` no-op); wire audit logging across `ei_workflow`, `ei_impact`, `ei_changes`, `ei_status`; add CLI `ei audit [--since 7d]` and `ei cache clear`; add text-only stage protocol lines to `src/workflow/render.ts` + import-isolation test (`src/workflow/**` never imports `src/core/impact/**` or `src/core/changes/**`).
- **Round 4 — Live, Measurements & Mutation Smoke:** Live OMP check on scratch branch (pasted outputs + audit lines); `docs/research/m2c-measurements.md` latency breakdown; kill all 8 required mutations from `M2c-changes.md` Round 4.
- **Round 5 (Independent Cross-Vendor Review) & Round 6 (Fix):** Read-only review by a different vendor model across all 8 Review Focus areas, then test-first fixes, full verification gate, and owner handoff.

---

## Questions for Owner Before Starting Round 1

1. **Approve Round 0 reconciliations (#1–#9 above)** — specifically:
   - Adding `ei_changes` to AGY MCP (`scripts/mcp/tools.mjs`) in Round 2?
   - Adding `ei cache clear` in Round 3?
   - In `RISK.md §2.5` stage protocol line for `review`/`ship`, keep `"include its policy verdict and unindexedChanges"` verbatim or modernize `"policy verdict"` → `"verdict"` (matching D32)?
2. **Sequencing:** Hold Round 1 until Ticket 03 real work-repo setup + limits + Task #1 are recorded, or proceed to Round 1 once `release/0.2.0-unified-skills` is merged?
