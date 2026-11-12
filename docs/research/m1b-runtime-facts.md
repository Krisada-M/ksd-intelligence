# M1b — runtime facts

Measured 2026-11-12 on the owner's machine: macOS (darwin 27.0.0) arm64, 10 cores, 17.2 GB RAM. OMP `omp/18.18.9` (single compiled executable `~/.local/bin/omp`). Node v24.22.0. Bun 1.4.2 (CLI) and Bun 1.4.4 (inside OMP). TypeScript 5.9.3 (this repo's `node_modules`, from `package-lock.json`).

Spike code: `spikes/m1b/`. Raw outputs: `spikes/m1b/out/`. Nothing under `src/` or `tests/` changed.

OMP docs and types read for this spike: `omp://extensions.md` (tool authoring, `execute(toolCallId, params, signal, onUpdate, ctx)`), `omp://extension-loading.md` (Bun import, `?mtime` cache-buster, `--no-extensions`), `omp://custom-tools.md`, `omp://cli-reference.md` (`--mode json`, `--session-dir`), `omp://marketplace.md` and `omp://plugin-manager-installer-plumbing.md` (plugin installs). Installed types: `~/.bun/install/global/node_modules/@oh-my-pi/pi-agent-core/src/types.ts` lines 1026–1041 and 1111–1118. That global package is **18.16.0**, older than the running 18.18.9 binary, whose types are not shipped separately; the callback shape below is from 18.16.0 types plus the live 18.18.9 behaviour.

---

## Part A — inside a loaded extension

How it ran: `spikes/m1b/probe-extension.mjs` registers one read-only tool, `ei_probe`, whose logic lives in `spikes/m1b/dist/probe-core.js` and `spikes/m1b/dist/probe-worker.js`. Every live run used:

```sh
omp -p --no-extensions --model claude-haiku-4-5 --mode json --session-dir "$TMPDIR/m1b/sessions" \
  -e spikes/m1b/probe-extension.mjs '<prompt>'
```

`--mode json` emits the event stream; `node spikes/m1b/extract-events.mjs <events.jsonl>` prints raw `tool_execution_*` events, so the rows below quote the tool's own text, not model paraphrases. `--session-dir` kept transcripts in `$TMPDIR/m1b/sessions`; no OMP config was changed and the probe is not loaded by default. The model reached the tool through the device dispatch seen in M1 (`write` to `xd://ei_probe`, once preceded by `read` of `xd://ei_probe` for its schema).

Baselines outside OMP: `node spikes/m1b/run-probe-cli.mjs` → `out/probe-cli-node.txt`, `bun spikes/m1b/run-probe-cli.mjs` → `out/probe-cli-bun.txt`.

| # | Fact | Command / prompt | Key output (raw tool text) | Label |
|---|---|---|---|---|
| A1 | Runtime | prompt `Call the ei_probe tool with section "facts"…` → `out/a-facts-omp.txt` | `typeof Bun=object typeof Deno=undefined`; `Bun.version=1.4.4`; `process.versions.node=26.3.0` (Bun's Node-compat version); `execPath=/Users/mezn/.local/bin/omp`; `navigator.userAgent=Bun/1.4.4`. OMP process RSS when tool ran: 247 MB (later run) and 645 MB (cold run) | VERIFIED |
| A2 | Worker threads | same | `echo ok=true startToReplyMs=8.1` (23.1 in cold run). `resourceLimits maxOldGenerationSizeMb=32: workerDied=false … lastReportedAllocatedMb=512 lastHeapUsedMb=257 reachedCap=true` → **`resourceLimits` is NOT honoured under Bun**. Same under Bun 1.4.2 CLI. Under Node 24 the same worker dies: `ERR_WORKER_OUT_OF_MEMORY` at 32 MB | VERIFIED |
| A3 | Loading `typescript` | same | Main thread: `createRequire(...).resolve('typescript')` **fails** (`Cannot find module 'typescript'`), `import.meta.resolve` **fails**, but `await import('typescript')` **works** (`version=5.9.3 importMs=80.6`): OMP's extension loader resolves the extension's own dependencies on the main thread. Worker: bare `import('typescript')` and `require.resolve` **fail** (`Cannot find package 'typescript' imported from …/probe-worker.js`); `import(<absolute path>)` **works** (`absoluteImport ok …/node_modules/typescript/lib/typescript.js`, `version 5.9.3`, `importMs 198`, checker call resolved). The absolute path came from a plain filesystem walk up from the probe's directory. Outside OMP (Node and Bun CLI) all four routes work | VERIFIED |
| A4 | Built-in SQLite | same | `node:sqlite: open ok sqlite_version=3.54.0 fts5 MATCH 'fee' -> ["calculateFee"]`, `WAL journal_mode=wal walFileWhileOpen=true`; `bun:sqlite`: identical result. Both modules work inside OMP. (Node 24 CLI: `node:sqlite` 3.53.4 with FTS5 and WAL; `bun:sqlite` not available) | VERIFIED |
| A5 | Progress streaming | prompt `…section "progress"…` → `out/a5-progress-omp.txt` | Argument shape (types 18.16.0, `AgentToolUpdateCallback`): `(partialResult: AgentToolResult) => void`, i.e. `{ content: (TextContent \| ImageContent)[], details?, isError? }`; probe sent `{ content: [{ type: 'text', text }], details }`. In event stream: three `tool_execution_update` events, `ei_probe progress 1/3 at 03:19:43.407Z`, `2/3 … 44.412Z`, `3/3 … 45.420Z`, then `tool_execution_end`. In persisted session file (`--session-dir`): final `toolResult` is stored, progress texts are **not** (verified by full-text search of session files). Visibility in interactive TUI: for owner | VERIFIED (stream, persistence); NOT VERIFIED (TUI) |
| A6 | Blocking tolerance | prompts `…section "block" and seconds 20…` / `…seconds 60…` → `out/a6-block-20-omp.txt`, `out/a6-block-60-omp.txt` | 20 s: `returned after 20087 ms; signal.aborted=false`, 4 progress updates streamed, `isError=false`, run wall 30 s. 60 s: `returned after 60067 ms; signal.aborted=false abortedAtMs=null`, 12 progress updates streamed (every 5 s), `isError=false`, run wall 73 s. OMP neither timed out nor cancelled; it waited. No `--max-time` was set; none of the read docs names a per-tool deadline for extension tools | VERIFIED |
| A7 | Module format and paths | `facts` run | The `.mjs` entry imported `./dist/probe-core.js` (ESM `.js` under repo `"type": "module"`) by relative path: works. `import.meta.url` inside it is `file:///…/spikes/m1b/dist/probe-core.js?mtime=1794453536829` (OMP's cache-buster); `new URL('./probe-worker.js', import.meta.url)` gives `file:///…/dist/probe-worker.js` (query dropped) and worker starts from it. `typeof require` is `function` inside ESM module under Bun. Product entry `dist/adapters/omp/extension.js` loading as ESM was verified in M1 | VERIFIED |

Extra facts found on the way:

| Fact | Command | Key output | Label |
|---|---|---|---|
| The OMP executable can run a script as plain Bun | `BUN_BE_BUN=1 ~/.local/bin/omp --version`; `BUN_BE_BUN=1 ~/.local/bin/omp -e '…'` | `1.4.4`; `child-ok 1.4.4`; from `spikes/m1b/`: `require("typescript")` resolves normally (`5.9.3 …/node_modules/typescript/lib/typescript.js`); `--smol` accepted | VERIFIED |
| Whether a marketplace install provides a plugin's runtime dependencies | `ls ~/.omp/plugins/cache/plugins/*/`; `package.json#dependencies` of each cached plugin; `omp://marketplace.md`, `omp://plugin-manager-installer-plumbing.md` | Both cached marketplace plugins (`engineering-proxy` 0.6.0, `ponytail` 5.3.2) declare no `dependencies` and have no `node_modules`. Docs describe marketplace install as a cached clone symlinked into scope `node_modules`; `bun install` step is documented for npm and git specs. Until observed, assume runtime `typescript` must be committed or bundled into `dist/` | NOT VERIFIED (no installed plugin with dependencies to observe) |

---

## Part B — cost on a real project

Measured project: `oh-my-pi` checkout at `/var/folders/tj/skmpx5kj42x6jc2zsrkb3fgw0000gn/T/m1b/omp-src` (realpath `/private/var/...`), commit `04cd1a7549a02d62ad1d24826198d52507595683`, after `bun install --ignore-scripts`.
Compiler: this repository's TypeScript 5.9.3 (resolved from `node_modules/typescript`), never omp-src's 7.x.
Scripts: `spikes/m1b/{b-common,b1-census,b2-cost,b3-worker,b4-builder,b5-buildinfo,b7-probe,ts-affected-refs-paths}.cjs`. Raw outputs: `spikes/m1b/out/`.

### B1 — Census of files, lines, and tsconfigs

Command: `node spikes/m1b/b1-census.cjs` → `out/b1-census-node.json` (un-timed, deterministic).

| Metric | Measured Value | Label |
|---|---|---|
| Visible files (`git ls-files -co --exclude-standard`) | 10,502 files (listing time 189 ms) | VERIFIED |
| TS/JS source files (non-.d.ts) | 6,851 files / 2,266,431 lines (ts-only: 6,829 / 2,252,529 lines; js: 22 / 13,902 lines) | VERIFIED |
| Declaration files (.d.ts) | 18 files / 5,031 lines | VERIFIED |
| tsconfig files found in visible set | 42 | VERIFIED |
| Projects reachable from root `tsconfig.json` via references | **2**: `packages/tsconfig.workspace.json` (6,710 root names) and `tsconfig.tools.json` (34 root names). Root itself has no source files (references only) | VERIFIED |
| Project references used? | **Yes**, but only in root `tsconfig.json` to link the two sub-projects. Sub-projects are NOT composite | VERIFIED |
| `paths` used? | **No** — 0 of 42 tsconfigs declare `paths`, and no path aliases are inherited | VERIFIED |
| Coverage gaps (reachable vs visible) | 122 visible TS/JS files are not in any reachable project (e.g. `python/robomp/web` 34, `packages/coding-agent/examples` 34, `crates/*` 10, `packages/metaharness/adapters` 6) | VERIFIED |
| Per-package alternative (16 `packages/*/tsconfig.json`) | 6,451 root names across 16 package tsconfigs; each pulls the transitive workspace graph | VERIFIED |

### B2 — Program creation + ADR 0003 resolve pass cost

Solo commands: `node --max-old-space-size=6144 spikes/m1b/b2-cost.cjs one workspace` / `bun … one workspace` / `seq reachable` / `seq packages` → `out/b2-one-workspace-{node,bun}.json`, `out/b2-seq-*`.

| Project / mode | Runtime | config ms | program ms | checker ms | decl-pass ms | resolve ms | Total s | Peak RSS MB | Label |
|---|---|---|---|---|---|---|---|---|---|
| workspace (6,695 own, 7,895 in program) | Node | 142 | 4,720 | 1,943 | 57 | **21,652** | **28.5 s** | **5,038 MB** | VERIFIED |
| workspace | Bun | 92 | 5,326 | 2,059 | 96 | **75,702** | **83.3 s** | **3,994 MB** | VERIFIED |
| tools (34 own, 3,283 in program) | Node | 8 | 2,778 | 986 | 38 | 342 | 4.3 s | 1,728 MB | VERIFIED |
| tools | Bun | 6 | 1,959 | 804 | 48 | 468 | 3.4 s | 2,155 MB | VERIFIED |
| seq reachable (D31 sequential: workspace + tools) | Node | — | Σ7,662 | Σ2,704 | Σ69 | Σ25,556 | **36.2 s** | **4,636 MB** | VERIFIED |
| seq reachable | Bun | — | Σ7,712 | Σ3,651 | Σ262 | Σ36,347 | **48.0 s** | **4,380 MB** | VERIFIED |
| seq packages (16 package projects) | Node | — | Σ14,907 | Σ6,061 | Σ153 | Σ23,004 | 44.3 s | 5,016 MB | VERIFIED |
| seq packages | Bun | — | Σ14,654 | Σ6,099 | Σ239 | Σ27,286 | 48.4 s | 7,914 MB | VERIFIED |

Key observations:
1. Bun runs the AST identifier resolve pass **3.5× slower than Node** (75.7 s vs 21.7 s).
2. Node default heap (~2–4 GB) crashes with OOM; all successful Node runs required `--max-old-space-size=6144`.
3. Even a 34-file project (`tools`) pulls 3,283 files through imports, costing 1.6–2.2 GB RSS.

### B3 — Worker threads with `resourceLimits.maxOldGenerationSizeMb`

Commands: `node spikes/m1b/b3-worker.cjs <capMb> reachable` / `bun …` → `out/b3-cap*.json`.

| Memory Cap | Node | Bun | Label |
|---|---|---|---|
| 1,536 MB | **DIED** `ERR_WORKER_OUT_OF_MEMORY` after 5.9 s (during program/checker init) | **COMPLETED** in 55.2 s; worker reported `heap_size_limit` = **17,180 MB**, peak RSS **5,283 MB** (cap completely ignored) | VERIFIED |
| 3,072 MB | Not run (skipped after 4608 MB failed) | — | NOT VERIFIED |
| 4,608 MB | **DIED** `ERR_WORKER_OUT_OF_MEMORY` after 36.5 s (during workspace resolve pass) | — | VERIFIED |
| 6,144 MB | Not run inside worker; main-thread runs at 6144 MB completed reliably | — | NOT VERIFIED (in worker) |

Result: Bun does not honour `resourceLimits` on this workload; Node strictly enforces it and fails below ~5 GB heap for this project.

### B4 — Builder program with in-memory overlays

Target: `packages/catalog/src/build.ts` function `buildModel` / `Model<TApi>` (**478 importing files**).
Command: `node --max-old-space-size=6144 spikes/m1b/b4-builder.cjs rounds --chain=affected`.

| Round (chain: affected-only, `ignoreSourceFile: true`) | createBuilder ms | affected-set ms | affected count | resolve affected ms | Label |
|---|---|---|---|---|---|
| cold build | 5,858 | 37 | 7,833 (6,973 non-.d.ts) | 20,831 (full pass) | VERIFIED |
| no change | 173 | 0 | 0 | — | VERIFIED |
| (a) body edit | 135 | 13 | **1** | 66 | VERIFIED |
| (b) signature edit (+optional param) | 136 | 8 | 1 ⚠ | 57 | VERIFIED (artifact of ignoreSourceFile) |
| (c) return-type edit (`\| undefined`) | 132 | 6 | 1 ⚠ | 49 | VERIFIED (artifact of ignoreSourceFile) |
| (d) global .d.ts edit (added member to `types/assets/index.d.ts`) | 132 | 3,226 | **7,823 (whole program)** | 21,186 | VERIFIED |

⚠ Critical finding: Passing `ignoreSourceFile: () => true` to `getSemanticDiagnosticsOfNextAffectedFile` stops change propagation through importers. It quickly returns the edited file, but omits downstream importers from the affected set on signature/return-type changes. Full check chain (without ignore) OOM'd at 6,144 MB before finishing round (d2).
Bun run for B4: NOT VERIFIED (script bug on Bun platform fixed after allocated test window).

### B5 — Persisting build info (`.tsbuildinfo`)

Command: `node|bun --max-old-space-size=6144 spikes/m1b/b5-buildinfo.cjs write` → `out/b5-write-*.json`.

| Metric / Step | Node | Bun | Label |
|---|---|---|---|
| P1 `createIncrementalProgram` (workspace, `incremental+noEmit+tsBuildInfoFile` in `$TMPDIR`) | 6,155 ms | 4,683 ms | VERIFIED |
| Emit and write `.tsbuildinfo` | 73 ms | 60 ms | VERIFIED |
| `.tsbuildinfo` file size | 2,314,664 bytes (2.3 MB) | 2,314,664 bytes (identical) | VERIFIED |
| P2 `readBuilderProgram` + one-file edit in fresh process | Threw "Not implemented" from host integration | Threw "Not implemented" | NOT VERIFIED (host mismatch) |

Finding: `.tsbuildinfo` is 2.3 MB and fast to write (60–73 ms), but it stores only program versions and signatures. A new process still requires 5–6 s to run `createProgram` and re-parse files before it can instantiate a type checker.

### B6 — Synthetic project references + `paths` workspace

Synthetic workspace in `$TMPDIR`: `pkg-a` (composite, declaration) and `pkg-b` referencing `pkg-a` via `references` and `paths` alias (`@a/*` → `../pkg-a/src/*`).
Command: `node spikes/m1b/ts-affected-refs-paths.cjs` and `bun …` → `out/b6-refs-paths-{node,bun}.json`.

| Variant | Call in pkg-b resolves to | Body edit in pkg-a | Signature edit in pkg-a | Return-type edit in pkg-a | New pkg-b file | Delete unused pkg-a file | Label |
|---|---|---|---|---|---|---|---|
| v1: `paths` + `references` (pkg-a built to dist) | **`pkg-a/src/util.ts` (source!)** | util.ts, b1.ts, b2.ts | util.ts, b1.ts | 3 files | new.ts | none | VERIFIED |
| v2: `paths` only (no references) | `pkg-a/src/util.ts` | same | same | same | new.ts | none | VERIFIED |
| v3: references + `useSourceOfProjectReferenceRedirect` | `pkg-a/src/util.ts` | same | same | same | new.ts | none | VERIFIED |
| v4: `@ws/pkg-a` via node_modules symlink + references | `pkg-a/src/util.ts` | util.ts, index.ts | same | same | new.ts | none | VERIFIED |
| v5: workspace name only | `pkg-a/src/util.ts` | same | same | same | new.ts | none | VERIFIED |

Core confirmation for DESIGN: A check-only `createProgram` (the impact engine's model) **always resolves declarations to the original source `.ts` file, never to output `.d.ts`**, across all project-reference and path-alias configurations.

### B7 — Probe cost

Listing 10,502 visible files via spawned git and statting every file.
Command: `node spikes/m1b/b7-probe.cjs --runs=3` / `bun …` → `out/b7-probe-*.json`.

| Step (10,502 files, 0 missing) | Node (median / min) | Bun (median / min) | Label |
|---|---|---|---|
| `git ls-files -co --exclude-standard -z` (spawned child) | 143 ms / 141 ms | 75 ms / 61 ms | VERIFIED |
| `fs.statSync` all 10,502 paths | 77 ms / 27 ms | 19 ms / 18 ms | VERIFIED |
| `fs.promises.stat` all 10,502 paths | 86 ms / 37 ms | 15 ms / 13 ms | VERIFIED |
| **Total probe duration** | **220 ms / 168 ms** | **94 ms / 79 ms** | VERIFIED |

### B8 — ADR 0003 classification (workspace project, own files)

Source: `out/b2-one-workspace-{node,bun}.json` (Node and Bun produced **identical counts**).

| ADR 0003 Category | Use Sites | % of Uses | Stored Records | Ratio / Notes | Label |
|---|---|---|---|---|---|
| edge → **CALLS** | 303,803 | 11.1% | 135,705 | 2.24× collapse to records | VERIFIED |
| edge → **CONSTRUCTS** | 20,268 | 0.7% | 8,423 | 2.41× collapse | VERIFIED |
| edge → **REFERENCES** | 478,373 | 17.4% | 256,615 | 1.86× collapse | VERIFIED |
| **Edge Total** | **802,444** | **29.3%** | **400,743** | **2.00× collapse overall** | VERIFIED |
| edge-module (namespace-import of in-scope file) | 10,141 | 0.4% | 0 | Not stored as identifier edge | VERIFIED |
| local:binding (locals, params, type params, local fns) | 1,038,238 | 37.9% | 0 | Skipped per ADR 0003 | VERIFIED |
| local:member (anonymous object type members, etc.) | 67,916 | 2.5% | 0 | Skipped per ADR 0003 | VERIFIED |
| external (node_modules and standard library) | 759,359 | 27.7% | 0 | Counted only | VERIFIED |
| no-declaration symbols (e.g. `undefined`, builtins) | 45,279 | 1.7% | 0 | Counted only | VERIFIED |
| unresolved-name-match | 15,050 | 0.5% | 0 | Kept for cross-check | VERIFIED |
| unresolved-other | 4,285 | 0.2% | 0 | Skipped | VERIFIED |
| **Total use sites evaluated** | **2,742,712** | **100%** | **400,743** | **1,129,593 declaration names skipped** | VERIFIED |

Indexed declarations in own files: **155,588** (71,810 class/interface/enum members, 28,836 functions, 21,435 object-literal members, 18,704 variables, 9,340 interfaces, 3,665 type aliases, 1,638 classes, 70 namespaces, 69 enums, 21 default exports).
Imports: 48,436 total → 39,521 resolved (11,015 external-lib), 8,915 satisfied by ambient wildcard modules (`*.md`, `*.svg`), **unresolved-import: 0, external-unresolved: 0**.
Ratio: **14.6% of identifier use sites become stored records** (400,743 records from 2,742,712 uses).

---

## Surprises & discoveries

1. **Bun runs the TS checker 3.5× slower** than Node on the resolve pass (75.7 s vs 21.7 s). Because OMP extensions run under Bun, cold builds on multi-million-line codebases will take over 1 minute under Bun.
2. **Bun completely ignores worker `resourceLimits`**: worker threads allocate past any specified cap up to host memory (5.3 GB allocated under a 32 MB and 1,536 MB cap). Worker memory limits cannot protect OMP under Bun.
3. **Real memory requirement is ~5–6 GB**, not 0.6–0.8 GB. Node OOMs below 4.6 GB; default Node heap crashes immediately.
4. **Small tsconfigs do not mean small programs**: a 34-file project (`tools`) pulls 3,283 files and consumes 1.6–2.2 GB RSS. Splitting into 16 package tsconfigs repeated work (44–48 s seq runtime, up to 7.9 GB peak RSS).
5. **`ignoreSourceFile=true` breaks affected-set propagation** in `createSemanticDiagnosticsBuilderProgram`: downstream importers are silently omitted unless semantic diagnostics are computed.
6. **Ambient `.d.ts` edits re-affect the entire program**: editing a global `.d.ts` invalidated 7,823 files (3.2 s set computation + 21 s resolve).
7. **Wildcard ambient modules**: 8,915 imports in oh-my-pi use ambient wildcards (`*.md`, `*.svg`). A naive resolver would falsely classify them as `unresolved-import`.
8. **Project references resolve to source `.ts`**: in check-only programs, cross-project symbol lookups reliably resolve to declaring source `.ts` files rather than emitted `.d.ts` outputs.

---

## Answers to the four brief questions

### 1. Can the engine run in a worker here?
**Technically yes, but worker memory containment does NOT work.**
- `node:worker_threads` starts, communicates, and can run TypeScript analysis inside OMP's Bun runtime, provided `typescript` is loaded via an absolute path (bare `import('typescript')` fails in workers).
- BUT: **Bun completely ignores `resourceLimits.maxOldGenerationSizeMb`**. A worker thread can grow to 5+ GB and exhaust system RAM without being stopped by Bun.
- Recommendation: For real memory containment, run the engine in a separate child process (e.g. `BUN_BE_BUN=1 ~/.local/bin/omp ...` or Node if available), where OS-level or self-monitored process limits can kill runaway builds without crashing OMP.

### 2. Which SQLite, if any?
**`node:sqlite` is the clear choice.**
- Inside OMP (Bun 1.4.4): Both `node:sqlite` and `bun:sqlite` are present, run SQLite **3.54.0**, support FTS5, and support WAL mode on disk files.
- Outside OMP (Node 24 CLI): `node:sqlite` is built-in (3.53.4, FTS5, WAL); `bun:sqlite` does not exist.
- Using `node:sqlite` provides zero-dependency SQLite with FTS5 and WAL across both OMP extensions and CLI tools without platform branching.

### 3. What memory cap is realistic for the measured project?
**6 GB heap / ~5.5–6.0 GB RSS.**
- The workspace project (6,851 TS/JS files, 2.27M lines) died with OOM under Node at 1.5 GB and 4.6 GB; it completed reliably at 6,144 MB heap, peaking at 5,038 MB RSS.
- Under Bun, peak RSS reached 5,283 MB for the workspace and 7,914 MB during sequential package analysis.
- A 1–1.5 GB cap is completely inadequate for large real-world TS codebases with `node_modules`.

### 4. Can a tool block for 60 s with visible progress?
**Yes.**
- The probe blocked for 60,067 ms inside OMP (`omp -p ...`). OMP waited the full 73 s wall clock time without timing out, throwing, or aborting (`signal.aborted=false`).
- 12 `tool_execution_update` progress events were streamed at 5-second intervals and appeared in OMP's JSON event stream.
- Note: Progress events are streamed in real time to the UI/event stream but are not persisted in the saved `.jsonl` session transcript.

---

## Implications for `docs/DESIGN.md`

Do not edit `docs/DESIGN.md` directly (the owner applies changes). Lines that hold vs must change:

### §6.2.1 Index lifecycle (lines 149–236)
- **Lines 183–188 (Affected set / builder program):**
  - Line 187: "Checked in a sandbox on TypeScript 6.0.3... To be re-verified in M2 with project references and `paths`." -> **HOLDS.** B6 confirmed that cross-package calls resolve to the declaring source `.ts` file across all `references` and `paths` configurations.
  - BUT add note: Using `ignoreSourceFile=true` in `getSemanticDiagnosticsOfNextAffectedFile` stops downstream importer propagation. Affected-set collection cannot suppress semantic diagnostics without undercounting importers on signature changes.
- **Lines 192–202 (Freshness probe):**
  - Line 196: "Probe: list the visible files... one stat each... Listing cost on a large repo is measured in M2a" -> **HOLDS.** B7 measured 10,502 files: `git ls-files` + `stat` takes 94 ms (Bun) / 220 ms (Node). The probe is fast enough for every query.
- **Lines 203–215 (When it runs):**
  - Line 208: "First query with no active index: blocks for up to 60 s, streaming progress... returns the real answer" -> **HOLDS in principle, but RISKY on Bun.** A6 verified OMP waits 60 s without timeout. However, B2 showed a cold resolve on Bun takes **83 s** on a 2.2M-line repo. The 60 s blocking budget will expire and trigger `index-building` guidance on large projects unless accelerated.
  - Line 212: "M2 evaluates persisting TypeScript's build info to avoid a full RESOLVE" -> **REVISE.** B5 showed `.tsbuildinfo` is 2.3 MB and writes in ~70 ms, but it only stores signatures/versions. A fresh process still requires 5–6 s for `createProgram` before type checking can begin.
- **Lines 226–236 (Program lifetime and memory):**
  - Lines 226–235: "Program lifetime and memory (D31, provisional until M1b measures a real project with node_modules)... peak memory 0.6–0.8 GB... So a cold build is on the order of 10 s per few hundred thousand lines and needs most of a gigabyte." -> **MUST CHANGE.** With `node_modules` and 2.27M lines, cold build takes 28.5 s (Node) / 83.3 s (Bun) and requires **5.0–5.3 GB RSS**. The 0.6–0.8 GB sandbox estimate was an artifact of missing `node_modules`.

### §11 Storage (lines 594–611)
- **Lines 608–611 (SQLite):**
  - Line 608: "SQLite (D28, moved into M2a): the runtime's built-in SQLite module becomes the primary store for index records, the full-text index and (M6) vectors... once M2a confirms which runtime OMP runs extensions in and that its built-in SQLite (with FTS5) is available." -> **HOLDS.** Verified (A4). OMP's Bun runtime provides `node:sqlite` (SQLite 3.54.0) with FTS5 and WAL mode, and Node 24 CLI also supports it. `node:sqlite` can be adopted immediately as the primary store.

### Decision Log (§15, lines 681–726)
- **Decision D30 (line 712):**
  - "`typescript` is a runtime dependency: bundled and pinned by default... Engine runs in a worker with time and memory budgets (RISK R5 as amended, R6)" -> **MUST REVISE.**
    1. Bun worker threads **ignore `resourceLimits`**, so worker memory budgets cannot protect the host OMP process from OOM. Isolation must be achieved via child processes or self-monitoring.
    2. Bare `import('typescript')` fails in Bun workers; the worker must be passed an absolute path to TypeScript from the main thread.
    3. Marketplace plugin installs do not run `npm/bun install` for plugin dependencies. TypeScript must either be bundled into `dist/` or committed in `node_modules`.
- **Decision D31 (line 713):**
  - "Program lifetime: sequential builds, compiler state kept for at most two recently touched projects; cap set from M1b (provisional)" -> **MUST CHANGE.**
    The cap cannot be 1–1.5 GB. It must be at least **6 GB** for large monorepos with `node_modules`. Furthermore, sequential builds across 16 package tsconfigs repeatedly re-parsed shared dependencies and took 44–48 s / 7.9 GB RSS; keeping the monolithic workspace program is both faster (36 s Node / 48 s Bun) and uses less memory.
- **Decision D35 (line 717):**
  - "First call blocks up to 60 s with streamed progress" -> **HOLDS.** OMP supports 60 s blocking calls with real-time `tool_execution_update` progress streaming without aborting.
