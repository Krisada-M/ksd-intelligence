# F4 / F7 baseline reproduction

Baseline: `6be6c2e77b5e5d4ae79e3e487b40e8fcd54cb6dc`, extracted with `git archive` into `/tmp/r6-f4-f7.ust6vr`; no source checkout was edited. Local `node_modules` symlinked from `/tmp/ksd-wt/01/node_modules`; no install or network.

Temporary harness: `/tmp/r6-f4-f7.ust6vr/tests/core/f4-f7.test.ts`, built with repository `tests/tsconfig.json`. The harness creates temporary fixture repositories, indexes them using baseline `Indexer`, and queries using baseline `ImpactQuery`.

## F4 — asserted and nested element access

The fixture uses an asserted object literal (`const asserted = { fn: targetFn } as Record<string, () => number>`) and a nested object literal (`nested.handlers[k]`). Expected behavior is partial completeness with computed-member-access coverage. The fixed-behavior assertion failed on baseline:

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected
+ 'complete'
- 'partial'
```

The baseline characterization (actual `complete` with no reasons) passed in the later combined run. The asserted+nested case is combined, so this confirms missing gap coverage for the combined scenario, not separate attribution to each initializer form.

## F7 — precise resolution behavior

D59 specifies bare-name candidates as the union of `d.name` and `d.simple`; `path:line` selects the innermost declaration by smallest span, then deepest key, and only a remaining tie is ambiguous; an ambiguous parent in fallback returns that parent's candidates. Therefore the routes same-line case expects the inner `routes.POST /charge` declaration, not ambiguity. A separate destructuring-free declaration tie (`export const a = 1, b = 2;`) exercises equal-span/equal-depth ambiguity.

Fixtures and targets:
- `top-charge.ts`: module-level `charge` plus class members `A.charge`, `B.charge`; query `charge` should be ambiguous.
- `routes.ts`: `export const routes = { 'POST /charge': handler };` on line 2; query `routes.ts:2` should resolve inner `routes.POST /charge`.
- `tie.ts`: `export const a = 1, b = 2;`; query line 1 should be ambiguous.
- Two files declare `Usage.cost`; query `Usage.cost.input` should return ambiguous candidates for the nearest ambiguous parent, `Usage.cost`.

Command:
```sh
./node_modules/.bin/tsc -p tests/tsconfig.json
node --test --test-name-pattern='F7' dist-test/tests/core/f4-f7.test.js
```

Exit: 1. Exact output (duration values from this run):
```text
▶ baseline F4/F7
  ✔ F4 nested and asserted element accesses produce target-scoped gaps (365.675125ms)
F7 observed summary: [{"label":"bare","kind":"result","target":"packages/api/src/top-charge.ts#charge"},{"label":"innermost-span","kind":"result","target":"packages/api/src/routes.ts#routes"},{"label":"equal-span-tie","kind":"result","target":"packages/api/src/tie.ts#a"},{"label":"ambiguous-parent","kind":"guidance","code":"target-not-found","nearest":[]}]
  ✖ F7 bare name union and same-line path target ambiguity (205.797542ms)
✖ baseline F4/F7 (572.170625ms)
ℹ tests 2
ℹ suites 1
ℹ pass 1
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 711.180625

✖ failing tests:

test at dist-test/tests/core/f4-f7.test.js:51:5
✖ F7 bare name union and same-line path target ambiguity (205.797542ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  
  + 'result'
  - 'ambiguous-target'
      at TestContext.<anonymous> (file:///private/tmp/r6-f4-f7.ust6vr/dist-test/tests/core/f4-f7.test.js:75:20)
```

The summary records each observed result, including the cases after the first failing assertion. Baseline defects reproduced: bare `charge` silently resolves to the module-level function; line 2 silently resolves to outer `routes` rather than `routes.POST /charge`; equal-span/equal-depth tie silently resolves to `a`; nearest ambiguous parent incorrectly becomes `target-not-found` with no candidates.

## Green characterization and limits

No fixed-version green run was performed; the scope required baseline-only verification and prohibited modifying either checkout. An earlier passing run asserted the baseline's observed F4/F7 behavior, which is only a baseline characterization, not a fixed-behavior pass. No full suite, lint, or build run. A copied current wrong-low test file was not usable because its typecheck failed on unrelated `FileImpactResult.completeness` typing errors; this focused harness was used instead.
