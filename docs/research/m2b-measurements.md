# M2b measurements

## Round 1 — Step 1: index additions

### 1. Golden data audit (before any code change)

Method: every case C01–C26 and F01–F06 checked against the index built by `origin/main` (`2e15bbf`, extractor of M2a.3) on the base fixture, and, for the cases that add files, on a fixture copy with exactly the files the case names (`.tmp-m2b/golden-probe.mjs`, throwaway, not committed). "Held" means a row in the published index answers it; "derivable" means a query can compute it from held rows plus the loaded `ei.config.json`, without reading source files or creating a program.

| Case | Data the case needs | Held by the index today | If not held: derivable at query time? | Round 1 action |
|---|---|---|---|---|
| C01 | `service.ts#PaymentService.charge` CALLS `calculateFee`; gap sites for completeness; factors `public-export-surface`, `route`, `cross-package` | edges, gap sites, `files.package` yes. Route: no row needed. Package privacy and package entry: **no** (the census holds `package.json` paths and hashes, not their content) | route: yes (`impact.routes` globs over `declarations.file`); privacy/entry: **no** | add package metadata (1.2) |
| C02 | `charge.ts#chargeHandler` CALLS `calculateFee` through the `@fx/payments` barrel | yes (`chargeHandler → fee.ts#calculateFee CALLS [5]`) | — | none |
| C03 | `checkout.ts#submit` CALLS `calculateFee`; no declaration `fee` | yes; import specifiers are not declarations | — | none |
| C04 | `calculateFee` CALLS `roundMoney` via `@fx/shared/money`; depth 2 by traversal; factors as C01 | edges yes; privacy no | as C01 | as C01 |
| C05 | `chargeHandler` CALLS `PaymentService.charge`; `chargeHandler` CONSTRUCTS `PaymentService` | yes | — | none |
| C06 | `StripeProcessor.charge` IMPLEMENTS `PaymentProcessor.charge`; `runCheckout` CALLS `PaymentProcessor.charge`; `interface-dispatch` gap `checkout-flow.ts:5` | yes | heuristic node: yes (IMPLEMENTS edge, then the interface member's callers) | none |
| C07 | `normalizeAll` REFERENCES `roundMoney` | yes | — | none |
| C08 | one key; overload spans `7-7`, `8-8` | yes (`other_spans`) | — | none |
| C09 | `submit` REFERENCES `Fee`; `Fee` exported from the payments entry | edges and `exports` (barrel re-export) yes; privacy no | as C01 | as C01 |
| C10 | `lazyFee` CALLS `calculateFee`; no gap at the literal import | yes; no gap row at `checkout-flow.ts:13` | — | none |
| C11 | `dynamic-import` gap scoped by its static prefix | yes (`handlers.ts:4`, detail `packages/api/src/handlers/`) | prefix match: yes | none |
| C12 | `routes.POST /charge` and `registry.charge` REFERENCES `chargeHandler`; `computed-member-access` gap on `registry` | yes (`handlers.ts:10`, detail `handlers.ts#registry`) | route: yes | none |
| C13 | zero incoming edges; `unusedHelper` exported by the public entry | edges, `exports` yes; privacy no | as C01 | as C01 |
| C14 | `localOnly`: zero users, not exported | data held, but the fixture has an incoming edge: `fee.ts#<module> REFERENCES localOnly [20]` (`void localOnly;`) | the stored reference conflicts with `byDepth: []`; an extractor change would discard a real reference | none; owner question, no filtering rule adopted |
| C15 | candidates for bare `charge` | five declarations have simple name `charge`: four methods plus `handlers.ts#registry.charge` (ADR 0003 indexes it; the M2a test pins all five) | the expected four conflict with the stored declarations; no missing extractor data | none; owner question, no candidate-hiding rule adopted |
| C16 | `parse-error` gap; callers still present | yes on the copy: `broken.ts:2 parse-error`; the five callers of `calculateFee` unchanged | — | none |
| C17 | `cjs-require` gap `fee.ts:3` on `legacy.cjs` and `unresolved-name-match toCents fee.ts:12` | yes | — | none; expected outcome **B** |
| C18 | `report.js#report` CALLS `roundMoney` | yes | — | none |
| C19 | `a`↔`b` CALLS; neither reachable from the payments entry | edges and `exports` yes (the barrel does not re-export the cycle files) | entry check needs privacy/entry | as C01 |
| C20 | `fee.test.ts` reaches `calculateFee` | TESTS edge `fee.test.ts#<module> → fee.ts#<module>` and CALLS from `fee.test.ts#<module>` yes | test-file rule (`isTestFile` on the path): yes | none |
| C21 | `Pay` REFERENCES `Button`, strength compiler | yes on the copy (`Pay.tsx#Pay REFERENCES [4]`; the fixture sets no `jsx` option, which is a semantic diagnostic only, no parse error) | — | none |
| C22 | `unresolved-name-match` for `obj.localOnly()` in `loose.js` | yes on the copy (`loose.js:2`) | — | none |
| C23 | string token `unusedHelper` | yes on the copy (`name_tokens names.ts unusedHelper [1]`) | — | none |
| C24 | `db.ts` imports `pg` | yes on the copy (`external_imports db.ts pg 1`, kept though `pg` is not installed) | `boundary:sql` by specifier: yes. Golden P2 points to the detection defaults of `docs/RISK.md` §3.2, which also name a `sql` tagged template and `NativeModules`/`TurboModuleRegistry` imported from `react-native`: **not held** (external imports keep the specifier, not the imported names; tagged templates are not recorded); `android/`, `ios/` paths: derivable | add boundary markers (1.2) |
| C25 | `page.tsx#default` CALLS `calculateFee`; `impact.routes` from config | yes on the copy (the config change makes it a cold build) | route glob: yes | none |
| C26 | 9 then 10 CALLS edges into `tiny`; `impact.manyCallers` | yes on the copy | — | none |
| F01 | new caller at depth 1; `freshness.workingTreeHash` differs | edge yes (M2a test F01). No hash is stored | yes: hash of the `files` rows (path, content hash) | none |
| F02 | untracked file indexed; `includesUntracked` | yes; the census lists `git ls-files --cached --others --exclude-standard` | yes: true by construction of the census | none |
| F03 | no stale edges after rename and delete | yes (M2a test F03) | — | none |
| F04 | `unresolved-import` records at the barrel import sites | yes (`charge.ts:1 calculateFee`, `checkout.ts:1`, `checkout.ts:2`; M2a test F04) | scoping by imported name: yes | none |
| F05 | incremental == cold | yes (M2a tests, randomised run) | — | none |
| F06 | stat blind spot, then `ei index` | yes (M2a test F06) | — | none |

Rows that cannot be derived, and so change the index in Round 1:

1. **Package privacy and entries** (C01, C04, C09, C13, C19; golden P2 `public-export-surface`): which workspace packages are not `"private": true` and which indexed files their `package.json` entry fields point to.
2. **Boundary markers** (C24 via golden P2 and `docs/RISK.md` §3.2): `sql` tagged templates and `NativeModules`/`TurboModuleRegistry` imports from `react-native`.
3. **1.1 key access through `keyof`** (D52), not a golden case, required by the brief.

Observations for Step 2 (not acted on in Round 1):

- **C14** and **C15** have the mismatches named in the table. These are evidence for owner review, not permission to suppress references or candidates. No query test or golden expectation was changed.
- **C01, C02, C04, C05 vs brief §2.2.** The brief counts "a gap that applies to the target or to any impacted symbol". Golden P4 scopes `computed-member-access` to "values stored in the accessed object": `registry.charge` stores `chargeHandler`, and C12 expects `partial` for that reason. `chargeHandler` is a depth-1 caller of `calculateFee` (C01/C02), a depth-2 user of `roundMoney` (C04) and a depth-1 caller of `PaymentService.charge` and `PaymentService` (C05). Applying that scope throughout the caller chain would make those expected `complete`/`medium` cases `partial`/`unknown`. No query verdict was computed in Round 1; the oracle and the stored references remain untouched.

### 2. Implemented index additions

Model: `openai-codex/gpt-6.1-sol`. Runtime: Linux WSL2 x86_64, Node `24.21.0`, TypeScript `5.9.3`. `omp --version` reported `18.20.0`; no live OMP compatibility claim is made in Round 1.

- `src/core/indexing/keys.ts` and the resolver record `REFERENCES` for literal keys resolving to one indexed declaration; ambiguous or non-literal keys record owner-scoped `computed-member-access` gaps. Anonymous member owners fall back to their nearest indexed parent. Mapped `Record` keys without declarations record neither an edge nor a gap.
- The resolver rejects ordinary `string` parameters, including `keyof Usage | string` (which TypeScript reduces to `string`). That negative control was observed failing with a false `Usage.cost` edge before the guard was added.
- Generic call constraints are read from the signature declaration: inference otherwise turns `K extends keyof Usage` into just `"cost"`. Generic owner arguments, key arrays, generic aliases and instantiated class receivers are covered by fixture-copy regressions.
- A resolved key union's `origin` is an internal TypeScript field. This use is isolated and documented in `keys.ts`; the pinned `5.9.3` compiler is verified here. Other compiler versions are **NOT VERIFIED**.
- `meta.packages` stores package directory/name, privacy, exact indexed entry paths and unresolved entry values (including conditional exports and wildcards). Missing build output is **not** guessed back to source. This data is computed at indexing time, not by reading manifests during a future query.
- Schema **3** adds `markers(file, line, kind)` for tagged SQL and named native bindings, including aliases. Bare database imports already live in `external_imports`; route/test markers and native directory factors remain derivable from paths. Markers participate in deletion, verification, canonical equality and table-count accounting.

No changes to the golden file, base fixture, policy module, OMP adapter, CLI, graph traversal or verdict logic. No dependency or package-version changes. No query core, tool, snapshots, risk zones or audit log were implemented.

### 3. Local checks

`node_modules` package versions were compared to every non-link entry in `package-lock.json`: **VERIFIED**, all matched; no `npm ci` was needed.

The new tests were also executed against the preserved pre-change compiled indexer: 12 tests, 2 passed, 10 failed (missing key edges/gaps and missing metadata). Additional regressions were observed failing before their fixes: generic aliases/key arrays, anonymous members, a string-superset false edge, a computed key expression, and an anonymous nested owner. All pass on the final implementation.

```text
npm test
ℹ tests 445
ℹ suites 26
ℹ pass 445
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0

npm run typecheck
exit 0

npm run lint
exit 0
```

These are **VERIFIED** on Linux. The first lint attempt found an unused import in a throwaway probe under `.tmp-m2b/`; the probes were moved out of the repository and lint then passed.

`npm test` includes the four seeded randomised incremental-equals-cold runs (12 steps each, including tight-memory and fresh-Indexer runs), `update-soundness`, F01–F06 at index level, and the exact fixture differential. **No differential expected count changed:** 31 declarations, 48 references, 48 covered by edges, 0 covered only by records, 0 misses. The new cases use copies, not edits to the base fixture. `tests/core/status.test.ts` changes only the asserted schema version from 2 to 3.

### 4. Mutation smoke

**VERIFIED: 49/49 killed; 0 survived; no timeout.** Command:

```sh
node /tmp/m2b/extend-smoke.mjs
bash /tmp/m2b/mutate-round1.sh "$PWD"
```

This extends the existing M2a `mutate6.sh` campaign (39 mutants) with ten Round 1 mutants. It changes only the ignored compiled test tree and restores each file after the run.

| Mutant | Break | Observed result |
|---|---|---|
| K01 | drop literal keyof property edges | 8 failed tests |
| K02 | drop owner-scoped keyof gaps | 6 failed tests |
| K03 | choose the first property for an ambiguous key | 1 failed test |
| K04 | treat `keyof Usage \| string` as property access | 1 failed test |
| K05 | record an owner gap for a mapped `Record` key without a declaration | 1 failed test |
| K06 | omit generic owner instantiation from the object argument | 1 failed test |
| K07 | ignore a computed key expression | 1 failed test |
| K08 | lose the indexed parent of an anonymous owner | 1 failed test |
| B01 | omit marker writes while claiming their produced count | VERIFY fails in setup; all four metadata tests cancelled, suite exit 1 |
| B02 | discard package privacy | 1 failed test |

The final campaign ends with `not killed: 0`, exit 0. B01 is killed by the real indexer's produced/read-back invariant, not by a syntax error. The other 39 mutants were all killed by the existing M2a tests.

### 5. Final oh-my-pi measurements and stop gate

Corpus: oh-my-pi commit `04cd1a7549a02d62ad1d24826198d52507595683`, installed dependencies, 10,502 visible files, 6,761 indexed files. The pre-change published index's extractor stamp matched the baseline build (`55fdcca6d6368592`); it was copied before replacement. Delta counts compare that index with the final cold build on the same tree. No corpus source was edited.

Exact commands:

```sh
/usr/bin/time -f 'wall=%e maxrss_kb=%M exit=%x' \
  -o /tmp/m2b/real/cold.time \
  node dist/adapters/cli/main.js index \
  --root /var/tmp/m2a2/omp-src --full --json \
  > /tmp/m2b/real/cold.json 2> /tmp/m2b/real/cold.err

node /tmp/m2b/count-keyof.mjs \
  "$HOME/.cache/ksd-intelligence/6245da6948cefc28/index.sqlite"

/usr/bin/time -f 'wall=%e maxrss_kb=%M exit=%x' \
  -o /tmp/m2b/real/doctor.time \
  node dist/adapters/cli/main.js doctor --deep \
  --root /var/tmp/m2a2/omp-src --differential 300 --json \
  > /tmp/m2b/real/doctor.json 2> /tmp/m2b/real/doctor.err
```

| Final command | Wall (s) | Max RSS (KiB) | Outcome |
|---|---:|---:|---|
| cold build | 148.36 | 7,621,872 | exit 0; no VERIFY problems |
| deep doctor, 300-declaration differential | 220.16 | 8,086,668 | exit 0; no drift; 0 graph or counter differences |

```text
differences.count: 0
counterDifferences.count: 0
differential.declarations: 300
differential.references: 7640
differential.covered: 7640
differential.coveredBy: edge 7640, exportStatus 0, recordOnly 0
differential.misses: []
```

Differential exclusions are unchanged: 301 definitions, 785 related declaration names, 834 unindexed properties, 3 unindexed methods, 9 shorthand-value uses, 2 declaration-less mapped keys, 4 mapped-property accesses; 13 documentation-only references.

| Keyof addition / scope | Count | Share of non-module declarations |
|---|---:|---:|
| non-module declarations (unchanged) | 156,421 | 100% |
| new REFERENCES edges | 2,547 | — |
| removed edges | 0 | — |
| new use-site lines across edge records | 6,180 | — |
| new computed-member-access gap sites | 233 | — |
| distinct indexed gap owners | 42 | — |
| indexed members beneath those owners | 1,350 | — |
| owners plus their indexed members | 1,392 | 0.89% |
| conservative outgoing closure through depth 10 | 26,003 | 16.62% |

**Counting method:** new gap rows are identified by `(file, line, code, detail, source)` against the baseline, not just a change in total counts. Direct scope is the owner key and declaration keys beneath its qualified-name prefix. The larger count follows outgoing symbol edges from that scope for up to ten hops, excluding `IMPORTS` and `TESTS`: a target reached this way has one of those gap-scoped declarations in its incoming impact traversal. This is a **VERIFIED structural count**, but a **projection** of future completeness, not a query verdict: Round 2 does not exist yet, and other existing gaps may already make some of these declarations partial.

**STOP GATE: exceeded under the conservative full-traversal reading.** Direct scope is below 5%, but projected propagated scope is 16.62%. No narrowing or tuning was applied to make this pass. The owner must decide the intended scope before continuing to Round 2.

An earlier measurement, before the computed-expression and nearest-parent fixes, projected 3.03%. The final broader count above supersedes it. Both cold builds and both doctors exited 0. The cold builds overlapped mutation checks; these are correctness measurements, not isolated performance benchmarks.

The corpus produced no SQL/native syntax marker rows. Their positive and deletion cases are verified by the separate fixture-copy tests.

### 6. Scope, limits and owner questions

- **Round 1 only.** No Round 2/3 work started. `tests/golden/**`, the base fixture, `src/policy/**` and `tests/policy/**` are unchanged.
- **Owner questions:** review the propagated 16.62% gap scope before proceeding; resolve the C14/C15 data/expectation mismatches and the C01/C02/C04/C05 transitive-gap interpretation recorded in the audit. No expectation was changed, hidden, weakened or skipped.
- **NOT VERIFIED:** macOS, CI (requires owner push), query-level golden verdicts, live OMP calls, rendering, query latency and independent cross-vendor review. These are not Round 1 claims.
- `AGENTS.md` was clean; no injected block needed restoration. A pre-existing, untracked and locally ignored GitNexus `CLAUDE.md` was left untouched. No `.ignore` appeared.
- Branch `m2b-impact` was created from fetched `origin/main`; it was later observed at `2e15bbf` when the new round prompts appeared. No commit to `main`, push, merge, tag, deployment, dependency change or OMP installation/configuration change was performed.

### 7. Requested generic-owner fix

Model: `openai-codex/gpt-6.1-sol`. Scope stays within Round 1.

The explicit-type-argument investigation found six valid TypeScript cases with missing or wrong property edges: a type-only generic function call, an explicit base type paired with a subtype value argument, a constrained generic instantiated with a subtype, an omitted default type, a generic constructor, and a generic method. The index's structural VERIFY passed despite these semantic errors. TypeScript 5.9.3 `findReferences` did not return the key-literal call sites, so the differential alone could not detect the defect. The retained name tokens are not a substitute for the missing compiler-grade edges.

`KeyAccess.instantiate` now matches explicit type arguments to their declaring type parameter before attempting value-argument inference. Constructor arguments bind the class's type parameters; a generic method's arguments do not bind unrelated receiver-class parameters. If inference supplies no binding, defaults are resolved, including defaults that name an earlier type parameter. A visited set prevents recursive defaults from looping on invalid input. Receiver-based inference and the existing constraint fallback remain after the applicable bindings.

Permanent regressions are in `tests/core/key-generics.test.ts`. The first eleven cases were run before the fix: **2 passed, 9 failed**. All six reported defects are represented. Three additional branch controls prevent a default from masking ignored constructor arguments, a later type parameter from incorrectly taking argument zero, and method arguments from leaking into receiver-class bindings.

```text
npm test
ℹ tests 459
ℹ suites 27
ℹ pass 459
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

**VERIFIED:** all fourteen generic-owner cases and the full suite pass. No assertion, golden expectation, base fixture or gap-scope rule was weakened to obtain this result.

Fix mutation smoke: **VERIFIED, 55/55 killed, 0 survived, no timeout**. Command:

```sh
node /tmp/m2b/generic-fix/extend-mutations.mjs
bash /tmp/m2b/generic-fix/mutate.sh "$PWD"
```

This retains the earlier 49 mutants and adds:

| Mutant | Break | Failed tests |
|---|---|---:|
| G01 | ignore explicit type arguments | 7 |
| G02 | ignore constructor type arguments | 1 |
| G03 | bind every type parameter to argument zero | 2 |
| G04 | discard default owners | 3 |
| G05 | resolve a dependent default only to its constraint | 1 |
| G06 | apply method type arguments to receiver-class parameters | 1 |

Each new mutant is killed by `key-generics.test.ts`; no new mutant hangs, fails parsing or relies on a cancelled test. The existing B01 marker-write mutant still fails the index's produced/read-back invariant during setup, as documented above.

The fixed build was cold-indexed on the same oh-my-pi corpus and checked again:

```sh
node dist/adapters/cli/main.js index \
  --root /var/tmp/m2a2/omp-src --full --json
node dist/adapters/cli/main.js doctor --deep \
  --root /var/tmp/m2a2/omp-src --differential 300 --json
```

| Fix verification | Wall (s) | Max RSS (KiB) | Outcome |
|---|---:|---:|---|
| cold build | 305.34 | 7,637,296 | exit 0; no VERIFY problems |
| deep doctor, 300 declarations | 276.96 | 7,615,328 | exit 0; 0 graph/counter differences; 7,640/7,640 references covered; 0 misses |

The mutation campaign overlapped the real-repository commands. These are not isolated speed measurements.

Against the published index before this fix: **32 additional REFERENCES edges**, 0 removed edge records, 1 existing edge record with changed use-site lines, and 0 added or removed gap sites. Examples include `extractReadableText` and `extractStructuredText` referencing `TextLikeContent.text`, and `extractTerminalId` referencing `TerminalIdContainer.terminalId` in `packages/coding-agent/src/modes/acp/acp-event-mapper.ts`.

Against the original pre-Round-1 index, the fixed build adds **2,579 REFERENCES edges** and 6,214 use-site lines. The gap figures are unchanged: 233 new sites, 42 owners, 1,392 owners/members (0.89%), and a conservative depth-10 projection of 26,003 declarations (16.62%). **The generic-owner regressions and all executed correctness gates pass; the separate >5% scoping stop remains unresolved.** No scope rule was narrowed to conceal that gate, and Round 2 was not started.

`npm run typecheck`, `npm run lint` and `npm run format:check` also passed after the final regression additions. macOS, CI, query-level verdicts and live OMP remain **NOT VERIFIED**. This fix changes only `keys.ts`, its built `dist` file, the new generic regression file and this evidence document.

## Round 2 — Step 2: query core and golden cases

Model: `anthropic/claude-opus-5-5` (integration, query-core rewrite, regressions, measurements). Two `openai-codex/gpt-6-sol` sub-agents wrote the first golden/freshness tests and first drafts of `query.ts` and `session.ts`; both stopped on a usage limit, and their output was reviewed and corrected here. Runtime: Linux WSL2 x86_64, Node `24.21.0`, TypeScript `5.9.3`, `omp/18.20.2` (no live OMP call this round).

### 1. Starting point

- Branch `m2b-impact-r2` from fetched `origin/main` (`2e15bbf`). Round 1 was not on main: commits `46c6bd3` and `75a5669` were cherry-picked with the owner's approval, then the owner-approved decision commit `5ce1047` (D54, G13) from `origin/docs/m2b-golden-decisions`.
- Fixture correction (G13): removed `void localOnly;` from `tests/fixtures/mono/packages/payments/src/fee.ts`. The fixture still type-checks (`fixture.test.ts`). Exact counts changed only in `tests/core/differential.test.ts`, each by the one removed reference: base fixture references 48 → 47 and `coveredBy.edge` 48 → 47; shorthand copy `coveredBy.edge` 52 → 51; anonymous-kinds copy `coveredBy.edge` 58 → 57. No other number moved.

### 2. Tests written first

`tests/core/impact-golden.test.ts` (C01–C26, never-low sweep), `tests/core/impact-freshness.test.ts` (F01–F06 and the freshness risky cases) and `tests/core/impact-risk.test.ts` (target, completeness and factor risky cases) were compiled and run before any query code existed: every suite failed on the missing `src/core/impact/query.js` / `session.js`.

Review of the first `query.ts` against golden P4, DESIGN §7.2 and the oh-my-pi index found defects the fixture does not exercise. Six regressions were written and **observed failing** first, each on its defect (four as wrong `low`/`complete` answers):

| Regression | Defect in the first draft | Observed before the fix |
|---|---|---|
| `import(p)` with no static prefix | gap detail `*` scoped to nothing (`file.startsWith('*')`); all 15 oh-my-pi dynamic-import gaps have detail `*` | `{"status":"complete","reasons":[]}` |
| `require(p)` of a computed path | gap detail `*` scoped to nothing | `{"status":"complete","reasons":[]}` |
| public package, wildcard subpath export (`./*` → `./src/*.ts`) | unresolved entries ignored; 12 public oh-my-pi packages use wildcard subpaths | factors `[]` (level `low`) |
| public package, `main` is unbuilt output | unresolved code entries ignored | factors `[]` (level `low`) |
| caller reached only through a heuristic interface hop | counted in compiler-grade reach | `reach.total` 1, expected 0 |
| engine stamp; dotted names | engine version hard-coded `0.3.0` (package is `0.1.0`); D51 parent fallback missing for `Owner.member.sub`, and accepting any dotted input such as `calculateFee.ts` | `'0.3.0' !== '0.1.0'` |

The rewrite also replaced a per-row `prepare` and a scan of every gap row per impacted symbol (≈21k rows on oh-my-pi) with gap sites indexed by scope, cached statements and cached incoming edges.

Scoping as implemented (golden P4, D54, target only; an impacted symbol in scope gets `gapScoped: true`):

| Code | Scope |
|---|---|
| `parse-error` (and any unrecognised code) | every target |
| `dynamic-import` | exported declarations in files under the static prefix; no prefix, or a prefix that names no indexed file, → every exported declaration (a module namespace exposes exports only) |
| `cjs-require` | declarations of the required file; computed path (`*`) → every exported declaration; an external module name → none |
| `interface-dispatch` | implementations of that interface member (`IMPLEMENTS`) |
| `computed-member-access` | the accessed owner, its members, and values stored in them (a `REFERENCES` edge from the owner or a member) |
| `unresolved-name-match`, `unresolved-import`, `string-name-match` | the declaration whose simple name matched |
| `depth-limit` | the target, when either traversal is capped at 10 with unvisited callers |

Reach uses a compiler-only traversal; listing, factors and tests use the listing traversal (compiler plus heuristic interface callers), so a factor can only be added, never lost.

### 3. Local checks

Two freshness-test defects were fixed in the tests (product behaviour verified separately): F06 restored a sub-millisecond mtime through a `Date`, so the stat probe saw real drift (the existing index-level F06 test uses whole seconds for this reason; `buildIndex` on the same edit reports `update`); and gated builds were released but not awaited, so a real build outlived its test, held the lock and wrote into a removed temp dir. `npm test` isolates `HOME`, so real builds need the pinned runtime there: `ensureRuntime()` provisions it offline from this repository's TypeScript, as `status.test.ts` already does.

```text
npm test
ℹ tests 518
ℹ suites 35
ℹ pass 518
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0

npm run typecheck      exit 0
npm run lint           exit 0
npm run format:check   All matched files use Prettier code style!
```

**VERIFIED** on Linux. Golden C01–C26 and F01–F06 all pass at query level; none is left failing. C17 takes outcome **B** (`partial` + `cjs-require`). The never-low sweep covers C06, C11, C12, C17 on the base fixture, C16, C22, C23 through `copyCase` and F04, at depth 1–10.

### 4. oh-my-pi distribution (index built, no drift)

Corpus and index as in Round 1 (`04cd1a7`, 156,421 non-module declarations, schema 3, extractor `7498355c17278a57`); stat probe before the run: 0 added, 0 changed, 0 deleted. 200 targets by the seeded shuffle of `differential.ts` (seed 1), queried at depth 10 with one `ImpactQuery`. Script and raw output kept outside the repository (`/tmp/ksd-m2b-r2/measure.mjs`, `distribution.json`).

| Level | Count | Share |
|---|---:|---:|
| low | 21 | 10.5% |
| medium | 11 | 5.5% |
| unknown | 168 | 84.0% |

| Completeness reason (targets carrying it) | Count | Sole reason of an unknown |
|---|---:|---:|
| `dynamic-import` | 110 | 17 |
| `depth-limit` | 102 | 15 |
| `string-name-match` | 83 | 12 |
| `unresolved-name-match` | 54 | 0 |
| `computed-member-access` | 9 | 2 |
| `interface-dispatch` | 4 | 0 |
| `cjs-require` | 1 | 0 |

Only seven reason codes occur. Unknown results carry a median of 16 reasons (max 3,380, `string-name-match` on a common name). Removing any one code alone would leave at least 151 of the 168 unknown: no single rule explains the share.

**STOP GATE: more than 60% unknown.** Per the prompt nothing was tuned. The largest contributor is `dynamic-import` with detail `*`: 15 sites (11 in `packages/coding-agent/src`, 4 in tests) with no static prefix, which under P4 ("files its static prefix can match") put every exported declaration in scope. Narrowing that, or `depth-limit` on long reference chains, is the owner's decision.

### 5. The first ten lows against `findReferences`

The first ten `low` results of the sample in key order (no selection by kind or outcome), checked with the TypeScript language service over the same program grouping (`/tmp/ksd-m2b-r2/check-lows.mjs`). "Unlisted" counts references to the declaration itself whose enclosing symbol is neither listed at depth 1 nor the target.

| Target | Kind | Index direct / total | TS references | Unlisted |
|---|---|---:|---:|---:|
| `packages/ai/test/issue-6913-harmony-marker-escaping.test.ts#ESCAPED` | variable | 1 / 1 | 7 (1 source) | 0 |
| `packages/ai/test/kimi-usage.test.ts#makeCredential` | function | 1 / 1 | 8 (1 source) | 0 |
| `packages/coding-agent/src/cli/images-cli.ts#DEFAULT_DEPENDENCIES.loadProviderFileCache` | method | 0 / 0 | 0 (1 to the interface member it implements) | 0 |
| `packages/coding-agent/src/mnemopi/backend.ts#clampLimit` | function | 1 / 1 | 1 | 0 |
| `packages/coding-agent/test/btw-session-lifecycle.test.ts#SideTurn` | interface | 1 / 1 | 1 | 0 |
| `packages/coding-agent/test/mcp-lost-remote-retry.test.ts#FAST.retryBaseMs` | property | 0 / 0 | 0 (2 to `MCPReconnectPolicy.retryBaseMs`) | 0 |
| `packages/coding-agent/test/mcp/config-request-id-format.test.ts#fallbackAgentDir` | variable | 1 / 1 | 1 | 0 |
| `packages/coding-agent/test/memories/stage1-input.test.ts#referenceItems` | function | 1 / 1 | 1 | 0 |
| `packages/metaharness/adapters/edit/runner.ts#TaskRunItem` | interface | 3 / 5 | 3 (3 sources) | 0 |
| `packages/tui/src/theme/symbols.ts#UNICODE_SYMBOLS.boxRound.topRight` | property | 0 / 0 | 1 | **1** |

**Candidate wrong `low` (blocker until the owner rules):** `packages/tui/src/theme/theme-class.ts:589`, `topRight: this.#symbols["boxRound.topRight"]` inside `Theme.boxRound`. `#symbols` is `SymbolMap = Record<SymbolKey, string>`; the presets (`UNICODE_SYMBOLS`, `NERD_SYMBOLS`, `ASCII_SYMBOLS`) are spread into it, so a change to the preset value reaches `Theme.boxRound` at runtime. The checker binds the literal to a transient mapped-type symbol with **0 declarations** (`/tmp/ksd-m2b-r2/miss-symbol.mjs`: `mapped: true, declarations: 0`). ADR 0003 and Round 1 record no edge and no gap for a declaration-less `Record` key, and the differential oracle skips this read as "use of a property of a mapped type (no declaration)"; raw `findReferences` lists it. Under the oracle the low holds; under `findReferences` it is a missed reader. Nothing was changed: the layer is the index rule (Step 1), not the query.

### 6. Not acted on (owner questions)

1. Whether an empty-prefix `dynamic-import` should scope every export (84% unknown, §4).
2. Whether 102/200 `depth-limit` results reflect real chains longer than 10 or call for a different cap.
3. The `Record`-alias read in §5: accept it as ADR 0003 policy, or add a gap for reads through a mapped-type alias of an object literal's type.
4. Files outside the index scope (63 `.ts`/`.tsx`/`.d.ts` and 1 `.js` under `outside-index-scope`) and 21 orphan `.js` files may call in-scope targets; P4 defines no scope for `outside-index-scope`, so it is not applied to targets.
5. Index layer: a computed index into an array (`list[i]()`) records no `computed-member-access` gap (only object literals, classes, enums and namespaces do).
6. `unresolved-import` is scoped by imported name; a broken `default` import does not match the target's own name.

**NOT VERIFIED:** macOS, CI, rendering, the agent tool and CLI (Round 3), query latency, live OMP.
