# M2b acceptance record — owner disposition pending

**Status: NOT VERIFIED for formal acceptance.** This record does not accept M2b.
The independent cross-vendor review, the body-edit measurement discrepancy, and
the current branch's protected-path gate require resolution before M3.

## Revision and environment

- **VERIFIED:** `GIT_TERMINAL_PROMPT=0 git fetch origin` exited 0.
  `git merge-base --is-ancestor ad21058 origin/main` exited 0.
- Candidate: `ad21058ebbd115580bbcb16e24328f5ab93869bc` (PR #32).
  Local `origin/main`: `ac3caaa041450fbf1d2331d356f4c9b201c480c6`.
- Candidate commands ran in a detached, temporary worktree at `ad21058` with
  the existing `node_modules` linked. The checkout was not switched. Runtime
  and cache used a temporary `HOME`; the pinned TypeScript 5.9.3 was installed
  offline from the existing package.
- Linux WSL2 x86_64; Node `v24.21.0`; npm `12.2.0`; Bun `1.4.2`; OMP `19.1.0`.
- `git diff --stat 7ee7307 ad21058 -- src/ dist/ ei.config.json package.json package-lock.json`
  produced no output. This compares code and configuration with the recorded
  Round 6 code commit, not the identity of every historical test environment.

## Traceability to `docs/briefs/M2b-impact.md#acceptance`

| Criterion | Evidence and result | Status |
| --- | --- | --- |
| 1. Local suite and macOS/Linux CI | At `ad21058`: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, and `npm run check:dist` each exited 0. `npm test`: 605 tests, 59 suites, 605 passed, 0 failed, 0 skipped. Candidate CI jobs are linked below; both succeeded. Runner architectures were not obtained from the job logs. | VERIFIED for listed commands and job conclusions; NOT VERIFIED for runner architectures |
| 2. C01–C26 and F01–F06 | `node --import ./tests/policy/helpers/isolated-home.js --test dist-test/tests/core/impact-golden.test.js dist-test/tests/core/impact-freshness.test.js`: exit 0; 43 tests passed. The output contains all 26 C IDs and all 6 F IDs. | VERIFIED |
| 3. Unknown never rendered low or medium | The same targeted run passed `golden unknown targets never yield low or medium any display depth`. | VERIFIED for the tested golden cases |
| 4. M2a checks and 300-target reference doctor | Candidate `npm test` passed; a targeted differential/randomized/update-soundness run passed 16 tests. The historical doctor artifact reports 0 graph differences, 0 counter differences, 300 declarations, 8,103 references covered and 0 misses. The reference doctor was not rerun in this session. | NOT VERIFIED by a current reference-doctor run; historical artifact corroborated |
| 5. Snapshots proposed for review | All 11 candidate snapshots are listed below as `PROPOSED`; no owner acceptance was found. | PROPOSED |
| 6. Live OMP output and latency | The real installed OMP extension loader executed both `ei_impact` calls below. An isolated live LLM turn failed before completion. Historical R8 artifacts report 20 targets, whole-call p50 201.18 ms and p95 291.54 ms; the body-edit artifact conflicts with the written measurement. | VERIFIED for loader/tool outputs; NOT VERIFIED for an LLM turn and disputed body-edit measurement |
| 7. Required report and stop | The session report is delivered separately. Owner disposition remains pending; ticket 02 requires stopping before M3. | NOT VERIFIED for owner disposition |

The targeted candidate commands also reported 149/149 policy tests and 4/4
packaging tests passed. The 16-test differential/randomized run used:

```sh
node --import ./tests/policy/helpers/isolated-home.js --test \
  dist-test/tests/core/differential.test.js \
  dist-test/tests/core/randomized.test.js \
  dist-test/tests/core/update-soundness.test.js
node --import ./tests/policy/helpers/isolated-home.js --test tests/policy/*.test.js
node --import ./tests/policy/helpers/isolated-home.js --test tests/packaging/*.test.js
```

## CLI and real OMP results

**VERIFIED:** After an offline TypeScript runtime setup and `node
 dist/adapters/cli/main.js index --root "$PWD"`, the candidate CLI and the
installed OMP `loadExtensions` tool each returned the following identical
`Graph.incoming` output. Both commands exited 0. The first pre-index `status`
returned exit 1 with `STATUS degraded (no index)`; the post-index status
returned exit 0 with `STATUS ready`.

```sh
node dist/adapters/cli/main.js impact 'src/core/graph/graph.ts#Graph.incoming' --depth 2 --root "$PWD"
```

```text
IMPACT Graph.incoming — src/core/graph/graph.ts:44
ACTION proceed · level low · picture complete
REACH 3 direct · 3 total · 2 files · 1 package · 0 routes · factors: none

Callers, depth 1 (3)
  tests/core/differential.test.ts:1  <module>  CALLS
  tests/core/indexing.test.ts:1  <module>  CALLS
  tests/core/indexing.test.ts:23  users  CALLS
Tests (2)
  tests/core/differential.test.ts
  tests/core/indexing.test.ts
Gaps: none
Next: after your change, run the tests above; call ei_changes before you report done.
— index fresh · 402 files · limits: 1 unbounded dynamic import, 119 excluded files · ts 5.9.3 · engine 0.1.0
```

**VERIFIED:** `render` returned `NOT FOUND`, not ambiguity. The candidate CLI
and real OMP tool were then called with `status`; each exited 0 and returned:

```text
AMBIGUOUS status — 4 declarations. Call again with one of:
  src/core/engine/host.ts#EngineHost.status
  src/core/kernel/types.ts#Completeness.status
  src/core/workspace/scan.ts#CensusRecord.status
  src/storage/sqlite.ts#FileRecord.status
```

CLI command: `node dist/adapters/cli/main.js impact status --depth 2 --root "$PWD"`.
For the OMP calls, Bun imported the installed
`@oh-my-pi/pi-coding-agent/src/extensibility/extensions/loader.ts`, called
`loadExtensions(["<candidate>/dist/adapters/omp/extension.js"], cwd)`, and
invoked the registered `ei_impact` definition with `targets` containing each
of the two names and `depth: 2`. This exercised the real OMP loader, not an
LLM turn. **NOT VERIFIED:** live model invocation or interactive OMP UI.

An isolated full turn was also attempted with:

```sh
timeout 90s omp -p --no-session --no-extensions --tools=ei_impact \
  --model=claude-haiku-4-5 -e "$PWD/dist/adapters/omp/extension.js" \
  'Call ei_impact with targets ["src/core/graph/graph.ts#Graph.incoming"] and then ["status"], depth 2. Print both tool outputs verbatim. Do not read environment variables or credentials.'
```

It exited 1, and its diagnostic contained `No API key`. No credential was
requested or copied. The live LLM turn remains **NOT VERIFIED**.

The exact OMP loader calls were:

```sh
export OMP_LOADER="$REAL_HOME/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/extensions/loader.ts"
bun -e '
const { loadExtensions } = await import(process.env.OMP_LOADER);
const cwd = process.cwd();
const loaded = await loadExtensions([`${cwd}/dist/adapters/omp/extension.js`], cwd);
if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
const tool = loaded.extensions[0]?.tools.get("ei_impact");
if (!tool) throw new Error("ei_impact not registered");
for (const target of ["src/core/graph/graph.ts#Graph.incoming", "render"]) {
  const result = await tool.definition.execute(`audit-${target}`, { targets:[target], depth:2 }, undefined, undefined, { cwd });
  console.log(`--- OMP ei_impact ${target} ---`);
  for (const entry of result.content ?? []) if (entry.type === "text") console.log(entry.text);
  if (result.isError) process.exitCode = 1;
}
'
bun -e '
const { loadExtensions } = await import(process.env.OMP_LOADER);
const cwd = process.cwd();
const loaded = await loadExtensions([`${cwd}/dist/adapters/omp/extension.js`], cwd);
if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
const tool = loaded.extensions[0]?.tools.get("ei_impact");
if (!tool) throw new Error("ei_impact not registered");
const result = await tool.definition.execute("audit-status", {targets:["status"],depth:2}, undefined, undefined, {cwd});
for (const entry of result.content ?? []) if (entry.type === "text") console.log(entry.text);
if (result.isError) process.exitCode = 1;
'
```

## CI and independent review

`gh run list --commit ad21058ebbd115580bbcb16e24328f5ab93869bc --limit 100 --json databaseId,name,status,conclusion,url,headSha,event,createdAt`
returned completed successful run [44939731705](https://github.com/Krisada-M/ksd-intelligence/actions/runs/44939731705).
`gh run view 44939731705 --json jobs` returned:

| Job | Conclusion | Architecture |
| --- | --- | --- |
| [Node 24 / ubuntu-latest](https://github.com/Krisada-M/ksd-intelligence/actions/runs/44939731705/job/136954062881) | VERIFIED success | NOT VERIFIED; job-log output was empty |
| [Node 24 / macos-latest](https://github.com/Krisada-M/ksd-intelligence/actions/runs/44939731705/job/136954062653) | VERIFIED success | NOT VERIFIED; job-log output was empty |

**NOT VERIFIED:** independent cross-vendor review of the final Round 6
candidate. `docs/reviews/2026-11-18-m2b-round-4-findings.md` identifies the
Round 4 reviewer as Gemini 4 Argon (High); the Round 4 decisions expressly say
that review did not satisfy the cross-vendor rule. The final Round 6 builder's
model is not established by the reviewed evidence. GitHub PR #32 returned an
empty reviews list and no issue or inline comments. These observations do not
prove that no off-platform review exists.

The historical Round 6 findings and dispositions are in
[`../01/findings.md`](../01/findings.md) and
[`docs/reviews/2026-11-18-m2b-round-4-decisions.md`](../../../../docs/reviews/2026-11-18-m2b-round-4-decisions.md).
The retained mutation artifact has 16 `KILLED` lines followed by a JSON object;
extracting the object reported `total: 16`, `killed: 16`, `survived: 0`.
**NOT VERIFIED:** mutation campaign rerun in this session.

## Reference-corpus evidence and discrepancies

Historical evidence used `oh-my-pi` commit
`04cd1a7549a02d62ad1d24826198d52507595683`, Linux WSL2 x86_64, Node
`v24.21.0` and TypeScript `5.9.3`. The retained cohort artifact reports 200
sampled targets: 17 low, 138 medium, 45 unknown. It reports 20 low-result
reference audits, 63 reference sites, 63 covered, and 0 uncovered. These
historical commands were not rerun here.

The retained `doctor-deep.json` reports zero graph and counter differences,
300 declarations, 8,103 references, 8,103 covered and 0 misses. The historical
command is recorded in `docs/research/m2b-measurements.md`:

```sh
node dist/adapters/cli/main.js doctor --deep --root /var/tmp/m2a2/omp-src --differential 300 --json
```

**FORENSIC RESOLUTION (2026-11-22, VERIFIED from `/var/tmp/ksd-m2b-r6/`):**
Both discrepancies trace to the same event — adding object-literal `get`/`set` accessor resolution in `src/core/indexing/resolve.ts` between `pre-r8-index.json` (`00:31`) and `status.json` (`02:06`, `builtAt: 2026-11-21T18:49:58.977Z`):
1. **Why `cohort-audit-edit.json` recorded `180,351.37 ms` and `updatedFiles: 0`:** Because `resolve.ts` changed the extractor stamp, that run triggered a **full cold rebuild** (`status.json`: `lastAction: "cold"`, `lastReason: "extractor stamp changed"`, phase sum `scan 2,346 + program 19,575 + extract 1,152 + resolve 151,121 + verify 2,452 = 176,646 ms` ≈ `180.35 s` wall time; cold rebuilds report `updatedFiles: 0`). The separate `26,338.98 ms` (`updatedFiles: 1`) incremental measurement in `docs/research/m2b-measurements.md` was run after the extractor stamp settled, without overwriting `cohort-audit-edit.json` (raw JSON for the 26.34 s incremental run was not retained, so that specific 26.34 s figure remains **NOT VERIFIED** from retained raw JSON).
2. **Why edges increased from `637,538` to `637,638` (+100):** `pre-r8-index.json` (`00:31`) was built before the `isGetAccessorDeclaration`/`isSetAccessorDeclaration` fix in `resolve.ts`; `status.json` (`02:06`) reflects the post-fix cold rebuild with +100 newly resolved accessor edges.

## Candidate snapshot disposition

All snapshots are **PROPOSED** pending owner review. No snapshot was edited in
this acceptance session. The ten marked below also differ on the pre-existing
`release/0.2.0-unified-skills` branch relative to `ad21058`; that branch's
protected-path gate reports them for owner review.

| Snapshot | Disposition | Different on current release branch |
| --- | --- | --- |
| `tests/snapshots/impact/C01.txt` | PROPOSED | yes |
| `tests/snapshots/impact/C06.txt` | PROPOSED | yes |
| `tests/snapshots/impact/C11.txt` | PROPOSED | yes |
| `tests/snapshots/impact/C13.txt` | PROPOSED | yes |
| `tests/snapshots/impact/C14.txt` | PROPOSED | yes |
| `tests/snapshots/impact/C15.txt` | PROPOSED | no |
| `tests/snapshots/impact/C26.txt` | PROPOSED | yes |
| `tests/snapshots/impact/batch-3.txt` | PROPOSED | yes |
| `tests/snapshots/impact/d51-parent.txt` | PROPOSED | yes |
| `tests/snapshots/impact/over-budget.txt` | PROPOSED | yes |
| `tests/snapshots/impact/stale-index.txt` | PROPOSED | yes |

## Current-branch verification gate

On `release/0.2.0-unified-skills` at `633f4785d6f22bce2bd8a3dd29b00df3f04786d5`,
with a temporary `HOME` and offline npm cache:

- **VERIFIED:** `npm run typecheck`, `npm run lint`, `npm run format:check`,
  `npm test`, `npm run check:dist`, and `npm run verify:skills` exited 0.
  `npm test`: 641 tests, 68 suites, 641 passed, 0 failed, 0 skipped.
- `npm run verify:skills` reported `omp-live-runtime` **NOT VERIFIED** because
  the isolated `HOME` did not contain the installed package. The separate real
  loader calls above used the installed package without modifying the real home.
- **VERIFIED:** `git grep -nE "/home/|/Users/|C:\\\\Users\\\\" -- src/ scripts/ skills/ || echo "CLEAN"` printed `CLEAN`.
- **NOT VERIFIED / BLOCKED:** `node scripts/check-protected-paths.mjs origin/main HEAD`
  exited 1 and listed the ten existing snapshot differences above. The script
  requests owner review and the `owner-approved` PR label. No protected file
  was modified by this acceptance session.

**STOP GATE:** The owner must disposition this record and the proposed
snapshots. Missing required evidence, including a different-vendor review,
keeps M3 blocked under ticket 02.
