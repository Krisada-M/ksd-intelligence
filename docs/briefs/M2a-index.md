# M2a — Codebase index (agent brief)

Read `AGENTS.md` first, then `docs/DESIGN.md` §6.2, §6.2.1, §7, §9, §11, §12 and decisions D20–D23, D25, D30, D35–D36, D43–D47; `docs/adr/0002-stable-keys.md`; `docs/adr/0003-indexed-declarations.md`; `docs/research/m1b-runtime-facts.md`; `docs/research/index-techniques.md`.

M2a has **two parts. Do part 1, stop, report, and wait for review.** Part 2 starts only after the owner accepts part 1.

**Model:** implement with Claude Opus 5.5 at effort `xhigh`. State the exact model and effort setting in each report. Live OMP checks: `omp -p --no-extensions --model claude-haiku-4-5 -e dist/adapters/omp/extension.js …`.

**Branch:** `m2a-index` from `main`. Never commit to `main` (D41).

---

## Part 0 — fix before starting

1. `tests/workflow/loader.test.ts` fails on macOS: it expects the temp path (`/var/folders/…`) but the loader returns the real path (`/private/var/folders/…`). Compare against `realpathSync` of the expected path. Do not change loader behaviour (it returns real paths on purpose). `npm test` must be fully green on macOS and Linux before part 1 starts; paste the summary.
2. If `AGENTS.md` has a GitNexus block again, restore it (`git checkout -- AGENTS.md`) and report it.

## Part 1 — M2a.1: host, store, scan, probe, status

### 1.1 TypeScript provisioning (D44)

- `package.json` gets `"eiRuntime": { "typescript": "<exact version>" }`. Pin the version this repo already builds with (5.9.3 unless the owner says otherwise).
- `ei setup` installs exactly that version into `~/.cache/ksd-intelligence/runtime/typescript-<version>/` using `npm install --prefix` or `bun add` (whichever exists), verifies `lib/typescript.js` and the `lib.*.d.ts` files, and writes a small manifest with the version and a sha256 of `lib/typescript.js`. `ei setup --check` only verifies. This is the only command in the library that uses the network, and it is owner-run.
- The engine loads TypeScript **by absolute path** from that directory (or, only with `impact.useWorkspaceTypescript: true`, from the analysed repo). Missing or mismatched runtime → `ei_status` says `degraded (typescript runtime missing) · run: ei setup`; impact tools return that as guidance.

### 1.2 Engine host (D45, D35)

- `src/core/engine/host.ts` (parent side, runs inside OMP) and `src/core/engine/child.ts` (engine entry). Communication over stdio with newline-delimited JSON messages: `request {id, op, args}`, `progress {id, …}`, `result {id, …}`, `error {id, code, message}`.
- Runtime choice: `node` from `PATH` if its version is ≥ 22.5, else `process.execPath` (OMP's Bun). Report which one in `ei_status`.
- Memory: limit = `impact.maxMemoryMb` or, when null, min(8192, half of physical RAM). Node child: pass `--max-old-space-size`. Bun child: the parent samples the child's RSS once per second and kills it above the limit. Both cases end in failure code `index-failed` with reason `memory-limit`.
- Idle exit after 10 minutes without a request. A crashed or killed child is restarted lazily on the next request.
- Lock: one builder per repository via a lock file in the cache dir (holder pid + start time; stale if the pid is gone). Only the holder starts a child. Another session reads the published index and, if the probe finds drift, answers later with `stale-index` (part 2 implements the answers; part 1 implements and tests the lock).
- Add `impact.maxMemoryMb` to `src/core/kernel/config.ts` (null default) with parsing and tests.

### 1.3 Store (D46)

- `src/storage/sqlite.ts` on `node:sqlite`, one database per repository at `~/.cache/ksd-intelligence/<repo-id>/index.sqlite`, WAL mode, schema version table, migrations as numbered SQL in code.
- Tables for part 1: `meta` (schema version, extractor stamp, TypeScript version, config hash), `files` (path, size, mtime_ms, content hash, kind, package, tsconfig, status, reason). Part 2 adds declarations, edges, unresolved, name tokens.
- Publish model: build into `index.staging.sqlite`, then atomic rename over `index.sqlite`. Readers open `index.sqlite` read-only.
- Cache dir and files stay mode `0700`/`0600`.

### 1.4 Scan and probe (DESIGN §6.2.1 phase 1, D22, D25)

- Visible files: `git ls-files --cached --others --exclude-standard -z` when in a git repo, else a filesystem walk honouring `.gitignore`. Then every path is checked on disk (disk is the truth).
- Apply `impact.include`/`exclude` and the secret excludes from `docs/RISK.md` §6 (excluded files never have their content read).
- Census per file: path, size, mtime, kind (`ts`, `tsx`, `js`, `jsx`, `mjs`, `cjs`, `d.ts`, `json`, `other`), content hash (sha256), owning package (nearest `package.json`), owning tsconfig (nearest config whose `include`/`files` covers it; resolve `extends` and project references). Classification: `indexable` · `orphan` (no tsconfig) · `unindexed` (other kinds).
- Probe (D22): list visible files + `stat`; a file is drifted if new, deleted, or (size, mtime) differs; only drifted files are read and hashed. `impact.freshness: "hash"` hashes everything.
- `ei index` in part 1 runs scan and writes the census (no extraction yet) and prints the scan summary of DESIGN §6.2.1 with the fields available so far.

### 1.5 `ei_status` and CLI

- `ei_status` tool and `ei status` CLI, text per `docs/TOOLS.md` §6 limited to what exists: state, coverage counts, runtime (`node 24.x` or `bun 1.4.x`), TypeScript runtime (version, path, verified), store (path, size, schema version), memory limit, lock holder, last scan duration.
- Register `ei_status` in the single extension entry next to `ei_workflow`; `EI_DISABLED=1` removes both.

### 1.6 Fixture

Build `tests/fixtures/mono` exactly as described in `tests/golden/M2-impact-cases.md` (base fixture only; temp-copy cases come later). It must type-check with the pinned TypeScript. Do not edit the golden file.

### Part 1 acceptance

1. `npm test` green on the owner's machine; paste the summary.
2. Scan census on the fixture accounts for every file: each is `indexable`, `orphan` or `unindexed` with a reason. Test it.
3. Probe tests: edit, add, delete, rename, same-size edit with restored mtime (documents the blind spot), `freshness: "hash"`.
4. Lock tests: second holder refused; stale lock taken over; holder exit releases it.
5. Host tests: child started on the expected runtime; a child that allocates past its limit is killed and reported as `memory-limit` (use a tiny limit and a test-only allocating op); idle exit; restart after a kill.
6. `ei setup` and `ei setup --check` tested against a fake registry or a local tarball (no network in tests); `ei_status` shows `degraded` with the fix when the runtime is missing.
7. Live: `ei_status` called from OMP via `omp -p` returns the status text; paste it.
8. Measured on the oh-my-pi checkout used in M1b: scan time, probe time with no drift, file counts.
9. Report in the `AGENTS.md` template. **Stop.**

## Part 2 — M2a.2: extract, resolve, verify, publish, update

Starts only after part 1 is accepted. Runs inside the child process.

### 2.1 Program (D43, D45)

- One program for the index scope from the root configuration, following project references. Compiler options as configured **except** `verbatimModuleSyntax: false`, `isolatedModules: false`, `noEmit: true`; never pass `ignoreSourceFile`. If packages have conflicting options that make one program impossible, fall back to one program per conflicting project and record it in the scan summary.
- Incremental updates use `createSemanticDiagnosticsBuilderProgram` chained from the previous program, plus this repo's own export-surface hashes as a cross-check: if a changed file's export-surface hash changed, its direct importers are added to the affected set even if the builder omitted them, and a counter `affected-set-supplemented` is recorded in status. A non-zero counter is reported, never hidden.

### 2.2 Extract-local (phase 2) and resolve (phase 3)

- Exactly per ADR 0002 (keys) and ADR 0003 (what is indexed, how uses are classified, edge kinds, unresolved records, name tokens). Gap sites per DESIGN §7.2 reason codes, scoped per golden P4.
- Extract-local records are keyed by content hash + extractor stamp (D23: hash of the built extractor modules + TypeScript version + index-relevant config).
- Tables: `declarations`, `edges` (source key, target key, kind, strength, sites), `unresolved` (site, name, reason), `name_tokens`, `gap_sites`, plus the per-file extraction status.

### 2.3 Verify (phase 4) and publish (phase 5)

Invariants checked on the staging database before publishing: unique keys; valid spans; every edge endpoint exists or is an unresolved record; every scanned file indexed or listed with a reason; counts read back equal counts produced. Failure keeps the previous index and records `incompleteReasons`.

### 2.4 Internal query (no agent tool yet)

`graph.incoming(key, depth)` and `graph.symbol(query)` in `src/core/graph/` for tests and the next milestone. `ei_impact` itself is M2b; do not register it.

### 2.5 Correctness tests (D36)

- **Freshness equality:** golden F01–F05 at the index level (incremental index == cold build, canonicalised), run with `freshness: "hash"`.
- **Seeded randomised test:** random sequences of body edits, signature edits, export add/remove, file add/delete/rename, barrel changes and tsconfig `paths` changes on a temp copy of the fixture; after each step, incremental == cold. Seed printed on failure. Short run in `npm test`; long run behind an env var.
- **Differential test:** for sampled indexed declarations, every reference TypeScript's language service `findReferences` reports inside the index scope must be an edge (or a recorded unresolved/gap) in the index. On the fixture in `npm test`; on oh-my-pi via `ei doctor --deep --differential <n>`.
- `ei doctor --deep`: cold rebuild into a temp database and diff against the active index.

### 2.6 Measure

On the oh-my-pi checkout: cold build (Node and Bun), peak RSS, published database size, new-session load time with no drift, one-file body edit update time, one signature edit update time, `ei doctor --deep` result, differential sample size and misses. Compare with the targets in DESIGN §14.

### Part 2 acceptance

1. `npm test` green; randomised short run and differential test included; paste the summary.
2. All golden F01–F05 index-level equality checks pass.
3. Differential test: zero misses on the fixture; on oh-my-pi, every miss listed with file:line and cause, or zero.
4. `ei doctor --deep` reports no difference on the fixture and on oh-my-pi after a sequence of edits.
5. Measurements from 2.6 in `docs/research/m2a-measurements.md`.
6. Report in the `AGENTS.md` template.

## Do not

- Register `ei_impact` or `ei_changes`, or implement verdicts (M2b, M2c).
- Edit `tests/golden/**`, `src/policy/**`, or KSD behaviour.
- Use the network anywhere except `ei setup`.
- Install, uninstall or upgrade OMP plugins, or edit `~/.omp/**`.
- Commit to `main`, or push without the owner's instruction.
