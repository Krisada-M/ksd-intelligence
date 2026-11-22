# 05: Review the actual change with M2c

**What to build:** Deliver M2c in strict round order: (1) risk zones (`payments`, `auth`, `migrations`, `prod-config`), (2) `ei_changes` full-hash diff impact review with `Not in plan` (`planned`), (3) private local audit log (`audit.jsonl` + `ei audit`), and (4) text-only stage protocol in `ei_workflow` — exposed cleanly in CLI, OMP extension, and AGY MCP.

**Blocked by:** 03 — Start M3 dogfood on real repositories (setup + daily-use limits + dogfood start recorded).

**Status:** ready-for-agent (MUST start with **Round 0 — reconcile ONLY**; do NOT write code until owner approves Round 0)

**Requirement:** REQ-05 in the [spec](../spec.md).

**Playbook:** Read [PLAYBOOK.md](../PLAYBOOK.md) BEFORE running any command.

---

## Read First (Exact Files)
1. [PLAYBOOK.md](../PLAYBOOK.md)
2. [docs/briefs/README.md](../../../docs/briefs/README.md) (Common rules + Round 0 / Review / Fix templates)
3. [docs/briefs/M2c-changes.md](../../../docs/briefs/M2c-changes.md) (entire file — 115 lines)
4. [docs/RISK.md](../../../docs/RISK.md) §2 (risk zones, verdict table, `ei_changes`, stage protocol), §3.2, §5 (audit log), §6
5. [docs/TOOLS.md](../../../docs/TOOLS.md) §3 (`ei_workflow`), §4 (`ei_impact`), §5 (`ei_changes`), §8, §10
6. [tests/golden/M2-impact-cases.md](../../../tests/golden/M2-impact-cases.md) — cases `P01–P05` and `X01–X03`
7. Existing code seams to inspect BEFORE editing:
   - `src/core/kernel/config.ts` (already has `DEFAULT_RISK_ZONES` and `RiskZoneConfig` — reuse, do NOT duplicate!)
   - `src/core/impact/query.ts` & `src/core/impact/render.ts` (verdict derivation & `ACTION` line)
   - `src/core/indexing/surface.ts` (syntactic surface hash for `signature-changed` vs `modified`)
   - `src/core/engine/status.ts` (`Config` line for active zones)
   - `src/workflow/render.ts` (stage protocol header — MUST NOT import `src/core/**`!)
   - `src/adapters/omp/extension.ts`, `src/adapters/cli/main.ts`, `scripts/mcp/tools.mjs`

## Allowed vs Forbidden Paths
- **Branch:** `m2c-changes` created from `origin/main`.
- **Allowed (Rounds 1–6 ONLY, NOT Round 0):** `src/core/changes/**`, `src/core/audit/**` (or `src/core/kernel/audit.ts`), `src/core/impact/**`, `src/core/engine/**`, `src/workflow/render.ts`, `src/adapters/**`, `scripts/mcp/tools.mjs`, `src/index.ts`, `dist/**`, `tests/core/**`, `tests/workflow/**`, `tests/packaging/**`, `docs/research/m2c-measurements.md`.
- **Forbidden:** NEVER edit `tests/golden/**`, `src/policy/**`, `tests/policy/**`. Never edit existing `tests/snapshots/impact/*.txt` — add NEW proposed snapshots only for `P01`, `P02`, and `ei_changes`!

---

## Step-by-Step Execution Runbook (ONE Round per Session — Do NOT Skip Ahead)

### Round 0 — Reconcile ONLY (Zero Code Changes!)
1. Do NOT create files or edit `src/`, `tests/`, or `docs/briefs/M2c-changes.md`.
2. Compare `docs/briefs/M2c-changes.md` line-by-line against current `main`:
   - List every mismatch (`file:line` on both sides), including `DEFAULT_RISK_ZONES` already in `src/core/kernel/config.ts`, `scripts/mcp/tools.mjs` AGY MCP parity, and `src/workflow/render.ts` new header lines from PR `#33` (`Orchestrator`, `Primary Pack`, `Compliance Gate`).
   - List any index data M2c assumes that `src/storage/sqlite.ts` does not yet store.
   - List golden cases `P01–P05` and `X01–X03`, plus which already pass vs need implementation.
   - Note any findings from `docs/dogfood-log.md`.
   - Propose exact round plan (Rounds 1–6).
3. **STOP GATE:** Report Round 0 findings and STOP. Wait for owner approval before starting Round 1.

### Round 1 — Risk Zones
1. Inspect `DEFAULT_RISK_ZONES` and `parseProjectConfig` in `src/core/kernel/config.ts`:
   - Support `"default"`, explicit array, or `[]`. Invalid entries fall back to defaults and append to `configErrors` (shown by `ei_status`).
2. Apply zone matching by **path only** (never read excluded/secret file content!) across target file + every impacted symbol's file (full traversal, even when `depth: 1`!):
   - Implement exact derivation table from `docs/RISK.md §2.3`:
     - `high` + (`low`/`medium`) → `high`, `run-tests`
     - `high` + `unknown` → `high`, `ask-owner` (`P02`)
     - `critical` + any → `critical`, `ask-owner`
     - Multiple zones → strongest level & strongest action. **Zones can NEVER lower a verdict.**
   - Populate `verdict.zones`, `verdict.requiredActions`, `verdict.basis`.
3. Render zone on line 2 of `ei_impact` (`ACTION ... · level high (zone payments) · ...`) and list active zones on `ei_status` `Config` line.
4. **CRITICAL TRAP FIX:** Update `C01–C26` test fixtures/helpers to pass `riskZones: []` explicitly so all existing M2b golden tests and snapshots stay 100% untouched and green!
5. Write tests for: `P01–P04`, depth-4 zone with `depth: 1`, critical on quiet target, `P02` (`high + unknown → ask-owner`), unmatched glob, malformed glob (no throw), property test (`verdictWithZones >= verdictWithoutZones` for every golden target), excluded/secret path-only matching.
6. Run full verification gate (`PLAYBOOK.md §4`) and commit locally on `m2c-changes`. **STOP.**

### Round 2 — `ei_changes` (`src/core/changes/`)
1. Git diff collection (NO shell! Use `execFile('git', ...)` with `-z` and `--`):
   - Resolve `base`: explicit `base` (reject values starting with `-` to prevent git flag injection!), else `merge-base HEAD <defaultBranch>` (`origin/HEAD` → `main` → `master`).
   - Collect staged + unstaged + untracked files. Handle no-git, detached HEAD, shallow clone, missing `--base` ref with clear guidance/failure (never silent "nothing changed").
   - Empty diff against base → return `"CHANGES vs <base> — nothing changed in the working tree."` (success-shaped, even if index is stale).
2. Always refresh index with **full content hash** (`freshness: 'hash'`, never stat probe!).
3. Compare declarations in engine child (`git show <base>:<path>` syntax-only parse vs working tree) by stable key using `surface.ts`:
   - Classify each symbol: `added`, `removed`, `signature-changed`, `modified` (top-level/import edits → `<module>`).
   - List `removed` and `signature-changed` symbols that still have users FIRST (for removed symbols, include unresolved imports and name matches pointing at them).
4. Compute union impact across changed symbols, then apply risk zones to target files, impacted files, AND every changed path.
5. **X03 Invariant (shared test helper):** Every changed path MUST appear in either `changedFiles` (`indexed: true`) or `unindexedChanges` (which adds `outside-index-scope` and forces `partial`). Secret/excluded files are listed by path only (content never read!).
6. Support optional `planned?: string[]` → render `Not in plan` (advisory, after signature-changed) and `Planned, unchanged` without altering verdict.
7. Render within 8,000-char budget (keep header + verdict + signature-changed intact before trimming lower sections); deterministic byte output.
8. Wire `ei_changes` into CLI (`ei changes [--base REF] [--depth N] [--json]`), OMP extension (`src/adapters/omp/extension.ts`), and AGY MCP (`scripts/mcp/tools.mjs`). `EI_DISABLED=1` disables it.
9. Write tests covering ALL 16 risky cases in `M2c-changes.md` Round 2 (`X01–X03`, `P05`, untracked/staged/unstaged, deleted with importers, renames, whitespace-only, inferred return type, `.sql`/`.env`/binary/excluded/orphan, parse-error, git error states, worktree/subdir, 300 files budget, determinism, `planned` edge cases).
10. Run full verification gate and commit locally. **STOP.**

### Round 3 — Audit Log & Stage Protocol
1. **Audit log (`<cache>/<repo-id>/audit.jsonl`, dir `0700`, file `0600`):**
   - Append-only JSONL, rotate at 5 MB (keep 3 files).
   - Log every `ei_workflow`, `ei_impact`, `ei_changes`, `ei_status` call (results, guidance, failures).
   - Truncate `task` to 200 chars; NEVER write source text, skill text, diffs, env values, tokens, or absolute home paths.
   - Isolate write failures (never throw or delay > 50 ms; report once in `ei_status`). `EI_DISABLED=1` writes nothing.
   - Add CLI `ei audit [--since 7d]` + `ei cache clear` (removes audit log too).
2. **Stage protocol (`src/workflow/render.ts`):**
   - Add exact per-stage line from `RISK.md §2.5` (`investigate`/`implement`, `verify`, `review`/`ship`) AFTER `PRECEDENCE_HEADER`.
   - Add an explicit dependency test proving `src/workflow/**` has ZERO imports from `src/core/impact/**` or `src/core/changes/**`.
3. Write tests for redaction/secret-grep, 200-char truncation, read-only dir failure isolation (< 50 ms), concurrent appenders, rotation + corrupt-line resilience, `EI_DISABLED=1`, and stage protocol.
4. Run full verification gate and commit locally. **STOP.**

### Round 4 — Live, Measurements & Mutation Smoke
1. Live OMP run on a scratch branch: edit a function body, invoke `ei_changes` + `ei_impact` on a zoned path, paste raw outputs + audit lines (label OS + OMP version).
2. Measure `ei_changes` latency (1-file body edit, signature edit, 20 changed files) split by `update / base-parse / traverse / render` → save in `docs/research/m2c-measurements.md`.
3. Run the 8 required mutation smokes from `M2c-changes.md` Round 4 (apply 1-line break → prove named test fails → revert). Every mutation must be killed (`8/8`). **STOP.**

### Round 5 (Independent Cross-Vendor Review) & Round 6 (Fix)
- Use a **different vendor model** for Round 5 (read-only, check all 8 Review Focus items in `M2c-changes.md`).
- Round 6 fixes each confirmed finding test-first, reruns full gates + mutation smoke, commits locally, and hands off to owner.

---

## Acceptance Criteria
- [ ] Run Round 0 on the [M2c brief](../../../docs/briefs/M2c-changes.md). Report conflicts and missing inputs against current contracts, code and dogfood. Stop before Round 1 until the owner accepts the corrected brief.
- [ ] Demonstrate that full-hash review accounts for every changed path, including untracked, removed and unindexed changes. Risk zones never lower a verdict. Stale or incomplete data cannot be presented as complete; `Not in plan` is advisory and does not filter out changes.
- [ ] Verify the private, failure-isolated audit behavior and the text-only stage protocol without coupling workflow routing to the engine or changing KSD precedence. Confirm tests cover redaction, failures, rotation and concurrency per the approved brief.
- [ ] Pass the accepted P/X cases and prior C/F cases unchanged. Record CLI/live OMP outputs, measurements, mutation results and platform CI; submit changed snapshots for owner review.
- [ ] Resolve only after owner acceptance and after the accepted milestone is on `origin/main`. Record the owner decision and the resulting `origin/main` commit SHA for ticket 06. Only the owner pushes or merges.

## Common Traps to Avoid
- **Trap 1:** Forgetting `riskZones: []` on `C01–C26` tests (causes M2b tests to fail on `payments/` fixture paths!).
- **Trap 2:** Passing `base` directly to `git diff` without rejecting leading `-` (git argument injection!).
- **Trap 3:** Using `probe()` (stat) instead of full content hash in `ei_changes`.
- **Trap 4:** Importing `src/core/changes` inside `src/workflow/render.ts` (violates `DESIGN §5.1`).
- **Trap 5:** Reading `.env*` or excluded files when computing `unindexedChanges` (list by path ONLY!).
