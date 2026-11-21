# F1/F2 baseline reproductions

Baseline: `6be6c2e77b5e5d4ae79e3e487b40e8fcd54cb6dc`, extracted with `git archive` to `/tmp/r6-f1-f2.Eim7TI/tree`. Dependency reuse: symlink to `/tmp/ksd-wt/01/node_modules`; no install or network. Harness: `/tmp/r6-f1-f2.Eim7TI/tree/tests/core/r6-baseline.test.ts`; fixture helper copied from `/tmp/ksd-wt/01/tests/core/index-helpers.ts`. Existing public-impact tests were adapted to a small focused harness because current `impact-round6-wronglow.test.ts` has assertions against result fields absent from baseline's `FileImpactResult` API.

## F1 — broken import and body-use evidence

Input follows reviewer finding #1: `packages/api/src/broken-import.ts` imports `localOnly` from missing `./does-not-exist` and calls it on line 3. Target: `packages/payments/src/fee.ts#localOnly`. The adapted harness checks both the unresolved-import body-use row and target result severity/completeness.

Command:

```sh
cd /tmp/r6-f1-f2.Eim7TI/tree
./node_modules/.bin/tsc -p tests/tsconfig.json --pretty false
node --test dist-test/tests/core/r6-baseline.test.js
```

Verbatim relevant output:

```text
F1 body-use unresolved row: null
F1 answer: {"target":"packages/payments/src/fee.ts#localOnly","span":{"file":"packages/payments/src/fee.ts","startLine":19,"endLine":19},"byDepth":[],"bridged":[],"tests":["packages/payments/src/fee.test.ts"],"completeness":{"status":"complete","reasons":[]},"reach":{"direct":0,"total":0,"files":0,"packages":0,"crossPackage":false,"routes":0},"factors":[],"limits":{"unboundedDynamicImports":0,"excludedFiles":0,"failedFiles":0},"scannedFiles":27,"verdict":{"level":"low","action":"proceed","zones":[],"requiredActions":[],"basis":[]},"freshness":{"workingTreeHash":"be10cf7384dc65f348c12ec53e05aac51e6ca69a337ec428f4b6f694c7fe7c9a","includesUntracked":true},"engine":{"version":"0.1.0","typescript":"5.9.3","extractor":"1c8df4f8a8820b45"}}
✖ F1 broken import body use and local-name targeting (316.166083ms)
  AssertionError [ERR_ASSERTION]: expected unresolved import body-use evidence
      at TestContext.<anonymous> (file:///private/tmp/r6-f1-f2.Eim7TI/tree/dist-test/tests/core/r6-baseline.test.js:43:20)
```

## F2 — abstract-member override dispatch

Input follows reviewer finding #2: abstract `AbstractProcessor.charge`, concrete override `ConcreteProcessor.charge`, and `runAbstract` calling through the abstract type. Target: `ConcreteProcessor.charge`. The adapted harness checks the `IMPLEMENTS` edge, propagated caller and unknown verdict.

Verbatim relevant output:

```text
F2 IMPLEMENTS row: null
F2 answer: {"target":"packages/payments/src/abstract-proc.ts#ConcreteProcessor.charge","span":{"file":"packages/payments/src/abstract-proc.ts","startLine":5,"endLine":5},"byDepth":[],"bridged":[],"tests":[],"completeness":{"status":"complete","reasons":[]},"reach":{"direct":0,"total":0,"files":0,"packages":0,"crossPackage":false,"routes":0},"factors":[],"limits":{"unboundedDynamicImports":0,"excludedFiles":0,"failedFiles":0},"scannedFiles":27,"verdict":{"level":"low","action":"proceed","zones":[],"requiredActions":[],"basis":[]},"freshness":{"workingTreeHash":"81e71977dfcfd0ec1722c05a0e2126e48c477453e615ce800babffc3ee72ba99","includesUntracked":true},"engine":{"version":"0.1.0","typescript":"5.9.3","extractor":"1c8df4f8a8820b45"}}
✖ F2 abstract override dispatch (158.982542ms)
  AssertionError [ERR_ASSERTION]: expected override IMPLEMENTS edge
      at TestContext.<anonymous> (file:///private/tmp/r6-f1-f2.Eim7TI/tree/dist-test/tests/core/r6-baseline.test.js:56:20)
```

## Outcome and limits

Both scenarios reproduced as failing assertions on the immutable baseline. F1 independently confirms no body-use unresolved row and a complete/low result. F2 independently confirms no override edge and a complete/low result; the omitted `runAbstract` caller follows because the edge is absent. Compile succeeded before the test run. The combined Node test run exited 1, with 0 passing and 2 failing tests. No green/post-fix run was attempted: this assignment's verification target is the immutable baseline, and no fixed snapshot was specified. This is not evidence that fixes pass.
