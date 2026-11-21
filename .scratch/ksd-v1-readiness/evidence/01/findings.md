# Round 6 findings evidence — VERIFIED (F1–F15, R8, D59 small items, and real-corpus gates)

All 15 review findings (`F1`–`F15`), `R8` on-demand SQLite loading + schema v4 indexes, `ei init --dry-run` `(would create)`/`(would overwrite)`, `tests/fixtures/**` exclusion in `ei.config.json`, and contextually typed object-literal `get`/`set` accessors were verified on Linux WSL2 x86_64 (commit `7ee7307` on `m2b-final`), with 605/605 unit/integration tests passing, 16/16 Round 6 mutants killed, and all `oh-my-pi` reference-corpus gates passing ([checks.md](checks.md), [r8-split.md](r8-split.md)).

The earlier macOS worktree notes below are retained for historical traceability.

| Finding | Fix summary | Test name / evidence | Status |
|---|---|---|---|
| F1 | Unresolved imports are keyed by local/imported names; body uses now emit an `unresolved-import` record at their use site. | Test: “F1 unresolved imports apply unresolved-import by local and imported name”; body-use assertion added. Temporary mutation suppressing body-use records was killed. [Baseline red output](f1-f2-baseline.md) was reproduced retrospectively against `6be6c2e`, after implementation. | FIXED; targeted green; mutation killed; retrospective baseline red |
| F2 | Direct override edges and transitive interface dispatch. | [Baseline red](f1-f2-baseline.md); frozen candidate also omitted the inherited caller. `impact-round6-dispatch-file.test.ts` now exercises caller and gap through the base class. | VERIFIED for fixture |
| F3 | Union owner types and contextual tokens include union members, including optional/undefined cases. | Test: “F3 union contextual types yield keyof edges, owner gaps and name tokens”; includes line-specific `keyof Usage | undefined` owner gap and a `string | undefined` name-token match. Mutations disabling owner-union traversal and token-union traversal were killed. Red below is from the original union contextual-type case. | FIXED; targeted green; mutations killed |
| F4 | Unwraps asserted/nested literals and handles computed property access through a namespace import. | [Baseline red](f4-f7-baseline.md); namespace receiver failed on the frozen candidate and passed in `r6-f4-f5-regressions.test.ts`. | VERIFIED for fixtures |
| F5 | Root `./` differs from prefix-less `*`; partial filenames retain their prefix; unknown in-repo alias scope is conservative. | Red below. Root scope with a static importer, partial-file require, unmatched alias and module-only target pass in `r6-f4-f5-regressions.test.ts`. | VERIFIED for fixtures |
| F6 | File text and structured details use the same aggregate `ImpactResult` at the indexed module key. | Original red below; frozen candidate dropped partial details and the combined caller threshold. Updated detail, threshold and stale-file tests passed. | VERIFIED for fixtures |
| F7 | Target resolution changes in `src/core/graph/graph.ts` and `src/core/impact/query.ts`. | [Baseline red output](f4-f7-baseline.md) was reproduced retrospectively for bare name, innermost line, equal-depth tie and ambiguous-parent fallback. | Targeted green; retrospective baseline red |
| F8 | Uses syntax only to disambiguate slash after `}`; token scanning still emits lexical evidence only. | Frozen candidate lost division operands; interim fix still lost the function-expression case (actual lines `[1]`, expected `[1, 2]`). Division and block-close regex pass in `impact-round6-cancellation.test.ts`. | VERIFIED for fixtures |
| F9 | Probe readability behavior updated with D57. | No finding-specific repro output collected. | FIXED; red evidence NOT VERIFIED |
| F10 | Removed level-word scrubbing; template-slot assertion. | `impact-render.test.ts`: “enforces the one-verdict rule across all golden targets and synthetic level-word collisions”. | FIXED; green in full suite |
| F11 | File reach unions distinct compiler-grade callers at their shallowest depth; output uses the same aggregate independent of display depth. | Frozen candidate reported 2 total at depth 1 and 4 at depth 3. The corrected fixture reports 4 at both depths. | VERIFIED for fixture |
| F12 | One abort does not cancel a surviving waiter; all-aborted waits for build teardown. | Gated public-query regression failed at the final abort before the fix. Existing `impact-tool.test.ts` checks real child-process teardown; both passed after fixing cancellation cleanup. | VERIFIED for fixtures |
| F13 | C08 caller assertion updated. | `impact-golden.test.ts`: “C08 both overload signatures resolve to one target and list their caller”. | FIXED; green in full suite |
| F14 | Adding a declaration queues files containing braced, fixed-width Unicode and hex escapes. | Sandbox: two braced cases failed before the fix; all four passed after; disabling requeue made all four fail. Ported `f14-escaped-name.test.ts` passed. | VERIFIED for fixtures; targeted mutation verified |
| F15 | Hard-ceiling fallback reports the real depth range and does not suggest querying an invalid range. | Frozen probe printed `Depth 1: 2 more in 1 file.` The corrected two-file fixture asserts `Depth 1–2: 2 more in 2 files.` | VERIFIED for fixture |
| R8 | `unresolved`, `name_tokens`, and `gap_sites` use prepared on-demand queries. | Full suite and synthetic fixture correctness lane passed. | FIXED; timing NOT VERIFIED |
| Small: init dry-run | Emit exactly one set of parentheses around the status. | CLI repro printed `((would create))`; corrected fixture verifies single-parenthesis output. | VERIFIED for create; overwrite uses the same template |
| Small: fixture exclusion | Added `tests/fixtures/**` to `ei.config.json` exclude. | Changes included in `d6eb8e9`; no separate red output collected. | FIXED; green in full suite |

F3 verbatim red output (captured before its fix):

```text
test at dist-test/tests/core/impact-round6-wronglow.test.js:94:5
✖ F3 union contextual types yield keyof edges, owner gaps and name tokens (138.017583ms)
  AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
  
    assert.ok(codes(cost).includes('computed-member-access'))
  
      at TestContext.<anonymous> (file:///private/tmp/ksd-wt/01/dist-test/tests/core/impact-round6-wronglow.test.js:119:20)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Suite.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: '==',
    diff: 'simple'
  }
```

F5 verbatim red output (captured before its fix; the `cjs-require` case remained complete):

```text
test at dist-test/tests/core/impact-round6-wronglow.test.js:162:5
✖ F5 computed import and require prefixes scope to the directory, not "*" (311.934791ms)
  AssertionError [ERR_ASSERTION]: cjs-require
  + actual - expected
  
  + 'complete'
  - 'partial'
  
      at TestContext.<anonymous> (file:///private/tmp/ksd-wt/01/dist-test/tests/core/impact-round6-wronglow.test.js:184:24)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Suite.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 'complete',
    expected: 'partial',
    operator: 'strictEqual',
    diff: 'simple'
  }
```

The same initial run exposed root-level `./` normalization. Its expected line number was subsequently corrected from 10 to 11; the prefix mismatch was the defect:

```text
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  
    [
      'dynamic-import 2 dir/',
      'dynamic-import 5 dir/',
  +   'dynamic-import 8 ./',
  +   'cjs-require 11 dir/'
  -   'dynamic-import 8 *',
  -   'cjs-require 10 dir/'
    ]
  
      at TestContext.<anonymous> (file:///private/tmp/ksd-wt/01/dist-test/tests/core/impact-round6-wronglow.test.js:247:16)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async Promise.all (index 0)
      at async Suite.run (node:internal/test_runner/test:1905:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: [ 'dynamic-import 2 dir/', 'dynamic-import 5 dir/', 'dynamic-import 8 ./', 'cjs-require 11 dir/' ],
    expected: [ 'dynamic-import 2 dir/', 'dynamic-import 5 dir/', 'dynamic-import 8 *', 'cjs-require 10 dir/' ],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }
```

F6 verbatim red output (captured before its fix):

```text
test at dist-test/tests/core/impact-round6-wronglow.test.js:193:5
✖ F6 file targets never fabricate a complete low picture (158.04975ms)
  AssertionError [ERR_ASSERTION]: F6 fabricated a wrong low for packages/api/src/handlers/refund.ts:
  IMPACT packages/api/src/handlers/refund.ts:1 — 0 exported declarations with callers outside file (1 other declaration in file)
  ACTION proceed · level low · picture complete
  REACH 0 direct · 0 total · 0 files · 0 packages · 0 routes · factors: none
  
  Callers: none
  Tests: none
  Gaps: none
  Next: make your change and call ei_changes before you report done.
  — index fresh · 26 files · ts 5.9.3 · engine 0.1.0
```

F1, F2, F4 and F7 red output was reproduced retrospectively on the immutable baseline, not captured before the initial fixes. Later red/green runs cover the reproduced review findings. Full acceptance remains incomplete.

## Candidate review reproductions

These commands ran against sandbox copies of the candidate, not against a fixed revision:

- `/tmp/r6-repros-1.0s6J6V`: `./node_modules/.bin/tsc -p tests/tsconfig.json && node --import ./tests/policy/helpers/isolated-home.js --test dist-test/tests/core/r6-f4-f5-regressions.test.js`. Compilation passed, tests exited 1 (0 pass, 5 fail); `r6-f4-f5-red.log` retains the detailed output. F4 namespace receiver and all four loader-scope assertions expected an in-scope completeness reason and saw none.
- `/tmp/r6-repros-2.ilqOfd`: `./node_modules/.bin/tsc -p tests/tsconfig.json && node --import ./tests/policy/helpers/isolated-home.js --test dist-test/tests/core/impact-round6-dispatch-file-red.test.js`. Exit 1; inherited dispatch, structured details, and file-wide threshold failed. The original reach assertion matched neither output; after correcting it, the same command with `--test-name-pattern='full compiler reach'` before the test path exited 1 with `REACH 2 direct · 2 total` instead of `REACH 2 direct · 4 total`.
- `/tmp/r6-repros3.BxrV04`: `./node_modules/.bin/tsc -p tsconfig.json --pretty false` (exit 0), `node --test repros.test.mjs` (exit 1; see `repros.log`). Scanner, renderer, and CLI outputs reproduce the issues above. The build probe is supplemental, not public cancellation verification.
- Public F12: `node --test cancellation.test.mjs` in `/tmp/r6-repros3.BxrV04`. Exit 1, 0 pass / 2 fail. Both final-abort assertions failed with `AssertionError [ERR_ASSERTION]: final abort must stop the shared build` (`actual: undefined`, `expected: true`). Exercises the real query coordinator with an injected, gated build; does not exercise child process teardown.
- F14: `node_modules/.bin/tsc -p tests/tsconfig.json && node --import ./tests/policy/helpers/isolated-home.js --test dist-test/tests/core/f14-escaped-name.test.js` in `/tmp/f14-sandbox.dogVkm`. Before the sandbox fix, 2 passed, 2 braced cases failed (missing token rows). After the fix, 4 passed. Disabling the escape rescan made all 4 fail. This does not cover the full historical mutation campaign.
- Second review: `./node_modules/.bin/tsc -p tests/tsconfig.json && node --import ./tests/policy/helpers/isolated-home.js --test --test-name-pattern='during cancelled-build|barrel re-export incomplete' dist-test/tests/core/{impact-round6-cancellation,r6-f4-f5-regressions}.test.js`. Exit 1, 0 passed and 2 failed before fixes: new query saw `'stale' !== 'updated'`; barrel target returned `completeness.status: complete`, `verdict.level: low`. Both pass in the committed candidate's 597-test run.
