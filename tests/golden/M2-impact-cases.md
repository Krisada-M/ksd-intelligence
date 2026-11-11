# Impact golden cases (owner-confirmed oracle)

**Status:** contract refreshed and all cases confirmed 2026-11-11. The owner delegated these decisions to the design review of that date (`docs/reviews/2026-11-11-senior-review.md`, DESIGN D32, D37); every box below is ticked on that authority. Earlier expectations written as `risk: …` are restated as `verdict.level: …` with the same meaning, plus the new reach and factor fields.

**Agent:** build the fixture described here, then turn every case into a test in the milestone named by its section. Never edit an `Expected` block, a policy, or a checkbox. If an expected value looks wrong or impossible, report it under QUESTIONS FOR OWNER and leave it. A case passes only if every stated assertion holds.

---

## Result contract (DESIGN §7.2, §7.4)

```ts
type Completeness = { status: 'complete' | 'partial' | 'unknown'; reasons: string[] };
type Strength = 'compiler' | 'syntax-exact' | 'scope-resolved' | 'heuristic' | 'unknown';
type EdgeKind = 'CALLS' | 'REFERENCES' | 'IMPORTS' | 'CONSTRUCTS' | 'IMPLEMENTS' | 'TESTS';

interface ImpactNode { symbol: string; via: EdgeKind; strength: Strength;
                       span: { file: string; startLine: number; endLine: number } }

interface Reach { direct: number; total: number; files: number; packages: number;
                  crossPackage: boolean; routes: number }

interface Verdict { level: 'low' | 'medium' | 'high' | 'critical' | 'unknown';
                    action: 'proceed' | 'run-tests' | 'check-gaps' | 'ask-owner';
                    zones: string[]; requiredActions: string[]; basis: string[] }

interface ImpactResult {
  target: string;                 // stable key, ADR 0002
  byDepth: ImpactNode[][];        // depth 1 = direct; --depth limits display only
  bridged: ImpactNode[];          // always [] until M4b
  tests: string[];
  completeness: Completeness;
  reach: Reach;
  factors: string[];
  verdict: Verdict;
  freshness: { workingTreeHash: string; includesUntracked: boolean };
}
```

An ambiguous or unknown target is a **guidance** outcome (`ambiguous-target`, `target-not-found`), not an `ImpactResult` and not an error.

### Assertion rules

- `byDepth[n]` is compared as a **set** of `symbol` + `via`, order-insensitive. "Includes" means the listed nodes must be present; extras are allowed unless the case says "exactly".
- `reasons` and `factors` are matched by **code** (the prefix before `:`).
- `--depth` limits only what is listed. Completeness, reach, factors and verdict always come from the full traversal (cap: depth 10; hitting it with unvisited nodes adds `depth-limit`).
- A case that names a symbol only as "a node in `<file>`" accepts any stable key in that file.

---

## Policies

### P1 — Verdict derivation
- [x] Owner confirmed

1. Completeness `partial` or `unknown` → `level: 'unknown'`, `action: 'check-gaps'`.
2. Complete with at least one factor → `level: 'medium'`, `action: 'run-tests'`.
3. Complete with no factor → `level: 'low'`, `action: 'proceed'`.
4. Risk zones (section "Policy and changes") only raise level and action.

`low` therefore means: the picture is complete **and** nothing reaches another package, a route, a public surface, a boundary, or many callers.

### P2 — Factors
- [x] Owner confirmed

| Factor | When |
|---|---|
| `public-export-surface` | target or an impacted symbol is reachable from the entry of a workspace package that is not `"private": true` |
| `route` | an impacted symbol is in a file matched by `impact.routes` (or, from M4a, detected as a route) |
| `cross-package` | an impacted symbol is in a different workspace package than the target |
| `many-callers` | `reach.total` ≥ `impact.manyCallers` (default 10) |
| `boundary:sql`, `boundary:native` | target's file or an impacted symbol's file talks to a database or native module (detection defaults in `docs/RISK.md` §3.2) |

Public surface and boundaries are factors, not completeness gaps.

### P3 — Codes
- [x] Owner confirmed

Completeness reasons: `dynamic-import`, `computed-member-access`, `interface-dispatch`, `parse-error`, `unsupported-syntax`, `cjs-require`, `unresolved-import`, `unresolved-name-match`, `string-name-match`, `outside-index-scope`, `depth-limit`, `stale-index`, `engine-self-check-failed`.
Guidance: `index-building`, `ambiguous-target`, `target-not-found`. Failure: `index-failed`.
Adding a code needs an ADR and the owner.

### P4 — Scoping of completeness gaps
- [x] Owner confirmed

- `parse-error`: affects every target in the index scope. The base fixture must parse cleanly; C16 uses a copy.
- `dynamic-import` with a computed specifier: affects targets in files its static prefix can match.
- `computed-member-access`: affects values stored in the accessed object.
- `interface-dispatch`: affects implementations of that interface member.
- `unresolved-name-match`, `string-name-match`: affect the declaration whose name matched.

---

## Fixture: `tests/fixtures/mono`

The base fixture type-checks and parses cleanly. Cases that need broken or mutated code run on a temp copy. Freshness and mutation cases run with `impact.freshness: "hash"`.

```text
mono/
├── ei.config.json                # { "impact": { "routes": ["packages/api/src/routes.ts"] }, "riskZones": [] }
├── tsconfig.base.json            # paths: "@fx/shared/*" -> packages/shared/src/*; allowJs: true
├── packages/
│   ├── shared/
│   │   ├── package.json          # "private": true
│   │   └── src/
│   │       ├── money.ts          # export function roundMoney()
│   │       └── legacy.cjs        # module.exports = { toCents }
│   ├── payments/
│   │   ├── package.json          # name "@fx/payments", main src/index.ts, NOT private (public surface)
│   │   └── src/
│   │       ├── index.ts          # export * from './fee'; export { default as PaymentService } from './service'
│   │       │                     #   (does NOT export processor/stripe/manual/checkout-flow/cycle files)
│   │       ├── fee.ts            # calculateFee() (2 overloads + impl), type Fee, unusedHelper(), non-exported localOnly()
│   │       │                     #   calculateFee calls roundMoney and require('…/legacy.cjs').toCents
│   │       ├── fee.test.ts       # tests calculateFee
│   │       ├── service.ts        # default class PaymentService { charge() } — charge() calls calculateFee
│   │       ├── processor.ts      # interface PaymentProcessor { charge(): void }
│   │       ├── stripe.ts         # class StripeProcessor implements PaymentProcessor
│   │       ├── manual.ts         # class ManualProcessor implements PaymentProcessor
│   │       ├── checkout-flow.ts  # runCheckout(p: PaymentProcessor) { p.charge() }
│   │       │                     # normalizeAll(items) { return items.map(roundMoney) }
│   │       │                     # async lazyFee() { (await import('./fee')).calculateFee(...) }
│   │       ├── cycle-a.ts        # export function a() calls b()
│   │       └── cycle-b.ts        # export function b() calls a()
│   └── api/
│       ├── package.json          # "private": true
│       └── src/
│           ├── routes.ts         # export const routes = { 'POST /charge': chargeHandler }
│           ├── charge.ts         # chargeHandler: new PaymentService().charge(); calculateFee(...) via '@fx/payments'
│           ├── handlers.ts       # loadHandler(name) { return import(`./handlers/${name}`) }
│           │                     # const registry = { charge: chargeHandler }; run(key) { registry[key]() }
│           ├── handlers/refund.ts  # export function refund()
│           └── report.js         # plain JS: function report() calls roundMoney
└── apps/web/
    ├── package.json              # "private": true
    └── src/checkout.ts           # import { calculateFee as fee } from '@fx/payments'; import type { Fee } …
                                  # export function submit() { fee(...) }
```

The agent may add files a case needs and lists them in the report. No added file may change another case's expected result.

---

## Engine cases (M2b)

### C01 — Direct call
- [x] Owner confirmed

**Query:** `impact packages/payments/src/fee.ts#calculateFee --depth 1`
**Expected:**
- `byDepth[0]` includes `packages/payments/src/service.ts#PaymentService.charge` via `CALLS`, strength `compiler`.
- `completeness.status: 'complete'`; `factors` include `public-export-surface`, `route`, `cross-package`; `reach.crossPackage: true`; `reach.routes` ≥ 1.
- `verdict.level: 'medium'`, `verdict.action: 'run-tests'`.

### C02 — Barrel re-export
- [x] Owner confirmed

**Query:** `impact packages/payments/src/fee.ts#calculateFee`
**Expected:** `byDepth[0]` includes `packages/api/src/charge.ts#chargeHandler` via `CALLS` (import goes through the `@fx/payments` barrel; the target is the declaration in `fee.ts`, not `index.ts`). `verdict.level: 'medium'`.

### C03 — Aliased import
- [x] Owner confirmed

**Query:** `impact packages/payments/src/fee.ts#calculateFee`
**Expected:** `byDepth[0]` includes `apps/web/src/checkout.ts#submit` via `CALLS`. No result anywhere has a target or node named `fee` as if it were a separate declaration.

### C04 — tsconfig `paths` alias
- [x] Owner confirmed

**Query:** `impact packages/shared/src/money.ts#roundMoney --depth 2`
**Expected:**
- `byDepth[0]` includes `packages/payments/src/fee.ts#calculateFee` via `CALLS` (imported as `@fx/shared/money`).
- `byDepth[1]` includes `packages/payments/src/service.ts#PaymentService.charge` and `packages/api/src/charge.ts#chargeHandler`.
- `factors` include `public-export-surface`, `route`, `cross-package`; `verdict.level: 'medium'`.

### C05 — Default export renamed through the barrel
- [x] Owner confirmed

**Query:** `impact packages/payments/src/service.ts#PaymentService.charge`
**Expected:** `byDepth[0]` includes `packages/api/src/charge.ts#chargeHandler` via `CALLS`. Query `impact …/service.ts#PaymentService` includes `chargeHandler` via `CONSTRUCTS`. `verdict.level: 'medium'`.

### C06 — Interface dispatch
- [x] Owner confirmed

**Query:** `impact packages/payments/src/stripe.ts#StripeProcessor.charge`
**Expected:**
- `byDepth[0]` includes `packages/payments/src/checkout-flow.ts#runCheckout` via `CALLS`, strength `heuristic` (the call is on `PaymentProcessor`).
- `completeness.status: 'partial'`, reasons include `interface-dispatch`.
- `verdict.level: 'unknown'`, `verdict.action: 'check-gaps'`.

### C07 — Callback reference (not a call)
- [x] Owner confirmed

**Query:** `impact packages/shared/src/money.ts#roundMoney`
**Expected:** `byDepth[0]` includes `packages/payments/src/checkout-flow.ts#normalizeAll` via `REFERENCES`, **not** `CALLS`.

### C08 — Overloads
- [x] Owner confirmed

**Query:** `impact packages/payments/src/fee.ts#calculateFee`
**Expected:** call sites using either overload resolve to the single target key. Querying by the line of either overload signature (`path:line`) returns the same `target`.

### C09 — Type-only import
- [x] Owner confirmed

**Query:** `impact packages/payments/src/fee.ts#Fee`
**Expected:** `byDepth[0]` includes a node in `apps/web/src/checkout.ts` via `REFERENCES`. No `CALLS` edge comes from the type-only import, and callers of `calculateFee` are not pulled into this result. `factors` include `public-export-surface`; `verdict.level: 'medium'`.

### C10 — Literal dynamic import (resolvable)
- [x] Owner confirmed

**Query:** `impact packages/payments/src/fee.ts#calculateFee`
**Expected:** `byDepth[0]` includes `packages/payments/src/checkout-flow.ts#lazyFee` via `CALLS`, strength `scope-resolved` or `compiler`. This site adds no completeness reason.

### C11 — Computed dynamic import (unresolvable)
- [x] Owner confirmed

**Query:** `impact packages/api/src/handlers/refund.ts#refund`
**Expected:** `completeness.status: 'partial'`, reasons include `dynamic-import: packages/api/src/handlers.ts:<line>`; `verdict.level: 'unknown'`, `action: 'check-gaps'`. Per P4, this reason does **not** appear in C01–C10.

### C12 — Route table and computed registry access
- [x] Owner confirmed

**Query:** `impact packages/api/src/charge.ts#chargeHandler`
**Expected:**
- `byDepth[0]` includes a node in `packages/api/src/routes.ts` via `REFERENCES` and a node in `packages/api/src/handlers.ts` via `REFERENCES`.
- `completeness.status: 'partial'`, reasons include `computed-member-access`.
- `factors` include `route` (factors are reported even when the level is `unknown`).
- `verdict.level: 'unknown'`.

### C13 — Zero callers, public export
- [x] Owner confirmed

**Query:** `impact packages/payments/src/fee.ts#unusedHelper`
**Expected:** `byDepth: []`; `reach.total: 0`; `completeness.status: 'complete'`; `factors` include `public-export-surface`; `verdict.level: 'medium'`. Must **not** be `low`.

### C14 — Zero callers, not exported, fully indexed
- [x] Owner confirmed

**Query:** `impact packages/payments/src/fee.ts#localOnly`
**Expected:** `byDepth: []`; `reach` all zero / `crossPackage: false`; `completeness.status: 'complete'`; `factors: []`; `verdict.level: 'low'`, `action: 'proceed'`. This case proves the engine does not answer `unknown` or `medium` for everything.

### C15 — Ambiguous target name
- [x] Owner confirmed

**Query:** `impact charge` (bare name)
**Expected:** guidance `ambiguous-target`, no merged result. Candidates are exactly: `packages/payments/src/service.ts#PaymentService.charge`, `packages/payments/src/stripe.ts#StripeProcessor.charge`, `packages/payments/src/manual.ts#ManualProcessor.charge`, `packages/payments/src/processor.ts#PaymentProcessor.charge`.

### C16 — Parse error in scope (temp copy)
- [x] Owner confirmed

**Steps:** copy the fixture; add `packages/api/src/broken.ts` with a syntax error; query `impact packages/payments/src/fee.ts#calculateFee`.
**Expected:** callers still returned (as C01–C03); `completeness.status: 'partial'`, reasons include `parse-error: packages/api/src/broken.ts`; `verdict.level: 'unknown'`.

### C17 — CommonJS `require`
- [x] Owner confirmed

**Query:** `impact packages/shared/src/legacy.cjs#toCents`
**Expected (either passes):** **A:** `byDepth[0]` includes `packages/payments/src/fee.ts#calculateFee` via `CALLS`, status `complete`, level `medium`. **B:** status `partial`, reasons include `cjs-require`, level `unknown`. **Fails:** zero callers with status `complete`. The report states which outcome occurred.

### C18 — Plain JS caller (allowJs)
- [x] Owner confirmed

**Query:** `impact packages/shared/src/money.ts#roundMoney`
**Expected:** `byDepth[0]` includes `packages/api/src/report.js#report` via `CALLS`.

### C19 — Circular calls, same package, not exported from the barrel
- [x] Owner confirmed

**Query:** `impact packages/payments/src/cycle-a.ts#a --depth 5`
**Expected:** terminates. `byDepth[0]` is exactly `{ packages/payments/src/cycle-b.ts#b via CALLS }`; each symbol appears once at its shallowest depth; the target is not its own caller. `reach.direct: 1`, `reach.crossPackage: false`; `factors: []`; `verdict.level: 'low'`.

### C20 — Test adjacency
- [x] Owner confirmed

**Query:** `impact packages/payments/src/fee.ts#calculateFee`
**Expected:** `tests` includes `packages/payments/src/fee.test.ts`.

### C21 — JSX reference
- [x] Owner confirmed

**Setup:** add `apps/web/src/Button.tsx` (`export function Button()`) and `apps/web/src/Pay.tsx` (`export function Pay()` rendering `<Button />`).
**Query:** `impact apps/web/src/Button.tsx#Button`
**Expected:** `byDepth[0]` includes `apps/web/src/Pay.tsx#Pay` via `REFERENCES`, strength `compiler`; status `complete`.

### C22 — Unresolved name match (temp copy)
- [x] Owner confirmed

**Steps:** add `packages/payments/src/loose.js` with `function loose(obj) { obj.localOnly() }` (untyped `obj`). Query `impact packages/payments/src/fee.ts#localOnly`.
**Expected:** `completeness.status: 'partial'`, reasons include `unresolved-name-match: packages/payments/src/loose.js:<line>`; `verdict.level: 'unknown'`. (C14 on the base fixture stays `low`.)

### C23 — String name match (temp copy)
- [x] Owner confirmed

**Steps:** add `packages/api/src/names.ts` with `export const k = 'unusedHelper'`. Query `impact packages/payments/src/fee.ts#unusedHelper`.
**Expected:** reasons include `string-name-match`; `completeness.status: 'partial'`; `verdict.level: 'unknown'`.

### C24 — SQL boundary
- [x] Owner confirmed

**Setup:** add `packages/api/src/db.ts` importing `pg`, with `export function findUser()`, called from nowhere else.
**Query:** `impact packages/api/src/db.ts#findUser`
**Expected:** `factors` include `boundary:sql`; `completeness.status: 'complete'` (the boundary is not a gap); `verdict.level: 'medium'`.

### C25 — Route glob
- [x] Owner confirmed

**Steps (temp copy):** set `impact.routes` to `["apps/web/app/**/page.tsx"]`; add `apps/web/app/pay/page.tsx` whose default export calls `calculateFee`. Query `calculateFee`.
**Expected:** `factors` include `route`; `reach.routes` ≥ 1.

### C26 — Many callers threshold (temp copy)
- [x] Owner confirmed

**Steps:** add `packages/shared/src/many.ts` with a non-exported `tiny()` and nine non-exported module-level functions that each call it. Query `impact packages/shared/src/many.ts#tiny`; then add a tenth caller and query again.
**Expected:** with nine callers: `reach.total: 9`, `factors: []`, `verdict.level: 'low'`. With ten: `reach.total: 10`, `factors` include `many-callers`, `verdict.level: 'medium'`.

---

## Freshness cases (M2a for index equality, M2b for query results)

Temp copy, initialised as a git repo with the base fixture committed, `impact.freshness: "hash"`.

### F01 — Uncommitted edit
- [x] Owner confirmed

**Steps:** query `calculateFee`; add a function in `packages/api/src/charge.ts` that calls `calculateFee`, **without committing**; query again.
**Expected:** the new function is a depth-1 caller in the second result; `freshness.workingTreeHash` differs.

### F02 — Untracked new file
- [x] Owner confirmed

**Steps:** create untracked `packages/api/src/extra.ts` calling `calculateFee`; query.
**Expected:** a node in `extra.ts` is a depth-1 caller; `freshness.includesUntracked: true`.

### F03 — Rename and delete
- [x] Owner confirmed

**Steps:** rename `apps/web/src/checkout.ts` → `apps/web/src/pay.ts`; query `calculateFee`; delete `pay.ts`; query again.
**Expected:** first result has the caller under `pay.ts` and nothing under `checkout.ts`; second has neither. No stale edges.

### F04 — Barrel change
- [x] Owner confirmed

**Steps:** remove `export * from './fee'` from `packages/payments/src/index.ts`; query `calculateFee`.
**Expected:** callers importing through `@fx/payments` are no longer `CALLS` edges; `completeness.status: 'partial'`, reasons include `unresolved-import` at those import sites; `verdict.level: 'unknown'`. Broken imports never disappear silently.

### F05 — Incremental equals full rebuild
- [x] Owner confirmed

**Steps:** after each of F01–F04, compare the incrementally updated index to a full rebuild on the same working tree.
**Expected:** canonicalised indexes (sorted declarations, edges, unresolved records, reasons) are identical. A difference fails the test and prints the diff. The seeded randomised test (DESIGN D36) extends this beyond the scripted steps.

### F06 — The probe's blind spot, documented
- [x] Owner confirmed

**Steps:** with `impact.freshness: "stat"`: query; overwrite a file with different content of the **same byte length** and restore its previous mtime; query again; then run `ei index`.
**Expected:** the second query may return the old result (this is the accepted blind spot; the test asserts nothing about it except that it does not crash). `ei index` (full hash) detects the change and the next query reflects it.

---

## Policy and changes cases (M2c)

Run with `riskZones: "default"` (payments, auth, migrations, prod-config; `docs/RISK.md` §2.1). `ChangesResult` is defined in `docs/RISK.md` §2.4.

### P01 — Zone raises a complete, quiet target
- [x] Owner confirmed

**Query:** `impact packages/payments/src/fee.ts#localOnly`
**Expected:** `factors: []`, completeness `complete`; `verdict.level: 'high'`, `action: 'run-tests'`, `zones: ['payments']`.

### P02 — Zone plus incomplete picture
- [x] Owner confirmed

**Query:** `impact packages/payments/src/stripe.ts#StripeProcessor.charge`
**Expected:** `verdict.level: 'high'`, `action: 'ask-owner'`, `zones` include `payments`.

### P03 — Zone reached through impacted symbols
- [x] Owner confirmed

**Query:** `impact packages/shared/src/money.ts#roundMoney`
**Expected:** `zones` include `payments` (impacted symbols live there); `verdict.level: 'high'`, `action: 'run-tests'`.

### P04 — No zone, incomplete picture
- [x] Owner confirmed

**Query:** `impact packages/api/src/handlers/refund.ts#refund`
**Expected:** `zones: []`; `verdict.level: 'unknown'`, `action: 'check-gaps'`.

### P05 — Unindexed change in a critical zone (temp copy)
- [x] Owner confirmed

**Steps:** add untracked `packages/api/migrations/001.sql`; run `changes`.
**Expected:** `unindexedChanges` includes the file; reasons include `outside-index-scope`; `verdict.level: 'critical'`, `action: 'ask-owner'`, `zones` include `migrations`.

### X01 — Diff union (temp copy)
- [x] Owner confirmed

**Steps:** modify the bodies of `calculateFee` and `roundMoney`; run `changes`.
**Expected:** `changedSymbols` is exactly those two, both `modified`; `impact.byDepth[0]` is the union of both caller sets; `tests` includes `packages/payments/src/fee.test.ts`.

### X02 — Signature change with live callers (temp copy)
- [x] Owner confirmed

**Steps:** add a required parameter to `calculateFee`; run `changes`.
**Expected:** `changedSymbols` has `calculateFee` as `signature-changed`, listed first with its callers.

### X03 — Nothing hidden (temp copy)
- [x] Owner confirmed

**Steps:** any change set used in P05, X01, X02.
**Expected:** every changed path appears either in `changedFiles` with `indexed: true` or in `unindexedChanges`.

---

## Decision log

| # | Decision | Date |
|---|---|---|
| G1 | Verdict derivation P1; no separate engine "risk" value (DESIGN D32) | 2026-11-11 |
| G2 | Factors P2, including `cross-package` and `many-callers` (default 10) | 2026-11-11 |
| G3 | C06: interface call sites listed as `heuristic` plus `interface-dispatch` | 2026-11-09 |
| G4 | C13: zero-caller public export is `medium` through the factor, never `low` | 2026-11-09 |
| G5 | C17: resolved CJS or `partial` + `cjs-require`; never complete-with-zero | 2026-11-09 |
| G6 | F04: reason code `unresolved-import` | 2026-11-09 |
| G7 | Analysis on the full traversal; `--depth` is display-only | 2026-11-09 |
| G8 | Gaps scoped to reachable targets (P4); base fixture parses cleanly | 2026-11-09 |
| G9 | Routes declared in `impact.routes`; detection added by M4a | 2026-11-11 |
| G10 | Name cross-check cases C22–C23 and boundary case C24 are engine cases (M2b) | 2026-11-11 |
| G11 | Freshness cases run with full hashing; F06 documents the stat probe's blind spot | 2026-11-11 |
| G12 | Policy and changes cases P01–P05, X01–X03 confirmed for M2c | 2026-11-11 |

Bridge cases (M4b) and route-detection cases (M4a) are written and confirmed when those milestones are briefed.
