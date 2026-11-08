# M2 — `ei_impact` golden cases (owner-confirmed oracle)

**Owner:** fill in or correct every `Expected` block, then tick `Owner confirmed`. Expected values marked `PROPOSED` are a starting suggestion only. Do not tick a box you have not thought through: these answers are the oracle the agent is graded against.

**Agent:** build the fixture described here, then turn each confirmed case into a test. Never edit an `Expected` block or tick a box. Cases without `[x] Owner confirmed` are skipped and listed in your report. If an expected value looks wrong, report it and leave it.

---

## Result contract (what every case asserts against)

```ts
type Risk = 'low' | 'medium' | 'high' | 'critical' | 'unknown';
type Completeness = 'complete' | 'partial' | 'unknown';
type Strength = 'compiler' | 'syntax-exact' | 'scope-resolved' | 'heuristic' | 'unknown';
type EdgeKind = 'CALLS' | 'REFERENCES' | 'IMPORTS' | 'CONSTRUCTS' | 'IMPLEMENTS' | 'TESTS';

interface ImpactNode {
  symbol: string;        // stable key: "<repo-relative path>#<qualified name>"
  via: EdgeKind;
  strength: Strength;
  span: { file: string; startLine: number; endLine: number };
}

interface ImpactResult {
  target: string;                      // resolved stable key, or error if ambiguous
  byDepth: ImpactNode[][];             // depth 1 = direct
  tests: string[];                     // test files reaching the target
  risk: Risk;
  completeness: { status: Completeness; reasons: string[] };
  freshness: { workingTreeHash: string; includesUntracked: boolean };
}
```

Assertion rules, unless a case says otherwise:

- `byDepth[0]` is compared as a **set** of `symbol` + `via` (order-insensitive). Spans are checked only for line numbers the case names.
- `reasons` is matched by **reason code** (prefix before `:`), e.g. `dynamic-import: packages/api/src/handlers.ts:12`.
- Risk policy (owner to confirm once, applies to all cases):
  - `low` only if `completeness.status === 'complete'` **and** no caller is on a public export surface or route.
  - Any `partial` / `unknown` completeness → risk is never `low`.

- [ ] Owner confirmed risk policy

Reason codes the agent must use (extend only with owner approval):
`dynamic-import`, `computed-member-access`, `string-registry`, `public-export-surface`, `interface-dispatch`, `parse-error`, `unsupported-syntax`, `ambiguous-target`, `cjs-require`, `outside-index-scope`.

---

## Fixture: `tests/fixtures/mono`

A small pnpm-style workspace (no install needed; resolution via `tsconfig` paths and project references).

```text
mono/
├── tsconfig.base.json            # paths: "@fx/shared/*" -> packages/shared/src/*
├── packages/
│   ├── shared/src/
│   │   ├── money.ts              # export function roundMoney()
│   │   └── legacy.cjs            # module.exports = { toCents }
│   ├── payments/
│   │   ├── package.json          # name "@fx/payments", main src/index.ts
│   │   └── src/
│   │       ├── index.ts          # export * from './fee'; export { default as PaymentService } from './service'
│   │       ├── fee.ts            # calculateFee() (+ overloads), type Fee, unusedHelper(), private localOnly()
│   │       ├── fee.test.ts
│   │       ├── service.ts        # default class PaymentService { charge() }
│   │       ├── processor.ts      # interface PaymentProcessor { charge() }
│   │       ├── stripe.ts         # class StripeProcessor implements PaymentProcessor
│   │       ├── manual.ts         # class ManualProcessor implements PaymentProcessor
│   │       └── cycle-a.ts / cycle-b.ts   # import each other
│   └── api/src/
│       ├── routes.ts             # route table: { 'POST /charge': chargeHandler }
│       ├── charge.ts             # chargeHandler; uses calculateFee via '@fx/payments'
│       ├── handlers.ts           # import(`./handlers/${name}`) and registry['charge']()
│       ├── broken.ts             # deliberate syntax error
│       └── report.js             # allowJs file calling roundMoney
└── apps/web/src/
    └── checkout.ts               # import { calculateFee as fee } from '@fx/payments'
```

The agent may add files if a case needs them; list additions in the report.

---

## Cases

### C01 — Direct call
**Query:** `impact packages/payments/src/fee.ts#calculateFee --depth 1`
**Setup:** `packages/payments/src/service.ts` `charge()` calls `calculateFee` via relative import.
**Expected (PROPOSED):** `byDepth[0]` includes `service.ts#PaymentService.charge` via `CALLS`, strength `compiler`.
- [ ] Owner confirmed

### C02 — Barrel re-export
**Setup:** `api/src/charge.ts` imports `calculateFee` from `@fx/payments` (resolved through `index.ts` `export *`).
**Expected (PROPOSED):** `charge.ts#chargeHandler` is a depth-1 `CALLS` caller of `fee.ts#calculateFee` (target is the declaration, not the barrel).
- [ ] Owner confirmed

### C03 — Aliased import
**Setup:** `apps/web/src/checkout.ts` uses `import { calculateFee as fee }` and calls `fee()`.
**Expected (PROPOSED):** `checkout.ts#<caller>` appears as a `CALLS` caller; the alias name `fee` does not appear as a separate target.
- [ ] Owner confirmed

### C04 — tsconfig `paths` alias
**Query:** `impact packages/shared/src/money.ts#roundMoney`
**Setup:** `fee.ts` imports `roundMoney` from `@fx/shared/money`.
**Expected (PROPOSED):** `fee.ts#calculateFee` is a depth-1 caller; depth 2 includes the callers from C01–C03.
- [ ] Owner confirmed

### C05 — Default export, renamed on import
**Query:** `impact packages/payments/src/service.ts#PaymentService.charge`
**Setup:** `api/src/charge.ts` does `new PaymentService().charge()` (imported via the barrel's `default as PaymentService`).
**Expected (PROPOSED):** `charge.ts#chargeHandler` via `CALLS`; also `CONSTRUCTS` edge to `PaymentService`.
- [ ] Owner confirmed

### C06 — Interface dispatch
**Query:** `impact packages/payments/src/stripe.ts#StripeProcessor.charge`
**Setup:** some code holds `processor: PaymentProcessor` and calls `processor.charge()`. Two implementations exist.
**Expected (PROPOSED):** the interface call site is listed, strength **not** `compiler` (e.g. `heuristic`); `completeness.status: 'partial'`, reason `interface-dispatch`; risk not `low`.
**Owner note:** decide whether interface call sites should be listed at all, or only reported as a reason.
- [ ] Owner confirmed

### C07 — Callback reference (not a call)
**Setup:** `items.map(roundMoney)` somewhere in `payments`.
**Expected (PROPOSED):** listed with `via: 'REFERENCES'`, not `CALLS`; still counts toward impact.
- [ ] Owner confirmed

### C08 — Overloads
**Setup:** `calculateFee` has two overload signatures and one implementation.
**Expected (PROPOSED):** all overload call sites resolve to the single `fee.ts#calculateFee` target; no duplicate targets per overload.
- [ ] Owner confirmed

### C09 — Type-only import
**Setup:** `checkout.ts` has `import type { Fee } from '@fx/payments'`.
**Query:** `impact packages/payments/src/fee.ts#Fee`
**Expected (PROPOSED):** `checkout.ts` listed via `REFERENCES`; `calculateFee` callers are **not** pulled in by the type-only import.
- [ ] Owner confirmed

### C10 — Literal dynamic import (resolvable)
**Setup:** `await import('./fee')` then `.calculateFee()` in a payments file.
**Expected (PROPOSED):** caller found via `CALLS`, strength `scope-resolved` or better; completeness unaffected.
- [ ] Owner confirmed

### C11 — Computed dynamic import (unresolvable)
**Setup:** `api/src/handlers.ts` has ``import(`./handlers/${name}`)``.
**Query:** impact on any function exported from a file under `api/src/handlers/`.
**Expected (PROPOSED):** `completeness.status: 'partial'`, reason `dynamic-import: api/src/handlers.ts:<line>`; risk `unknown`.
- [ ] Owner confirmed

### C12 — String-keyed registry / route table
**Query:** `impact packages/api/src/charge.ts#chargeHandler`
**Setup:** `routes.ts` maps `'POST /charge'` to `chargeHandler` (direct reference); `handlers.ts` also calls `registry['charge']()`.
**Expected (PROPOSED):** `routes.ts` listed via `REFERENCES` (it is a route, so risk ≥ `medium`); the `registry['charge']()` site produces reason `computed-member-access` and status `partial`.
- [ ] Owner confirmed

### C13 — Zero callers, but public export
**Query:** `impact packages/payments/src/fee.ts#unusedHelper`
**Setup:** exported through the package barrel; nothing in the fixture calls it.
**Expected (PROPOSED):** `byDepth: []`, reason `public-export-surface`, risk **not** `low` (`unknown` or `medium`; owner decides).
- [ ] Owner confirmed

### C14 — Zero callers, private and fully indexed
**Query:** `impact packages/payments/src/fee.ts#localOnly`
**Setup:** non-exported function, no references, file parses cleanly.
**Expected (PROPOSED):** `byDepth: []`, `completeness.status: 'complete'`, risk `low`. This is the one case where `low` is correct; it shows the engine is not just always returning `unknown`.
- [ ] Owner confirmed

### C15 — Ambiguous target name
**Query:** `impact charge` (bare name)
**Expected (PROPOSED):** no merged result; error `ambiguous-target` listing every candidate stable key (`PaymentService.charge`, `StripeProcessor.charge`, `ManualProcessor.charge`, `PaymentProcessor.charge`).
- [ ] Owner confirmed

### C16 — Parse error elsewhere in scope
**Setup:** `api/src/broken.ts` has a syntax error.
**Query:** any impact query in `api`.
**Expected (PROPOSED):** results still returned; `completeness.status: 'partial'`, reason `parse-error: api/src/broken.ts`. Never `complete`.
- [ ] Owner confirmed

### C17 — CommonJS `require`
**Setup:** `fee.ts` or a `.cjs` file uses `require('./legacy.cjs').toCents()`.
**Query:** `impact packages/shared/src/legacy.cjs#toCents`
**Expected (PROPOSED):** owner decides: either resolved (`scope-resolved`) or reported with reason `cjs-require` and status `partial`. Must not silently return zero callers with `complete`.
- [ ] Owner confirmed

### C18 — Plain JS caller (allowJs)
**Setup:** `api/src/report.js` calls `roundMoney`.
**Expected (PROPOSED):** listed as a caller of `money.ts#roundMoney`.
- [ ] Owner confirmed

### C19 — Circular imports
**Setup:** `cycle-a.ts` ↔ `cycle-b.ts` call each other.
**Query:** `impact cycle-a.ts#a --depth 5`
**Expected (PROPOSED):** terminates; each symbol appears once (at its shallowest depth); no error.
- [ ] Owner confirmed

### C20 — Test adjacency
**Query:** `impact packages/payments/src/fee.ts#calculateFee`
**Expected (PROPOSED):** `tests` contains `packages/payments/src/fee.test.ts`.
- [ ] Owner confirmed

---

## Freshness cases (run on a temp copy of the fixture, initialized as a git repo)

### F01 — Uncommitted edit
**Steps:** index; add a new call to `calculateFee` in an existing file **without committing**; query again.
**Expected (PROPOSED):** new caller present; `freshness.workingTreeHash` differs from the first query.
- [ ] Owner confirmed

### F02 — Untracked new file
**Steps:** create a new untracked file that calls `calculateFee`; query.
**Expected (PROPOSED):** caller present; `includesUntracked: true`.
- [ ] Owner confirmed

### F03 — Rename and delete
**Steps:** rename `checkout.ts` → `pay.ts`; query; then delete `pay.ts`; query.
**Expected (PROPOSED):** first query shows the caller under the new path only; second shows neither. No stale edges.
- [ ] Owner confirmed

### F04 — Barrel change
**Steps:** remove `export * from './fee'` from `index.ts`; query `calculateFee`.
**Expected (PROPOSED):** callers that imported through `@fx/payments` disappear and surface as resolution errors in `reasons` (or a dedicated `unresolved-import` reason; owner decides), not as silent omissions.
- [ ] Owner confirmed

### F05 — Incremental equals full rebuild
**Steps:** after each of F01–F04, compare the incremental graph to a full rebuild from scratch.
**Expected (PROPOSED):** canonicalized graphs identical. Any difference fails the test and prints the diff.
- [ ] Owner confirmed

---

## Owner decisions collected by this file

1. Risk policy (top of file).
2. C06: list interface call sites, or reason only?
3. C13: risk for unused public export: `unknown` or `medium`?
4. C17: support CJS `require` in M2, or report `cjs-require`?
5. F04: new `unresolved-import` reason code?
