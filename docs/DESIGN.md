# ksd-intelligence — Final Design

> **Status:** authoritative design, 2026-11-10; index lifecycle, tool surface and scope revised 2026-11-11 (D20–D28); senior-review decisions applied the same day (D29–D37); KSD merged into the library and packaging decided (D39–D40); M1b runtime facts applied 2026-11-12 (D43–D47). Supersedes the architecture sections of `docs/reference/knowledge-export.md` (which remains historical background).
> **Owner/user:** one person, personal non-commercial use.
> **Host:** OMP marketplace or AGY over local MCP stdio. CLI and engine: Node ≥ 22.5 (ADR 0005; Node 24 recommended). Live host verification is separate from CI.
> **Labels:** `DONE` = shipped and covered by tests · `NEXT` = current milestone · **PLANNED (V2)** = not shipped in 1.0.0 · `NEVER` = explicitly out of scope.
> **Release status:** 1.0.0 candidate; [close-out audit](research/v1-closeout-audit.md) and [owner gates](release-checklist.md). Historical decisions remain in §15.
> **Review record:** `docs/reviews/2026-11-11-senior-review.md`. Its decisions are applied here; what still needs measurement is gated by milestone M1b.

---

## 1. Purpose

Give the coding agent inside OMP two things it does not have on its own:

1. **How to work:** the right engineering skill for this task, stage and risk, from pinned and hash-checked sources, under the owner's policy.
2. **What the code really does:** evidence-backed answers about symbols, callers and change impact in a TS/JS workspace. When the evidence is incomplete, the answer says `unknown` and gives the reason. A tidy-looking guess is never returned as fact.

Later and only if measured worthwhile: focused context, recoverable compression, anchored project knowledge, and honest verification evidence.

The library **informs**. The agent decides and acts. The owner approves anything that merges, deploys or destroys.

## 2. Principles (in priority order)

1. **Correctness over savings.** A wrong "low risk" is worse than a slow answer.
2. **Evidence or `unknown`.** Every claim carries file, span, extractor and strength. Gaps are named, never hidden.
3. **Read-only by default.** No tool edits code, runs skill scripts, or calls the network. The only network actions in the whole library are owner-run CLI commands (`ei embeddings install`) and the GitLab adapter when enabled.
4. **OMP stays in charge** of models, permissions, sessions and approvals. The pinned erosiano-dev bundle is the single engineering policy implementation in the composed product (D70).
5. **Fail open for advice, fail closed for trust.** A broken index never breaks a session. A tampered skill is never delivered.
6. **Add a module only on evidence.** Each V2 module has an entry gate (§13). If it does not pass, the module is not built. Exception: the six V1.5 items the owner brought forward (D28).
7. **Small and boring.** TypeScript, no servers, no daemons. The only OMP always-on engineering hook is the composed erosiano-dev per-turn injection; intelligence capabilities add none. Runtime dependencies only when justified and approved: `typescript` (impact engine) and an optional local embedding runtime (M6) are the anticipated ones.

## 3. System context

```text
                ┌──────────────────────────── owner's machine (WSL2) ────────────────────────────┐
                │                                                                                │
  owner ──────▶ │  OMP 18.18.2  ──tools──▶  ksd-intelligence (extension, in-process)              │
                │    │  ▲                       │        │            │            │             │
                │    │  └── tool results ───────┘        │            │            │             │
                │    │                                   ▼            ▼            ▼             │
                │    ├── Ponytail, Caveman        ~/ei-skill-sources  workspace    cache dir      │
                │    │   (separate plugin;        (pinned checkouts)  (git repo    (~/.cache/     │
                │    │    read-only bridge)                            being worked ksd-intelli-  │
                │    └── GitNexus (if present;                         on)          gence/)       │
                │        benchmark baseline only)                                                 │
                └────────────────────────────────────────────────────────────────────────────────┘
                                       PLANNED adapters, read-only: GitLab API, uiMatch, test/lint runners
```

| Neighbour | Relationship | Rule |
|---|---|---|
| OMP | Host. Loads the extension, owns approvals | Use only verified extension APIs (§10.1). Never patch OMP or `~/.omp/**` |
| erosiano-dev | Pinned upstream engineering runtime (D70), composed once by KSD | No second installed policy owner; retain v0.6 historical tests (§6.7, §10.2) |
| Ponytail, Caveman | Other installed OMP plugins | Coexist; never mutate their state. Caveman may compress tool output (§10.1) |
| Skill sources (Matt, poteto/pstack, Osmani) | Instruction text | Loaded from pinned checkouts with sha256 lock. Never bundled, never executed |
| GitNexus | Possibly installed (`.gitnexus/` seen) | Not a dependency. Used only as a comparison baseline in M3 |
| GitLab | Where real projects live | PLANNED read-only adapter, after M3 |
| uiMatch (`Krisada-M/visual-qa`) | Owner's visual QA tool | PLANNED optional verification adapter |

## 4. Scope

| Tier | Contents |
|---|---|
| **V1** | KSD policy · skill workflow · TS/JS index, status, and impact · risk zones and changed-code review · audit · lexical search · OMP marketplace · AGY stdio/npm · CLI and platform CI |
| **PLANNED (V2)** | Context packs, GitLab, verification, anchored knowledge, recoverable compression (§13); not enabled by the existing config placeholders |
| **PLANNED (V2), conditional** | Automatic route detection (skipped in V1, D61), heuristic bridges, watcher/worktree seeding and local semantic search; dogfood evidence and separate owner approval still required |
| **NEVER** | New agent runtime or model router · always-on proxy · graph DB server · external vector DB or embedding service · auto-merge/deploy · auto-promoting model guesses to knowledge · replacing KSD · running skill scripts |

## 5. Architecture

### 5.1 Layers and dependency rule

```text
  adapters/        omp · cli · (gitlab · uimatch · runners)        ← entry points, no business logic
      │
  capabilities/    workflow · impact · bridges · search · watch · policy · (context · compression · knowledge · verification)
      │
  core/            kernel (contracts, errors, config) · evidence · workspace · indexing · graph
      │
  storage/         one interface: built-in node:sqlite (D46) · CAS (V2)
```

- Dependencies point **down only**. Capabilities never import each other; shared needs go through `core/`.
- Each capability can be disabled by config without breaking the others.
- Adapters translate I/O (OMP tool schema, CLI args, HTTP). They do not make decisions.

### 5.2 Repository layout (final)

```text
ksd-intelligence/
├── AGENTS.md · PROVENANCE.md · README.md · skills.lock.json · ei.config.example.json
├── docs/  DESIGN.md · adr/ · briefs/ · reference/ · dogfood-log.md
├── src/
│   ├── core/
│   │   ├── kernel/        types.ts · errors.ts · config.ts · result.ts
│   │   ├── evidence/      evidence.ts · completeness.ts · risk.ts
│   │   ├── workspace/     discover.ts · fingerprint.ts · gitstate.ts
│   │   ├── indexing/      scan.ts · fingerprint.ts · extract-local.ts · resolve.ts · affected.ts · stamp.ts · verify.ts · publish.ts · lock.ts
│   │   └── graph/         edges.ts · traverse.ts · resolve-target.ts
│   ├── workflow/          catalog · classify · router · sources · loader · render     (DONE, M0)
│   ├── impact/            impact.ts · symbol.ts                                        (M2)
│   ├── bridges/           routes-next.ts · routes-hono.ts · http-path.ts · navigation.ts · events.ts · dynamic-import.ts   (M4)
│   ├── search/            lexical.ts · segments.ts · embeddings.ts · rank.ts           (M6)
│   ├── watch/             watcher.ts · worktree-seed.ts                                (M5)
│   ├── context/           rank.ts · pack.ts                                            (V2)
│   ├── compression/       classify.ts · codecs/ · ccr.ts                               (V2)
│   ├── knowledge/         learnings.ts · anchors.ts · staleness.ts                     (V2)
│   ├── verification/      report.ts · runners/                                         (V2)
│   ├── policy/            KSD Engineering Proxy, moved with history: runtime · policy · sdlc · config · commands ·
│   │                      status · change-scope · check-changed · review-verdict · eslint-rules     (M1c)
│   ├── storage/           store.ts · sqlite.ts · cas.ts                                (store M2a; CAS V2)
│   ├── adapters/
│   │   ├── omp/extension.ts
│   │   ├── cli/main.ts
│   │   ├── gitlab/        client.ts · mr.ts · pipeline.ts                              (V2)
│   │   └── uimatch/       run.ts                                                       (V2)
│   └── index.ts           public API (§7.10)
└── tests/  workflow/ · golden/ · fixtures/mono/ · freshness/ · integration/
```

M0 placed workflow at `src/workflow/`; it stays there. `core/` is created in M2.

## 6. Capabilities

### 6.1 Workflow router — `DONE` (M0/M1; unified catalog #33)

Selects one primary leaf skill per (task type × stage), plus at most one reviewer/verifier at `review`/`verify` when `risk: high`.

- **Types:** `bug · feature · refactor · security · performance · ui`. Caller-supplied `type` wins (`classifiedBy: caller`); otherwise English keyword stems (`keyword`); otherwise `feature` (`default`, visibly a guess).
- **Stages:** `plan · investigate · implement · verify · review · ship`.
- **Catalog:** 15 allowlisted skills (4 Matt, 3 pstack, 8 Osmani). Only one automatic router exists: upstream `ask-matt`, `poteto-mode` and `using-agent-skills` are never auto-enabled, and `pstack:tdd` is never selected alongside `matt:tdd`.
- **Trust chain:** catalog allowlist → provider root from env → realpath inside root → regular file ≤ 64 KiB with frontmatter → sha256 equals `skills.lock.json` → delivered. Any failure gives a named error and no skill text.
- **Output:** precedence header first (KSD + owner decisions outrank skill text; never merge/deploy), then type, `classifiedBy`, provenance, hash status, skill text. `mayMerge: false` and `mayDeploy: false` always.

### 6.2 Impact engine — `DONE` (M2a/M2b/M2c)

Answers "what is affected if this symbol changes?" for TS/JS workspaces.

- **Semantic authority:** the TypeScript compiler API (program + type checker; no chained builder). `ei setup` provisions the library's pinned TypeScript; a repository can opt into its own copy with `impact.useWorkspaceTypescript: true`. It handles paths, barrels, re-exports, aliases, overloads, type-only imports and `allowJs`. Tree-sitter is not used.
- **Index lifecycle (D20):** an explicit initial **scan → extract → verify → publish** builds a whole-scope index before any impact answer is given; queries then read the index. Details in §6.2.1.
- **Freshness:** every query checks the working tree (tracked, modified, untracked within scope) with the two-level scheme in §6.2.1 and updates the index for changed files before answering. The session watcher (M5) is an optimisation, never the authority.
- **Traversal:** resolve target (or return guidance `ambiguous-target` / `target-not-found`) → BFS over incoming edges to closure (node budget 50,000; D55) → attach tests → assess completeness → compute reach and factors → derive the verdict.
- **Verdict (D32):** the engine reports three separate things: **completeness** (how much of the picture is known), **reach** (how far a change travels: callers, files, packages, routes) and **factors** (why it matters). One verdict is derived from them: picture incomplete → level `unknown`; any factor → `medium`; otherwise `low`. Risk zones (M2c) can only raise it to `high` or `critical`. There is no separate engine "risk" word that could be read as a safety claim.
- **Identity (D34):** what is indexed and how symbols are keyed is fixed in `docs/adr/0002-stable-keys.md` and `docs/adr/0003-indexed-declarations.md`.
- **Scoped gaps:** each completeness gap affects only targets it can reach (parse errors affect everything in scope).
- **Contract and oracle:** `tests/golden/M2-impact-cases.md` (20 cases + 5 freshness, owner-confirmed; additions proposed in `docs/RISK.md` appendix and for bridges).
- **Tools:** `ei_status` (M2a), `ei_impact` (M2b), `ei_changes` (M2c). Contract in `docs/TOOLS.md`.

#### 6.2.1 Index lifecycle

**Why a full index, not lazy per-target queries:** completeness rules need a census of the whole scope. A parse error, a computed dynamic import or an orphan file can only be reported if every file was looked at. A full index also makes queries graph lookups, and is the base for `ei_changes`, the name cross-check and (V2) context ranking.

**Shape of the pipeline (D21, D50):** cache per-file records by content and extractor stamp; re-resolve the conservative affected set below. Verify the staging database before publishing; tests and `ei doctor --deep` compare incremental and cold graphs.

```text
1 SCAN           disk is the truth. Git only supplies the visible set (tracked + untracked − ignored);
                 every path is then checked on disk. Minus excludes and secret patterns.
                 → census per file: path, size, mtime, kind, content hash, owning package, owning tsconfig
                 → classify: indexable (TS/JS under a tsconfig) · orphan (no tsconfig) · unindexed (other kinds)
2 EXTRACT-LOCAL  pure, per file, from its AST only. Cached by content hash + extractor stamp.
                 declarations   stable key, kind, span, exported?, signature hash
                 use sites      identifier positions to be resolved, import/export statements
                 gap sites      computed dynamic import, computed member call, require
                 markers        boundary imports (sql, native), route file, test file
                 name tokens    identifier and string-literal names (for the name cross-check)
                 failures       parse errors, oversize, unreadable: recorded with a reason, never dropped
3 RESOLVE        needs the type checker. For each file in the affected set, resolve its use sites to
                 declarations → outgoing edges (CALLS, REFERENCES, IMPORTS, …) with strength.
                 A use that cannot be resolved is kept as an unresolved record (site, name, reason),
                 not discarded.
4 VERIFY         structural invariants on the staged index:
                 unique stable keys · valid spans · every edge endpoint exists (or is a recorded unresolved)
                 every scanned file is indexed or listed with a reason
                 edge and declaration counts read back equal the counts produced
5 PUBLISH        atomic swap of staged → active (staging dir, then rename).
                 A failed VERIFY keeps the previous active index and sets `incompleteReasons`.
```

Each phase is timed; `ei_status` shows the last run's per-phase durations.

Incoming edges (who calls X) are the inverse of the resolved outgoing edges, so an impact query is a graph traversal, not a fresh compiler search.

**Affected set (what RESOLVE re-does)**

- Cold build: every indexable file.
- Update (**D50**): no TypeScript builder and no state between runs; the engine child exits after every build and update, so each update creates its programs from the census and the published index. Re-resolved: the changed files; files that use a name whose declaration appeared or disappeared (for a name new to the index, every file whose text contains it); for added or deleted files, files with unresolved imports or imports into that directory; files with edges into removed files; then, round by round, the files with edges into any file whose surface changed. A file's surface counts as changed when its syntactic surface hash differs, or when one of its observable declarations, with a written or an inferred type, has an edge into a file whose surface changed: an overload, a conditional type or an inferred type over an imported type can resolve to something else with no edit to the file (tests a–c in `tests/core/update-soundness.test.ts`).
- Before D50 the update chained TypeScript's builder program (`createSemanticDiagnosticsBuilderProgram`) from the previous one. Checked in a sandbox on TypeScript 6.0.3: a return-type change re-affected direct and transitive importers; a parameter change with unchanged downstream shape stopped at direct importers; a new file affected only itself; the first change after a cold build was treated conservatively (importers included).
- **M1b correction (D43):** the builder only propagated through importers when the program did **not** set `verbatimModuleSyntax` or `isolatedModules`. With either on (oh-my-pi sets `verbatimModuleSyntax`), a signature or return-type change re-checked 1 file although it had 478 importers. The analysis program still forces both options **off** (they control emit and per-file checks, not symbol resolution) and never uses `ignoreSourceFile`; the seeded randomised incremental-equals-full test and `ei doctor --deep` catch any remaining miss.
- Config-level changes are not incremental: `tsconfig*`, `package.json`, lockfile, `ei.config.json`, TypeScript version or extractor stamp changed → full rebuild.

**Extractor stamp:** a hash of the indexing module's own built files + TypeScript version + the index-relevant config. It is part of every cache key, so changing the extractor invalidates old records without anyone remembering to bump a version.

**Freshness, two levels**

| Level | Used by | How |
|---|---|---|
| Probe | every `ei_impact` query | list the visible files (so new and deleted files are seen), one `stat` each; only files whose (size, mtime) differ from the fingerprint, or are new, are read and hashed. No change → answer immediately. Listing cost on a large repo is measured in M2a |
| Full hash | `ei index`, `ei_changes`, `ei doctor`, any rebuild | every file is read and hashed. A rebuild never trusts mtime |

The probe has a known blind spot (a same-size edit within the filesystem's mtime granularity). It is accepted for ordinary queries, never for the review gate (`ei_changes`) or a rebuild. `impact.freshness: "hash"` in config forces full hashing on every query; the freshness test cases run in that mode, and one test documents the blind spot on purpose.

The fingerprint (path → size, mtime, hash) is the `files` table of the repository database, with the extractor stamp and scope config hash in `meta` (M2a.1). The probe reads only those two tables and never loads declarations or edges. A missing or unreadable database degrades safely to a cold build.

**When it runs**

| Trigger | What happens |
|---|---|
| `ei index` (CLI, owner) | Full scan and build. Reports progress and a scan summary |
| First query with no active index | A child process builds the index; interactive tools can stream progress and report `index-building` after the build wait (D35) |
| Query, index present, probe clean | Answer from the active index |
| Query, index present, drift found | Update: re-extract changed files, re-resolve the affected set, verify, publish, then answer |
| New session, fingerprint unchanged | Load the published index from disk; no rebuild |
| New session, files changed since last publish | Load the published index; create the compiler program (3–12 s measured on oh-my-pi), then re-extract and re-resolve only the changed and affected files. TypeScript build-info persistence is **not** used (D47): writing it needs a full check (223 s on oh-my-pi) and it saves only the diagnostics pass, not program creation |
| `ei index --full` | Full rebuild on demand, ignoring caches |
| Git worktree with no index | Builds a separate index. Seeding from the main checkout is **PLANNED (V2)**, conditional on evidence (M5) |

**Concurrency and failure**

- One builder at a time per repo, guarded by a lock file in the cache dir. **Only the lock holder builds or updates.** Another session or sub-agent that sees drift does not start its own compiler: it waits within its budget for the holder to publish, otherwise answers from the published index marked `stale-index` with the drift list (D35).
- A failed update never breaks a query: the previous published index answers, with status `partial`, reason `stale-index`, and the list of drifted files. It is never presented as current.
- `ei doctor --deep` rebuilds from scratch and compares against the published index. The optional `--differential` also checks TypeScript references. A mismatch fails the command; it does not persist a degradation flag.

**Scan summary** (shown by `ei index` and `ei_status`): files scanned / indexed / orphan / unindexed, packages and tsconfigs found, extraction failures by reason, unresolved-use counts by reason, gap-site counts by code, `incompleteReasons`, per-phase durations, fingerprint, TypeScript version and extractor stamp, time of last full build. This is the owner's first look at how much of a repo the engine can actually see.

**Monorepo:** one TypeScript project per `tsconfig`, linked through `paths` and project references; edges across packages are resolved to the declaring file. Packages outside `impact.include` produce `outside-index-scope`.

**Engine host, lifetime and memory (D45, measured in M1b on oh-my-pi: 6,851 files, 2.27M lines with dependency types loaded):**

- The engine runs in a **child process**, not a worker thread. OMP runs on Bun, and Bun ignores worker `resourceLimits` (a worker allocated 512 MB under a 32 MB cap), so only a separate process can be contained and killed.
- The child runs on `node` (≥ 22.5) from `PATH` when available, else on OMP's own Bun runtime. Measured cold build: **28.5 s on Node, 83 s on Bun**, at 5–5.3 GB RSS.
- Memory: under Node the child gets `--max-old-space-size` from `impact.maxMemoryMb` (default: the smaller of 8,192 MB and half of physical RAM); under Bun, which has no such flag, the parent polls the child's RSS every second and kills it above the same limit. M1b's smallest passing heap for oh-my-pi was 6 GB (1.5, 3 and 4.6 GB failed).
- One program for the whole index scope, built from the root configuration with project references followed. Per-package sequential builds were measured **worse** (44–48 s, up to 7.9 GB), so they are only a fallback for packages whose compiler options conflict.
- The build/update child exits after each build or update (D50); the lock holder owns the build. The transport idle timeout is not a guarantee of a warm compiler.
- TypeScript is loaded by absolute path (a bare `import('typescript')` failed inside the worker in M1b).

**Measured cost.** First rows: sandbox, 2 cores, TypeScript 6.0.3, no `node_modules` (external types unresolved). Last row: M1b, macOS arm64, 10 cores, 17 GB RAM, TypeScript 5.9.3, dependencies installed.

| Codebase | Files | Lines | Create program | Resolve every identifier | Peak memory |
|---|---|---|---|---|---|
| CodeGraph `src/` | 327 | 201k | 1.9 s | 7.0 s | 0.6 GB |
| GitNexus `gitnexus/src/` | 1,130 | 388k | 2.8 s | 8.9 s | 0.8 GB |
| oh-my-pi (workspace) | 6,851 | 2.27M | full cold build 28.5 s on Node / 83 s on Bun | | 5.0–5.5 GB RSS; needs ≥ 6 GB heap |

So a large real workspace costs tens of seconds and several gigabytes on a cold build. This is why the engine is a separate, killable process, why it publishes an index that later sessions load without a compiler, and why warm updates re-resolve only affected files. The probe stays cheap: listing and stat-ing 10,502 files took 94 ms on Bun and 220 ms on Node.

### 6.3 Context packs — PLANNED (V2)

Selection-first: given a task, return the smallest set of files/spans the agent should read, ranked by exact symbol match, impact proximity, test adjacency, recent edits and lexical relevance, within a token budget. Returns spans plus why each was chosen. **Suggest only.** No automatic injection until an A/B in the dogfood log shows benefit.

### 6.4 Recoverable compression — PLANNED (V2, last)

Only for tool outputs (logs, test output, large JSON) and only if OMP's own compaction proves insufficient. Persist the exact original to CAS **before** emitting the compressed view and a retrieval handle; on any failure, pass the original through. 100% byte-exact recovery is a hard gate. Never compress source code under edit, errors the agent must act on, or secrets.

### 6.5 Anchored knowledge — PLANNED (V2)

Learnings are reviewable claims anchored to a symbol or file, stored in the repo at `.ksd/learnings/*.yaml` so they are versioned with the code. Source kinds are kept distinct: `owner-confirmed · code-observed · test-verified · model-inferred`. A changed or missing anchor moves a learning to `needs-review`; stale learnings are never surfaced as fact. Writes always need owner approval; nothing is auto-saved.

### 6.6 Verification evidence — PLANNED (V2)

Runs or reads existing tools (repo test/lint scripts, `tsc`, GitLab pipeline results, uiMatch) and returns what actually happened: command, revision, exit code, artifacts, timestamp, and `PASS · FAIL · SKIPPED · ERROR · NOT_VERIFIED`. Never infers PASS. Running commands goes through OMP's approval.

### 6.7 Historical KSD v0.6 policy contract — `DONE` (M1c, D39; superseded for activation by D70)

The frozen v0.6 files and test snapshots below remain historical evidence only. New product runtime and commands use the pinned erosiano-dev library in `src/engineering`/`dist/engineering`. They do not modify the historical contract.

KSD Engineering Proxy v0.6.0 moves into this library as `src/policy/`, so one install provides the skill router, the code intelligence tools and the personal engineering policy. The move is a migration, not a rewrite: what the owner sees and types does not change.

**Frozen contract (must be byte- or behaviour-identical to KSD 0.6.0 at commit `73fc916`):**

| Surface | Detail |
|---|---|
| Commands | `/engineering-proxy` with `status`, `adaptive`, `balanced`, `reset`, `global …`, `repo …`; `/engineering-review [scope]`; their output text |
| Config | Global `~/.omp/agent/engineering-proxy.json`; project `.engineering-proxy.json` at the nearest `.git`/`.omp` root; keys `enabled`, `enforcement: balanced \| adaptive`; precedence session > project > global > built-in balanced; `enabled` merges separately; invalid config fails open (injection off, error shown only in status) |
| Session state | The custom session entries KSD writes, so existing sessions restore their override after the cut-over |
| Status segment | `○ 🛡 KSD: BALANCED` / `● 🛡 KSD: ADAPTIVE` and its show/clear rules |
| Policy text | The per-turn style profile and the `/engineering-review` SDLC text, byte-identical per mode |
| Kill switch | `ENGINEERING_PROXY_DISABLED=1` (independent of `EI_DISABLED`: each disables only its own part) |
| Opt-in tools | `ksd-check-changed`, `ksd-review-verdict` CLIs and the ESLint rules export, same behaviour |

**Proof:** KSD's 148 tests come over unchanged except for import paths and run in this repo's `npm test`; snapshots of policy text and status strings taken from 0.6.0 must match byte for byte.

**Interaction with the rest of the library:** the module reads its own config only. Workflow and impact may later read the effective KSD mode through the module's exported function (a direct import, not a bridge), only when the dogfood log shows a case for it. KSD config stays in its own files and is not folded into `ei.config.json`, so existing files keep working.

### 6.8 GitLab adapter — DROPPED (D67)

The owner removed this module on 2026-11-26. The text below is kept for history.

Read-only access to issues (requirements for `plan`), merge request diffs (scope for `review`/`impact`), and pipeline/job results (evidence for `verify`). Host and project from `ei.config.json`; token from env `GITLAB_TOKEN` only, never stored or logged. This is the only library code allowed network access, and only when enabled.

### 6.9 Framework routes and heuristic bridges — PLANNED (V2, conditional; D61/D63)

V1 only applies manual `impact.routes` globs. The detectors below were skipped, and heuristic bridges did not meet their dogfood gates.

Static analysis stops at dynamic dispatch: a route file the framework calls, a `fetch('/api/charge')` that reaches a handler, an event name that links emitter to listener. Without bridges these become gap sites and many answers are `unknown`. Bridges add the likely edges, clearly marked.

**What TypeScript already resolves (no bridge needed, compiler strength):** JSX element use (`<Button />`), callbacks passed as props, typed store actions and context values, typed RPC clients. These are ordinary `REFERENCES`/`CALLS` edges.

**Bridge set for the owner's stack**

| ID | Bridge | Produces | Source of truth |
|---|---|---|---|
| B1 | Next.js routes (app and pages router), Expo Router | route nodes from file conventions (`page`, `layout`, `route`, `+api`, dynamic segments); risk factor `route` without config | file paths + exported handler names |
| B2 | Hono routes | route nodes from literal `app.get/post/...('/path', handler)` and `app.route('/prefix', sub)` composition; handler edge is compiler-resolved | AST literal paths |
| B3 | HTTP path → handler | `REQUESTS` edge from a literal `fetch`/`axios`/client call path to the matching B1/B2 route. A match is scoped to the caller's own app or package unless a literal base URL says otherwise; several matches are all listed as candidates | literal string match on normalised path + method |
| B4 | Navigation | `NAVIGATES` edge from `<Link href>` / `router.push('/x')` literals to the route | literal paths |
| B5 | Event channels | `EMITS_TO` edge between `emit('name')` and `on('name', handler)` on the same emitter type, literal names only | literal names + receiver type from the checker |
| B6 | Templated dynamic import | candidate edges from ``import(`./dir/${x}`)`` to every module under the static prefix | file listing |

**Rules that keep bridges honest**

1. Every bridged edge has `strength: 'heuristic'`, `synthesizedBy: '<bridge id>'` and `registeredAt` (the wiring site).
2. **A bridge never upgrades completeness and never counts toward reach.** The gap site stays in `completeness.reasons`, annotated `bridged: n candidates`. Bridged edges are returned in a separate `bridged` list, never mixed into `byDepth`, so compiler-grade evidence stays distinguishable. (The confirmed golden expectations for `byDepth` are unaffected.)
3. Bridges may **add** risk factors (`route`) and tests; they never remove a gap or lower a level.
4. **Whole flow or nothing.** A bridge ships only when the flow it serves connects end to end on a fixture (client call → route → handler → what the handler calls). A reference project measured that half-bridged flows made agents read more, not less.
5. Literal-only. A computed path or event name is not guessed; it remains a gap.
6. Each bridge can be disabled in config (`bridges: { B3: false }`), and config `routes` globs still work as an explicit override.

Tool text shows them as a separate section, `Possible (heuristic)`, after compiler-grade callers (see `docs/TOOLS.md`).

### 6.10 Session file watcher — PLANNED (V2, conditional)

An optimisation, never the authority. Inside the OMP session (no daemon), a recursive watcher on the index scope records changed paths and, after a debounce, starts the update in the worker so the next query is already fresh.

- The stat probe still runs when the watcher reports overflow or an error, at session start, and at least every 60 s of activity; `ei_changes` and rebuilds still full-hash. A watcher miss can cost time, never correctness.
- Auto-disables, with a line in `ei_status`, when the platform cannot watch reliably (for example a Windows-mounted path under WSL2, or the inotify limit is hit). Queries then use the probe as before.
- `impact.watch: false` turns it off. No watcher exists outside a running session.

### 6.11 Code search — lexical `DONE` (M6a); semantic PLANNED (V2, conditional)

Answers "where is the code that does X?" with ranked symbols and `path:line`, for the moment the agent would otherwise grep around.

- **Lexical tier:** SQLite FTS5 over names, identifier segments, signatures and JSDoc. Ranking uses BM25, exact matches, export status and distinct caller counts.
- **PLANNED (V2):** graph-proximity boosting, local embeddings, `ei embeddings install/status/remove`, and the `semantic` hit label. V1 has no embedding dependency or download.
- Tool: `ei_search` (fifth tool, `docs/TOOLS.md`). V2 context packs are built on this ranking.

## 7. Contracts

Shared types live in `src/core/kernel/types.ts`. These are the final shapes; fields may be added, never repurposed.

### 7.1 Evidence

```ts
type Strength = 'compiler' | 'syntax-exact' | 'scope-resolved' | 'heuristic' | 'unknown';

interface Span { file: string; startLine: number; endLine: number }

interface EngineStamp { version: string; typescript: string; extractor: string }   // on every result
```

Every edge carries its own `strength` and `span`; every result carries the `EngineStamp` and the working-tree fingerprint it was computed from.

### 7.2 Completeness, reach, factors, verdict

```ts
type CompletenessStatus = 'complete' | 'partial' | 'unknown';
interface Completeness { status: CompletenessStatus; reasons: string[] }   // "code: detail"

interface Reach {                    // over compiler-grade edges, full traversal
  direct: number;                    // depth-1 callers
  total: number;                     // unique impacted symbols, all depths
  files: number; packages: number;
  crossPackage: boolean;             // an impacted symbol lives in another package than the target
  routes: number;
}

type Level  = 'low' | 'medium' | 'high' | 'critical' | 'unknown';
type Action = 'proceed' | 'run-tests' | 'check-gaps' | 'ask-owner';

interface Verdict {
  level: Level; action: Action;
  zones: string[];                   // risk zones that applied (M2c)
  requiredActions: string[];
  basis: string[];                   // which completeness reasons, factors and zones produced it
}
```

**Deriving the verdict**

1. Completeness `partial` or `unknown` → level `unknown`, action `check-gaps`.
2. Complete with at least one factor → `medium`, `run-tests`.
3. Complete with no factor → `low`, `proceed`.
4. Risk zones (M2c, `docs/RISK.md`) raise the level to `high` or `critical` and strengthen the action; nothing lowers it.

Factor codes: `public-export-surface · route · cross-package · many-callers` (total ≥ `impact.manyCallers`, default 10) `· common-name` (name shared by more than `impact.commonName` declarations, default 10, with name-match sites; D56) `· boundary:sql · boundary:native`.
Reason codes: `dynamic-import · computed-member-access · interface-dispatch · parse-error · cjs-require · unresolved-import · unresolved-name-match · string-name-match · outside-index-scope · depth-limit · stale-index`. `depth-limit` denotes the traversal node budget. A separate `unsupported-syntax` detector and `engine-self-check-failed` are **PLANNED (V2)**; V1 uses `parse-error` for TypeScript parse failures.
Error codes (workflow): `INVALID_INPUT · NOT_ALLOWLISTED · LOCK_INVALID · PROVIDER_ROOT_MISSING · PROVIDER_ROOT_NOT_FOUND · SKILL_NOT_FOUND · PATH_ESCAPE · INVALID_SKILL · HASH_MISMATCH · SKILLS_UNAVAILABLE`; `sources check` only: `NOT_A_GIT_CHECKOUT · COMMIT_MISMATCH`.
Guidance codes (impact): `index-building · ambiguous-target · target-not-found`. Failure codes (impact): `index-failed`.

New codes need an ADR.

### 7.3 Workflow

```ts
type TaskType = 'bug' | 'feature' | 'refactor' | 'security' | 'performance' | 'ui';
type Stage = 'plan' | 'investigate' | 'implement' | 'verify' | 'review' | 'ship';

interface RouteResult {
  task: string; type: TaskType; classifiedBy: 'caller' | 'keyword' | 'default';
  stage: Stage; risk: 'normal' | 'high';
  skillIds: string[]; mayMerge: false; mayDeploy: false;
}
```

### 7.4 Impact

```ts
type EdgeKind = 'CALLS' | 'REFERENCES' | 'IMPORTS' | 'CONSTRUCTS' | 'IMPLEMENTS' | 'TESTS'
              | 'REQUESTS' | 'NAVIGATES' | 'EMITS_TO';            // bridge kinds (M4), heuristic only

interface ImpactNode { symbol: string; via: EdgeKind; strength: Strength; span: Span;
                       synthesizedBy?: string; registeredAt?: Span }   // set on bridged edges

interface ImpactResult {
  target: string;                    // "<repo-relative path>#<qualified name>"
  byDepth: ImpactNode[][];           // display limited by depth; analysis always full
  bridged: ImpactNode[];             // heuristic bridge edges (M4); never mixed into byDepth
  tests: string[];
  completeness: Completeness;
  reach: Reach;
  factors: string[];
  verdict: Verdict;
  freshness: { workingTreeHash: string; includesUntracked: boolean };
  engine: EngineStamp;
}
```

### 7.5 Context pack (V2)

```ts
interface ContextPack {
  task: string; budgetTokens: number; usedTokens: number;
  items: { span: Span; why: string[]; score: number }[];
  omitted: { span: Span; why: string }[];      // what was left out and why
  completeness: Completeness;
}
```

### 7.6 Compression (V2)

```ts
interface CompressionResult {
  visible: string; reversible: boolean; handle?: string;   // sha256 of original
  originalBytes: number; visibleBytes: number; strategy: string;
}
```

### 7.7 Learning (V2)

```ts
interface Learning {
  id: string; claim: string;
  anchor: { kind: 'symbol' | 'file'; key: string; signatureHash?: string; contentHash?: string };   // V2d writes contentHash
  source: 'owner-confirmed' | 'code-observed' | 'test-verified' | 'model-inferred';
  status: 'active' | 'needs-review' | 'superseded';
  createdAt: string; reviewedAt?: string; supersedes?: string;
}
```

### 7.8 Verification report (V2)

```ts
interface VerificationReport {
  check: string; command?: string; revision: string; startedAt: string;
  status: 'PASS' | 'FAIL' | 'SKIPPED' | 'ERROR' | 'NOT_VERIFIED';
  exitCode?: number; artifacts: string[]; summary: string; redacted: boolean;
  // V2c additions
  source: 'check' | 'junit' | 'tap' | 'none'; dirty: boolean; treeState: string;
  durationMs?: number; counts?: { tests: number; passed: number; failed: number; skipped: number };
  failures: string[]; outputTail: string[];
}
```

### 7.9 Tool result envelope (all OMP tools)

Every engine call ends in one of three outcomes (D24). The adapter maps them; capabilities never set `isError` themselves.

| Outcome | Meaning | OMP result |
|---|---|---|
| `result` | An answer | `{ content: [text], details: <typed result> }` |
| `guidance` | Expected, recoverable condition the agent can act on: `index-building`, `ambiguous-target` (with candidates), `target-not-found` (with nearest names) | **Success-shaped**: `{ content: [text with code + what to do next], details: { guidance: code, … } }` |
| `failure` | Real malfunction or trust failure: `index-failed`, `INVALID_INPUT`, `HASH_MISMATCH`, `PATH_ESCAPE`, `LOCK_INVALID` | `{ isError: true, content: [text: '<CODE>: <message>'] }`; malfunctions add "retry once" |

This follows a reference project's observation, not our measurement: early tool failures can discourage repeat calls. `ei_workflow` reports unavailable required skills as an error.

In the golden cases, C15's "error `ambiguous-target`" is the engine's `guidance` outcome with that code; the expectation (no merged result, exact candidate list) is unchanged.

The text form is for the agent; `details` is for tests and future UIs.

### 7.10 Library entry points

The npm package root exports the OMP extension. `@krisada-m/ksd-intelligence/eslint` exports the frozen policy rules. `src/index.ts` is the internal TypeScript barrel for workflow, workspace, audit, changes and lexical search; the earlier proposed `openWorkspace()` public API and its `symbol()` method are **PLANNED (V2)**, not npm exports.

## 8. Interfaces

### 8.1 OMP tools

Full contract (inputs, registered descriptions, exact output text, budgets, guidance responses): **`docs/TOOLS.md`**.

V1 exposes four tools, one per moment the agent already recognises (D27); `ei_search` joins as a fifth in M6 (D28):

| Tool | Moment | Input | Status |
|---|---|---|---|
| `ei_workflow` | Starting a stage | `task`, `stage`, optional `type`, `risk`, `potetoMode` | `DONE` |
| `ei_impact` | About to change symbols | `targets` (1–5), optional `depth` | `DONE` |
| `ei_changes` | Finished changing | optional `base`, `depth`, `planned` | `DONE` |
| `ei_status` | A result looks wrong or stale | none | `DONE` |
| `ei_search` | Looking for an implementation | `query`, optional `limit` | `DONE` |

AGY's stdio server advertises status, impact, changes and search by default. Enable workflow explicitly.

`ei_verify` (V2c) registers only when `verification.enabled` is true. It declares `exec` for a `check` call and `read` for a `report` call. `ei_learning` (V2d) registers only when `knowledge.enabled` is true, with `read` approval. `ei_context` and `ei_retrieve` are **PLANNED (V2)**; `ei_gitlab` is dropped (D67).

V1 adds no automatic EI prompt hook; D70 composes the new engineering policy hooks instead of the frozen module.

### 8.2 CLI (`ei`)

Run `ei --help` for the shipped syntax. CLI-only commands include `init`, `setup`, `index`, `doctor --deep`, `audit`, `cache clear`, `route`, `sources check`, `skills list/check/diff/sync/publish/rollback`, and `mcp`. CLI counterparts to OMP tools: `load`, `status`, `impact`, `changes`, `search`, `verify` (V2c), and `learning` (V2d; owner write commands are CLI-only). They share the renderers; the CLI waits for index work instead of returning interactive timeout guidance.

**PLANNED (V2):** `ei symbol`, `ei embeddings install/status/remove`, `ei cache list` and automatic pruning, and CLI equivalents of V2 tools. In V1, use `ei impact` for symbol guidance and `ei cache clear` for per-repository removal.

## 9. Configuration

V1 reads project `ei.config.json` at the root discovered by `ei init`/`ei index`. `ei init` writes it only on explicit invocation, skips existing files unless `--force`, and accepts `--dry-run`. Invalid values fall back and are reported by status.

| Shipped settings | Effect |
|---|---|
| `impact.include`, `impact.exclude`, `impact.routes` | Index scope and explicit route globs |
| `impact.freshness` | `stat` (default) or `hash`; changes uses hash |
| `impact.manyCallers`, `impact.commonName` | Verdict thresholds; defaults 10 |
| `impact.useWorkspaceTypescript`, `impact.maxMemoryMb` | Runtime source and child memory bound |
| `riskZones` | `"default"`, an explicit list, or `[]`; can only raise verdicts |
| `search.enabled` | Existing search-only switch |
| `knowledge.enabled` | V2d, off by default: registers `ei_learning` and the `ei_impact` learnings line. Learnings live in `.ksd/learnings/*.yaml`; agent proposals in the cache |
| `verification.enabled`, `verification.checks`, `verification.reports` | V2c, off by default. `checks`: `{ name, command: string[], timeoutSec? (default 600, max 3600) }`, run without a shell; `reports`: `{ name, format: "junit" \| "tap", path, covers? }`. Invalid entries are dropped and reported |

**PLANNED (V2):** global EI config/session precedence, general per-capability `enabled` flags, `impact.maxDepth` as a setting, `impact.watch`, `bridges.*`, `search.semantic`, and the five V2 module configurations. Some keys already appear in generated config and are accepted as placeholders. They do not activate these features. The frozen policy has its own separate config and precedence (§6.7).

## 10. Integrations

### 10.1 OMP

Verified on 2026-11-09 (prototype, OMP 18.18.2) and on 2026-11-11 (TS adapter, OMP 18.18.8, M1): load via `omp --extension <file>` (or `-e`); register with `pi.registerTool({ name, label, approval: 'read', description, parameters: pi.zod…, execute })`; the agent discovers and calls the tool unprompted. Documented `execute(toolCallId, params, signal, onUpdate, ctx)`; the library uses the first three. Re-run the M1 smoke after every OMP upgrade.

**Facts from M1 (2026-11-11, OMP 18.18.8):**

| Fact | Consequence |
|---|---|
| Non-interactive runs work with `omp -p --model <anthropic model> -e <extension> '<prompt>'`; the default Google provider rejected another MCP tool's schema (400). `--config <overlay>` with `disabledServers` is a documented alternative | Agents can run live OMP checks themselves; briefs say so |
| In 18.18.8 the model reaches extension tools through a device dispatch (`write` to `xd://ei_workflow`) | Discovery still worked unprompted; watch for changes on upgrade |
| Error results: after an `isError` from `ei_workflow` the agent called it again in the same session and recovered (S6, S8; one model, claude-haiku-4-5) | First counter-evidence to the "agents abandon tools after errors" report. D24 stays (guidance is harmless), but it is no longer treated as established |
| Skills load from `~/.omp/agent/skills`, `~/.claude/skills`, `~/.agents/skills`, `~/.codex/skills` and project `.omp/skills` (135 found). `poteto-mode` is present but `disable-model-invocation: true` (hidden, slash-command only); `ask-matt` and `using-agent-skills` absent | D05 holds; re-check after installing skills |
| Caveman (`caveman@4.0.1`) is active and wraps long tool output in a compressed presentation (`[155 lines compressed …]`); the raw result in the transcript is complete | What the model reads may be shortened. Tool text keeps the verdict in the first lines (TOOLS.md rule 3); measure in M3 |
| GitNexus and Graft index this repository and write into it: GitNexus injects a managed block into `AGENTS.md`; Graft adds `.gitignore` and `.ignore` entries | Third-party indexer edits never get committed. Local-only ignores go in `.git/info/exclude`; an injected `AGENTS.md` block is reverted |

**Persistent loading (D40, supersedes D38):** the library is packaged as an OMP marketplace plugin, the same way KSD was: `.omp-plugin/marketplace.json` plus `package.json#omp.extensions`, with the built JavaScript committed and a drift check (`npm run build && git diff --exit-code dist/`). Daily use installs it with `omp plugin marketplace add Krisada-M/ksd-intelligence` and `omp plugin install ksd-intelligence@ksd-intelligence`; upgrades use `omp plugin upgrade`. The marketplace version is bumped only when a milestone is accepted, which makes the installed plugin the stable channel (`docs/RISK.md` R8). Development builds are loaded explicitly with `omp -e dist/adapters/omp/extension.js`. Facts from M1c (`omp://marketplace.md`, OMP 18.18.8): an install is a git clone of the repository's **default-branch head**; the version comes from the catalog's `version` (here `0.1.0`); the cache is keyed by version; `omp plugin upgrade` reinstalls only when the catalog version is newer. Per-run `omp -p --no-extensions -e <file>` disables installed plugins and still loads an explicit extension, which is how live checks run without touching the installed set.

**Release rule (D41):** `main` is the release branch. Only accepted milestones land on `main`, through a PR, together with their version bump and committed `dist/`. Development happens on branches; agents never leave unaccepted work on `main`. Because a fresh install takes `main`'s head, this rule, not the version number alone, is what makes the installed plugin the stable channel. No separate `release` branch.

### 10.2 Engineering composition (D70)

`ksd-engineering` remains the upstream source of truth. A reviewed exact commit and allowlisted Git blob IDs/modes pin the vendored runtime. The OMP entry calls its factory once with a native intelligence default; AGY uses generated native rules and on-demand skills, with explicit fixed-root MCP. No network sync at runtime, no reverse dependency, no additional legacy compatibility mode. The old standalone and current standalone engineering extensions must be removed before installing the composed product. The historical module and tests are retained, but its generated distribution is removed. See the D70 brief for release and cross-host gates.

### 10.3 Skill sources

`~/ei-skill-sources/{matt, cursor-plugins, osmani}`; env `EI_MATT_ROOT`, `EI_POTETO_ROOT` (= cursor-plugins repo root; `rootSubpath: pstack/skills`), `EI_OSMANI_ROOT`. Pinned commits: matt `4ae2317d`, cursor/plugins `6b030021`, osmani `301b02b1`. Updating a source: pull → read the changed SKILL.md diffs → `ei sources check --write` → commit the lock.

## 11. Storage

| Data | First implementation | Later | Regenerable? |
|---|---|---|---|
| Skill text | read from checkouts each call | same | yes (from pinned checkout) |
| Index / graph | whole-scope index in `~/.cache/ksd-intelligence/<repo-id>/index.sqlite`: fingerprint, per-file local records (keyed by content hash + extractor stamp), resolved edges, unresolved records and the full-text tables, in one SQLite database (WAL); updates are written to a staging copy and published by atomic rename | Same | yes; `ei index --full` or delete dir |
| Compression originals | n/a | CAS files `<sha256>` in the same dir; retained while referenced | **no**; never evict a referenced object |
| Learnings | n/a | `.ksd/learnings/*.yaml` in the repo | **no**; versioned with code |
| Verification reports | n/a | cache dir, last N per check | yes |

The owner-run `ei init` can write `ei.config.json`; analysis does not modify source. Owner-run skill and policy configuration commands are separate (§§6.1, 6.7).

`<repo-id>` is derived from the repository root's real path. `ei init` creates the private cache and infers proposed include/route globs. `ei cache clear` removes that repository's index and audit, not the shared TypeScript runtime.

**SQLite (D46):** `node:sqlite` is the store. M1b verified it inside OMP (SQLite 3.54.0, FTS5, WAL) and under Node 24, so it works in either engine runtime. The sharded-JSON fallback and the SQLite entry gate are dropped. `bun:sqlite` is not used because it does not exist under Node.

Publish path (measured in M2a.1 on a 221 MB database, Linux): a full build publishes by rename in 39–48 ms; a small update by copy-then-rename takes 340–410 ms; the same update as an in-place WAL transaction takes 95–100 ms. M2a.2 keeps copy-then-rename for every publish, because it is the one tested recovery path and it fits the update target in §14. M2a.2 measures the real index size and update time on oh-my-pi. In-place transactions for small updates are considered only if a one-file update exceeds 1 s end to end, and then need an ADR covering reader isolation and interrupted-update recovery.


## 12. Safety and failure model

> The risk-containment design in `docs/RISK.md` is **in force** (decisions R1–R9 confirmed 2026-11-11, R5 as amended by D30).

| Situation | Behaviour |
|---|---|
| Skill missing, tampered, escaped, oversize | Fail closed: named error, no skill text |
| No index yet, or build in progress | Guidance `index-building` with progress (success-shaped); never an answer from a partial build |
| Update fails but a published index exists | Answer from it with `partial` + `stale-index` and the drifted files; never presented as current |
| Index build error, parser crash, timeout, failed integrity check | Fail open: `index-failed` error result; previous active index kept; session continues |
| Parse error in a file | Results still returned; `partial` + `parse-error`; level `unknown` |
| Ambiguous symbol | Guidance `ambiguous-target` with candidates; never merge results |
| Config invalid | Defaults for that section; warning in `ei_status` |
| GitLab unreachable / no token | PLANNED (V2): no inferred PASS |
| Compression store write fails | PLANNED (V2): pass original through uncompressed |
| Skill text says "ignore policy / deploy" | No effect on flags or header order; library never executes instructions |

V1 analyzes locally with no telemetry. The owner-run `ei setup` invokes the package manager to provision TypeScript. The future GitLab and embeddings exceptions are **PLANNED (V2)**. See RISK §§4–6 for timeouts, private cache modes and the trust boundary.

## 13. Roadmap and gates

| Order | Milestone | Deliverable | Exit gate |
|---|---|---|---|
| 1 | **M0** ✅ | TS repo, router fixed, sources lock | 56/56 tests; real 15/15 hashes; done 2026-11-09 |
| 2 | **M1** ✅ | TS adapter live in OMP; S1–S8 | S1–S6, S8 verified on 18.18.8; S7 owner check in TUI |
| 3 | **M1b** ✅ | Runtime spike, facts only | Facts in `docs/research/m1b-runtime-facts.md`; applied as D43–D47 |
| 3b | **M1c** ✅ | Merge KSD Engineering Proxy as `src/policy/` with history; one extension entry; marketplace packaging; cut-over from the old plugin (`docs/briefs/M1c-ksd-merge.md`) | KSD's 148 tests and this repo's tests all pass; policy and status snapshots byte-identical to 0.6.0; live OMP: one install, commands work, policy injected once, `ei_workflow` still works; rollback tested |
| 3c | **M1d** ✅ | Portable baseline: macOS/Linux CI, canonical-path checks, OS/arch evidence (`docs/briefs/M1d-platform-baseline.md`) | Matrix checks pass on both OS families; OS/arch recorded; real OMP smoke on each OS family remains a separate manual gate |
| 4 | **M2a.1** ✅ | Engine host (child process, runtime choice, memory watchdog, idle exit, lock) · TypeScript provisioning (`ei setup`) · SQLite store · scan · fingerprint and probe · `ei index` (scan only), `ei_status` (`docs/briefs/M2a-index.md`, part 1) | Scan census accounts for every fixture file; probe and lock behaviour tested; child is killed above its memory limit; status reports runtime, TypeScript and store |
| 4b | **M2a.2** ✅ (with M2a.3 review fixes, D50–D51) | Extract-local · resolve (ADR 0002/0003, D43 options) · verify · publish · incremental update · `ei doctor --deep` (`docs/briefs/M2a-index.md`, part 2) | Randomised incremental == full passes; differential test against TypeScript find-references passes on the fixture and on oh-my-pi; cold build and one-file update measured on oh-my-pi |
| 5 | **M2b** `DONE` | `ei_impact`, reference edges, gaps and verdict | #32; owner golden cases |
| 6 | **M3** `DONE` | Dogfood and exit review | D63 waived the 14-day window; keep logging |
| 7 | **M2c** `DONE` | Risk zones, `ei_changes`, audit and stage protocol | #34; changed-file census and golden cases |
| 8 | **M6a** `DONE` | `ei_search`, lexical | #34 and D62; query oracle and parity |
| 9 | **MAGY1 / D65** `DONE` | AGY stdio/npm packaging | Protocol/tarball tests; live host smoke separate |
| 10 | **V1 close-out** `NEXT` | 1.0.0 release candidate | Owner gates in `docs/release-checklist.md` |
| Later | **M4a / M4b / M5 / M6b** | **PLANNED (V2)**, conditional; M4a skipped in V1 | D61/D63; no qualifying detector, bridge, watcher or semantic evidence |

**Dogfood log entry:** task · tools called · was the answer correct (owner judges) · did it change what the agent did · latency · any false `low`. A single false `low` on a real change stops the roadmap until fixed.

**V2 starts after `v1.0.0`.** The table records historical, waived entry gates (D64). Each module ships disabled with byte-identical V1 output and a measured value check before the owner enables it. Compression also needs an installed OMP hook capable of replacing tool output. See `docs/briefs/V2-README.md`.

| Module | Historical gate (waived, D64) |
|---|---|
| Context packs | ≥ 3 logged tasks where the agent read clearly irrelevant files or missed a relevant one that impact knew about |
| GitLab adapter | Real work is on GitLab MRs and copying MR/pipeline info by hand is logged as friction |
| Verification | A logged case of the agent claiming a check passed without evidence |
| Knowledge | ≥ 2 logged cases of re-explaining the same project decision to the agent |
| Compression | Measured context pressure with OMP compaction on, plus a fixture showing a safe saving |

Delivery order: context → verification → knowledge → compression (GitLab dropped, D67).

## 14. Quality and testing

| Layer | What | When |
|---|---|---|
| Unit | Router, classifier table, loader trust chain, risk policy | every `npm test` |
| Golden | `tests/golden/M2-impact-cases.md` → tests; agent may not edit expectations | every `npm test` |
| Freshness | Temp git copies: edit, untracked, rename/delete, barrel change, incremental == full (run with `freshness: "hash"`), plus one documented blind-spot case | every `npm test` |
| Differential | For sampled declarations, every reference TypeScript's own find-references reports must be an edge in the index. Runs on the fixture in `npm test` and on real repositories in `ei doctor --deep` | every `npm test`; on demand |
| Randomised | Random sequences of edits, renames, adds and deletes on the fixture; after each, incremental index == cold build. Seeded, so a failure reproduces | every `npm test` (short run); nightly-style long run on demand |
| Platform CI | Node 24 on macOS and Linux: typecheck, lint, tests, dist drift; record OS and architecture | every PR and merge to main (M1d) |
| Runtime/OS integration | Real OMP adapter smoke on both OS families; engine process, memory enforcement, SQLite locking/recovery and cancellation after M2a | release gate per supported OS family; manual until automated |
| Live smoke | OMP scenarios S1–S8, all five tools and KSD policy; AGY stdio host separately | release and OMP upgrades |
| Dogfood | Real tasks, owner-judged | M3 onward |

**Performance targets (D52, revised after M2a; set build targets in M3):**

- Warm impact p95 < 300 ms and workflow < 50 ms excluding I/O are targets, not claims about all repositories.
- Reference, not a gate — oh-my-pi (6,761 indexable files, 2.27M lines, Linux, Node 24, new process per command, median of 3): cold build 145 s; one-file body edit 25 s; signature edit 124 s (4,837 files re-resolved); add file 58 s; peak RSS 7.1 GB. The resolve phase dominates because TypeScript checks lazily while symbols are resolved. A repository of this size needs Node ≥ 22.5; no Bun build completed within the memory limit.
- Build and update targets for daily use are set from the owner's own repositories during M3. The earlier figures (cold < 60 s, update < 3 s, first query with drift < 15 s) came from M1b measurements that did not include full resolution, and are withdrawn.
- D63 adopted advisory daily-use baselines: cold ≤ 5 s on this repo or ≤ 30 s on large daily repositories, drift update ≤ 3 s, warm impact p95 ≤ 300 ms. The much larger oh-my-pi index above demonstrates why these are not guarantees.

## 15. Decision log

| ID | Decision | Date |
|---|---|---|
| D01 | One owned TS package; OMP primary host + CLI; MCP deferred indefinitely | 2026-11-08 |
| D02 | Personal non-commercial use; keep `PROVENANCE.md`; no full license matrix/SBOM | 2026-11-08 |
| D03 | Repo name `ksd-intelligence`; tool prefix `ei_`; CLI `ei` | 2026-11-09 |
| D04 | KSD stays a separate plugin; V2 read-only mode bridge only (**superseded by D39**) | 2026-11-09 |
| D05 | Exactly one automatic skill router; upstream meta-routers off; `matt:tdd` only | 2026-11-09 |
| D06 | Caller-supplied task type; keyword fallback; `classifiedBy` always reported | 2026-11-09 |
| D07 | Skills loaded from pinned checkouts with sha256 + commit lock; never bundled | 2026-11-09 |
| D08 | OMP extension API shape as verified live on 18.18.2 | 2026-11-09 |
| D09 | TypeScript compiler API is the semantic authority; no Tree-sitter (mechanism refined by D21) | 2026-11-09 |
| D10 | File cache first; SQLite behind a gate (what is cached revised by D20) | 2026-11-09 |
| D11 | Base level: incomplete → unknown; factors → medium; else low (reframed as a verdict by D32) | 2026-11-09 |
| D12 | Public export surface is a risk factor, not a completeness gap | 2026-11-09 |
| D13 | Completeness gaps scoped to reachable targets; risk on full traversal | 2026-11-09 |
| D14 | Routes declared in `ei.config.json`; framework detection added in M4 by D28, config stays as override | 2026-11-09 |
| D15 | All tools read-only; intelligence capabilities add no OMP hooks or context injection (the merged KSD module keeps its own, D39) | 2026-11-10 |
| D16 | GitLab integration is a read-only V2 adapter; token from env only | 2026-11-10 |
| D17 | Learnings stored in repo (`.ksd/learnings/`), owner-approved writes only | 2026-11-10 |
| D18 | Generated data lives in `~/.cache/ksd-intelligence/<repo-id>/`, never in the repo | 2026-11-10 |
| D19 | V2 modules built only when their dogfood-log gate is met (six items exempted by D28) | 2026-11-10 |
| D20 | Explicit initial codebase scan builds a whole-scope index (scan → extract → verify → publish); queries read the index; incremental updates on change. Owner requirement | 2026-11-11 |
| D21 | Cache only file-local extraction; re-resolve the TypeScript-reported affected set; never patch edges in place | 2026-11-11 |
| D22 | Two-level freshness: stat probe per query, full hash for rebuilds, `ei_changes` and `ei doctor` | 2026-11-11 |
| D23 | Automatic extractor stamp in every cache key; unresolved uses and extraction failures stored as records with reasons | 2026-11-11 |
| D24 | Three outcomes (result / guidance / failure); expected conditions in impact tools are success-shaped | 2026-11-11 |
| D25 | Disk is the source of truth; git only lists visible files; one builder per repo under a lock; a failed update answers from the last published index marked `stale-index` | 2026-11-11 |
| D26 | Not adopted from reference projects: name-guess resolution tiers, in-place edge patching, commit-based staleness, graph DB server. (Synthesized edges, watchers and embeddings were on this list until D28) | 2026-11-11 |
| D27 | V1 agent surface is four tools (`ei_workflow`, `ei_impact`, `ei_changes`, `ei_status`); lookup folded into `ei_impact`; indexing automatic + owner CLI; output text contract in `docs/TOOLS.md` | 2026-11-11 |
| D28 | **Owner decision 2026-11-11:** bring forward, ahead of dogfood gates, six items previously deferred or not adopted: heuristic bridges across dynamic dispatch, framework route detection, built-in SQLite, session file watcher, git-worktree seeding, code search with optional local embeddings. Each is designed so it cannot weaken evidence rules (§6.9–6.11). Supersedes D19 for these items and the matching parts of D26. **Scheduling revised by D48:** the capabilities stay intended, but M4b and M5 wait for dogfood evidence and M6b for separate approval | 2026-11-11 |
| D29 | **M1b runtime spike** is a gate before any M2a code (review B-1, B-3) | 2026-11-11 |
| D30 | `typescript` is a runtime dependency: pinned, never taken from the analysed repo by default; a project's own copy only by explicit opt-in. Engine isolated with time and memory budgets (RISK R5 as amended, R6). **Delivery and isolation revised by D44 and D45** | 2026-11-11 |
| D31 | Program lifetime: sequential builds, two projects kept (**superseded by D45**: one program, child process, idle exit) | 2026-11-11 |
| D32 | No engine "risk" word. Results carry completeness, reach and factors; one derived verdict (level + action). New factors `cross-package`, `many-callers` | 2026-11-11 |
| D33 | Milestone order: M1 → M1b → M1c (D39) → M2a → M2b → M3 starts → M4a → M2c → M6a → M4b → M5 → M6b (**sequencing superseded by D48**) | 2026-11-11 |
| D34 | Stable key grammar and the set of indexed declarations and uses fixed by ADR 0002 and 0003 | 2026-11-11 |
| D35 | First call blocks up to 60 s with streamed progress; only the lock holder builds, other sessions read the published index | 2026-11-11 |
| D36 | Acceptance adds a differential test against TypeScript find-references and a seeded randomised incremental-equals-full test | 2026-11-11 |
| D37 | `docs/RISK.md` R1–R9 confirmed (R5 amended by D30); name cross-check is part of engine correctness (M2b). Golden file contract refreshed to match | 2026-11-11 |
| D38 | Persistent loading from user-level OMP config pointing at a stable worktree (**superseded by D40**); third-party indexer edits (GitNexus, Graft) are never committed (still in force) | 2026-11-11 |
| D39 | **Owner decision:** merge KSD Engineering Proxy into this library as `src/policy/` with its git history; frozen behaviour contract (§6.7); no bridge. Supersedes D04 | 2026-11-11 |
| D40 | Package as an OMP marketplace plugin with committed build output; marketplace version bumped only on accepted milestones. Supersedes D38 | 2026-11-11 |
| D41 | `main` is the release branch: only accepted milestones land there, by PR, with version bump and built `dist/`; development on branches | 2026-11-11 |
| D42 | `ei init` (owner CLI) adopted after it landed outside the milestone flow (#8): creates the private cache dir and a starting `ei.config.json`; `ksdBridge` removed from the config schema (obsolete since D39). Unplanned work still goes through a brief or a reviewed PR before `main` (D41) | 2026-11-12 |
| D43 | The engine's analysis program forces `verbatimModuleSyntax` and `isolatedModules` off and never uses `ignoreSourceFile`, so the builder's affected set propagates through importers (M1b B4) | 2026-11-12 |
| D44 | Marketplace installs copy the repository and install no dependencies (OMP `marketplace/cache.ts`, `fs.cp`). The pinned TypeScript is provisioned by an owner-run `ei setup` into `~/.cache/ksd-intelligence/runtime/typescript-<version>/` and loaded by absolute path; without it the impact tools report `degraded` with that fix. No network from the agent or the tools | 2026-11-12 |
| D45 | Engine host is a child process, Node ≥ 22.5 when on `PATH` else OMP's Bun; memory limit enforced by flag (Node) or RSS watchdog (Bun); one program per index scope; idle exit after 10 minutes; at most one engine process per repository | 2026-11-12 |
| D46 | Store is `node:sqlite` (one database per repository, WAL, staged then renamed); JSON fallback and the SQLite gate dropped | 2026-11-12 |
| D47 | No TypeScript build-info persistence; a new session loads the published index and creates a program only when the probe finds drift | 2026-11-12 |
| D48 | Practical delivery replan: add M1d macOS/Linux CI baseline before M2a; retain D43–D47 engine design and D28 capability intent, but reorder M2c and lexical search before route/heuristic work; M5 only on measured need, M6b requires separate approval. Accepted by the owner 2026-11-12. Supersedes D33's sequencing and D28's unconditional scheduling of M4b, M5 and M6b | 2026-11-12 |
| D49 | M2a.1 review: engine and CLI need Node ≥ 22.5 (`engines.node`, ADR 0005); secret name patterns (`*credentials*`, `secrets/**`) exclude only non-code files (`docs/RISK.md` §6); every publish stays copy-then-rename until M2a.2 measurements say otherwise; `ei_status` text shows home-relative paths, full paths stay in `details`; fingerprint lives in the `files` table | 2026-11-13 |
| D50 | M2a.3 review: the engine child exits after every build and update (idle exit only after query ops); no builder chaining across updates and no `releaseProgram`; an update's propagation treats a file as changed when its observable declarations, written or inferred, have edges into a changed-surface file. Supersedes the builder affected set of §6.2.1 and the `affected-set-supplemented` status counter | 2026-11-14 |
| D51 | M2a.3 answers: (1) members of anonymous object types (`Usage.cost.input`) stay unindexed; in M2b, `ei_impact` on such a member answers with guidance that names the indexed parent (`Usage.cost`) and marks the result `partial`, because the parent's direct users miss reads through an alias of the parent's type (`Usage["cost"]`, reached only transitively) and through generic key access (`get(u, "cost")`). Indexing deeper is an option after M3. (2) The D50 propagation rule stays as is; narrowing it to edges from type-stating text is a speed change, scheduled only if M3 dogfood finds updates too slow | 2026-11-14 |
| D52 | M2b scope and M2a close-out: (1) M2a accepted; oh-my-pi timings are reference values and the M1b-era build/update targets are withdrawn (§14); (2) a string-literal key typed by `keyof T` is a `REFERENCES` edge to the property when it resolves to one indexed declaration, else a `computed-member-access` gap on the owner type; (3) when an update is still running at 60 s, or another session holds the lock, `ei_impact` answers from the published index as `picture partial (stale index)` and the update continues; (4) rendering and the base verdict are built inside M2b (the separate parallel tracks B and C are folded in); risk zones, `ei_changes` and the audit log stay in M2c | 2026-11-14 |
| D53 | Briefs for everything left in V1 are written ahead as drafts (`docs/briefs/`: M3, M2c, M6a, M4a, gated M4b/M5/M6b, V1 close-out) with the D48 order unchanged. Each draft starts with a reconcile round that changes nothing; the owner corrects the brief before any build round. Gates for M4a detectors, M4b, M5 and M6b are stated as countable evidence from the dogfood log. V1 ends at the close-out; V2 modules keep their entry gates | 2026-11-14 |
| D54 | M2b Round 1 review. (1) Completeness is scoped to the **target** as golden P4 says; a gap on an impacted symbol does not make the target partial. The M2b brief's wording to the contrary was wrong and is corrected. The impacted symbol carries `gapScoped` and the `gap` row marker, so the limit stays visible without turning most results `unknown` (on oh-my-pi the transitive reading would have made 16.6% of declarations partial from `keyof` gaps alone, against 0.89% in direct scope). (2) Golden C15 lists five candidates (G13). (3) The fixture's stray `void localOnly;` is removed; C14 stands. (4) Index additions accepted: `keyof` key edges and gaps, package privacy and entries in `meta.packages`, boundary `markers` (schema 3). The use of TypeScript's internal union `origin` field in `keys.ts` is accepted for the pinned compiler only and must be covered by a test that fails if the field disappears | 2026-11-15 |
| D55 | M2b Round 2 review: 84% of 200 sampled targets on oh-my-pi were `unknown`. No golden case changes; golden P4 and the traversal rule are clarified (G14). (1) Traversal to closure, node budget 50,000, no depth cap. (2) Prefix-less `import(x)` / `require(x)`: scoped to exported declarations in files with no static importer (tests and package entries excepted); otherwise a repository limit in the footer and `ei_status`. (3) Excluded files: repository limit. Code files without a tsconfig are scanned lexically for the name cross-check. (4) A string literal typed as a literal or union not built from `keyof` is not a `string-name-match`. (5) Object-literal members inherit the whole-value users of their enclosing objects as dependents. (6) Scope statement: `ei_impact` follows references, not values. A value stored into a field, array or map is followed to the symbol that stores it, not to later readers of that container; README and TOOLS say so. The `UNICODE_SYMBOLS.boxRound.topRight` finding is this case and is not counted as a wrong `low` once (5) lists the storing symbol. (7) An array of functions needs no gap: the array's declaration is the dependent and its users continue the chain | 2026-11-15 |
| D56 | M2b rounds 2 and 2b accepted as the base for round 3 (review: `docs/reviews/2026-11-16-m2b-rounds-2-2b.md`). New factor `common-name` and config `impact.commonName` (default 10): name-match sites for a name shared by more declarations than that are not completeness reasons; the target is at least `medium` / `run-tests` and `basis` states the counts (golden G15). `gapScoped` marks only gaps that hide users of the marked row. A failed build is not retried until the drifted set changes. The CLI never waits 60 s and exits stale in a loop | 2026-11-16 |
| D57 | M2b round 3 review (`docs/reviews/2026-11-17-m2b-round-3.md`): a wrong `low` on this repository (`Graph.incoming`, called only from `tests/`). (1) `ei init` proposes an include that covers every directory a tsconfig in the repository owns, plus `src/**`, `test/**`, `tests/**`, `__tests__/**`, `spec/**` when present; never narrower than the root and test tsconfigs. (2) The lexical name scan of D55 item 4 covers every visible code file outside the index scope (outside `include`, in an owner `exclude`, or orphan), except files under the secret rule and the default excludes (`node_modules`, `dist`, `.git`). Such files never get declarations or edges; their matches give `unresolved-name-match` (or `common-name` per D56). (3) A target whose name matches only in out-of-scope files is `partial`, never `complete`. (4) `ei_status` and the footer keep the excluded-file count; `ei init --dry-run` prints which tsconfig-owned directories its include would leave out | 2026-11-17 |
| D59 | M2b round 4 review: fifteen findings, six of them paths to a wrong `low`. Decisions in `docs/reviews/2026-11-18-m2b-round-4-decisions.md`; among them: unresolved imports are keyed by local and imported name; overriding class members get `IMPLEMENTS` edges to the base member (ADR 0003); a `path` target's verdict is the union over every declaration in the file; bare-name targets match `name` and `simple`; level words in paths and names are never altered | 2026-11-18 |
| D58 | Practices taken from Anthropic's *AI-Native SDLC Playbook*: (1) the advisory rules for protected paths get a deterministic backstop, the `Owner approval` workflow, which fails a pull request touching `tests/golden/**`, `src/policy/**`, `tests/policy/**` or `tests/snapshots/**` until the owner adds the `owner-approved` label; (2) automated review on code pull requests with the Claude Code GitHub Action and the official `code-review` plugin, authenticated with the owner's subscription token, guided by `REVIEW.md`; it comments only (managed Code Review needs a Team or Enterprise plan); (3) `ei_changes` gains optional planned targets and a `Not in plan` section (M2c); (4) M3 measures leading and lagging indicators; (5) agent-behaviour evals before V1. Not adopted now: a hook that blocks edits in risk zones without a prior `ei_impact` call; reconsidered in V2 if M3 shows edits without it | 2026-11-18 |
| D60 | **M6a (`ei_search`, lexical) Round 0 reconciliation (`PROPOSED`):** SQLite schema bumps `4 → 5` adding FTS5 virtual table `declarations_fts` (`tokenize = 'unicode61'`, `rowid = declarations.id`, `0.0` weights for `UNINDEXED` columns in `bm25()`); `RISK §6` is amended to allow 400-char capped signatures and first-paragraph JSDoc comments for `extraction = 'ok'` indexable code files only (never secrets, excluded files, or `parse-error` files); `stamp.ts` hashes `src/core/search/segments.js`; `ei_search` ships across OMP, CLI (`ei search <query> [--limit N] [--json]`), and AGY MCP (`scripts/mcp/tools.mjs`); graph-proximity boosting is deferred unless Round 3 query evaluation shows need; fixed query corpus evaluates `ksd-intelligence` and `work-sure` | 2026-11-22 |
| D61 | **Owner decision 2026-11-22 (Ticket 07 Round 0 stop gate):** M4a route detectors `SKIP ALL`. No dogfood evidence exists for `B1a` (Next.js App Router), `B1b` (Next.js Pages Router), `B1c` (Expo Router) or `B2` (Hono) — the M3 route census (`docs/research/m3-work-sure-linux.md` §7) and dogfood log record no qualifying workflow, and no manifest in the work repository declares `next`, `expo-router` or `hono`. Ticket 07 closes with this recorded skip; no detector code is written. Manual `impact.routes` globs remain the only route source | 2026-11-22 |
| D62 | **Owner decision 2026-11-22 (M6a acceptance):** `tests/golden/search-queries.md` (40-query oracle) and the `PROPOSED` M6a items of `RISK §6` / `DESIGN §15` (D60) are accepted. Search-hit `callers` counts **distinct caller symbols**, not dependency edges: `COUNT(DISTINCT e.source)` over non-`IMPORTS`/`TESTS` edges — one symbol contributing `REFERENCES` + `CALLS` to the same target is one caller (test 4b; recall oracle unchanged after the fix). Fix-forward findings recorded in `docs/reviews/m6a-review.md` §8 stay open for the owner | 2026-11-22 |
| D63 | **Owner decision 2026-11-23 (M3 exit, owner close-out directive):** V1 closes today. The ≥14-day daily-use window is **waived** (10 real tasks logged over 2 days, 8 of them a same-day burst plainly dated in `docs/dogfood-log.md`; 0 wrong answers, 0 wrong `low`). Exit decisions per `docs/research/m3-exit-review.md`: daily-use limits become advisory baselines (cold ≤ 5 s this repo / ≤ 30 s large, drift update ≤ 3 s, warm query p95 ≤ 300 ms), D50 propagation unchanged, anonymous object-type members stay unindexed, scoping unchanged with the `unresolved-name-match` noise presentation deferred to V2. No optional milestone starts: M4a `SKIP ALL` (D61); M4b B3–B6, M5 and M6b gates all **not met / no data**. The dogfood log keeps running through close-out | 2026-11-23 |
| D64 | **Owner decision 2026-11-25:** build all five V2 modules without waiting for the §13 entry gates. Order unchanged (context → GitLab → verification → knowledge → compression), starting after `v1.0.0`. Instead of gates, each module ships disabled, leaves V1 output byte-identical when disabled, and reports a before/after value check that the owner reads before enabling it. Compression is built only if the installed OMP exposes a hook that can replace another tool's result. Briefs: `docs/briefs/V2-README.md`, `V2a`–`V2e` | 2026-11-25 |
| D65 | **Owner decision 2026-11-25: npm publishing.** The package is published as `@krisada-m/ksd-intelligence` (scoped, public) so AGY and CLI users can `npm install -g` it instead of cloning. OMP keeps installing from the marketplace (D40). (1) `files` whitelist: `dist/`, `scripts/agy-mcp.mjs`, `scripts/mcp/`, `skills/`, `skills.lock.json`, `skills.registry.json`, `LICENSE`, `README.md`; nothing from `tests/`, `docs/`, `src/`, `.scratch/`, `spikes/`. (2) Publishing runs only from CI on a `v*` tag that equals `package.json` version, through npm trusted publishing with provenance; no npm token is stored. (3) `tests/packaging/npm-tarball.test.js` packs, installs the tarball in an empty directory, runs `ei` and an MCP `initialize`. (4) `prepare` is `husky \|\| true` so a consumer or CI without husky does not fail. (5) No runtime dependency is added; upstream skill text is still read from the owner's checkouts (PROVENANCE). Use stays personal; MIT file added | 2026-11-25 |
| D66 | **Owner request 2026-11-25: M3b comparison.** Before `v1.0.0`, compare `ksd` with the other code-intelligence tools the owner has installed (GitNexus, CodeGraph, Graft, any other he names) and with `ripgrep` and TypeScript `findReferences` baselines, on golden, dogfood, sampled-symbol, change and search task sets with a pooled, code-read oracle (`docs/briefs/M3b-compare.md`). Headline metric: false safe. Research only: no ksd code changes; defects go to the V1 close-out. Contestants run in throwaway clones; none runs on `work-sure` if it sends data off the machine unless the owner approves it by name. Answers open question 4. Outcome lines added when the owner decides on the recommendations | 2026-11-25 |
| D67 | **Owner decision 2026-11-26:** the GitLab adapter (V2b, `ei_gitlab`) is dropped from V2. The library gets no network code beyond the owner-run `ei setup`; V2c reads only local results (allowlisted checks, JUnit/TAP files) and has no pipeline source. Supersedes D16 and the GitLab parts of D64. The `.gitlab-ci.yml` skill-update job is CI configuration, not library code, and is unaffected | 2026-11-26 |
| D68 | **Owner request 2026-11-26: UI polish (`1.1.0`).** Nicer output on four surfaces, compact-tree results plus an animated HUD for `ei index` / `ei setup` / `ei doctor` (owner's choice): `ei` CLI, OMP tool results, the KSD status segment and `/engineering-proxy status`, and AGY (`docs/briefs/UI-polish.md`). Presentation only: tool `content` text, TOOLS.md, snapshots and golden cases stay byte-identical, proven by a test per surface; styling reads `details`. For the KSD policy module this unfreezes presentation only (colour, symbols, order, spacing); words, modes, commands, config keys and behaviour stay. No runtime dependency. AGY text changes only behind an opt-in flag | 2026-11-26 |
| D69 | **Owner exception 2026-11-26: lane runs.** After `v1.0.0`, one session may build several V2 or UI-polish milestones back to back without the stop between milestones (`AGENTS.md`). Conditions: own branch and worktree per milestone, gates and a self-review file each round, evals ≥ 9/10 with the strong model after each milestone, a current handoff file, stop at the first hard stop. Push, merge and cross-vendor review stay with the owner, per milestone | 2026-11-26 |
| D70 | **Owner-directed single-install architecture (candidate):** keep `ksd-engineering` as the source of truth for erosiano-dev; KSD Intelligence consumes an exact verified runtime pin and is the sole installed engineering/intelligence product. Supersedes D39's frozen active policy and archival decision; historical source and oracle remain unchanged. OMP composes the new factory once, AGY gets native rule/skill packaging plus fixed-root local MCP. No new runtime download, no reverse dependency, no legacy activation mode. Separate owner acceptance and live verification required. | 2026-11-26 |

Each decision gets a short ADR in `docs/adr/` when the milestone that depends on it starts. Changing a decision needs a new ADR that supersedes the old one.

## 16. Open questions

- **Closed for V1:** default-branch marketplace (D40/D41); child-process layout and TypeScript/SQLite runtime (D43–D47); dogfood reference projects and scope (D63); npm packaging (D65). A wrong `low` still stops release or roadmap work.
- **Owner release verification:** repeat S1–S8, policy status and all five tools on macOS and Linux. Review skill sources at their pins and whenever updating them.
- **PLANNED (V2):** doctor golden canary and `engine-self-check-failed`, OMP version warning, general per-capability switches, `ei symbol` and hard 5 s per-query budget. Review limits, noise presentation and upstream tool comparison when there is evidence; D64's module conditions are in §13.

## Owner-directed exception — Antigravity MCP adapter (2026-11-19)

The owner has explicitly authorized **MAGY1** as a standalone adapter-only integration milestone, superseding the earlier general MCP deferral for this narrow read-only local transport only. Scope, tests and manual host gate: `docs/briefs/MAGY1-mcp.md`. Installation and configuration: `docs/integrations/antigravity.md`.

Antigravity consumes the existing KSD Core through local MCP stdio. Its default tools are `ei_status`, `ei_impact`, `ei_changes`, and `ei_search`; workflow is opt-in. It does not install the OMP policy, run skill scripts, edit source code, or merge.

No other MCP host adapter, AGY native plugin/skill packaging or policy migration is authorized by this exception. Existing roadmaps and acceptance criteria for M2b/M3/M2c remain unchanged. Green mock/protocol tests on CI do **not** prove compatibility in live AGY; a macOS/Linux runtime smoke must be separately recorded before making that claim.
