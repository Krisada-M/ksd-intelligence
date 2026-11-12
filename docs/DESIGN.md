# ksd-intelligence — Final Design

> **Status:** authoritative design, 2026-11-10; index lifecycle, tool surface and scope revised 2026-11-11 (D20–D28); senior-review decisions applied the same day (D29–D37); KSD merged into the library and packaging decided (D39–D40); M1b runtime facts applied 2026-11-12 (D43–D47). Supersedes the architecture sections of `docs/reference/knowledge-export.md` (which remains historical background).
> **Owner/user:** one person, personal non-commercial use.
> **Host:** Oh My Pi (OMP) 18.18.8 on WSL2 (verified 18.18.2 on 2026-11-09, re-verified 18.18.8 on 2026-11-11). Node >= 20 (owner runs v24). Owner shell: fish.
> **Labels:** `DONE` = built and verified · `NEXT` = current or next milestone · `PLANNED` = designed; starts at its milestone (M4–M6, owner-directed) or when its entry gate is met (V2) · `NEVER` = explicitly out of scope.
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
4. **OMP stays in charge** of models, permissions, sessions and approvals. The KSD policy module (merged from KSD Engineering Proxy, D39) stays in charge of style and per-turn policy, with its behaviour unchanged.
5. **Fail open for advice, fail closed for trust.** A broken index never breaks a session. A tampered skill is never delivered.
6. **Add a module only on evidence.** Each V2 module has an entry gate (§13). If it does not pass, the module is not built. Exception: the six V1.5 items the owner brought forward (D28).
7. **Small and boring.** TypeScript, no servers, no daemons. The only always-on hook is the KSD policy module's existing per-turn injection, carried over unchanged; intelligence capabilities add none. Runtime dependencies only when justified and approved: `typescript` (impact engine) and an optional local embedding runtime (M6) are the anticipated ones.

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
| KSD Engineering Proxy | **Merged into this library** as the `policy` module (D39); the old plugin is uninstalled on cut-over | Commands, config files, status text and policy text unchanged (§6.7, §10.2) |
| Ponytail, Caveman | Other installed OMP plugins | Coexist; never mutate their state. Caveman may compress tool output (§10.1) |
| Skill sources (Matt, poteto/pstack, Osmani) | Instruction text | Loaded from pinned checkouts with sha256 lock. Never bundled, never executed |
| GitNexus | Possibly installed (`.gitnexus/` seen) | Not a dependency. Used only as a comparison baseline in M3 |
| GitLab | Where real projects live | PLANNED read-only adapter, after M3 |
| uiMatch (`Krisada-M/visual-qa`) | Owner's visual QA tool | PLANNED optional verification adapter |

## 4. Scope

| Tier | Contents |
|---|---|
| **V1** (M0–M3) | Skill workflow router · KSD policy module (merged, M1c) · codebase scan + whole-scope index · TS/JS impact engine · OMP adapter · CLI · golden + freshness tests · dogfood log |
| **V1.5** (M4–M6, owner-directed, D28) | Framework route detection · heuristic bridges across dynamic dispatch · built-in SQLite store · session file watcher · git-worktree seeding · code search (lexical, optional local embeddings) |
| **V2** (each gated, §13) | Context packs (built on search) · GitLab adapter · verification adapters · anchored learnings · recoverable compression |
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
  storage/         one interface: built-in SQLite if the runtime has it, else sharded JSON · CAS (V2)
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
│   ├── storage/           store.ts · sqlite.ts · json-shards.ts · cas.ts               (store M2a; CAS V2)
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

### 6.1 Workflow router — `DONE` (M0), live smoke `NEXT` (M1)

Selects one primary leaf skill per (task type × stage), plus at most one reviewer/verifier at `review`/`verify` when `risk: high`.

- **Types:** `bug · feature · refactor · security · performance · ui`. Caller-supplied `type` wins (`classifiedBy: caller`); otherwise English keyword stems (`keyword`); otherwise `feature` (`default`, visibly a guess).
- **Stages:** `plan · investigate · implement · verify · review · ship`.
- **Catalog:** 15 allowlisted skills (4 Matt, 3 pstack, 8 Osmani). Only one automatic router exists: upstream `ask-matt`, `poteto-mode` and `using-agent-skills` are never auto-enabled, and `pstack:tdd` is never selected alongside `matt:tdd`.
- **Trust chain:** catalog allowlist → provider root from env → realpath inside root → regular file ≤ 64 KiB with frontmatter → sha256 equals `skills.lock.json` → delivered. Any failure gives a named error and no skill text.
- **Output:** precedence header first (KSD + owner decisions outrank skill text; never merge/deploy), then type, `classifiedBy`, provenance, hash status, skill text. `mayMerge: false` and `mayDeploy: false` always.

### 6.2 Impact engine — `NEXT` (M2)

Answers "what is affected if this symbol changes?" for TS/JS workspaces.

- **Semantic authority:** the TypeScript compiler API (program + type checker, with the builder program for incremental updates), using the library's **bundled, pinned** `typescript` by default; a project can opt in to its own copy with `impact.useWorkspaceTypescript: true` (D30). It handles paths, barrels, re-exports, aliases, overloads, type-only imports and allowJs. Tree-sitter is not used.
- **Index lifecycle (D20):** an explicit initial **scan → extract → verify → publish** builds a whole-scope index before any impact answer is given; queries then read the index. Details in §6.2.1.
- **Freshness:** every query checks the working tree (tracked, modified, untracked within scope) with the two-level scheme in §6.2.1 and updates the index for changed files before answering. The session watcher (M5) is an optimisation, never the authority.
- **Traversal:** resolve target (or return guidance `ambiguous-target` / `target-not-found`) → BFS over incoming edges, depth cap 10 → attach tests → assess completeness → compute reach and factors → derive the verdict.
- **Verdict (D32):** the engine reports three separate things: **completeness** (how much of the picture is known), **reach** (how far a change travels: callers, files, packages, routes) and **factors** (why it matters). One verdict is derived from them: picture incomplete → level `unknown`; any factor → `medium`; otherwise `low`. Risk zones (M2c) can only raise it to `high` or `critical`. There is no separate engine "risk" word that could be read as a safety claim.
- **Identity (D34):** what is indexed and how symbols are keyed is fixed in `docs/adr/0002-stable-keys.md` and `docs/adr/0003-indexed-declarations.md`.
- **Scoped gaps:** each completeness gap affects only targets it can reach (parse errors affect everything in scope).
- **Contract and oracle:** `tests/golden/M2-impact-cases.md` (20 cases + 5 freshness, owner-confirmed; additions proposed in `docs/RISK.md` appendix and for bridges).
- **Tools:** `ei_status` (M2a), `ei_impact` (M2b), `ei_changes` (M2c). Contract in `docs/TOOLS.md`.

#### 6.2.1 Index lifecycle

**Why a full index, not lazy per-target queries:** completeness rules need a census of the whole scope. A parse error, a computed dynamic import or an orphan file can only be reported if every file was looked at. A full index also makes queries graph lookups, and is the base for `ei_changes`, the name cross-check and (V2) context ranking.

**Shape of the pipeline (D21):** per-file work that depends only on that file's bytes is cached; cross-file resolution is recomputed for exactly the files TypeScript reports as affected. Nothing patches individual edges in place. This is what keeps "incremental == full rebuild" true by construction instead of by bookkeeping. Background and sources: `docs/research/index-techniques.md`.

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
- Warm update: the files reported by TypeScript's builder program (`createSemanticDiagnosticsBuilderProgram`, chained from the previous program). It propagates through importers when a file's exported shape changes, and stops when it does not.
- Checked in a sandbox on TypeScript 6.0.3: a return-type change re-affected direct and transitive importers; a parameter change with unchanged downstream shape stopped at direct importers; a new file affected only itself; the first change after a cold build was treated conservatively (importers included). To be re-verified in M2 with project references and `paths`.
- **M1b correction (D43):** the builder only propagates through importers when the program does **not** set `verbatimModuleSyntax` or `isolatedModules`. With either on (oh-my-pi sets `verbatimModuleSyntax`), a signature or return-type change re-checked 1 file although it had 478 importers. The engine therefore builds its analysis program with both options forced **off** (they control emit and per-file checks, not symbol resolution), never uses `ignoreSourceFile`, and relies on the seeded randomised incremental-equals-full test and `ei doctor --deep` to catch any remaining miss.
- Config-level changes are not incremental: `tsconfig*`, `package.json`, lockfile, `ei.config.json`, TypeScript version or extractor stamp changed → full rebuild.

**Extractor stamp:** a hash of the indexing module's own built files + TypeScript version + the index-relevant config. It is part of every cache key, so changing the extractor invalidates old records without anyone remembering to bump a version.

**Freshness, two levels**

| Level | Used by | How |
|---|---|---|
| Probe | every `ei_impact` query | list the visible files (so new and deleted files are seen), one `stat` each; only files whose (size, mtime) differ from the fingerprint, or are new, are read and hashed. No change → answer immediately. Listing cost on a large repo is measured in M2a |
| Full hash | `ei index`, `ei_changes`, `ei doctor`, any rebuild | every file is read and hashed. A rebuild never trusts mtime |

The probe has a known blind spot (a same-size edit within the filesystem's mtime granularity). It is accepted for ordinary queries, never for the review gate (`ei_changes`) or a rebuild. `impact.freshness: "hash"` in config forces full hashing on every query; the freshness test cases run in that mode, and one test documents the blind spot on purpose.

The fingerprint (path → size, mtime, hash, plus extractor stamp and scope config) is a small file separate from the index records, so the probe never loads the index. Either file missing degrades safely: no fingerprint → rebuild; no records → cold build.

**When it runs**

| Trigger | What happens |
|---|---|
| `ei index` (CLI, owner) | Full scan and build. Reports progress and a scan summary |
| First query with no active index | Build starts in the worker; the call **blocks for up to 60 s, streaming progress** through the tool's update callback, and returns the real answer. Only a build that exceeds 60 s returns guidance `index-building` (D35) |
| Query, index present, probe clean | Answer from the active index |
| Query, index present, drift found | Update: re-extract changed files, re-resolve the affected set, verify, publish, then answer |
| New session, fingerprint unchanged | Load the published index from disk; no rebuild |
| New session, files changed since last publish | Load the published index; create the compiler program (3–12 s measured on oh-my-pi), then re-extract and re-resolve only the changed and affected files. TypeScript build-info persistence is **not** used (D47): writing it needs a full check (223 s on oh-my-pi) and it saves only the diagnostics pass, not program creation |
| `ei index --full` | Full rebuild on demand, ignoring caches |
| Git worktree with no index (M5) | Seed from the main checkout's published index and records, then treat the difference as ordinary drift |

**Concurrency and failure**

- One builder at a time per repo, guarded by a lock file in the cache dir. **Only the lock holder builds or updates.** Another session or sub-agent that sees drift does not start its own compiler: it waits within its budget for the holder to publish, otherwise answers from the published index marked `stale-index` with the drift list (D35).
- A failed update never breaks a query: the previous published index answers, with status `partial`, reason `stale-index`, and the list of drifted files. It is never presented as current.
- `ei doctor --deep` rebuilds from scratch and diffs against the active index; any difference is a bug report and sets the engine to `degraded`.

**Scan summary** (shown by `ei index` and `ei_status`): files scanned / indexed / orphan / unindexed, packages and tsconfigs found, extraction failures by reason, unresolved-use counts by reason, gap-site counts by code, `incompleteReasons`, per-phase durations, fingerprint, TypeScript version and extractor stamp, time of last full build. This is the owner's first look at how much of a repo the engine can actually see.

**Monorepo:** one TypeScript project per `tsconfig`, linked through `paths` and project references; edges across packages are resolved to the declaring file. Packages outside `impact.include` produce `outside-index-scope`.

**Engine host, lifetime and memory (D45, measured in M1b on oh-my-pi: 6,851 files, 2.27M lines with dependency types loaded):**

- The engine runs in a **child process**, not a worker thread. OMP runs on Bun, and Bun ignores worker `resourceLimits` (a worker allocated 512 MB under a 32 MB cap), so only a separate process can be contained and killed.
- The child runs on `node` (≥ 22.5) from `PATH` when available, else on OMP's own Bun runtime. Measured cold build: **28.5 s on Node, 83 s on Bun**, at 5–5.3 GB RSS.
- Memory: under Node the child gets `--max-old-space-size` from `impact.maxMemoryMb` (default: the smaller of 8,192 MB and half of physical RAM); under Bun, which has no such flag, the parent polls the child's RSS every second and kills it above the same limit. M1b's smallest passing heap for oh-my-pi was 6 GB (1.5, 3 and 4.6 GB failed).
- One program for the whole index scope, built from the root configuration with project references followed. Per-package sequential builds were measured **worse** (44–48 s, up to 7.9 GB), so they are only a fallback for packages whose compiler options conflict.
- The child exits after 10 minutes without a request, releasing memory; the next update pays program creation again (3–12 s). Only the lock holder runs a child (D35), so there is at most one engine process per repository.
- TypeScript is loaded by absolute path (a bare `import('typescript')` failed inside the worker in M1b).

**Measured cost.** First rows: sandbox, 2 cores, TypeScript 6.0.3, no `node_modules` (external types unresolved). Last row: M1b, macOS arm64, 10 cores, 17 GB RAM, TypeScript 5.9.3, dependencies installed.

| Codebase | Files | Lines | Create program | Resolve every identifier | Peak memory |
|---|---|---|---|---|---|
| CodeGraph `src/` | 327 | 201k | 1.9 s | 7.0 s | 0.6 GB |
| GitNexus `gitnexus/src/` | 1,130 | 388k | 2.8 s | 8.9 s | 0.8 GB |
| oh-my-pi (workspace) | 6,851 | 2.27M | full cold build 28.5 s on Node / 83 s on Bun | | 5.0–5.5 GB RSS; needs ≥ 6 GB heap |

So a large real workspace costs tens of seconds and several gigabytes on a cold build. This is why the engine is a separate, killable process, why it publishes an index that later sessions load without a compiler, and why warm updates re-resolve only affected files. The probe stays cheap: listing and stat-ing 10,502 files took 94 ms on Bun and 220 ms on Node.

### 6.3 Context packs — `PLANNED` (V2)

Selection-first: given a task, return the smallest set of files/spans the agent should read, ranked by exact symbol match, impact proximity, test adjacency, recent edits and lexical relevance, within a token budget. Returns spans plus why each was chosen. **Suggest only.** No automatic injection until an A/B in the dogfood log shows benefit.

### 6.4 Recoverable compression — `PLANNED` (V2, last)

Only for tool outputs (logs, test output, large JSON) and only if OMP's own compaction proves insufficient. Persist the exact original to CAS **before** emitting the compressed view and a retrieval handle; on any failure, pass the original through. 100% byte-exact recovery is a hard gate. Never compress source code under edit, errors the agent must act on, or secrets.

### 6.5 Anchored knowledge — `PLANNED` (V2)

Learnings are reviewable claims anchored to a symbol or file, stored in the repo at `.ksd/learnings/*.yaml` so they are versioned with the code. Source kinds are kept distinct: `owner-confirmed · code-observed · test-verified · model-inferred`. A changed or missing anchor moves a learning to `needs-review`; stale learnings are never surfaced as fact. Writes always need owner approval; nothing is auto-saved.

### 6.6 Verification evidence — `PLANNED` (V2)

Runs or reads existing tools (repo test/lint scripts, `tsc`, GitLab pipeline results, uiMatch) and returns what actually happened: command, revision, exit code, artifacts, timestamp, and `PASS · FAIL · SKIPPED · ERROR · NOT_VERIFIED`. Never infers PASS. Running commands goes through OMP's approval.

### 6.7 KSD policy module — `NEXT` (M1c, D39)

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

### 6.8 GitLab adapter — `PLANNED` (V2)

Read-only access to issues (requirements for `plan`), merge request diffs (scope for `review`/`impact`), and pipeline/job results (evidence for `verify`). Host and project from `ei.config.json`; token from env `GITLAB_TOKEN` only, never stored or logged. This is the only library code allowed network access, and only when enabled.

### 6.9 Framework routes and heuristic bridges — `PLANNED` (M4, D28)

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

### 6.10 Session file watcher — `PLANNED` (M5, D28)

An optimisation, never the authority. Inside the OMP session (no daemon), a recursive watcher on the index scope records changed paths and, after a debounce, starts the update in the worker so the next query is already fresh.

- The stat probe still runs when the watcher reports overflow or an error, at session start, and at least every 60 s of activity; `ei_changes` and rebuilds still full-hash. A watcher miss can cost time, never correctness.
- Auto-disables, with a line in `ei_status`, when the platform cannot watch reliably (for example a Windows-mounted path under WSL2, or the inotify limit is hit). Queries then use the probe as before.
- `impact.watch: false` turns it off. No watcher exists outside a running session.

### 6.11 Code search — `PLANNED` (M6, D28)

Answers "where is the code that does X?" with ranked symbols and `path:line`, for the moment the agent would otherwise grep around.

- **Lexical tier (always on, no dependency):** full-text index over symbol names (split into identifier segments), signatures and doc comments, ranked with BM25, boosted by exact-name match, export status and graph proximity to symbols named in the query.
- **Semantic tier (optional):** embeddings of declaration text from a small **local** model, stored locally and searched by brute-force cosine (adequate below roughly 100k vectors). Incremental by content hash; computed in the background worker; never blocks other tools.
  - Needs a one-time model install by the owner (`ei embeddings install`), which is the only network action and is never triggered by the agent. Without it, search is lexical only and says so.
  - The runtime library and model are an **optional** dependency chosen in M6 after measuring size, speed and licence on the owner's machine. Nothing here is decided by this document beyond "local, optional, replaceable".
- **Labels:** every hit is marked `exact`, `lexical` or `semantic`. A semantic hit is a suggestion of where to look, not evidence about behaviour; it never feeds risk or completeness.
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

Factor codes: `public-export-surface · route · cross-package · many-callers` (total ≥ `impact.manyCallers`, default 10) `· boundary:sql · boundary:native`.
Reason codes: `dynamic-import · computed-member-access · interface-dispatch · parse-error · unsupported-syntax · cjs-require · unresolved-import · unresolved-name-match · string-name-match · outside-index-scope · depth-limit · stale-index · engine-self-check-failed`.
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
  anchor: { kind: 'symbol' | 'file'; key: string; signatureHash?: string };
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
}
```

### 7.9 Tool result envelope (all OMP tools)

Every engine call ends in one of three outcomes (D24). The adapter maps them; capabilities never set `isError` themselves.

| Outcome | Meaning | OMP result |
|---|---|---|
| `result` | An answer | `{ content: [text], details: <typed result> }` |
| `guidance` | Expected, recoverable condition the agent can act on: `index-building`, `ambiguous-target` (with candidates), `target-not-found` (with nearest names) | **Success-shaped**: `{ content: [text with code + what to do next], details: { guidance: code, … } }` |
| `failure` | Real malfunction or trust failure: `index-failed`, `INVALID_INPUT`, `HASH_MISMATCH`, `PATH_ESCAPE`, `LOCK_INVALID` | `{ isError: true, content: [text: '<CODE>: <message>'] }`; malfunctions add "retry once" |

Reason: a reference project's maintainers report that one or two error results early in a session make an agent stop calling the tool family altogether. That is their observation, not our measurement, so it is applied to the impact tools (not yet built) and watched in the dogfood log. `ei_workflow` keeps its M0 behaviour (errors for unavailable skills) until the log shows a problem.

In the golden cases, C15's "error `ambiguous-target`" is the engine's `guidance` outcome with that code; the expectation (no merged result, exact candidate list) is unchanged.

The text form is for the agent; `details` is for tests and future UIs.

### 7.10 Public API (`src/index.ts`)

```ts
routeTask(req): RouteResult
prepareWorkflow(req): Promise<WorkflowPlan>
openWorkspace(root, config?): Promise<Workspace>

interface Workspace {
  index(opts?): Promise<ScanSummary>;
  impact(q): Promise<Outcome<ImpactResult[]>>;
  symbol(q): Promise<Outcome<SymbolResult>>;
  status(): Promise<WorkspaceStatus>;
  changes(q?): Promise<Outcome<ChangesResult>>;      // M2c
  search(q): Promise<Outcome<SearchResult>>;          // M6
  // V2: context(), compress(), retrieve(), learnings(), verify()
}
```

## 8. Interfaces

### 8.1 OMP tools (all `approval: 'read'`)

Full contract (inputs, registered descriptions, exact output text, budgets, guidance responses): **`docs/TOOLS.md`**.

V1 exposes four tools, one per moment the agent already recognises (D27); `ei_search` joins as a fifth in M6 (D28):

| Tool | Moment | Input | Status |
|---|---|---|---|
| `ei_workflow` | Starting a stage | `task, stage, type?, risk?` | DONE (prototype verified live; TS port M1) |
| `ei_impact` | About to change symbols | `targets[1..5], depth?` | M2b |
| `ei_changes` | Finished changing | none required (`base?`, `depth?`) | M2c |
| `ei_status` | A result looks wrong or stale | none | M2a |
| `ei_search` | Looking for where something is implemented | `query, limit?` | M6 |

Not tools in V1, CLI only: index, symbol lookup, doctor, audit, sources check. Symbol lookup is folded into `ei_impact` (an ambiguous or unknown name returns candidates). Indexing is automatic on first query and explicit for the owner through `ei index`.

Planned behind their gates (§13): `ei_context` (built on `ei_search`), `ei_verify`, `ei_learning`, `ei_gitlab`, `ei_retrieve`. Each must first show there is a moment the agent recognises and input it already has; a capability that can ride on an existing tool's output does that instead of becoming a tool.

No OMP hooks in V1. A `before_agent_start` hint ("ei tools available for this repo") is the only hook ever considered, and only with A/B evidence.

### 8.2 CLI (`ei`)

```text
ei route   --task … --stage … [--type …] [--risk high]      DONE
ei load    --task … --stage … [--type …] [--risk high]      DONE
ei sources check [--write]                                 DONE
ei init   [--force] [--dry-run]                           M2 (pre-index; landed early in #8)
ei setup   [--check]                                       M2a.1 (installs the pinned TypeScript runtime; owner-run, network once; D44)
ei index   [--full]                                        M2
ei impact  <target…> [--depth N] [--json]                  M2
ei symbol  <query>                                         M2   (CLI only)
ei status                                                  M2
ei doctor  [--deep]                                        M2
ei changes [--base REF] [--json]                           M2c
ei search  <query> [--limit N]                             M6
ei embeddings install | status | remove                    M6
ei audit   [--since 7d]                                    M2c
ei cache clear                                             M2
ei context · ei retrieve · ei learn · ei verify            V2
```

The CLI and OMP tools call the same functions and print the same text. Any behaviour difference is a bug.

## 9. Configuration

One schema, three scopes, same precedence as KSD: **session > project > global > defaults**.

| Scope | Location |
|---|---|
| Project | `<repo>/ei.config.json` (committed) |
| Global | `~/.config/ksd-intelligence/config.json` |
| Secrets | env only (`GITLAB_TOKEN`, `EI_*_ROOT`) |

```jsonc
{
  "skills":   { "enabled": true },
  "impact":   { "enabled": true, "include": ["packages/**", "apps/**"], "exclude": ["**/dist/**"],
                "routes": ["packages/api/src/routes.ts"], "maxDepth": 10,
                "freshness": "stat", "watch": true,                         // watch: M5
                "manyCallers": 10, "useWorkspaceTypescript": false,
                "maxMemoryMb": null },                                    // null = min(8192, half of RAM); D45
  "bridges":  { "B1": true, "B2": true, "B3": true, "B4": true, "B5": true, "B6": true },   // M4
  "search":   { "enabled": true, "semantic": false },                       // M6
  "riskZones": "default",                                                   // M2c; "default" = the four zones in docs/RISK.md, or a list, or []
  "context":  { "enabled": false },
  "compression": { "enabled": false },
  "knowledge":   { "enabled": false },
  "verification":{ "enabled": false },
  "gitlab":   { "enabled": false, "host": "https://gitlab.example.com", "project": "group/repo" }
}
```

Invalid config: log the error, fall back to defaults for that section, keep running. Config is never rewritten by the library.

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

### 10.2 KSD (merged)

Merged as the policy module (§6.7). The extension entry registers the KSD hooks and commands and the `ei_*` tools from one module. Cut-over: uninstall the old `engineering-proxy@engineering-proxy` plugin before or together with installing this one, so the policy is never injected twice; rollback is reinstalling the old plugin at 0.6.0. The `Krisada-M/ksd-engineering` repository is archived (not deleted) after the cut-over and its README points here.

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

Nothing the library generates is written into the repo except learnings the owner approved.

`<repo-id>` is the first 16 hex characters of the SHA-256 of the repository root's real path. `ei init` creates this directory (mode `0700`) and writes a starting `ei.config.json` from the detected layout: detected route directories become file globs, and no route is assumed when none is found. `ei cache list` shows each cache with its size and last use; caches unused for 30 days are pruned on the next `ei index`.

**SQLite (D46):** `node:sqlite` is the store. M1b verified it inside OMP (SQLite 3.54.0, FTS5, WAL) and under Node 24, so it works in either engine runtime. The sharded-JSON fallback and the SQLite entry gate are dropped. `bun:sqlite` is not used because it does not exist under Node.


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
| GitLab unreachable / no token | `NOT_VERIFIED` with reason; never cached as PASS |
| Compression store write fails | Pass the original through uncompressed |
| Skill text says "ignore policy / deploy" | No effect on flags or header order; library never executes instructions |

Hard rules: no writes outside the cache dir (and approved learnings); no network except the GitLab adapter when enabled and the owner-run `ei embeddings install`; no secrets in logs, reports or caches; no `git` write commands.

## 13. Roadmap and gates

| Order | Milestone | Deliverable | Exit gate |
|---|---|---|---|
| 1 | **M0** ✅ | TS repo, router fixed, sources lock | 56/56 tests; real 15/15 hashes; done 2026-11-09 |
| 2 | **M1** ✅ | TS adapter live in OMP; S1–S8 | S1–S6, S8 verified on 18.18.8; S7 owner check in TUI |
| 3 | **M1b** ✅ | Runtime spike, facts only | Facts in `docs/research/m1b-runtime-facts.md`; applied as D43–D47 |
| 3b | **M1c** ✅ | Merge KSD Engineering Proxy as `src/policy/` with history; one extension entry; marketplace packaging; cut-over from the old plugin (`docs/briefs/M1c-ksd-merge.md`) | KSD's 148 tests and this repo's tests all pass; policy and status snapshots byte-identical to 0.6.0; live OMP: one install, commands work, policy injected once, `ei_workflow` still works; rollback tested |
| 4 | **M2a.1** | Engine host (child process, runtime choice, memory watchdog, idle exit, lock) · TypeScript provisioning (`ei setup`) · SQLite store · scan · fingerprint and probe · `ei index` (scan only), `ei_status` (`docs/briefs/M2a-index.md`, part 1) | Scan census accounts for every fixture file; probe and lock behaviour tested; child is killed above its memory limit; status reports runtime, TypeScript and store |
| 4b | **M2a.2** | Extract-local · resolve (ADR 0002/0003, D43 options) · verify · publish · incremental update · `ei doctor --deep` (`docs/briefs/M2a-index.md`, part 2) | Randomised incremental == full passes; differential test against TypeScript find-references passes on the fixture and on oh-my-pi; cold build and one-file update measured on oh-my-pi |
| 5 | **M2b** | `ei_impact`: targets, guidance, reach, factors, base verdict, name cross-check, text per `docs/TOOLS.md` | All confirmed engine golden and freshness cases pass; rendering snapshots reviewed by owner; mutation smoke |
| 6 | **M3** | Dogfood on oh-my-pi repo + one real GitLab project (read-only clone). Starts when M2b is accepted and continues alongside later milestones | 2 weeks of `docs/dogfood-log.md`; ≥ 10 real tasks logged |
| 7 | **M4a** | Route detection B1–B2 (Next.js, Expo Router, Hono): facts from file conventions and literal paths | Routes found on a fixture app without config; `route` factor appears; no golden regression |
| 8 | **M2c** | Risk zones, `ei_changes`, audit log + `ei audit`, stage-protocol lines, skill content lint | Policy and changes golden cases pass |
| 9 | **M6a** | `ei_search`, lexical tier | Ranked hits on a fixed query set reviewed by owner |
| 10 | **M4b** | Bridges B3–B6, one complete flow at a time, each justified by dogfood-log entries | Per bridge: end-to-end fixture flow connects; bridged edges never in `byDepth` or reach |
| 11 | **M5** | Session watcher · worktree seeding | Watcher on and off give identical results on the freshness cases; seeding equals a cold build |
| 12 | **M6b** | Semantic search tier | Written comparison of local model options first; works offline after install; absent model degrades to lexical with a clear label |

Items 7 and 9–12 are in scope by owner decision D28, ahead of the dogfood gates D19 would otherwise apply. The order above is D33; dogfood results may still reorder items 7–12.

**Dogfood log entry:** task · tools called · was the answer correct (owner judges) · did it change what the agent did · latency · any false `low`. A single false `low` on a real change stops the roadmap until fixed.

**V2 entry gates (build a module only when its gate is met):**

| Module | Gate (from the dogfood log) |
|---|---|
| Context packs | ≥ 3 logged tasks where the agent read clearly irrelevant files or missed a relevant one that impact knew about |
| GitLab adapter | Real work is on GitLab MRs and copying MR/pipeline info by hand is logged as friction |
| Verification | A logged case of the agent claiming a check passed without evidence |
| Knowledge | ≥ 2 logged cases of re-explaining the same project decision to the agent |
| Compression | Measured context pressure with OMP compaction on, plus a fixture showing a safe saving |

Order if several gates pass: context → GitLab → verification → knowledge → compression.

## 14. Quality and testing

| Layer | What | When |
|---|---|---|
| Unit | Router, classifier table, loader trust chain, risk policy | every `npm test` |
| Golden | `tests/golden/M2-impact-cases.md` → tests; agent may not edit expectations | every `npm test` |
| Freshness | Temp git copies: edit, untracked, rename/delete, barrel change, incremental == full (run with `freshness: "hash"`), plus one documented blind-spot case | every `npm test` |
| Differential | For sampled declarations, every reference TypeScript's own find-references reports must be an edge in the index. Runs on the fixture in `npm test` and on real repositories in `ei doctor --deep` | every `npm test`; on demand |
| Randomised | Random sequences of edits, renames, adds and deletes on the fixture; after each, incremental index == cold build. Seeded, so a failure reproduces | every `npm test` (short run); nightly-style long run on demand |
| Live smoke | OMP scenarios S1–S7 (+ impact scenarios after M2) | after each milestone and each OMP upgrade |
| Dogfood | Real tasks, owner-judged | M3 onward |

**Performance targets (revised after M1b; recalibrate after M3):** query with a clean probe p95 < 300 ms (probe measured 94–220 ms for 10.5k files); update after a one-file body edit < 3 s once a program exists; first query in a new session with drift < 15 s (program creation measured 3–12 s); cold build of a 2M-line workspace < 60 s on Node (measured 28.5 s), with Bun accepted as slower; peak engine memory reported by `ei_status`; `ei_workflow` < 50 ms excluding file I/O.

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
| D28 | **Owner decision 2026-11-11:** bring forward, ahead of dogfood gates, six items previously deferred or not adopted: heuristic bridges across dynamic dispatch, framework route detection, built-in SQLite, session file watcher, git-worktree seeding, code search with optional local embeddings. Each is designed so it cannot weaken evidence rules (§6.9–6.11). Supersedes D19 for these items and the matching parts of D26 | 2026-11-11 |
| D29 | **M1b runtime spike** is a gate before any M2a code (review B-1, B-3) | 2026-11-11 |
| D30 | `typescript` is a runtime dependency: pinned, never taken from the analysed repo by default; a project's own copy only by explicit opt-in. Engine isolated with time and memory budgets (RISK R5 as amended, R6). **Delivery and isolation revised by D44 and D45** | 2026-11-11 |
| D31 | Program lifetime: sequential builds, two projects kept (**superseded by D45**: one program, child process, idle exit) | 2026-11-11 |
| D32 | No engine "risk" word. Results carry completeness, reach and factors; one derived verdict (level + action). New factors `cross-package`, `many-callers` | 2026-11-11 |
| D33 | Milestone order: M1 → M1b → M1c (D39) → M2a → M2b → M3 starts → M4a → M2c → M6a → M4b → M5 → M6b | 2026-11-11 |
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

Each decision gets a short ADR in `docs/adr/` when the milestone that depends on it starts. Changing a decision needs a new ADR that supersedes the old one.

## 16. Open questions

1. Answered by M1c: default-branch head, versioned by the catalog (§10.1).
7. Follow-ups from M1c, folded into the M2a brief: (a) KSD's TypeScript sources in `src/policy/src/` are excluded from this repo's build and its committed runtime ships as is; add a drift check that rebuilds them with KSD's pinned compiler (5.8.3) and compares, so an edit to the sources cannot silently diverge from what runs; (b) slash commands produce no output under `omp -p`, so `/engineering-proxy status` and the `🛡 KSD` segment are verified by the owner in the TUI after cut-over.
2. Answered by M1b (D43–D47). Still open from it: progress visibility in the interactive TUI, Bun runs above 1.5 GB, the exact memory floor between 4.6 and 6 GB for oh-my-pi, TypeScript 6/7 behaviour (oh-my-pi itself ships 7.x).
3. Which real GitLab project to clone read-only for M3 dogfooding.
4. Whether GitNexus is active for repos the owner works in; if so, how its answers compare on the same M3 tasks.
5. Upstream skill content review: the owner reads the 15 pinned SKILL.md files once and re-reads diffs on each update.
6. Whether 10 is the right `manyCallers` threshold, and 4,000 characters the right per-target budget (dogfood log).
