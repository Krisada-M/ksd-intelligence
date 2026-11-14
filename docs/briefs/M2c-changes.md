# M2c — Risk zones, `ei_changes`, audit log, stage protocol (agent brief, DRAFT)

**Draft.** Written before M2b was built. Start with Round 0 (`README.md`).

Read `docs/briefs/README.md` (common rules). Then `docs/RISK.md` §2, §3.2, §5, §6; `docs/TOOLS.md` §3, §4, §5, §8, §10; `docs/DESIGN.md` §7.2, §7.4, §9 and decisions D32, D50–D53; golden cases P01–P05 and X01–X03.

**Branch:** `m2c-changes` from `origin/main`.

## Goal

1. Dangerous areas raise the verdict: risk zones.
2. Before reporting done, the agent sees what its diff actually affects: `ei_changes`, with no changed file left out.
3. Every tool call leaves a trace without source text: the audit log.
4. `ei_workflow` tells the agent at each stage which evidence to gather.

## Round 1 — risk zones

- `riskZones` in config: `"default"` (the four zones of RISK §2.1), a list, or `[]`. Invalid entries fall back to the default for that section and are reported by `ei_status`.
- A zone applies when the target's file or any impacted symbol's file matches (and, in Round 2, any changed file). Zones only raise: derivation table RISK §2.3, several zones → strongest action. `verdict.zones`, `requiredActions` and `basis` are filled.
- Line 2 of the `ei_impact` block shows the zone as in TOOLS §4.
- `ei_status` Config line lists the active zones.

Risky cases, one test each:
- Golden P01–P04 pass with `riskZones: "default"`.
- **Golden C01–C26 were confirmed without zones.** Their tests must set `riskZones: []` explicitly and still pass unchanged; a C-case that changes level because the default zones now apply is a test set-up error, not a new expectation.
- A zone reached only at depth 4 still applies when `depth` is 1.
- `floor: critical` with a complete, quiet target → critical, `ask-owner`.
- high zone + unknown base → high, `ask-owner` (P02), never `run-tests`.
- A zone glob that matches nothing changes nothing; a malformed glob does not throw.
- A zone can never lower: property test over every golden target, verdict with zones ≥ verdict without.
- Zone matching uses paths only; an excluded or secret file still matches by path and its content is never read.
- Accepted M2b snapshots are unchanged when `riskZones: []`; new snapshots for P01 and P02 are PROPOSED.

## Round 2 — `ei_changes`

`ChangesResult` per RISK §2.4, text per TOOLS §5 (budget 8,000 characters), CLI `ei changes [--base REF] [--json]`. Location: `src/core/changes/`.

- **Base:** `base` argument, else the merge-base of `HEAD` with the default branch (`origin/HEAD`, else `main`, else `master`); plus staged, unstaged and untracked changes. Git is called with fixed arguments and `-z`; no shell.
- **Freshness:** always the full content hash. The index is updated first; a failed or over-budget update gives the stale answer of M2b (never complete).
- **Changed symbols:** in the engine child (it has TypeScript), parse the base version of each changed indexable file (`git show base:path`, syntax only) and compare declarations by stable key: `added`, `removed`, `signature-changed` (the type-stating text of `surface.ts` differs), `modified` (only the body differs). A change outside any declaration (imports, top-level statements) is reported against the file's module symbol.
- **Removed or signature-changed symbols that still have users** come first, with those users. For a removed symbol the users are the unresolved imports and name matches that now point at nothing; say so in the text.
- **Impact:** the union of `ei_impact` results over the changed symbols (`byDepth`, `tests`, `completeness`, `reach`, `factors`), then one verdict with zones applied to target files, impacted files **and every changed path**.
- **Nothing hidden (X03):** every changed path is either in `changedFiles` with `indexed: true` or in `unindexedChanges`. Any unindexed change adds `outside-index-scope` and makes the picture partial.
- No changes: the success-shaped line of TOOLS §5.
- Register `ei_changes` in the extension entry; `EI_DISABLED=1` removes it.

Risky cases, one test each (temp git repositories; set `user.name`, `user.email` and the default branch explicitly so CI behaves the same):
- X01, X02, X03, P05.
- Untracked new file; staged-only change; unstaged-only; both on the same file.
- Deleted file with live importers → its exports listed as removed, importers shown.
- Renamed file (with and without edits): no symbol silently lost; old key removed, new key added, users of the old path shown.
- Rename of a symbol: removed + added, old users listed.
- Whitespace-only and comment-only edit → file listed, no changed symbol, no impact, still not omitted.
- Body edit of a function with an inferred return type → at least `modified`; if `surface.ts` treats it as type-stating, `signature-changed`. State which and why.
- Change in a `.sql` file, a `.env.local`, a JSON config, a binary, a file in an excluded directory, an orphan `.ts` (no tsconfig): each listed under `Not analysed` with a reason; secret files by path only, content never read; zone floors applied (migrations and prod-config → critical).
- A changed file that fails to parse → listed, `parse-error`, partial.
- No git repository; detached `HEAD`; no default branch; shallow clone without the merge-base; `--base` naming a ref that does not exist: guidance or a clear failure, never an empty "nothing changed".
- A git worktree; `cwd` in a subdirectory.
- 300 changed files: within budget, sections summarised with counts, the first line and verdict intact.
- Over budget: signature-changed section is kept in full before anything else is cut.
- Called twice with no edits in between → identical bytes.
- An empty diff against the base while the index is stale → "nothing changed", not a stale warning.

## Round 3 — audit log and stage protocol

**Audit log** (RISK §5): append-only JSON Lines at `<cache>/<repo-id>/audit.jsonl`, directory `0700`, file `0600`; fields as in RISK §5; rotate at 5 MB, keep 3. One line per call of `ei_workflow`, `ei_impact`, `ei_changes`, `ei_status` (and later tools), written for results, guidance and failures alike. `ei audit [--since 7d]` prints calls per tool, verdict distribution, slowest calls, and symbols changed (from `ei_changes` lines) without an earlier `ei_impact` line for them.

Risky cases, one test each:
- No source text, skill text, diff, env value, token or absolute home path in any line: write a line for a target whose file contains a marker string and for a task containing a token-like string, then grep the log.
- Task strings truncated to 200 characters.
- A failing write (read-only directory, disk full simulated) never fails or slows the tool call beyond 50 ms and is reported once by `ei_status`.
- Two processes appending at once produce only whole lines.
- Rotation at the size limit; `ei audit` reads rotated files; a corrupt line is skipped and counted.
- `EI_DISABLED=1` writes nothing. `ei cache clear` removes the log.

**Stage protocol** (RISK §2.5): the `ei_workflow` header gains the one line per stage from the table. It is text only: `src/workflow/**` must not import `src/core/impact/**` or `src/core/changes/**` (add a dependency test). The KSD precedence header stays first. Workflow snapshots that change are PROPOSED.

## Round 4 — live, measurements, mutation

- **Live, on this repository (label the OS):** through `omp -p`, edit a function body in a scratch branch, have the agent call `ei_changes` with no arguments, then `ei_impact` on a file under a default zone; paste both outputs. Show the resulting audit lines.
- **Latency** on the work repository or oh-my-pi: `ei_changes` after a one-file body edit, a signature edit, and with 20 changed files; split into update, base parsing, traversal, render.
- **Mutation smoke** extended; these must be killed: a zone that lowers; zones not applied to changed paths; a changed file dropped from both lists; untracked files ignored; a removed symbol with users not listed first; the stat probe used instead of the hash; audit line containing the task untruncated; an unindexed change not adding `outside-index-scope`.
- `docs/research/m2c-measurements.md`.

## Round 5 — review · Round 6 — fix

Use the round types in `README.md`.

**Review focus**
1. Any way a changed file is omitted from both `changedFiles` and `unindexedChanges`.
2. Any way a zone fails to apply (path normalisation, case, a changed path outside the index scope, a deleted file) or lowers a verdict.
3. A diff answered from a stale index as complete.
4. Symbol comparison errors: overloads, merged declarations, class members, re-exports, default exports, a symbol moved between files.
5. Git handling: argument injection through `base`, paths with spaces or newlines, non-UTF-8 names, submodules.
6. Audit log content and failure isolation.
7. Golden C-cases still tested without zones; nothing in `tests/golden/**` changed.
8. Workflow router independent of the engine.

## Acceptance

1. P01–P05 and X01–X03 pass; C01–C26 and F01–F06 still pass unchanged.
2. X03 holds for every change set in the tests (a shared assertion helper).
3. Property test: zones never lower a verdict.
4. Audit log passes its content tests.
5. Live outputs pasted; measurements written; mutation smoke clean.
6. CI green on macOS and Linux after the owner pushes. Snapshots listed as PROPOSED.

## Do not

- Implement route detection, bridges, search or a watcher.
- Track owner acknowledgements or any other state between calls (RISK §2.3: the library is stateless).
- Read the content of secret or excluded files.
- Let the agent override or suppress a verdict through any input.
