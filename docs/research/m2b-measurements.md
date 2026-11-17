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


## Round 2b — D55 / G14 scoping decisions

**VERIFIED:** Linux x64 (WSL2), Node 24.21.0, TypeScript 5.9.3. Implementing model: `openai-codex/gpt-6.1-sol`. No OMP adapter was changed or loaded.

### 1. Starting point and scope

`origin/main` was fetched at `5956c16`. The local Round 2 branch contained equivalent Round 1 work on older ancestry; its Round 1 tree matched the upstream squash. Rebased the Round 2 commit onto `origin/main` using `git rebase --onto origin/main 40c90a9 m2b-impact-r2`; the retained Round 2 commit is `d50cdbc`. No work was pushed.

Installed packages matched the lockfile (0 non-link version mismatches), so dependencies were not reinstalled. No dependency, golden oracle, base fixture, policy module, OMP adapter or OMP configuration changed. Round 3 was not started.

### 2. Implemented decisions

|Item|Implementation|Regression evidence|
|---|---|---|
|1|Traverse the incoming closure with a 50,000-symbol budget, including the target. Only skipped unseen symbols add `depth-limit`; display depth stays 1–10.|25 callers, injected small budget, cycle, and depth-invariant reach/completeness/factors/verdict.|
|2|Prefix-less import/require gaps affect exported targets in files without static importers, except tests and package entries. Resolved static-import sites use existing marker rows; literal dynamic imports are not static importers.|Isolated export, static importer, dynamic-only importer and exceptions. C11 and existing prefix/literal-require scopes preserved.|
|3|Shared `repositoryLimits` supplies `{ unboundedDynamicImports, excludedFiles, failedFiles }` to impact results and status, independently of completeness/verdict.|Real SQL counts and actual status output. Failed files means `not-in-program`; C16 parse-error behavior is unchanged.|
|4|Orphan code files receive scanner-only lexical name rows, never declarations/compiler edges. Content and declaration-name changes invalidate them; timestamp-only changes preserve them.|Identifiers, decoded strings, comments/regex/templates, exclusions/secrets and incremental == cold across touch/edit/delete/add/name changes.|
|5|Exclude literal type positions and contextual literal/union types. Keep strings with no contextual type (C23), or contextual `string`, `any` or `unknown`.|Discriminants, literal annotations, finite unions and optional-string unions excluded; broad strings/any/unknown/untyped constants retained.|
|6|Use the permitted conservative fallback: include indexed users of every enclosing object literal. Existing edges do not distinguish whole-value use from member access.|Dotted preset spread into a `Record<K, string>` class field; storing field at depth 1 and reader at depth 2. No value-flow gap invented.|
|7|Keep existing array reference traversal.|`a → hs → run`: complete, two dependents, no computed-member gap.|

### 3. Regression and mutation evidence

**VERIFIED:** the new Round 2b regression file run against archived `d50cdbc` produced **13 tests: 5 pass, 8 fail, 0 cancelled**. Failures covered closure/budget, dynamic-import scoping, limits, orphan names, discriminants and the storing symbol; the array case already passed. The first successful baseline-red run happened after initial integration edits; earlier compile/setup failures were not counted. This deviates from the requested fail-first execution order.

Integration regressions for unmatched prefixes and external literal requires failed before their original scopes were restored. The 12-caller expectation was aligned with golden P2 (`many-callers`, `medium`), not weakened to `low`. A final optional-string-union regression failed with actual lines `[5,6,7,8]` versus expected `[6,7,8]`; the contextual filter was corrected, followed by the full checks below.

```text
npm test
tests 538 · suites 41 · pass 538 · fail 0 · cancelled 0 · skipped 0
npm run typecheck: exit 0
npm run lint: exit 0
npm run format:check: All matched files use Prettier code style!
```

Includes C01–C26, F01–F06, never-low depth sweeps, four seeded randomized incremental/cold comparisons, update soundness, and exact fixture differential: **31 declarations, 47 references, 47 edge-covered, 0 misses**. Those differential counts are unchanged from Round 2.

|Mutation group|Intended mutants|Killed|
|---|---:|---:|
|Retained M2a smoke|39|39|
|Reconstructed Round 1 keyof/metadata/generic-owner smoke|16|16|
|D55 items 4–6|3|3|
|Query-core controls|6|6|
|Total|64|64|

The typed-literal mutant was rerun and killed after the final contextual-union correction. No intended mutant timed out. B01 was killed by a produced/read-back VERIFY invariant (four setup cancellations), not syntax failure; all 25 additional mutations were syntax-checked. An initial malformed K05 experiment attached its invented gap to the module and survived. Correcting its source to the enclosing use symbol killed two negative controls, without changing production code or weakening tests.

### 4. Same 200 targets, before and after

Corpus: oh-my-pi `04cd1a7549a02d62ad1d24826198d52507595683`; 10,502 visible files, 6,761 compiler-indexable files, 156,421 non-module declarations. Seed 1 and the original Fisher–Yates shuffle reproduced the Round 2 84% baseline. The final run reused exactly the same 200 saved keys and key order. Both probes reported no added/changed/deleted files. No corpus source was edited.

|Level|Before|Before share|After|After share|
|---|---:|---:|---:|---:|
|low|21|10.5%|17|8.5%|
|medium|11|5.5%|94|47.0%|
|unknown|168|84.0%|89|44.5%|

Each target is counted once per reason; “sole” means no other reason code.

|Reason|Before targets|Before sole|After targets|After sole|
|---|---:|---:|---:|---:|
|`dynamic-import`|110|17|2|0|
|`depth-limit`|102|15|0|0|
|`string-name-match`|83|12|78|18|
|`unresolved-name-match`|54|0|59|2|
|`computed-member-access`|9|2|9|6|
|`interface-dispatch`|4|0|4|2|
|`cjs-require`|1|0|1|1|

|Traversal measurement|Before|After|
|---|---:|---:|
|p50, sum of both passes (ms)|0.58|101.75|
|p95, sum of both passes (ms)|58.34|166.35|
|Largest listing closure, including target|12,751|17,816|
|Largest compiler closure, including target|6,777|10,741|
|Depth-cap stops|102|0|
|50,000-node budget hits|not applicable|0|

These are traversal timings, not whole-call/renderer latency. Some original measurements overlapped correctness work; they are not isolated performance benchmarks. No performance tuning was done. Round 3 owns whole-call latency.

Final cold index: **VERIFIED exit 0**, wall=162.38 maxrss_kb=7459552 exit=0. No VERIFY problems.

### 5. Remaining name matches

Top 20 names among sampled targets still carrying each reason, ranked by distinct matching `file:line` sites. Declaration counts cover the whole index. Sites on one line count once; up to three examples are shown. No additional name-scoping change was made.

#### string-name-match

|Name|Matching sites|Sampled targets|Declarations sharing name|Example sites|
|---|---:|---:|---:|---|
|`"error"`|1266|1|293|`packages/agent/src/agent-loop.ts:1613`; `packages/agent/src/agent-loop.ts:2352`; `packages/agent/src/agent-loop.ts:2398`|
|`"default"`|789|1|123|`packages/ai/src/auth-gateway/http.ts:303`; `packages/ai/src/auth/usage-cache.ts:297`; `packages/ai/src/auth/usage-cache.ts:311`|
|`"model"`|436|1|503|`packages/agent/test/remote-compaction.test.ts:120`; `packages/ai/src/images/openai-images.ts:86`; `packages/ai/src/providers/factory-droid/gemini.ts:347`|
|`"session"`|403|1|220|`packages/ai/src/providers/openai-codex-responses.ts:4279`; `packages/ai/src/usage/claude.ts:33`; `packages/ai/src/usage/claude.ts:768`|
|`"run"`|367|1|114|`packages/agent/test/agent-loop.test.ts:1726`; `packages/agent/test/agent-loop.test.ts:1788`; `packages/agent/test/agent-loop.test.ts:1836`|
|`"path"`|280|1|432|`packages/agent/bench/normalize-tools.bench.ts:49`; `packages/agent/bench/normalize-tools.bench.ts:84`; `packages/agent/src/speculative-execution.ts:103`|
|`"close"`|241|2|219|`packages/agent/test/remote-compaction.test.ts:180`; `packages/ai/test/gitlab-duo-workflow-provider.test.ts:4805`; `packages/ai/test/gitlab-duo-workflow-provider.test.ts:969`|
|`"id"`|217|1|984|`packages/ai/src/providers/gitlab-duo-workflow.ts:1626`; `packages/ai/src/providers/gitlab-duo-workflow.ts:1674`; `packages/ai/src/providers/gitlab-duo-workflow.ts:3152`|
|`"type"`|209|4|1108|`packages/agent/src/agent-loop.ts:348`; `packages/agent/src/agent-loop.ts:605`; `packages/agent/src/compaction/compaction-v2-streaming.ts:682`|
|`"name"`|204|5|996|`packages/agent/src/compaction/utils.ts:104`; `packages/agent/src/telemetry.ts:801`; `packages/ai/src/dialect/anthropic.ts:358`|
|`"input"`|194|1|393|`packages/ai/src/providers/openai-codex-responses.ts:3578`; `packages/ai/test/helpers/factory-droid-native.ts:120`; `packages/ai/test/issue-2080-repro.test.ts:33`|
|`"status"`|194|1|387|`packages/agent/src/compaction/compaction-v2-streaming.ts:645`; `packages/ai/src/auth-gateway/routes/embeddings.ts:51`; `packages/ai/src/auth-gateway/routes/images.ts:84`|
|`"role"`|139|1|230|`packages/agent/src/agent-loop.ts:1956`; `packages/ai/src/providers/openai-codex-responses.ts:3570`; `packages/ai/src/providers/openai-configuration-update.ts:176`|
|`"summary"`|130|1|118|`packages/agent/src/telemetry.ts:463`; `packages/agent/src/telemetry.ts:475`; `packages/agent/test/anthropic-native-compaction.test.ts:460`|
|`"response"`|119|1|35|`packages/agent/test/compaction-telemetry.test.ts:255`; `packages/ai/src/providers/openai-responses-server.ts:1471`; `packages/ai/src/providers/openai-responses-server.ts:1496`|
|`"data"`|108|1|169|`packages/ai/src/providers/cursor/interaction-query.ts:41`; `packages/ai/src/providers/gitlab-duo-workflow.ts:1578`; `packages/ai/src/providers/openrouter-generation.ts:34`|
|`"body"`|107|1|128|`packages/ai/src/dialect/glm.ts:120`; `packages/ai/test/deepseek-reasoning-content.test.ts:654`; `packages/ai/test/factory-droid-completions-reasoning.test.ts:28`|
|`"fixture"`|83|1|22|`packages/ai/test/cursor-exec-modern.test.ts:1013`; `packages/ai/test/cursor-exec-modern.test.ts:1022`; `packages/ai/test/cursor-exec-modern.test.ts:1031`|
|`"output"`|83|2|362|`packages/agent/src/tokenizer.ts:419`; `packages/ai/src/providers/google-gemini-cli.ts:1063`; `packages/ai/src/providers/openai-codex/request-transformer.ts:322`|
|`"dir"`|65|1|47|`packages/coding-agent/src/cli/completion-gen.ts:200`; `packages/coding-agent/src/cli/completion-gen.ts:341`; `packages/coding-agent/src/cli/completion-gen.ts:483`|

#### unresolved-name-match

|Name|Matching sites|Sampled targets|Declarations sharing name|Example sites|
|---|---:|---:|---:|---|
|`"type"`|849|4|1108|`packages/agent/src/agent-loop.ts:296`; `packages/agent/src/agent-loop.ts:362`; `packages/agent/src/agent-loop.ts:388`|
|`"id"`|442|1|984|`packages/agent/src/agent-loop.ts:269`; `packages/agent/src/agent-loop.ts:273`; `packages/agent/src/append-only-context.ts:460`|
|`"name"`|246|5|996|`packages/agent/src/append-only-context.ts:458`; `packages/agent/src/compaction/compaction.ts:1653`; `packages/agent/test/agent-loop.test.ts:8064`|
|`"path"`|207|1|432|`packages/agent/src/agent-loop.ts:316`; `packages/agent/src/agent-loop.ts:317`; `packages/agent/src/compaction/pruning.ts:681`|
|`"input"`|203|1|393|`packages/agent/src/compaction/openai.ts:776`; `packages/agent/test/remote-compaction.test.ts:1890`; `packages/agent/test/remote-compaction.test.ts:1957`|
|`"role"`|129|1|230|`packages/agent/src/append-only-context.ts:453`; `packages/agent/src/compaction/compaction-v2-streaming.ts:738`; `packages/agent/src/compaction/compaction-v2-streaming.ts:739`|
|`"data"`|120|1|169|`packages/ai/src/images/shared.ts:244`; `packages/ai/src/providers/cursor.ts:1092`; `packages/ai/src/usage/alibaba-token-plan.ts:166`|
|`"model"`|116|1|503|`packages/agent/src/compaction/anthropic.ts:112`; `packages/ai/src/judgment/openai-decisions.ts:147`; `packages/ai/src/judgment/systemone.ts:40`|
|`"error"`|104|1|293|`packages/agent/src/compaction/compaction-v2-streaming.ts:675`; `packages/agent/src/compaction/compaction-v2-streaming.ts:676`; `packages/agent/src/compaction/compaction-v2-streaming.ts:677`|
|`"status"`|100|1|387|`packages/ai/src/error/body-error.ts:216`; `packages/ai/src/error/body-error.ts:233`; `packages/ai/src/error/flags.ts:531`|
|`"key"`|91|2|226|`packages/ai/src/auth/sqlite-credential-store.ts:172`; `packages/ai/src/auth/sqlite-credential-store.ts:174`; `packages/ai/src/utils/schema/wire.ts:37`|
|`"summary"`|53|1|118|`packages/ai/src/providers/openai-responses-server.ts:723`; `packages/ai/src/utils.ts:646`; `packages/ai/test/factory-droid-gemini.test.ts:1076`|
|`"output"`|52|2|362|`packages/agent/test/remote-compaction.test.ts:253`; `packages/agent/test/remote-compaction.test.ts:3039`; `packages/agent/test/remote-compaction.test.ts:415`|
|`"default"`|50|1|123|`packages/ai/src/utils/schema/normalize.ts:2313`; `packages/ai/src/utils/schema/normalize.ts:2317`; `packages/ai/src/utils/validation.ts:858`|
|`"body"`|48|1|128|`packages/ai/src/utils/request-debug.ts:68`; `packages/ai/test/gitlab-duo-workflow-oauth.test.ts:30`; `packages/ai/test/issue-2424-repro.test.ts:70`|
|`"response"`|46|1|35|`packages/agent/src/compaction/compaction-v2-streaming.ts:651`; `packages/agent/src/compaction/compaction-v2-streaming.ts:674`; `packages/ai/src/error/body-error.ts:191`|
|`"headers"`|36|1|102|`packages/agent/src/telemetry.ts:1278`; `packages/agent/src/telemetry.ts:268`; `packages/ai/src/providers/openai-codex-responses.ts:1655`|
|`"cwd"`|27|1|295|`packages/coding-agent/examples/extensions/api-demo.ts:56`; `packages/coding-agent/src/dap/session.ts:1201`; `packages/coding-agent/src/discovery/agent-plugin-format.ts:375`|
|`"detail"`|25|1|50|`packages/agent/src/compaction/openai.ts:136`; `packages/ai/src/images/shared.ts:247`; `packages/ai/src/providers/openai-codex/live-steering.ts:241`|
|`"dir"`|23|1|47|`packages/natives/native/loader-state.js:62`; `packages/natives/native/loader-state.js:63`; `packages/natives/native/loader-state.js:64`|

### 6. Twenty reference audits and value flow

Rechecked the original first ten lows in order, plus ten additional final lows: **20 targets**, 17 still low. The audit used compiler-program-specific `findReferences`; target groups, related declarations, definitions, mapped members, documentation and import bindings were separated. Emitted use sites and enclosing symbols were inspected.

|Cohort|Target|Final level|Direct / total|Target-use sites|Uncovered|
|---|---|---|---:|---:|---:|
|original|`packages/ai/test/issue-6913-harmony-marker-escaping.test.ts#ESCAPED`|low|1 / 1|7|0|
|original|`packages/ai/test/kimi-usage.test.ts#makeCredential`|low|1 / 1|8|0|
|original|`packages/coding-agent/src/cli/images-cli.ts#DEFAULT_DEPENDENCIES.loadProviderFileCache`|medium|1 / 4|0|0|
|original|`packages/coding-agent/src/mnemopi/backend.ts#clampLimit`|medium|1 / 3118|1|0|
|original|`packages/coding-agent/test/btw-session-lifecycle.test.ts#SideTurn`|low|1 / 1|1|0|
|original|`packages/coding-agent/test/mcp-lost-remote-retry.test.ts#FAST.retryBaseMs`|low|2 / 2|0|0|
|original|`packages/coding-agent/test/mcp/config-request-id-format.test.ts#fallbackAgentDir`|low|1 / 1|1|0|
|original|`packages/coding-agent/test/memories/stage1-input.test.ts#referenceItems`|low|1 / 1|1|0|
|original|`packages/metaharness/adapters/edit/runner.ts#TaskRunItem`|low|3 / 5|3|0|
|original|`packages/tui/src/theme/symbols.ts#UNICODE_SYMBOLS.boxRound.topRight`|medium|1 / 10740|0|0|
|additional|`packages/collab-web/scripts/fixture.ts#makeScriptedTurn`|low|1 / 5|2|0|
|additional|`packages/mnemopi/src/core/plugins.ts#PluginManager.unloadPlugin`|low|2 / 3|2|0|
|additional|`packages/stats/src/client/spotlight/ResultsFeed.tsx#ResultsFeed`|low|1 / 4|2|0|
|additional|`packages/tui/test/status-line-native.test.ts#NO_USAGE.orchestrationInput`|low|1 / 2|0|0|
|additional|`packages/tui/test/status-line-path.test.ts#CHECKOUT_IS_SCRATCH`|low|1 / 1|4|0|
|additional|`packages/tui/test/table-chart.test.ts#DIFF`|low|1 / 1|2|0|
|additional|`packages/tui/test/tools-native-github.test.ts#resultFor`|low|1 / 1|5|0|
|additional|`packages/tui/test/write-figure.test.ts#MERMAID`|low|1 / 1|5|0|
|additional|`packages/tui/test/write-streaming-incremental-render.test.ts#hasLine`|low|1 / 1|11|0|
|additional|`packages/typescript-edit-benchmark/src/mutations.ts#randomSample`|low|3 / 3|3|0|

**VERIFIED: 0 wrong lows; 0 uncovered target references.** Import-binding sites are counted as target-use sites, not caller declarations.

The mapped read at `packages/tui/src/theme/theme-class.ts:589`, `topRight: this.#symbols["boxRound.topRight"]`, is value flow through a declaration-less mapped member, not a direct reference to the preset property. For `UNICODE_SYMBOLS.boxRound.topRight`, the result now includes `SYMBOL_PRESETS.unicode` at depth 1 and storing indexed class `Theme` at depth 2. It does not claim `Theme.boxRound` directly references that preset member. No mapped-read gap was added. The original preset low becomes medium; `clampLimit` and `DEFAULT_DEPENDENCIES.loadProviderFileCache` also become medium through existing factors.

### 7. Index rows, status and deep doctor

|Table|Before|After|Why|
|---|---:|---:|---|
|files|10,502|10,502|Same census.|
|file_index|6,761|6,782|21 lexical orphan rows.|
|declarations|163,182|163,182|No lexical declarations.|
|edges|633,567|633,567|Container expansion is query-time.|
|unresolved|14,116|31,378|Lexical orphan identifiers.|
|gap_sites|21,780|21,780|No new gap rule.|
|name_tokens|108,531|73,006|Contextual filtering plus orphan strings.|
|markers|0|38,869|Resolved static import sites.|

Actual status output:

```text
Limits      15 unbounded dynamic imports · 88 excluded files · 0 failed to index
```

**VERIFIED:** final `doctor --deep --differential 300`: no drift; no VERIFY problems; 0 graph differences; 0 counter differences; 300 declarations; 7,640 references, all edge-covered; 0 misses. Wall 254.72 s, maximum RSS 7,602,360 KiB, exit 0. The refreshed 20-target audit also passed (wall 20.54 s, maximum RSS 4,156,392 KiB): all 17 final lows covered, no wrong low and no uncovered target reference.

### 8. Commands, limits and stop gate

Commands executed; `$EVIDENCE_DIR` denotes the temporary evidence directory. Measurement/mutation/audit scripts are throwaway verification code, not library code.

```sh
git fetch origin
git checkout m2b-impact-r2
git rebase --onto origin/main 40c90a9 m2b-impact-r2
npm run build
./node_modules/.bin/tsc -p tests/tsconfig.json
node scripts/copy-policy-to-dist.mjs --test-tree
node --import ./tests/policy/helpers/isolated-home.js --test "$EVIDENCE_DIR/red/tests/core/impact-r2b.test.js"
node --import ./tests/policy/helpers/isolated-home.js --test dist-test/tests/core/impact-r2b-extractor.test.js
npm test
npm run typecheck
npm run lint
npm run format:check
bash /var/tmp/m2a2/tools/mutate6.sh "$PWD"
node "$EVIDENCE_DIR/mutation-extra.mjs"
MUTANT_FILTER=K05 node "$EVIDENCE_DIR/mutation-extra.mjs"
MUTANT_FILTER=D55-5 node "$EVIDENCE_DIR/mutation-extra.mjs"
node dist/adapters/cli/main.js index --root /var/tmp/m2a2/omp-src --full --json
node "$EVIDENCE_DIR/measure.mjs" "$EVIDENCE_DIR/baseline/dist" "$EVIDENCE_DIR/before.sqlite" "$EVIDENCE_DIR/before.json"
node "$EVIDENCE_DIR/measure.mjs" dist "$HOME/.cache/ksd-intelligence/6245da6948cefc28/index.sqlite" "$EVIDENCE_DIR/after.json" "$EVIDENCE_DIR/before.json.targets.json"
node --max-old-space-size=8192 --expose-gc "$EVIDENCE_DIR/check-lows.mjs" dist "$HOME/.cache/ksd-intelligence/6245da6948cefc28/index.sqlite" "$EVIDENCE_DIR/before.json" "$EVIDENCE_DIR/after.json" "$EVIDENCE_DIR/lows.json"
node dist/adapters/cli/main.js doctor --deep --root /var/tmp/m2a2/omp-src --differential 300 --json
node dist/adapters/cli/main.js status --root /var/tmp/m2a2/omp-src
```

**Gate: VERIFIED — unknown 44.5% (at most 60%), with no wrong low in the prescribed audits.** Round 3 may start only when requested; it was not started here.

**NOT VERIFIED:** macOS, pushed CI, live OMP, Round 3 tool/CLI/rendering/snapshots, isolated whole-call latency and later independent cross-vendor review. No push, merge, deployment, dependency addition or OMP installation/configuration mutation.

## Round 5 — fix round (R1–R8, D56, G15)

**VERIFIED:** macOS Darwin arm64, Node `24.22.0`, TypeScript `5.9.3`. Implementing model: Gemini 4 Argon (Medium).

### 1. Findings R1–R8 disposition

| Finding | Disposition | Evidence |
|---|---|---|
| R1 | Implemented `common-name` factor (`src/core/kernel/types.ts`, `src/core/kernel/config.ts`, `src/core/indexing/stamp.ts`, `src/core/impact/query.ts`). When `decl.simple` is shared by more than `impact.commonName` (default 10) non-module declarations and has at least one `unresolved-name-match` or `string-name-match` site, those sites are not completeness reasons; the target gets factor `common-name` and `verdict.basis` states `common-name: <N> declarations named "<name>"; <U> untyped uses, <S> equal strings not attributed` (G15). `commonName` is a query-time threshold and is excluded from `impactConfigHash`. | `tests/core/impact-r2b.test.ts` (`D56 / G15 — common-name factor`), `tests/core/init.test.ts`. Observed failing before the fix; passes after. |
| R2 | Implemented `userHidingGaps(decl)` in `src/core/impact/query.ts`. `gapScoped` is set only from gaps that hide users of that row (`computed-member-access`, `interface-dispatch`, `dynamic-import`/`cjs-require` in scope), never from name matches (`unresolved-name-match`, `string-name-match`, `unresolved-import`) or repository-wide gaps (`parse-error`, `unsupported-syntax`). This also avoids running the `name_tokens` query per listed symbol. | `tests/core/impact-risk.test.ts` (`R2: gapScoped marks only gaps that hide users of that row, not name matches or parse-error`). Observed failing before the fix; passes after. |
| R3 | Implemented drift-fingerprint failure memoization in `src/core/impact/session.ts`. When a build fails with drift, `lastFailed` records the fingerprint (`configHash` + sorted `path:size:mtimeMs` of `driftedFiles`) and failure message; while the fingerprint is unchanged, `query` answers stale immediately with the stored failure without starting a build. A changed fingerprint retries. | `tests/core/impact-freshness.test.ts` (`failed update retains the old index, marks it stale and includes the failure` — 3 calls, 1 build; edit retries for build 2). Observed failing before the fix; passes after. |
| R4 | Added `waitAfterExpiry?: boolean` to `ImpactSessionOptions` in `src/core/impact/session.ts` for the Round 3 CLI to use so a CLI invocation waits for an in-flight build or lock holder instead of exiting at `waitMs` and killing its child in a stale loop (D56). The CLI `impact` subcommand itself is Round 3 scope and is not registered here. | `tests/core/impact-freshness.test.ts` (`waitAfterExpiry mode waits for a build slower than waitMs instead of exiting stale`). Observed failing before the fix; passes after. |
| R5 | Added regression test for a method of an exported class (`Service.run`) and a property of an exported object (`Box.value`) in a file with no static importer under a prefix-less `import(p)`. `src/core/indexing/declarations.ts` already propagates `exported` to class and object-literal members (`classMembers`, `objectMembers`), so no product code change was needed. | `tests/core/impact-risk.test.ts` (`R5: a method of an exported class and a member of an exported object in an unimported file are partial under a prefix-less dynamic import`). |
| R6 | Widened D51 parent fallback in `src/core/impact/query.ts` to accept a nearest indexed parent of kind `property` or `variable`, and added regression test for `Config.a.b.c.d` (deeper than ADR 0003's 3-level object-literal limit) and `Flat.x` (parent kind `variable`). Line 1 rendering of both names belongs to Round 3 (`render.ts`); `ImpactAnswer` carries both `input` and `parentTarget`. | `tests/core/impact-risk.test.ts` (`R6: a member deeper than ADR 0003 object-literal depth 3 resolves to its nearest indexed parent`). Observed failing before the fix; passes after. |
| R7 | Changed `reach.routes` in `src/core/impact/query.ts` to count distinct reached route files (`[...reachedFiles].filter((file) => matchAny(this.impact.routes, file)).length`) with the required comment until M4a provides route records. | `tests/core/impact-risk.test.ts` (`R7: reach.routes counts distinct route files, not reached symbols in route files`). Observed failing before the fix; passes after. |
| R8 | No code change required before Round 3 whole-call latency measurement (`No change before the measurement`). | — |

### 2. Local checks and mutation smoke

```text
npm test
ℹ tests 546
ℹ suites 42
ℹ pass 546
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0

npm run typecheck      exit 0
npm run lint           exit 0
npm run format:check   All matched files use Prettier code style!
npm run check:dist     exit 0
```

Mutation smoke over 31 targeted mutants (Round 1 `keyof`/metadata/generics K01–K08, B01–B02, G01–G06; D55 items 4–6; query-core controls Q01–Q06; Round 5 controls R1-M, R2-M, R3-M, R4-M, R6-M, R7-M): **VERIFIED 31/31 killed, 0 survived**.

### 3. oh-my-pi 200-target distribution and 10 hand-checked lows

**NOT VERIFIED** on this machine: the `/var/tmp/m2a2/omp-src` checkout and its cached index (`~/.cache/ksd-intelligence/6245da6948cefc28/index.sqlite`) from the Linux WSL2 sessions do not exist on this macOS machine, and cloning or fetching external repositories is prohibited by `AGENTS.md`.

## Round 3 — Step 3: tool, CLI, rendering, live, latency

**VERIFIED:** macOS Darwin 27.0.0 arm64, Node `24.22.0`, TypeScript `5.9.3`, OMP `18.22.0` (`/Users/mezn/Library/Application Support/Tern/omp/bin/omp`). Implementing model: Gemini 4 Argon (High).

### 1. OMP extension types inspected before changing `src/adapters/omp/extension.ts`

- `omp --version` → `omp/18.22.0`
- `/Users/mezn/.bun/install/cache/@oh-my-pi/pi-coding-agent@18.16.0@@@1/dist/types/extensibility/extensions/types.d.ts` (`ExtensionAPI`, `ToolDefinition`, `AgentToolUpdateCallback`, `ExtensionContext`)
- `/Users/mezn/.bun/install/cache/@oh-my-pi/pi-coding-agent@18.16.0@@@1/src/extensibility/extensions/wrapper.ts`
- `/Users/mezn/.bun/install/cache/@oh-my-pi/omptype@18.16.0@@@1/src/zod.ts` (`pi.zod`: `string`, `number`, `array`, `enum`, `object`, `.int()`, `.min()`, `.max()`, `.optional()`, `.describe()`)
- `/Users/mezn/.bun/install/cache/@oh-my-pi/pi-agent-core@18.16.0@@@1/dist/types/types.d.ts` (`AgentToolResult`)

### 2. Pre-Step-3 oh-my-pi 200-target re-run and 20 lows after D56

**NOT VERIFIED** on this machine: `/var/tmp/m2a2/omp-src` and its cached SQLite index from the Linux WSL2 environment do not exist on this macOS machine, and cloning external repositories from the network is forbidden by `AGENTS.md`. (From the Round 2b tables in §5 above, every top-20 `string-name-match` and `unresolved-name-match` name with >10 declarations sharing the name — e.g. `type` 1,108, `name` 996, `id` 984, `model` 503, `path` 432, `input` 393, `status` 387, `output` 362, `cwd` 295, `error` 293, `role` 230, `key` 226, `session` 220, `close` 219, `data` 169, `body` 128, `default` 123, `summary` 118, `run` 114, `headers` 102, `detail` 50, `dir` 47, `response` 35, `fixture` 22 — exceeds `impact.commonName = 10` and converts from a completeness reason into the `common-name` factor (`medium`), so D56 cannot introduce any new `low`; live execution on `/var/tmp/m2a2/omp-src` remains **NOT VERIFIED** here.)

### 3. Snapshots (`PROPOSED` for owner review)

All 11 snapshots are written under `tests/snapshots/impact/` and verified by `tests/core/impact-render.test.ts`:

- `tests/snapshots/impact/C01.txt` (**PROPOSED**)
- `tests/snapshots/impact/C06.txt` (**PROPOSED**)
- `tests/snapshots/impact/C11.txt` (**PROPOSED**)
- `tests/snapshots/impact/C13.txt` (**PROPOSED**)
- `tests/snapshots/impact/C14.txt` (**PROPOSED**)
- `tests/snapshots/impact/C15.txt` (**PROPOSED**)
- `tests/snapshots/impact/C26.txt` (**PROPOSED**)
- `tests/snapshots/impact/batch-3.txt` (**PROPOSED**)
- `tests/snapshots/impact/over-budget.txt` (**PROPOSED**)
- `tests/snapshots/impact/d51-parent.txt` (**PROPOSED**)
- `tests/snapshots/impact/stale-index.txt` (**PROPOSED**)

### 4. Live OMP smoke on `ksd-intelligence` (macOS Darwin 27.0.0 arm64, `omp/18.22.0`)

Commands executed:

```sh
node dist/adapters/cli/main.js index --full
omp -p --no-session --no-extensions --model claude-haiku-4-5 -e dist/adapters/omp/extension.js \
  "Call the ei_impact tool three separate times (or once per target): 1) targets: ['Graph.incoming'], 2) targets: ['status'], 3) targets: ['calcFee']. Print each tool output verbatim."
```

Verbatim tool outputs from the live OMP run:

```text
IMPACT Graph.incoming — src/core/graph/graph.ts:44
ACTION proceed · level low · picture complete
REACH 0 direct · 0 total · 0 files · 0 packages · 0 routes · factors: none

Callers: none
Tests: none
Gaps: none
Next: make your change and call ei_changes before you report done.
— index fresh · 372 files · limits: 1 unbounded dynamic import, 175 excluded files · ts 5.9.3 · engine 0.1.0
```

```text
AMBIGUOUS status — 4 declarations. Call again with one of:
  src/core/engine/host.ts#EngineHost.status
  src/core/kernel/types.ts#Completeness.status
  src/core/workspace/scan.ts#CensusRecord.status
  src/storage/sqlite.ts#FileRecord.status
```

```text
NOT FOUND calcFee.
If the symbol is new and unsaved, save the file and call again.
```

### 5. Whole-call latency and 1-file body-edit drift

- **On `/var/tmp/m2a2/omp-src` (`oh-my-pi`):** **NOT VERIFIED** on this macOS machine (`/var/tmp/m2a2/omp-src` is absent).
- **On `ksd-intelligence` (372 scanned files, 48 indexable files, 1,317 declarations, 2,852 edges) — VERIFIED on macOS arm64:**

| Stage | p50 (ms) | p95 (ms) | Max (ms) |
|---|---:|---:|---:|
| `probe` (`readFiles` + stat probe) | 20.20 | 24.10 | 30.46 |
| `open` (`openPublished` + `new ImpactQuery`) | 2.23 | 2.62 | 3.53 |
| `traverse` (`query.query`) | 0.26 | 0.79 | 1.10 |
| `render` (`renderAnswer`) | 0.05 | 0.16 | 8.11 |
| **Whole call (`total`)** | **22.79** | **27.44** | **42.90** |

- **5,000-caller synthetic target (`tests/core/impact-render.test.ts`):** rendered within the 4,000-char budget in **3.52 ms** (< 300 ms).
- **One-file body edit (`src/core/graph/graph.ts`) on `ksd-intelligence`:** took freshness row 3 ("Drift, this session can take the lock" → `index.state === 'updated'`, `updatedFiles === 1`, footer `— index updated (1 file) · 372 files · limits: 1 unbounded dynamic import, 175 excluded files · ts 5.9.3 · engine 0.1.0`), wall time **671.80 ms**.

### 6. Local checks and mutation smoke

```text
npm test               tests 563 · suites 44 · pass 563 · fail 0 · cancelled 0 · skipped 0
npm run typecheck      exit 0
npm run lint           exit 0
npm run format:check   All matched files use Prettier code style!
npm run check:dist     exit 0
```

Mutation smoke over 35 mutants (Round 1 K01–K08, B01–B02, G01–G06; D55 items 4–6; query-core controls Q01–Q06; Round 5 controls R1-M, R2-M, R3-M, R4-M, R6-M, R7-M; Round 3 rendering/tool controls R3-RenderStale, R3-Budget, R3-OneVerdict, R3-GuidanceError): **VERIFIED 35/35 killed, 0 survived**.



