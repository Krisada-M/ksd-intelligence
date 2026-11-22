# 02: Accept M2b on final evidence

**What to build:** Give the owner one complete acceptance record for the final `ei_impact` candidate (`ad21058` / PR `#32`, already merged into `main`). Landing code is not formal acceptance until every criterion is traced and dispositioned.

**Blocked by:** 01 — Close M2b Round 6 findings (COMPLETED).

**Status:** ready-for-agent (code merged to `main` in `#32` `ad21058`; formal acceptance record & macOS/cross-vendor sign-off remain to be documented)

**Requirement:** REQ-02 in the [spec](../spec.md).

**Playbook:** Read [PLAYBOOK.md](../PLAYBOOK.md) BEFORE running any command.

---

## Read First (Exact Files)
1. [PLAYBOOK.md](../PLAYBOOK.md)
2. [docs/briefs/M2b-impact.md](../../../docs/briefs/M2b-impact.md) — `#acceptance` section
3. [docs/research/m2b-measurements.md](../../../docs/research/m2b-measurements.md)
4. [01-m2b-round-6.md](./01-m2b-round-6.md) — `## Comments` (WSL2 Round 6 evidence)
5. [docs/reviews/2026-11-18-m2b-round-4-decisions.md](../../../docs/reviews/2026-11-18-m2b-round-4-decisions.md)

## Allowed vs Forbidden Paths
- **Allowed:** `.scratch/ksd-v1-readiness/evidence/02/**`, updating `## Comments` in this ticket, and (only if requested) `docs/research/m2b-measurements.md`.
- **Forbidden:** Do NOT edit `src/**`, `tests/**`, `tests/golden/**`, `tests/snapshots/**`, `src/policy/**`, or `~/.omp/**`. This ticket is an **evidence and acceptance record** ticket, NOT a coding ticket.

---

## Step-by-Step Execution Runbook

### Step 1 — Confirm candidate commit on `origin/main`
```bash
export HOME="${SNAP_REAL_HOME:-$HOME}"
export PATH="$HOME/.local/share/fnm/node-versions/v24.21.0/installation/bin:$HOME/.bun/bin:$PATH"
git fetch origin
git log --oneline -n 5 origin/main
git show --stat ad21058
```
Record the exact SHA (`ad21058` for M2b PR `#32`, plus current `origin/main` head if checking head).

### Step 2 — Run local verification suite at the candidate revision
```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run check:dist
```
Record exact test counts (C01–C26 golden, F01–F06 freshness, differential, randomized, policy, packaging).

### Step 3 — Run deterministic CLI + live OMP `ei_impact` checks on `Graph.incoming` and an ambiguous name (`charge` or `render`)
```bash
node dist/adapters/cli/main.js status --root "$PWD"
node dist/adapters/cli/main.js impact "src/core/graph/graph.ts#Graph.incoming" --depth 2 --root "$PWD"
node dist/adapters/cli/main.js impact "render" --depth 2 --root "$PWD"
```
Check:
- `Graph.incoming` output lists its test callers (`tests/core/indexing.test.ts`, `tests/core/differential.test.ts`) and does NOT hide gaps.
- Ambiguous target returns `AMBIGUOUS ...` candidate list (never merges results into one answer).
- For real OMP live output (without touching `~/.omp`), run via OMP `loadExtensions` or `omp -p --no-extensions -e dist/adapters/omp/extension.js` and label OS + exact OMP version. If unable to invoke live LLM turn, label that portion `NOT VERIFIED` (never claim `VERIFIED` from CLI alone).

### Step 4 — Collect CI + cross-vendor review + snapshot disposition table
Create `.scratch/ksd-v1-readiness/evidence/02/acceptance-record.md` containing:
1. One-to-one traceability table of EVERY criterion in `docs/briefs/M2b-impact.md#acceptance` → command → observed output → `VERIFIED | MOCK-ONLY | NOT VERIFIED`.
2. GitHub Actions CI run links/outcomes for both `ubuntu-latest` (Linux x64) and `macos-latest` (macOS arm64) at `ad21058` (or mark `NOT VERIFIED` if CI logs cannot be fetched from this environment).
3. Cross-vendor independent review status: cite vendor/model used for build vs review (Round 4 alone did not satisfy cross-vendor; record whether a separate-vendor review of Round 6 exists or mark `NOT VERIFIED`).
4. List every snapshot in `tests/snapshots/impact/` with disposition column (`PROPOSED` / `ACCEPTED by owner`).

### STOP GATE — Owner Disposition Required
Do NOT mark M2b as formally accepted yourself. Present the acceptance record to the owner and STOP. Only the owner writes `ACCEPTED` or `BLOCKED` and triggers any marketplace/release action.

---

## Acceptance Criteria
- [ ] Trace all [M2b acceptance criteria](../../../docs/briefs/M2b-impact.md#acceptance) to the candidate revision: local checks, C01–C26, freshness F01–F06, unknown-verdict invariant, differential doctor, mutation results, live OMP and latency. Attach exact commands and observed results.
- [ ] Record CI evidence for macOS and Linux at the candidate revision, separately from real OMP `ei_impact` output for `Graph.incoming` and an ambiguous name. Confirm that `Graph.incoming` includes its test callers and that ambiguity returns candidates instead of an answer.
- [ ] Record the independent cross-vendor review and resolution of outstanding findings; Round 4 on its own did not satisfy the cross-vendor rule. Present the proposed snapshots, including changed ones, for owner disposition.
- [ ] Owner records accepted or blocked. An unresolved wrong `low`, missed performance gate, or missing required evidence keeps M3 blocked. Any release-branch or marketplace action stays owner-controlled.

## Common Traps to Avoid
- Do NOT confuse "PR `#32` merged to `main`" with formal acceptance.
- Do NOT mix macOS CI results with Linux/WSL2 runtime evidence; label OS/arch on every row.
- Do NOT edit `tests/snapshots/impact/*.txt` in this ticket.

## Comments
- 2026-11-22: M2b code landed on `main` via PR `#32` (`ad21058`). Unified AGY+OMP skills subsequently landed in PR `#33` (`ac3caaa`), and `release/0.2.0-unified-skills` (`71e30ba`) bumps version to `0.2.0` (updating snapshot footers `engine 0.1.0` → `0.2.0` pending `owner-approved` label). Ticket 02 still requires formal owner disposition of the acceptance table.
- 2026-11-22: Step 1 recorded. `git fetch origin` produced no output; its exit code was not separately captured. `ad21058` resolved to `ad21058ebbd115580bbcb16e24328f5ab93869bc` and is an ancestor of the local `origin/main` ref at `ac3caaa041450fbf1d2331d356f4c9b201c480c6`. The current checkout was `release/0.2.0-unified-skills` at `633f4785d6f22bce2bd8a3dd29b00df3f04786d5`, not the candidate; Step 2 must run at `ad21058`. No acceptance decision was made.
- 2026-11-22: Prepared [acceptance record](../evidence/02/acceptance-record.md) for owner disposition. Candidate `ad21058` passed 605 tests and the local quality checks; real OMP `loadExtensions` returned `Graph.incoming` and ambiguous `status` results. A full isolated LLM turn failed because no API key was available. Cross-vendor review is NOT VERIFIED. The retained body-edit artifact conflicts with the written latency report, and the current release branch's protected-path check reports ten pre-existing snapshot changes. No acceptance decision or local commit was made.
