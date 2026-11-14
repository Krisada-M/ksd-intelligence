# M2b — owner prompts, round by round

Paste one prompt per agent session. Each round ends with a local commit and a short report; the owner decides when the next one starts. The brief is `docs/briefs/M2b-impact.md`; these prompts add order, stop points and the known risky cases.

| Round | What | Model |
|---|---|---|
| 1 | Step 1: index additions | strongest coding model available (see `README.md`) |
| 2 | Step 2: query core and golden cases | same |
| 3 | Step 3: tool, CLI, rendering, live, latency | same |
| 4 | Independent review, read-only | a model from a different vendor than the one that wrote rounds 1–3 |
| 5 | Fix round | any of the writing models |
| — | Contingencies A–D | same model as the round they interrupt |

## Common rules (included in every prompt below)

```text
Rules for this session:
- Run `git fetch origin` first. Local main may be stale; branch from or
  rebase onto origin/main, never local main.
- If node_modules does not match package-lock.json, run `npm ci`.
- If AGENTS.md has an injected block or CLAUDE.md/.ignore appeared,
  restore AGENTS.md with git checkout, leave the others untracked, and
  say so in the report.
- Never edit tests/golden/**, src/policy/** or tests/policy/**. Never
  weaken, skip or delete a test to get green.
- Commit locally with dist/ (npm run check:dist must pass after the
  commit). Do not push. Do not start the next step.
- Before your context runs low, commit what works and write
  docs/research/m2b-handoff.md: done, in progress, next command, open
  questions.
- Report in the AGENTS.md template with the exact model. Label what you
  did not run as NOT VERIFIED.
```

## Round 1 — Step 1: index additions

```text
Read AGENTS.md, then docs/briefs/M2b-impact.md. Do Step 1 only.
Branch m2b-impact from origin/main.

[Common rules]

Order of work:
1. Before changing code, go through golden cases C01–C26 and F01–F06
   against the current index and write a table in
   docs/research/m2b-measurements.md: case, data it needs, whether the
   index already holds it, and if not whether it can be derived at query
   time. Extend the extractor only for rows that cannot be derived.
2. Implement 1.1 (keyof key access) with fixture-copy tests for both
   outcomes: edge when the property resolves to one indexed declaration,
   computed-member-access gap on the owner type when it does not.

Risky cases you must cover with a test each:
- get(u, "cost") with K extends keyof Usage            -> edge
- pick(u, ["cost", "total"])                           -> one edge per key
- a key held in a variable of type keyof Usage         -> gap on Usage
- a key valid for two owners (keyof A | keyof B)       -> gap on both
- a string literal that only looks like a key but is typed string
  (log("cost"))                                        -> nothing stored
- a literal key of a Record<"a" | "b", V>              -> nothing stored
  (no declaration; ADR 0003)
The fifth case matters most: a false edge from an ordinary string is a
defect.

After the change:
- npm test green, including randomised incremental == cold,
  update-soundness and the mutation smoke.
- The fixture differential asserts exact counts. Change a number only
  where 1.1 legitimately changes it and explain each changed number.
- On oh-my-pi: cold build, then `ei doctor --deep --differential 300`.
  It must exit 0. Report how many new edges and how many new gap sites
  1.1 produced, and how many declarations are now partial because of a
  keyof gap. If more than 5% of declarations became partial, stop and
  report before going on: the gap rule is too broad.

Stop after Step 1.
```

## Round 2 — Step 2: query core and golden cases

```text
Read AGENTS.md, docs/briefs/M2b-impact.md and
docs/research/m2b-measurements.md (and m2b-handoff.md if it exists).
Step 1 is committed on m2b-impact. Do Step 2 only.

[Common rules]

Order of work:
1. Write the golden tests first, one per case C01–C26 and F01–F06,
   named with the case id, asserting exactly what the case states. They
   fail at first. Then build src/core/impact/ until they pass.
2. Then the "never low" test from the brief.

The golden file is the oracle. If an expectation looks wrong, leave the
test failing, and report the case id, what the engine returns, and why
you think the expectation is wrong. Do not adjust either side.

Risky cases you must cover with a test each (beyond the golden cases):
Completeness
- A gap on a symbol three levels up the caller chain makes the target
  partial; a gap on an unrelated symbol in the same file does not.
- depth 1 and depth 10 give the same completeness, reach, factors and
  verdict; only the listing differs.
- Traversal cap reached with unvisited nodes -> depth-limit, partial.
- A cycle (C19) terminates and counts each symbol once.
Targets
- Bare name with one declaration; with several (ambiguous, sorted);
  with none (closest names, at most 5).
- Owner.member; path#name; path:line on a declaration line, inside a
  body, inside a local function, on a blank line between declarations,
  beyond the end of the file.
- path of a file with no exported declarations; path excluded by the
  secret rule; path that is not indexable (json, orphan).
- A member of an anonymous object type (D51): parent result, partial,
  line 1 names both.
- A target whose only users are in test files: tests listed, reach
  counted per the golden rules.
- Batch of 5 with one ambiguous and one not found: the other three are
  answered.
Factors
- public-export-surface when the package is not private and the symbol
  is reachable from its entry through a barrel; absent when the package
  is "private": true.
- many-callers at the threshold and one below it (C26).
- Factors are still reported when the level is unknown (C12).
Freshness (use a fake engine host where a real build would be slow)
- No drift: no child process is started. Assert it.
- Drift, update finishes in time: answer includes the edit; footer says
  index updated.
- Drift, update slower than the budget: stale answer, level unknown,
  drifted files listed; the update is still running afterwards.
- Lock held by another live process: stale answer, no second build.
- Two calls in the same session while one update runs: the second does
  not start another build.
- Update fails, older index exists: stale answer plus the failure.
- No index and the engine fails: index-failed error result.
- A stale answer can never be low, medium or complete. Assert it over
  every golden target.

Checks before you stop:
- npm test green; list any golden case left failing with its reason.
- On oh-my-pi (index built, no drift): run 200 targets sampled by a
  seeded shuffle and report the distribution of level (low, medium,
  unknown) and the ten most frequent completeness reasons with counts.
  If more than 60% are unknown, do not tune anything: report the top
  reasons and stop. The owner decides whether a scoping rule is too
  broad.
- From the same 200: pick the 10 with level low and verify each by hand
  against `findReferences` (or the differential oracle). Paste the
  table. One wrong low is a blocker.

Stop after Step 2.
```

## Round 3 — Step 3: tool, CLI, rendering, live, latency

```text
Read AGENTS.md, docs/briefs/M2b-impact.md, docs/TOOLS.md §1, §4, §8,
§10, and docs/research/m2b-measurements.md (and m2b-handoff.md if it
exists). Steps 1 and 2 are committed on m2b-impact. Do Step 3 only.

[Common rules]

Before changing src/adapters/omp/, read the extension types of the OMP
version installed on this machine and record the version and files read.

Risky cases you must cover with a test each:
Rendering
- Byte-identical output for the same input, twice, and across a fresh
  process.
- No absolute path, home directory, timestamp, duration or pid anywhere
  in the text (snapshots must be equal on macOS and Linux).
- Exactly one level word in a block, on the ACTION line.
- Over budget for one target: depth 1 kept, deeper levels summarised
  with the follow-up call named; the block is at most 4,000 characters.
- Batch over 12,000 characters: every target still gets its first
  three lines.
- A target with 5,000 callers renders within budget and within the
  latency target.
- Gaps render as `code path:line — what to check`, at most 10, then a
  count.
- Guidance results (ambiguous, not found, index building, NOT INDEXED)
  have no isError; index-failed has isError.
Tool
- EI_DISABLED=1 registers no ei_* tool.
- Invalid input (0 targets, 6 targets, depth 0, depth 11, a non-string)
  returns an error result, never throws.
- An abort signal during a build returns `Cancelled` and leaves no
  child behind (assert the pid is gone).
- A throw inside the query core becomes an index-failed result.
- details carries ImpactResult[] that matches the text.
- cwd in a subdirectory of the repository, and in a git worktree,
  resolves the same repository index.
CLI
- `ei impact x --json` prints the typed result; exit code 0 for
  results and guidance, non-zero only for failures.

Snapshots: write them under tests/snapshots/impact/ as the brief lists,
mark them PROPOSED in the report with their paths, and print two of
them in full in the report (C01 and the stale-index answer).

Live, on this repository (label the OS):
- `ei index`, then through
  `omp -p --no-extensions --model claude-haiku-4-5 -e
  dist/adapters/omp/extension.js` ask the agent to call ei_impact for
  `Graph.incoming`, then for an ambiguous bare name, then for a name
  that does not exist. Paste the three tool outputs.
- If the agent does not call the tool, say so; do not paste a CLI
  output in its place.

Latency on oh-my-pi (no drift), 20 targets of mixed size: p50 and p95
of the whole call, split into probe, open, traverse, render. Target
p95 < 300 ms. If it misses: report the split first. Fix only if one
cause dominates and the fix is an SQL index or a reused statement;
anything larger, stop and report.
Also one call after a one-file body edit: wall time and which freshness
row it took.

Extend the mutation smoke with the six mutations the brief lists; all
must be killed.

Stop after Step 3. Do not start M2c.
```

## Round 4 — independent review (read-only)

```text
You are reviewing, not building. Read AGENTS.md,
docs/briefs/M2b-impact.md, docs/TOOLS.md §4 and §8,
tests/golden/M2-impact-cases.md, then the diff
`git diff origin/main...m2b-impact -- . ':!dist'`.

Do not change anything under src/. You may add failing tests under
tests/review/ to prove a finding. Do not commit, do not push.

Look for, in this order:
1. Any path to a wrong `low` or `medium`: a gap that is stored but not
   applied to the target, a scoping rule narrower than golden P4, a
   stale or failed index answered as complete, an exception swallowed
   into an empty result, an empty caller list from a missing index
   treated as zero callers.
2. Golden tests that assert less than the case states, or a case with
   no test.
3. keyof handling: a false edge from an ordinary string; a missing gap.
4. Target resolution that silently picks one of several candidates.
5. Freshness: a second build started while one runs; a child left
   running after abort; a query that creates a TypeScript program.
6. Rendering: more than one level word, non-deterministic content,
   budget overflow, text that differs from docs/TOOLS.md §4.
7. Anything written that the brief forbids: risk zones, ei_changes,
   audit log, a new code not in DESIGN §7.2, edits to golden files.

Report: findings ordered by severity, each with file:line, a concrete
input that shows it, and the failing test if you wrote one. Say
explicitly which of the seven areas you checked and found clean, and
which you did not check. Give no praise and no style comments.
```

## Round 5 — fix round

```text
Read AGENTS.md and docs/briefs/M2b-impact.md. M2b steps 1–3 are
committed on m2b-impact. Fix the review findings below, nothing else.

[Common rules]

For each finding: first add a test that fails because of it (or adopt
the reviewer's test from tests/review/ into tests/core/), then fix,
then show the test passing. If you believe a finding is wrong, do not
change the code: answer with the evidence.

Findings:
<paste the list from the owner / reviewer here>

After the fixes: npm test, typecheck, lint, format, check:dist; rerun
the mutation smoke; rerun the 200-target distribution and the 10
hand-checked lows on oh-my-pi and report whether any number moved and
why. If a snapshot changed, list it as PROPOSED again with a one-line
reason.

Stop and report.
```

## Contingencies

### A — resume after a session was cut off

```text
Read AGENTS.md, docs/briefs/M2b-impact.md and
docs/research/m2b-handoff.md. Run `git status` and
`git log --oneline origin/main..m2b-impact`. Tell me in five lines what
is done, what is half done and what you will do next, then continue the
same step only.

[Common rules]
```

### B — CI is red after the push

```text
CI failed on m2b-impact. The failing job log is below. Fix the cause,
not the symptom: no skipped test, no OS-specific exception unless the
behaviour really differs, and then say why.

Usual causes in this repository: temp paths not passed through
realpath on macOS (/var vs /private/var); output that contains an
absolute path or a duration; file ordering taken from the filesystem
instead of sorted; a child process still alive at the end of a test;
dist/ not rebuilt; format:check.

[Common rules]

<paste the log>
```

### C — a golden case cannot pass

```text
Golden case <id> fails and you reported the expectation may be wrong.
Do not change the test or the golden file. Write
docs/research/m2b-golden-<id>.md with: the case text, the fixture
files involved, what the engine returns and from which edges or gaps,
what TypeScript's findReferences says, and the two readings of the
case with what each would mean for the other golden cases. Stop there;
the owner decides.
```

### D — a wrong `low` found while using the tool

```text
The owner found a wrong low. Target: <target>. What depended on it but
was missing: <file:line>. This stops all other work.

1. Reproduce it as a fixture-copy test that fails.
2. Say which layer lost it: not extracted, extracted but no edge, edge
   present but not traversed, gap not recorded, gap recorded but not
   applied, or stale index answered as fresh.
3. Fix that layer. Check whether the differential oracle should have
   caught it; if it has a skip that hid it, narrow the skip.
4. Rerun npm test, the mutation smoke and
   `ei doctor --deep --differential 300` on oh-my-pi.
5. Add a line to docs/dogfood-log.md: date, target, cause, fix.

[Common rules]
```
