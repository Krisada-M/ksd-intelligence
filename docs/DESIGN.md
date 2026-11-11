# ksd-intelligence — Final Design

> **Status:** authoritative design, 2026-11-10; index lifecycle, tool surface and scope revised 2026-11-11 (D20–D28); senior-review decisions applied the same day (D29–D37). Supersedes the architecture sections of `docs/reference/knowledge-export.md` (which remains historical background).
> **Owner/user:** one person, personal non-commercial use.
> **Host:** Oh My Pi (OMP) 18.18.2 on WSL2. Node >= 20 (owner runs v24). Owner shell: fish.
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
4. **OMP stays in charge** of models, permissions, sessions and approvals. KSD stays in charge of style and policy.
5. **Fail open for advice, fail closed for trust.** A broken index never breaks a session. A tampered skill is never delivered.
6. **Add a module only on evidence.** Each V2 module has an entry gate (§13). If it does not pass, the module is not built. Exception: the six V1.5 items the owner brought forward (D28).
7. **Small and boring.** TypeScript, no servers, no daemons, no always-on hooks. Runtime dependencies only when justified and approved: `typescript` (impact engine) and an optional local embedding runtime (M6) are the anticipated ones.

## 3. System context

```text
                ┌──────────────────────────── owner's machine (WSL2) ────────────────────────────┐
                │                                                                                │
  owner ──────▶ │  OMP 18.18.2  ──tools──▶  ksd-intelligence (extension, in-process)              │
                │    │  ▲                       │        │            │            │             │
                │    │  └── tool results ───────┘        │            │            │             │
                │    │                                   ▼            ▼            ▼             │
                │    ├── KSD Engineering Proxy    ~/ei-skill-sources  workspace    cache dir      │
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
| KSD Engineering Proxy | Separate plugin, unchanged | Never duplicate its injection or mutate its config. Read its mode only (§10.2) |
| Skill sources (Matt, poteto/pstack, Osmani) | Instruction text | Loaded from pinned checkouts with sha256 lock. Never bundled, never executed |
| GitNexus | Possibly installed (`.gitnexus/` seen) | Not a dependency. Used only as a comparison baseline in M3 |
| GitLab | Where real projects live | PLANNED read-only adapter, after M3 |
| uiMatch (`Krisada-M/visual-qa`) | Owner's visual QA tool | PLANNED optional verification adapter |

## 4. Scope

| Tier | Contents |
|---|---|
| **V1** (M0–M3) | Skill workflow router · codebase scan + whole-scope index · TS/JS impact engine · OMP adapter · CLI · golden + freshness tests · dogfood log |
| **V1.5** (M4–M6, owner-directed, D28) | Framework route detection · heuristic bridges across dynamic dispatch · built-in SQLite store · session file watcher · git-worktree seeding · code search (lexical, optional local embeddings) |
| **V2** (each gated, §13) | Context packs (built on search) · KSD mode bridge · GitLab adapter · verification adapters · anchored learnings · recoverable compression |
| **NEVER** | New agent runtime or model router · always-on proxy · graph DB server · external vector DB or embedding service · auto-merge/deploy · auto-promoting model guesses to knowledge · replacing KSD · running skill scripts |

## 5. Architecture

### 5.1 Layers and dependency rule

```text
  adapters/        omp · cli · (gitlab · uimatch · runners)        ← entry points, no business logic
      │
  capabilities/    workflow · impact · bridges · search · watch · (context · compression · knowledge · verification · policy-bridge)
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
│   ├── policy-bridge/     ksd-mode.ts                                                  (V2)
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
| New session, files changed since last publish | Reuse cached EXTRACT-LOCAL records; RESOLVE needs a program. M2 evaluates persisting TypeScript's build info to avoid a full RESOLVE; until proven, this case is a cold RESOLVE and its duration is reported |
| `ei index --full` | Full rebuild on demand, ignoring caches |
| Git worktree with no index (M5) | Seed from the main checkout's published index and records, then treat the difference as ordinary drift |

**Concurrency and failure**

- One builder at a time per repo, guarded by a lock file in the cache dir. **Only the lock holder builds or updates.** Another session or sub-agent that sees drift does not start its own compiler: it waits within its budget for the holder to publish, otherwise answers from the published index marked `stale-index` with the drift list (D35).
- A failed update never breaks a query: the previous published index answers, with status `partial`, reason `stale-index`, and the list of drifted files. It is never presented as current.
- `ei doctor --deep` rebuilds from scratch and diffs against the active index; any difference is a bug report and sets the engine to `degraded`.

**Scan summary** (shown by `ei index` and `ei_status`): files scanned / indexed / orphan / unindexed, packages and tsconfigs found, extraction failures by reason, unresolved-use counts by reason, gap-site counts by code, `incompleteReasons`, per-phase durations, fingerprint, TypeScript version and extractor stamp, time of last full build. This is the owner's first look at how much of a repo the engine can actually see.

**Monorepo:** one TypeScript project per `tsconfig`, linked through `paths` and project references; edges across packages are resolved to the declaring file. Packages outside `impact.include` produce `outside-index-scope`.

**Program lifetime and memory (D31, provisional until M1b measures a real project with `node_modules`):** projects are built one at a time in dependency order; after publishing, compiler state is kept only for projects touched in this session, at most two at once (least recently used is released). The worker's memory cap is set from the M1b measurement, not from the sandbox numbers below. Editing a global declaration file re-affects every file in that project; that is expected, not a fault.

**Measured cost (sandbox, 2 cores, TypeScript 6.0.3, no `node_modules` so external types were unresolved; real projects will be heavier):**

| Codebase | Files | Lines | Create program | Resolve every identifier | Peak memory |
|---|---|---|---|---|---|
| CodeGraph `src/` | 327 | 201k | 1.9 s | 7.0 s | 0.6 GB |
| GitNexus `gitnexus/src/` | 1,130 | 388k | 2.8 s | 8.9 s | 0.8 GB |

So a cold build is on the order of 10 s per few hundred thousand lines and needs most of a gigabyte. This is why the engine runs in a worker, why warm updates and cross-session reuse matter, and why targets in §14 were revised.

### 6.3 Context packs — `PLANNED` (V2)

Selection-first: given a task, return the smallest set of files/spans the agent should read, ranked by exact symbol match, impact proximity, test adjacency, recent edits and lexical relevance, within a token budget. Returns spans plus why each was chosen. **Suggest only.** No automatic injection until an A/B in the dogfood log shows benefit.

### 6.4 Recoverable compression — `PLANNED` (V2, last)

Only for tool outputs (logs, test output, large JSON) and only if OMP's own compaction proves insufficient. Persist the exact original to CAS **before** emitting the compressed view and a retrieval handle; on any failure, pass the original through. 100% byte-exact recovery is a hard gate. Never compress source code under edit, errors the agent must act on, or secrets.

### 6.5 Anchored knowledge — `PLANNED` (V2)

Learnings are reviewable claims anchored to a symbol or file, stored in the repo at `.ksd/learnings/*.yaml` so they are versioned with the code. Source kinds are kept distinct: `owner-confirmed · code-observed · test-verified · model-inferred`. A changed or missing anchor moves a learning to `needs-review`; stale learnings are never surfaced as fact. Writes always need owner approval; nothing is auto-saved.

### 6.6 Verification evidence — `PLANNED` (V2)

Runs or reads existing tools (repo test/lint scripts, `tsc`, GitLab pipeline results, uiMatch) and returns what actually happened: command, revision, exit code, artifacts, timestamp, and `PASS · FAIL · SKIPPED · ERROR · NOT_VERIFIED`. Never infers PASS. Running commands goes through OMP's approval.

### 6.7 KSD mode bridge — `PLANNED` (V2)

Reads KSD's effective mode (`balanced`/`adaptive`) from its documented config precedence (session > project `.engineering-proxy.json` > global `~/.omp/agent/engineering-proxy.json` > default). Read-only. Used as an input to workflow risk and verification strictness. If KSD is absent or its config is invalid, it reports `unknown` and the library continues.

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
                "manyCallers": 10, "useWorkspaceTypescript": false },
  "bridges":  { "B1": true, "B2": true, "B3": true, "B4": true, "B5": true, "B6": true },   // M4
  "search":   { "enabled": true, "semantic": false },                       // M6
  "riskZones": "default",                                                   // M2c; "default" = the four zones in docs/RISK.md, or a list, or []
  "context":  { "enabled": false },
  "compression": { "enabled": false },
  "knowledge":   { "enabled": false },
  "verification":{ "enabled": false },
  "ksdBridge":   { "enabled": false },
  "gitlab":   { "enabled": false, "host": "https://gitlab.example.com", "project": "group/repo" }
}
```

Invalid config: log the error, fall back to defaults for that section, keep running. Config is never rewritten by the library.

## 10. Integrations

### 10.1 OMP

Verified on 2026-11-09 (prototype, OMP 18.18.2): load via `omp --extension <file>`; register with `pi.registerTool({ name, label, approval: 'read', description, parameters: pi.zod…, execute })`; the agent discovers and calls the tool unprompted. Documented `execute(toolCallId, params, signal, onUpdate, ctx)`; the library uses the first three. Persistent loading method: recorded in M1. Re-run the M1 smoke after every OMP upgrade.

### 10.2 KSD

Coexists unchanged. The library never injects per-turn policy, never edits `.engineering-proxy.json`, never touches the KSD status indicator. Precedence header in workflow output defers to KSD. V2 bridge reads mode only.

### 10.3 Skill sources

`~/ei-skill-sources/{matt, cursor-plugins, osmani}`; env `EI_MATT_ROOT`, `EI_POTETO_ROOT` (= cursor-plugins repo root; `rootSubpath: pstack/skills`), `EI_OSMANI_ROOT`. Pinned commits: matt `4ae2317d`, cursor/plugins `6b030021`, osmani `301b02b1`. Updating a source: pull → read the changed SKILL.md diffs → `ei sources check --write` → commit the lock.

## 11. Storage

| Data | First implementation | Later | Regenerable? |
|---|---|---|---|
| Skill text | read from checkouts each call | same | yes (from pinned checkout) |
| Index / graph | whole-scope index in `~/.cache/ksd-intelligence/<repo-id>/`: a small fingerprint file, per-file local records (keyed by content hash + extractor stamp), resolved edges and unresolved records, as sharded JSON loaded into memory; staged and published atomically | SQLite (WAL, migrations) in the same dir, behind the same storage interface | yes; `ei index --full` or delete dir |
| Compression originals | n/a | CAS files `<sha256>` in the same dir; retained while referenced | **no**; never evict a referenced object |
| Learnings | n/a | `.ksd/learnings/*.yaml` in the repo | **no**; versioned with code |
| Verification reports | n/a | cache dir, last N per check | yes |

Nothing the library generates is written into the repo except learnings the owner approved.

`<repo-id>` is the first 16 hex characters of the SHA-256 of the repository root's real path. `ei cache list` shows each cache with its size and last use; caches unused for 30 days are pruned on the next `ei index`.

**SQLite (D28, moved into M2a):** the runtime's built-in SQLite module becomes the primary store for index records, the full-text index and (M6) vectors, behind the storage interface, once M2a confirms which runtime OMP runs extensions in and that its built-in SQLite (with FTS5) is available. If it is not, the sharded-JSON store stays and search uses an in-memory inverted index. No third-party database package either way.

**Original SQLite entry gate (superseded by D28):** loading the persisted index of the dogfood repo takes > 2 s, incremental writes become a bottleneck, or a query needs something the in-memory graph cannot answer. Candidate with no new dependency: the runtime's built-in SQLite module (a reference project uses Node's as its only backend, with FTS5), to be verified on OMP's runtime before it is chosen.

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
| 2 | **M1** | TS adapter live in OMP; S1–S8 | All scenarios observed in OMP 18.18.2; persistence method documented |
| 3 | **M1b** | Runtime spike, facts only (`docs/briefs/M1b-runtime-spike.md`): runtime identity, worker threads, `typescript` loading, built-in SQLite + FTS5, memory on a real project with `node_modules`, update-callback streaming | One page of measured facts; §6.2.1 and §11 adjusted once from them. **No M2a code before this** |
| 4 | **M2a** | Scan · fingerprint · extract-local · resolve · verify · publish · store · `ei index`, `ei_status` | Scan census accounts for every fixture file; **randomised incremental == full** passes; **differential test** against TypeScript find-references passes on the fixture and one real repo; probe listing cost measured |
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
| KSD bridge | A logged case where skill choice or strictness should have differed by KSD mode |
| GitLab adapter | Real work is on GitLab MRs and copying MR/pipeline info by hand is logged as friction |
| Verification | A logged case of the agent claiming a check passed without evidence |
| Knowledge | ≥ 2 logged cases of re-explaining the same project decision to the agent |
| Compression | Measured context pressure with OMP compaction on, plus a fixture showing a safe saving |

Order if several gates pass: context → GitLab → verification → KSD bridge → knowledge → compression.

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

**Performance targets (proposed; recalibrate after M3):** query with a clean probe p95 < 300 ms; update after a one-file edit < 3 s; cold build < 15 s per 300k lines (sandbox measurement: about 10 s, §6.2.1); loading a published index in a new session < 2 s; `ei_workflow` < 50 ms excluding file I/O. A missed target is logged, not hidden; correctness is never traded for it.

## 15. Decision log

| ID | Decision | Date |
|---|---|---|
| D01 | One owned TS package; OMP primary host + CLI; MCP deferred indefinitely | 2026-11-08 |
| D02 | Personal non-commercial use; keep `PROVENANCE.md`; no full license matrix/SBOM | 2026-11-08 |
| D03 | Repo name `ksd-intelligence`; tool prefix `ei_`; CLI `ei` | 2026-11-09 |
| D04 | KSD stays a separate plugin; V2 read-only mode bridge only | 2026-11-09 |
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
| D15 | All tools read-only; no OMP hooks or context injection | 2026-11-10 |
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
| D30 | `typescript` is a runtime dependency: bundled and pinned by default; a project's own copy only by explicit opt-in. Engine runs in a worker with time and memory budgets (RISK R5 as amended, R6) | 2026-11-11 |
| D31 | Program lifetime: sequential builds, compiler state kept for at most two recently touched projects; cap set from M1b (provisional) | 2026-11-11 |
| D32 | No engine "risk" word. Results carry completeness, reach and factors; one derived verdict (level + action). New factors `cross-package`, `many-callers` | 2026-11-11 |
| D33 | Milestone order: M1 → M1b → M2a → M2b → M3 starts → M4a → M2c → M6a → M4b → M5 → M6b | 2026-11-11 |
| D34 | Stable key grammar and the set of indexed declarations and uses fixed by ADR 0002 and 0003 | 2026-11-11 |
| D35 | First call blocks up to 60 s with streamed progress; only the lock holder builds, other sessions read the published index | 2026-11-11 |
| D36 | Acceptance adds a differential test against TypeScript find-references and a seeded randomised incremental-equals-full test | 2026-11-11 |
| D37 | `docs/RISK.md` R1–R9 confirmed (R5 amended by D30); name cross-check is part of engine correctness (M2b). Golden file contract refreshed to match | 2026-11-11 |

Each decision gets a short ADR in `docs/adr/` when the milestone that depends on it starts. Changing a decision needs a new ADR that supersedes the old one.

## 16. Open questions

1. How OMP 18.18.2 loads an extension persistently (M1 answers).
2. Runtime facts and real-project memory (M1b answers; D31 is provisional until then).
3. Which real GitLab project to clone read-only for M3 dogfooding.
4. Whether GitNexus is active for repos the owner works in; if so, how its answers compare on the same M3 tasks.
5. Upstream skill content review: the owner reads the 15 pinned SKILL.md files once and re-reads diffs on each update.
6. Whether 10 is the right `manyCallers` threshold, and 4,000 characters the right per-target budget (dogfood log).
