# M2c Rounds 5 & 6 — Independent Review & Fix Record

- **Date:** 2026-11-22
- **Branch Reviewed (Round 5):** `m2c-changes` @ `dde1b14` (base `release/0.2.0-unified-skills` @ `74698e7` / `45cea76`)
- **Runtime:** Linux WSL2 `x86_64` (`6.18.58.1-microsoft-standard-WSL2`) · Node `v24.21.0` · npm `12.2.0` · Bun `1.4.2` · OMP `omp/19.1.0`
- **Model & Cross-Vendor Caveat (per `docs/briefs/README.md` & `ORIGINAL_REQUEST.md` R3):**
  - Round 5 reviews and challenges were executed by subagents running in the `Gemini` agent runtime inside Antigravity CLI — the **same model family** as the Round 1–4 and Round 6 workers. True cross-vendor model diversity (e.g., an independent non-Gemini vendor model) is **`NOT VERIFIED`** in this automated local harness; the reviewers/challengers/auditor were separate read-only sessions that did not author `d790daf` or `dde1b14`.
  - Host boundaries unchanged: `omp -p` LLM turn (`NOT VERIFIED` — no model API key configured on host) and macOS CI / live macOS OMP (`NOT VERIFIED` on Linux WSL2 `x86_64`).

---

## 1. Round 5 Independent Reviews, Empirical Challenges, & Forensic Audit (`dde1b14`)

| Agent | Role & Scope | Verdict | Key Findings / Evidence |
|---|---|---|---|
| `teamwork_reviewer_m2_1` | Read-only reviewer & adversarial critic (Risk zones, `ei_changes`, Round 0 #1–#6/#9, Review Focus #1–#5) | `REQUEST_CHANGES` | **Major Finding 1:** `src/core/kernel/glob.ts:91` omitted `'s'` (`dotAll`) flag on compiled glob `RegExp`, causing `**` (`.*` / `(?:.*/)?`) to return `false` on paths containing `\n` (bypassed `**/payments/**` zone, `**/.env*` `neverReadOf` secret exclusion, and `packages/**` `impact.include`). **Minor Finding 2:** `tests/core/changes.test.ts` lacked automated regression tests for Focus #5 edge cases (spaces, newlines, non-UTF-8 bytes, submodules). All other Round 0 #1–#6/#9 and Focus #1–#5 checks passed. |
| `teamwork_reviewer_m2_2` | Read-only reviewer & adversarial critic (Audit log, `ei cache clear`, `src/workflow/render.ts` stage protocol, `RISK.md §2.5`, Review Focus #6–#8, `m2c-measurements.md`, `PROPOSED` snapshots) | `APPROVE` | All Round 0 #7–#8, Focus #6–#8, `ei_changes` full-hash/stale fallback, `m2c-measurements.md` evidence discipline, and `PROPOSED` snapshots passed. **Non-blocking Minor Observation:** `stripCodeDetail` (`src/core/audit/log.ts:154-158`) did not forward `{ env, root }` to its fallback `sanitizeAuditText(raw, { maxLen: 80 })` call. |
| `teamwork_challenger_m2_1` | Empirical challenger (CLI, AGY MCP, Bun `loadExtensions` OMP probes on `/tmp` repos) | `APPROVE` | Verified `PLAYBOOK.md §4` (`700/700`), flag-injection blocking (`--base -evil`, `--base=-evil`, `--upload-pack=...`), `chmod 0o000` `.env.local`, `P05`, `X01–X03`, `EI_DISABLED=1`, `ei audit`, and `ei cache clear` across CLI/MCP/OMP. |
| `teamwork_challenger_m2_2` | Empirical challenger (Round 4 mutations M1, M3, M6, M7 in disposable `/tmp` copies + `m2c-measurements.md` audit) | `REJECT` | Killed M1, M3, M7, **but Mutation M6 (`src/core/impact/session.ts:629`: `probe(..., 'hash')` → `'stat'`) SURVIVED (`EXIT=0`, `19/19` pass)** because `tests/core/changes.test.ts:707` initialized the index with `impact: impactOf(repo)` (`freshness: 'hash'`) while `runOnRepo()` used `workspace.config.impact` (`freshness: 'stat'`), causing `meta.config_hash !== configHash` in `session.ts:632` to trigger a rebuild regardless of `probe`. |
| `teamwork_auditor_m2_1` | Forensic integrity auditor (protected paths, genuine logic, no test weakening, `/tmp` & work-repo isolation) | `CLEAN` | Zero edits to `tests/golden/**`, `src/policy/**`, `tests/policy/**`, or M2b `tests/snapshots/impact/*.txt` (only the 4 `PROPOSED` M2c snapshots added); genuine implementations; zero personal home-path leaks in `45cea76..HEAD`. |

---

## 2. Round 6 Test-First Fixes & Re-Verification

All Round 5 confirmed findings and observations were fixed test-first on `m2c-changes`:

1. **Mutation M6 test fix + re-verified kill (`tests/core/changes.test.ts:609, 620, 707`):**
   - Replaced `impact: impactOf(repo)` with `impact: workspace.config.impact` (keeping `freshness: 'hash'` on `Indexer.index` options) so `meta.config_hash === configHash` and `prepareForChanges()` relies genuinely on `probe(..., 'hash')`.
   - **Verified M6 kill (`VERIFIED`):** Temporarily mutated `src/core/impact/session.ts:629` (`'hash'` → `'stat'`), rebuilt `dist/` and `dist-test/`, and ran `dist-test/tests/core/changes.test.js` (`--test-name-pattern="forces freshness"` and full file) — both failed with `EXIT=1` (`AssertionError: 'fresh' !== 'updated'`), then cleanly reverted `session.ts`. Updated `docs/research/m2c-measurements.md` to record the re-verified `8/8` mutation kills.
2. **Glob `dotAll` `'s'` flag (`src/core/kernel/glob.ts:91`, test-first):**
   - Added failing tests first in `tests/core/glob.test.ts` (`matchGlob` on `\n` paths), `tests/core/impact-risk-zones.test.ts` (`matchedRiskZones` and `neverReadOf` on `packages/payments/src/nl\nfile.ts` and `dir\n/.env`), and `tests/core/changes.test.ts` (`dir\n/.env` `chmod 0o000` initially threw `EACCES` in `scan()` without `'s'`).
   - Added `'s'` flag at `src/core/kernel/glob.ts:91` (`new RegExp(\`^${translate(pattern, 0, false).src}$\`, 's')`), rebuilt `dist/`, and verified all new and existing tests pass.
3. **Review Focus #5 regression tests (`tests/core/changes.test.ts`):**
   - Added `Focus #5: handles changed paths with spaces, newlines, non-UTF-8 bytes, and submodules under X03` exercising:
     - `packages/payments/src/space file.ts` and `packages/payments/src/nl\nfile.ts` (indexed, `payments` zone applied),
     - `dir\n/.env` (`chmod 0o000`, secret never read, `prod-config` critical floor),
     - non-UTF-8 byte filename (`0xff` -> safely placed in `unindexedChanges`),
     - committed gitlink submodule (`160000` mode change) and untracked nested git repo directory (safely placed in `unindexedChanges` as `git submodule; not analysed` without reading nested files).
4. **`stripCodeDetail` `env`/`root` forwarding (`src/core/audit/log.ts:154-170`, `tests/core/audit.test.ts`):**
   - Added optional `{ env, root }` parameter to `stripCodeDetail`, forwarded `{ env: options?.env, root: options?.root, maxLen: 80 }` into fallback `sanitizeAuditText(...)`, and wired `{ env: options.env, root: options.root }` from `sanitizeStringList`. Added test-first unit test in `tests/core/audit.test.ts` covering direct `stripCodeDetail` and `recordAudit` fallback sanitization.
5. **Protected paths & verification status:**
   - `tests/golden/**`, `src/policy/**`, `tests/policy/**`, and the 11 M2b `tests/snapshots/impact/*.txt` files remain completely untouched; only the 4 `PROPOSED` M2c snapshots (`tests/snapshots/impact/P01.txt`, `P02.txt`, `tests/snapshots/changes/P05.txt`, `X02.txt`) await owner review.
   - `omp -p` live LLM turn, macOS CI/live OMP, and independent cross-vendor model review remain explicitly marked `NOT VERIFIED`.
