# V1 close-out audit

Model: `openai-codex/gpt-6.2-sol`. Round 0 baseline: fetched `origin/main` at `70c1bca`; existing `v1-closeout` was an ancestor with no unique commits and was fast-forwarded before work. No change to code, brief or golden inputs in Round 0.

## Round 0 — reconcile

| Brief assumption | Baseline evidence | Close-out decision |
|---|---|---|
| V1 close-out:3 requires M4a acceptance or a skip and M3 sign-off | DESIGN:770–772 (D61–D63); `m3-exit-review.md` §§7–8 | D61 skipped all framework detectors; D63 waived the 14-day window and retained manual route globs. No optional V1 implementation. |
| V1 close-out:9–11 and :38 describe one OMP install | DESIGN:774 (D65); `package.json` `files`, `bin`; `scripts/mcp/tools.mjs` | Two installs: OMP marketplace and npm CLI/AGY stdio. Do not equate MCP protocol tests with live AGY. |
| V1 close-out:16–21 groups `ei doctor` and `ei cache clear` with open items | CLI `run()` dispatches both; `audit.test.ts` covers cache clear and `differential.test.ts` covers the oracle | Doctor exists and requires `--deep`; cache clear exists. Leave the canary, `engine-self-check-failed`, OMP-version warning, effective per-capability switches, `ei symbol` and a 5 s query budget planned. The parser accepting a flag does not mean the flag works. |
| V1 close-out:15, :25 use docs as shipped inventory | README:3, :75, :93, :154 conflict with OMP extension registrations and MAGY1 tool listings; DESIGN:140, :188, :323, :533–541; RISK:174 | Fix stale claims: five OMP tools, lexical search, child-per-update, npm setup, AGY transport, and planned capabilities. Preserve D50 and D62. |
| V1 close-out:26 implies bin help only needs a packaging check | CLI `parseArgs` has no `help`; both `src/policy/` CLI parsers reject extra or invalid args | Add CLI help and npm entrypoint help, without editing frozen policy source or changing delegation for existing invocations. |
| V1 close-out:27–28 assume existing live behaviour fixtures and a repeatable mutation entrypoint | D58 records evals as a gate; dogfood log includes rehearsals but no eval runner. M2a/M2b/M2c/M6a measurement reports reference earlier temporary mutation scripts. | Use disposable local evaluations based on the dogfood cases. Exercise existing tests against targeted mutants; do not change owner fixtures. |
| V1 close-out:39, :45–51 assume release and V2 gating are still unchanged | DESIGN:768–775 (D58 and D60–D66); V2-README; `.github/workflows/publish.yml` | Only prepare the candidate; tagging triggers OIDC npm publication. D64 waived the five V2 module entry gates, but their value checks and compression hook prerequisite stand. |
| V1 close-out:62–67 requires reference/host evidence beyond local checks | Current directive requests differential on this repository; local host is Linux WSL2 x64; no pushed candidate | Do not claim reference-repo, macOS, CI, real AGY, or owner acceptance from a local run. |

- `docs/research/m3b-findings.md` is absent from both fetched locations: `origin/main` and `origin/research/m3b-compare` (the latter ref is absent). No severity-1 findings to apply from that source.
- No extra index data required for close-out. Current schema 6 holds FTS5 lexical data (introduced in schema 5) and case-insensitive indexes. There is no automatic route or heuristic evidence, runtime value-flow graph, or semantic vectors.
- Dogfood findings retained: separate worktree caches, orphan/name guidance, lexical noise in mostly non-TS repos, `init --dry-run` config display, and extra comment-only test suggestions. D63 keeps scope and propagation unchanged. Earlier wrong `low` on `Graph.incoming` was fixed under D57, not counted as a clean historical run.
- Round order: report-only Round 0, Round 1 audit/help/evals, Round 2 documentation/version/gates. Do not enable or implement V2 features.

## Round 1 — claims, registration, and test inventory

Test references identify coverage, not a claim of exhaustive or live verification.

| Surface | Loaded/registered in the candidate | Tests or evidence |
|---|---|---|
| `ei_workflow` / `ei load` (`ei route` is routing only) | OMP and optional AGY (flag `--workflow` or `KSD_MCP_WORKFLOW=1`); CLI | `tests/workflow/{omp-extension,loader,router,skills-integration}.test.ts`; `tests/packaging/agy-mcp.test.js`; parity in `audit.test.ts` |
| `ei_status`, `ei_impact`, `ei_changes`, `ei_search` | OMP, CLI and AGY stdio; AGY host can separately filter tools | `status`, `impact-tool`, `impact-golden`, `changes`, and `search-query` core tests; `agy-mcp.test.js`; five-tool parity in `audit.test.ts` |
| `ei init`, `setup [--check]`, `index [--full]`, `doctor --deep [--differential]` | CLI only (`src/adapters/cli/main.ts`); CLI doctor doesn't install the golden canary | `tests/core/{init,typescript-runtime,indexing,differential,status,search-index}.test.ts` |
| `ei audit`, `ei cache clear` | CLI only; cache clear respects the build lock and preserves the shared pinned runtime | `tests/core/audit.test.ts` |
| `ei sources check [--write]`, `ei skills list/check/diff/sync/publish/rollback` | CLI only; upstream reads are local, owner-invoked write commands update local pin/registry state | `tests/workflow/{sources,skills-integration,unified-lifecycle}.test.ts`; `publish` here is local skill state, not npm |
| `ei --help`, `ksd-check-changed --help`, `ksd-review-verdict --help`; existing policy CLI args, slash commands and ESLint export | Npm entrypoints / unchanged KSD runtime | `tests/packaging/npm-tarball.test.js`; frozen `tests/policy/` contract |
| `ei symbol`, `ei embeddings`, `ei context/retrieve/learn/verify`; `ei_context`, `ei_verify`, `ei_learning`, `ei_gitlab`, `ei_retrieve` | **PLANNED (V2)**; no standalone entrypoints | No runtime verification |
| Config: `impact.include/exclude/routes/freshness/manyCallers/commonName/useWorkspaceTypescript/maxMemoryMb`, `riskZones`, `search.enabled` | Parsed in `src/core/kernel/config.ts`, applied in scan/probe, query, engine, zones and lexical search | `tests/core/{init,scan,probe,indexing,impact-golden,impact-risk-zones,typescript-runtime,engine-host,search-query}.test.ts` |
| Config: `impact.maxDepth` | Parsed but no runtime consumer; V1 uses each query's `depth` for display only | `impact-risk.test.ts` exercises the distinction |
| Config: `skills.enabled`, `impact.enabled`, `impact.watch`, `bridges.*`, `search.semantic`, config for five V2 modules; global EI config / three-scope precedence | Reserved schema only or unimplemented, **PLANNED (V2)**. `search.enabled` is an existing exception, not a general kill switch | `search-query.test.ts` covers ignored `semantic`; use the two env switches for shutdown |
| Factors: `public-export-surface`, `route`, `cross-package`, `many-callers`, `common-name`, `boundary:sql`, `boundary:native` | Engine verdict evidence, not separate tools | `impact-golden`, `impact-risk`, `impact-r2b`, `impact-risk-zones` core tests |
| Reasons: `dynamic-import`, `computed-member-access`, `interface-dispatch`, `parse-error`, `cjs-require`, `unresolved-import`, `unresolved-name-match`, `string-name-match`, `outside-index-scope`, `depth-limit`, `stale-index` | Emitted by index/query/changes paths. `depth-limit` covers node-budget exhaustion, never presentation depth | `impact-golden`, `impact-risk`, `impact-freshness`, `changes` core tests and accepted snapshots |
| Reasons: `unsupported-syntax`, `engine-self-check-failed` | Accepted renderer/code vocabulary only; V1 reports TypeScript parse errors, not a separate unsupported-syntax detector or a doctor canary. **PLANNED (V2)** | No runtime producer |
| Guidance `index-building`, `ambiguous-target`, `target-not-found`; failure `index-failed`, `INVALID_INPUT` | Engine / adapter outcomes; guidance is not a tool failure | `impact-tool`, `impact-render`, `search-query`, `changes`, `omp-extension` tests |
| Workflow failures `INVALID_INPUT`, `NOT_ALLOWLISTED`, `LOCK_INVALID`, `PROVIDER_ROOT_MISSING`, `PROVIDER_ROOT_NOT_FOUND`, `SKILL_NOT_FOUND`, `PATH_ESCAPE`, `INVALID_SKILL`, `HASH_MISMATCH`, `SKILLS_UNAVAILABLE`; source checks `NOT_A_GIT_CHECKOUT`, `COMMIT_MISMATCH` | Loader/router/lock validation, wrapped as tool error when required skills fail; source-only codes aren't tool names | `tests/workflow/{loader,router,sources,omp-extension}.test.ts` |
| OMP version mismatch check, canary and 5 s query budget | **PLANNED (V2)**. Existing child/RPC and query-build limits are not a 5 s wall clock | `engine-host`, `impact-freshness`, `status` tests cover shipped limits |

### Safety and dead-weight sweep

- Child processes: Node/Bun index worker (`engine/host.ts`), runtime/version/RSS probes (`engine/runtime.ts`, `engine/lock.ts`), local Git census/diff/ref reads (`workspace/scan.ts`, `changes/git.ts`, `workflow/sources.ts`, `workflow/updates.ts`), owner-run pinned package provisioning (`engine/typescript.ts`). No HTTP/network implementation was found in the shipped core except npm invoked by `ei setup`; catalog URLs and GitLab defaults are data. The AGY server uses stdio only. Frozen policy validates evidence URLs but does not fetch them.
- Owner commands also write project config (`init`), local skill pin/registry state (`sources check --write`, `skills publish/rollback`) and policy config (explicit policy mode commands). Analysis tools are advisory: no project-source edits. The cache and audit checks assert `0700`/`0600`; no rotation contents are packaged.
- Secret-pattern scan by filename returned no conventional private-key or provider-token pattern in tracked files. This is not a full secret scan. Historical measurements, spikes and synthetic test values do contain absolute home paths; the npm whitelist excludes those files. Do not call historical repo contents path-free.
- `releaseProgram` and `affected-set-supplemented` have no live references. Old README text about builder chaining was stale. Retain the two active shortcut comments (non-Git `.gitignore` grammar and Bun/macOS RSS unit) because each documents a real limit. No runtime export deletion justified.
- The discovery block in TOOLS §9 follows tool descriptions: impact before edit, changes before completion, inspect partial gaps. Workflow text and some envelopes are not shared across every host; the audit distinguishes real OMP from a mock registration harness.

## Round 2 — release gates

Linux WSL2 x86-64, Node `24.21.0`, npm `12.2.0`, OMP CLI `19.2.1`.

| Command | Observed output |
|---|---|
| `npm ci` | Added 100 packages. |
| `npm run typecheck` | Exit 0; both source and test TypeScript checks ran. |
| `npm run lint` | Exit 0. |
| `npm run format:check` | `All matched files use Prettier code style!` |
| `npm test` | 740 tests in 77 suites; 740 pass, 0 fail, 0 skipped. Includes v4/v5 → v6 clean rebuild and exact engine release stamp. |
| `npm run check:dist` | Exit 0; rebuild reports no tracked drift or untracked outputs. |
| `node --test tests/packaging/npm-tarball.test.js` | 1 pass, 0 fail; scoped npm package, three installed bin help paths, legacy policy delegation, and MCP initialization. |
| `node dist/adapters/cli/main.js doctor --deep --differential 300` | `DOCTOR ok`; 0 graph and counter differences; 300 declarations, 1839/1839 references covered, 0 misses. Ran on this repository with a temporary cache and normal Git ignore rules. |
| `node evals/run.mjs` | OMP exited 1 on the first case before tool execution: model unavailable in the isolated HOME. Exit 2 from runner; 0/10 scored, pass rate **NOT VERIFIED**, not 0%. |

The first `npm test` at version 1.0.0 reported 735 pass / 5 fail. All five differences were the `engine 0.2.0` footer in historical snapshots. The harness substitutes only this historical version token in the expected footer with the exact version from the release manifest; actual text remains unmodified and all other bytes are still compared. The golden files and accepted snapshot files were not changed.

### Mutation and upgrade rehearsals

`node /tmp/tmp.QRWOpl0sJU/mutate.mjs` (temporary runner, copied compiled test tree): 11/11 killed by named assertions. Witnesses: D49 scan exclusions, unchanged-content touch probe, cache mode, C01–C03 call edges, old schema rebuild, C23 name check, critical verdict, P05 untracked SQL, hung child, audit truncation, lexical ranking. The first witness for the probe checked a different-size edit and allowed the mutant; the existing unchanged-size touch test killed it. No production or oracle files were mutated.

A historical, unmodified engine from `git archive 'a9fa363^' dist package.json` (`ac3caaa`) wrote a real schema 4 index on a disposable `tests/fixtures/mono` copy. Candidate commands on the same root/cache:

```text
ei status → STATUS degraded (index schema 4, engine expects 6) · run: ei index
ei index → INDEX cold in 0.73 s (index schema 4)
STATUS ready
Store … · 184 KB · schema 6
ei search calculateFee --limit 1 → SEARCH "calculateFee" — 1 of 7 matches
```

Schema 5 was not a separate merged predecessor. `npm test` also verified the dedicated v5 fixture rebuilds to v6 with case-insensitive indexes and searchable rows.

### Clean-home rehearsal

`bash /tmp/tmp.QRWOpl0sJU/rehearse.sh "$PWD"` on Linux WSL2 x86-64. Clean local clone of `v1-closeout` at the initial Round 2 commit; no real `~/.omp` access. Marketplace source was the clone directory, not the unpublished GitHub branch. A live checkout fails if it contains an indexer's Unix socket; the clean clone had no socket. Cloning with `--no-hardlinks` avoided crossing the filesystem device.

```text
omp/19.2.1
✔ Added marketplace: <temp>/candidate
✔ Installed ksd-intelligence from ksd-intelligence (1.0.0)
ksd-intelligence@ksd-intelligence (1.0.0) (user)
npm pack . → krisada-m-ksd-intelligence-1.0.0.tgz
npm install --global --prefix <temp>/npm-prefix … → added 1 package
ei setup / ei setup --check → typescript 5.9.3: ready
ei init → Project initialized; existing ei.config.json skipped
ei index → INDEX cold in 5.04 s (no published index)
STATUS ready
Coverage 500 scanned · 113 indexable · 44 orphan · 343 unindexed
Store … · 3,788 KB · schema 6
```

Verified invocation through the separately installed real OMP extension loader (`18.14.0`, Bun `1.4.2`), using the **marketplace-installed** `dist/adapters/omp/extension.js`, not a mock adapter:

```text
ei_status → STATUS ready
ei_search → SEARCH "sanitize audit text" — 2 of 172 matches
ei_impact → IMPACT matchGlob — src/core/kernel/glob.ts:96
            ACTION check-gaps · level unknown · picture partial (2 gaps)
ei_changes → CHANGES vs HEAD — nothing changed in the working tree.
ei_workflow → # KSD Workflow
              Type: bug (classifiedBy: caller)
              Stage: investigate
```

**BLOCKED for live model invocation:** `omp -p --model claude-haiku-4-5 …` on CLI 19.2.1 exited `1` before calling any tool: `No API key found`. The loader result is real extension execution, not evidence of an LLM turn, a TUI policy indicator, or compatibility on macOS. See [handoff](v1-closeout-handoff.md).
