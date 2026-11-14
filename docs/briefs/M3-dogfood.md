# M3 — Dogfood on real repositories (owner-led)

M3 is use, not construction. It starts when M2b is accepted and continues alongside M2c, M6a and M4a. Its output is evidence: whether the answers are right, whether they change what the agent does, and how fast the tool is on the owner's own code. That evidence sets the build targets (DESIGN §14), decides the gated milestones, and corrects the draft briefs.

**Stop rule (DESIGN §13):** one wrong `low` on a real change stops all other work until it is fixed and has a regression test. Use contingency D in `README.md`.

## Repositories

- This repository (`ksd-intelligence`), on both machines.
- One real work project (read-only clone is enough). Name it in `docs/dogfood-log.md`; do not commit anything from it.
- `oh-my-pi` stays the stress reference, not a daily target.

## Setup round (agent, once per repository and machine)

```text
Read docs/briefs/README.md and docs/briefs/M3-dogfood.md, then do the
setup round on <repo path>. Change no code in ksd-intelligence.
1. `ei setup --check`; `ei init --dry-run` in the repository and show
   the proposed ei.config.json. Do not write it; the owner reviews it.
2. After the owner writes the config: `ei index`, `ei status`. Record in
   docs/research/m3-<repo>-<os>.md: indexable files, lines, cold build
   time and peak RSS, phase split, runtime (node or bun), gap-site
   counts by reason, orphan and unindexed counts with the top reasons.
3. Timings, 3 runs each, median and range: no-drift query p50/p95 over
   20 targets; one-file body edit update; signature edit of a widely
   used export; add file.
4. `ei doctor --deep --differential 300`; paste the result.
5. Distribution over 200 seeded targets: low / medium / unknown and the
   ten most frequent completeness reasons.
6. Hand-check 10 `low` results against findReferences. Paste the table.
Report; do not tune anything.
```

After the setup rounds the owner sets the daily-use limits for cold build, body-edit update and signature-edit update on the work repository. They go into DESIGN §14 as the gates. If a measurement misses a limit, use contingency E.

## Daily use (owner, two weeks, at least 10 real tasks)

Work normally in OMP with the plugin installed. For each real task add one entry to `docs/dogfood-log.md`:

```text
## <date> — <repo> — <task in one line>
Tools called: ei_workflow(stage) · ei_impact(target) · ei_changes · ei_search
Correct? yes / no / partly — <what was wrong; file:line>
Changed what the agent did? yes / no — <how>
Latency felt: fine / slow (<seconds, which call>)
Verdict given: <level, action> — was it the right call?
Missing: <what you wished the tool had told you>
```

Until M2c ships the audit log, the entry is written by hand; afterwards `ei audit --since 7d` fills in calls, verdicts and timings.

Things to try on purpose at least once: a change to an exported function used across packages; a change inside a payment or auth path; a rename; a deleted export; a type-only change; a change in a file the index marks orphan; a call right after editing three files; two OMP sessions on the same repository; a git worktree.

## Weekly review round (agent)

```text
Read docs/briefs/README.md, docs/briefs/M3-dogfood.md and
docs/dogfood-log.md (and the audit log through `ei audit --since 7d` if
it exists). Change no code. Report:
1. Tasks logged; share where the answer was correct; share where it
   changed what the agent did.
2. Every wrong or partly wrong answer, grouped by cause, with the layer
   that lost it. Any wrong `low` first.
3. The completeness reasons that made answers `unknown` most often, and
   for each whether the reason was real (the agent found something at
   the gap site) or noise.
4. Calls that felt slow, with measured time and phase.
5. Symbols edited without a prior ei_impact call (from the log).
6. What the owner wished for under "Missing", grouped.
7. Evidence for each gate in docs/briefs/gated-M4b-M5-M6b.md and for
   each M4a detector: met / not met / no data.
Stop.
```

## Exit

M3's first phase ends after two weeks and at least 10 logged tasks with no open wrong-`low`. The owner then decides and records in the decision log:

| Decision | Input |
|---|---|
| Build and update limits for daily use (DESIGN §14) | setup-round timings |
| Narrow the D50 propagation rule (D51) | signature-edit time on the work repository |
| Index members of anonymous object types (D51) | "Missing" entries that name them |
| Which scoping rules are too broad or too narrow | weekly review item 3 |
| Which M4a detectors to build | routes actually present in the work repository |
| Whether M4b, M5 or M6b ever start | their gates |

Dogfood itself does not end; the log keeps going until the close-out.
