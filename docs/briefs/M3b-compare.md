# M3b — comparison with other code-intelligence tools (agent brief)

**Decision:** D66. **Kind:** research. No product code changes. **Branch:** `research/m3b-compare` from `origin/main`.

Read `docs/briefs/README.md` (common rules) first, then `AGENTS.md`, `docs/DESIGN.md` §7, §13, §16 (open question 4), `docs/TOOLS.md`, `docs/dogfood-log.md`, `tests/golden/M2-impact-cases.md`, `tests/golden/search-queries.md`, `docs/research/m3-exit-review.md`.

## Goal

A measured, reproducible answer to two questions:

1. On the same tasks, does `ksd-intelligence` give answers an agent can trust more than the other code-intelligence tools the owner has, and more than plain `ripgrep`?
2. What, if anything, should ksd copy from them or hand off to them before `v1.0.0`?

The milestone ends with `docs/research/m3b-compare.md`, a findings list handed to the V1 close-out, and owner decisions recorded as a DESIGN decision. It does not end with code changes to ksd.

## Out of scope

- Fixing anything in ksd. A ksd defect found here becomes a finding (`docs/research/m3b-findings.md`) with a reproduction; the V1 close-out decides.
- Installing tools, changing global config, or logging in to any service. The owner installs; the agent only detects.
- Tuning another tool beyond its documented defaults plus at most one documented setting per tool (recorded).
- Publishing scores to anyone. The report is for the owner.

## Contestants

| Id | What | How it is run |
|---|---|---|
| `ksd` | `ei impact`, `ei changes`, `ei search` at the pinned commit, `--json` where available | CLI from this checkout's `dist/` |
| `rg` | `ripgrep -w <name>` over the repository, default ignores | baseline: "what an agent does without any tool" |
| `tsls` | TypeScript language service `findReferences` with the pinned TypeScript (`eiRuntime.typescript`) | baseline: compiler-grade references, no risk judgement |
| `gitnexus`, `codegraph`, `graft` | whichever the owner has installed (Round 0 detects) | their own CLI or MCP server, default config |
| other | any further tool the owner names in Round 0 | same rules |

A contestant that is not installed is **not run** and is listed as such. The milestone completes without it.

## Repositories

Pin one commit per repository in Round 0 and never move it.

- `ksd-intelligence` (this repository, at the pinned commit, in a separate clone).
- `oh-my-pi` (public).
- `work-sure` (owner's private repository). **Privacy rule:** before any contestant touches `work-sure`, Round 0 records whether it sends code, embeddings or telemetry off the machine (documentation, config, and a network check during a run on a public repository). A contestant that does, or whose behaviour cannot be established, is not run on `work-sure` unless the owner writes "approved" for that tool. Raw outputs for `work-sure` stay outside the repository (`~/.cache/ksd-intelligence/m3b/`); only counts, repo-relative paths and symbol names already present in `docs/dogfood-log.md` style may be committed.

## Isolation

Every contestant runs in its own throwaway clone under `$TMPDIR/m3b/<repo>-<tool>/`, never in the owner's working checkout. After each run, `git status --porcelain` in that clone is recorded; anything a tool wrote into the repository (for example GitNexus injecting into `AGENTS.md` or `CLAUDE.md`) is a recorded **repository-write** observation, not something to commit. Nothing from these clones is ever committed.

## Task sets

| Set | Source | Size | Oracle |
|---|---|---|---|
| `G` golden | `tests/golden/M2-impact-cases.md` fixtures | all cases | the golden expectations, as written |
| `D` dogfood | `docs/dogfood-log.md` daily-use tasks | every task with a target | the log's recorded correct answer, re-checked against the pinned commit |
| `S` sampled symbols | per repository, seeded random sample of exported declarations (seed recorded) | 50 per repository: 10 with no references outside their file, 10 with common names (D56), 10 class members or overrides, 10 re-exported through a barrel, 10 uniform random | pooled adjudication (below) |
| `C` changes | per public repository, 5 real commits from history (mixed: rename, signature change, test-only, docs-only, multi-file) | 10 | pooled adjudication of affected dependents outside the diff |
| `Q` search | `tests/golden/search-queries.md` | as written | the query file (still `PROPOSED`; say so next to every search score) |

A contestant without a feature for a set (for example no change review, no search) is scored `n/a` for that set, not zero.

## Oracle: pooled adjudication

For `S` and `C`, the truth set of a target is built by pooling: the union of every dependent reported by any contestant plus `tsls`, each item then adjudicated **true** or **false** by reading the code at the pinned commit. Adjudication rules:

- A dependent is true if changing the target's exported surface could change that code's behaviour or compile result (D50 propagation, D55: references, not values).
- Dynamic access (string keys, `keyof`, prefix-less dynamic import, reflection) is true when the code path can reach the target; mark it `dynamic` in the log.
- Test files count, and are tagged `test`.
- Unclear cases are written down with the reason and counted in a separate `undecided` column; they are excluded from recall and precision, never guessed.

Every adjudication goes in `docs/research/m3b-data/adjudication-<repo>.jsonl` (public repositories) with target, item, verdict, reason and line. The cross-vendor review audits a random 10%.

## Metrics, in priority order

1. **False safe.** The contestant's answer implies the change is safe or has no dependents (ksd: level `low` with `proceed`; others: zero reported dependents, or their own lowest risk class) while the oracle has at least one true non-test dependent. Counted per target. This is the headline number.
2. **Honest abstention.** On targets the oracle tags `dynamic` or `undecided`, does the contestant say it is unsure (ksd: `partial` / `unknown`; others: any explicit warning)? Rate, with the denominator stated.
3. **Recall and precision of direct dependents**, symbol level. Contestants that report only files are scored at file level in a separate column; do not mix the two.
4. **Change review** (`C`): affected dependents outside the diff found / missed; files in the diff silently not analysed.
5. **Search** (`Q`): the M6a rules (rank ≤ 8 recall, exact at rank 1).
6. **Latency:** cold index, update after a one-file edit, warm query p50 and p95 (at least 20 queries, 3 runs, median of runs). Same machine, nothing else heavy running; record CPU, RAM, OS, Node.
7. **Output size** the agent must read: bytes, and tokens estimated as `ceil(chars / 4)` for every contestant.
8. **Setup and side effects:** steps to first answer, network use, files written into the repository, memory peak.

No combined score. The report shows each metric separately; the owner weighs them.

## Mapping outputs

Each contestant's output is mapped to `path#qualifiedName` (or `path` at file level) by a small adapter per contestant in `spikes/m3b-compare/adapters/`. Each adapter has a unit test on recorded sample output. When a contestant's output cannot be mapped unambiguously, record the raw item and count it as unmapped; never drop it silently.

## Code location

`spikes/m3b-compare/` (committed): runners, adapters, sampler, scorer, their tests. Node built-ins only, no new dependency (devDependencies included). Not part of `npm test`, not in the published package. One command reproduces every score from recorded raw outputs: `node spikes/m3b-compare/score.mjs --data docs/research/m3b-data`.

## Rounds

### Round 0 — reconcile and inventory (changes nothing)

1. Detect each contestant: `command -v`, version, how it is invoked (CLI or MCP), what it indexes, where it stores data, whether it writes into the repository, whether it uses the network or a hosted service (docs plus config). Do not install anything.
2. Propose the pinned commit for each repository and confirm each builds an index with ksd.
3. Check that every task set is available: count golden cases, dogfood tasks with a target, search queries; say which dogfood tasks cannot be re-run at the pinned commit and why.
4. Propose the 5 commits per public repository for set `C`, one line of reason each.
5. List questions for the owner, each with a default. Defaults: run only contestants already installed; no contestant on `work-sure` that uses the network; one documented setting per contestant at most; sample seed `20261125`.

Report and stop. If the owner replies "defaults", Round 1 starts with every default applied.

### Round 1 — harness on one repository

On `ksd-intelligence` only:

1. Runners for every installed contestant, the sampler, the adapters with their tests, the adjudication log format and the scorer.
2. Scorer self-test on the golden fixtures: ksd must reproduce the golden verdicts through the harness exactly; any difference is a harness bug until shown otherwise.
3. Run sets `G`, `D` (this repository's tasks), `S` and `C` for this repository; adjudicate; score.
4. Commit the harness, the raw outputs of public repositories in `docs/research/m3b-data/`, and a draft `docs/research/m3b-compare.md` with this repository's tables.

Report the tables and anything that looks unfair to a contestant (for example a mapping that loses its information). Stop.

### Round 2 — all repositories

1. Run every set on `oh-my-pi`, then on `work-sure` under the privacy rule.
2. Adjudicate; score; latency runs.
3. Complete the report: method, contestants and versions, per-metric tables per repository, every false-safe case listed with target and the missed dependent, abstention cases, side effects, limits of the comparison (sample size, oracle limits, `Q` still `PROPOSED`).
4. `docs/research/m3b-findings.md`: every ksd defect or weakness found, each with a reproduction command, severity, and whether another contestant handles it; every capability another contestant has that ksd lacks, with evidence it matters on these tasks (not on its marketing).
5. A short "recommendations" section: adopt, hand off, or ignore, each tied to a metric row. Recommendations are `PROPOSED`.

Report and stop.

### Round 3 — cross-vendor review

Different vendor from the Round 1–2 writer. Read only; write `docs/reviews/<date>-m3b-review.md`.

### Round 4 — fixes and close

Writer fixes what the review accepted (harness, adjudication, report only). The design reviewer drafts D66's outcome lines from the owner's answers. Findings are copied into the V1 close-out as items for its Round 1.

## Contingencies

- **A contestant crashes or hangs.** Retry twice with the same input; then record `crash` or `timeout` (cold index limit 30 minutes, query limit 60 s) and move on. Do not debug the other tool.
- **A contestant writes into the repository or home config.** Record it; discard the clone; continue. If it wrote outside its clone and outside its own data directory, stop and report.
- **A contestant needs an account, a key or a paid tier.** Not run; listed with the reason.
- **ksd gives a false safe.** Record it in findings as severity 1 with a reproduction, add it to the dogfood log's wrong-`low` table (Contingency D), and continue the comparison. Do not fix.
- **The oracle disagrees with a golden case.** Golden wins for set `G`; report the disagreement for the owner. Never edit `tests/golden/**`.
- **Context running low.** Commit and write `docs/research/m3b-handoff.md` per the common rules.

## Done when

- `docs/research/m3b-compare.md` and `docs/research/m3b-findings.md` exist, reviewed cross-vendor, review fixes applied.
- `score.mjs` reproduces every committed table from committed data.
- The owner has answered the recommendations, and D66 records the outcome.
- Findings are listed in the V1 close-out Round 1 input.

---

## Prompts

Paste one prompt per session. Record the exact model in every report. The Round 3 model must come from a different vendor than Rounds 1–2.

### Round 0

```text
Read docs/briefs/README.md (common rules) and docs/briefs/M3b-compare.md.
Do Round 0 of M3b only. Change nothing in the repository except a new
branch research/m3b-compare from origin/main.

Detect every contestant without installing anything. For each: path,
version, invocation (CLI/MCP), data location, whether it writes into the
repository, whether it uses the network or a hosted service, and the
evidence for each answer (doc URL or file, config key, observed
behaviour). Do not run any contestant on work-sure in this round.

Then: propose pinned commits per repository (confirm ksd indexes each),
count every task set, list dogfood tasks that cannot be re-run and why,
propose the 5 change commits per public repository with one-line
reasons, and list owner questions each with its default from the brief.

Report in the AGENTS.md template. Stop.
```

### Round 1

```text
Read docs/briefs/README.md and docs/briefs/M3b-compare.md, and the
owner's Round 0 answers below (or "defaults": apply every default in the
brief). Do Round 1 of M3b only, on branch research/m3b-compare.

Build spikes/m3b-compare/ (Node built-ins only): runners, adapters with
unit tests on recorded output, seeded sampler, adjudication log, scorer.
Run contestants only in throwaway clones under $TMPDIR/m3b/. Record git
status of each clone after each run.

First prove the harness: ksd through the harness must reproduce every
golden verdict exactly. Then run sets G, D, S, C on ksd-intelligence,
adjudicate by reading code (log every verdict with reason and line,
undecided stays undecided), score, and write the draft report.

Risky cases you must cover and show in the report: a target with zero
references (false-safe check), a common-name target, an override, a
barrel re-export, a keyof or string-key access, a prefix-less dynamic
import if the repository has one, a test-only dependent.

Never fix ksd; write defects to docs/research/m3b-findings.md with a
reproduction. Commit locally (no push). Report tables, fairness concerns
and NOT VERIFIED items. Stop.

OWNER ANSWERS:
<paste here, or "defaults">
```

### Round 2

```text
Read docs/briefs/README.md, docs/briefs/M3b-compare.md and
docs/research/m3b-compare.md (draft). Do Round 2 of M3b only, on branch
research/m3b-compare.

Run every set on oh-my-pi, then on work-sure under the privacy rule
(only contestants cleared for it; raw outputs stay in
~/.cache/ksd-intelligence/m3b/, commit counts only). Adjudicate, score,
run latency (>= 20 queries, 3 runs, median; record CPU, RAM, OS, Node).

Complete the report and findings exactly as the brief's Round 2 lists,
including every false-safe case by name and the limits of the
comparison. Recommendations are PROPOSED. Confirm `node
spikes/m3b-compare/score.mjs --data docs/research/m3b-data` reproduces
every committed table.

Commit locally (no push). Report and stop.
```

### Round 3 — review (different vendor)

```text
You are reviewing M3b on branch research/m3b-compare. Read
docs/briefs/README.md, docs/briefs/M3b-compare.md,
docs/research/m3b-compare.md, docs/research/m3b-findings.md and
spikes/m3b-compare/. Change no code; write only
docs/reviews/<YYYY-MM-DD>-m3b-review.md.

Check, with evidence: (1) rerun score.mjs and confirm every table;
(2) audit a random 10% of adjudications by reading the code, report
the disagreement rate; (3) every adapter keeps the contestant's
information (nothing dropped, unmapped counted); (4) fairness: same
commit, same machine, defaults plus at most one recorded setting, no
contestant judged on a feature it does not have; (5) every false-safe
claim, for ksd and for the others, reproduced; (6) privacy rule held for
work-sure (no raw work-sure output committed, no uncleared contestant
run on it); (7) recommendations follow from the tables.

Findings with severity (blocker / should-fix / note) and a one-line fix
each. Record your exact model. Commit the review file locally. Stop.
```

### Round 4 — fixes

```text
Read docs/reviews/<date>-m3b-review.md and the owner's decisions on it
below. On branch research/m3b-compare, fix only the accepted findings
(harness, adjudication, report). Re-run score.mjs and confirm every
table. Copy every finding in docs/research/m3b-findings.md into a
"From M3b" list at the end of docs/briefs/V1-closeout.md Round 1 input,
one line each with its link. Commit locally (no push). Report and stop.

OWNER DECISIONS:
<paste here>
```
