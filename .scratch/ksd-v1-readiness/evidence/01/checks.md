# Round 6 checks — historical baseline verified; current scoped regressions verified; full acceptance pending

Host: macOS arm64. Node: v24.22.0. TypeScript runtime: 5.9.3.

| Command | Result |
|---|---|
| `npm run typecheck` | Exit 0; both source and test TypeScript projects completed. |
| `npm run lint` | Exit 0. |
| `npm test` | Exit 0; 568 tests, 45 suites, 568 pass, 0 fail. |
| `npm run format:check` | Exit 0; “All matched files use Prettier code style!” |
| `npm run check:dist` | Exit 0 after commit `368695e`; build, tracked-dist diff, and untracked-dist check completed. |
| `node dist/adapters/cli/main.js setup --check` | Exit 0; TypeScript 5.9.3 ready, SHA-256 `3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675`. |
| `node /Users/mezn/workspaces/private/ksd-intelligence/.scratch/ksd-v1-readiness/round-6-fixture.mjs` | Exit 0; 320 compiler callers, untracked caller indexed, 0 graph differences, 300 differential declarations, 640 references, 0 misses. **Not candidate evidence:** the script loads `dist/` relative to its own location in the main checkout, not the worktree. |

Historical checks above, other than the fixture command, were recorded against the prior `368695e` candidate; they do not verify the current F1–F6 changes. The fixture command exercised the main checkout. Reference-corpus replay, hand-checks, WSL and live OMP remain unrun.

Current scoped command:

```sh
npm run build && npx tsc -p tests/tsconfig.json && node scripts/copy-policy-to-dist.mjs --test-tree && node --import ./tests/policy/helpers/isolated-home.js --test dist-test/tests/core/impact-round6-wronglow.test.js dist-test/tests/core/key-access.test.js dist-test/tests/core/resolve-counts.test.js dist-test/tests/core/randomized.test.js dist-test/tests/core/update-soundness.test.js dist-test/tests/core/differential.test.js dist-test/tests/core/indexing.test.js dist-test/tests/core/impact-risk.test.js
```

Exit 0; 84 tests, 13 suites, 84 pass, 0 fail. This includes differential reference checks, randomized incremental-equals-cold, update-soundness, F1–F6 regressions, and impacted key/index/impact tests.

Current worktree `/tmp/ksd-wt/01`, with F1–F6 changes not yet committed:

| Command | Result |
|---|---|
| `npm run test` | Exit 0; 576 tests, 47 suites, 576 pass, 0 fail, 0 skipped. |
| `npm run typecheck` | Exit 0. |
| `npm run lint` | Exit 0. |
| `npm run format:check` | Exit 0 after formatting and removal of a throwaway probe. |
| `node dist/adapters/cli/main.js setup --check` | Exit 0; TypeScript 5.9.3 ready. |
| `node .scratch/ksd-v1-readiness/round-6-fixture.mjs` | Exit 0; 320 compiler callers, untracked caller indexed, 0 graph differences, 300 differential declarations, 640 references, 0 misses. Script run from the worktree copy, which loads the worktree `dist/`. Synthetic correctness only. |
| `semgrep --config p/default --metrics=off --disable-version-check --error --json` on the changed impact, indexing, graph, workspace and CLI source files | Exit 0; 0 findings, 0 errors. |

The earlier synthetic fixture command used the absolute path in the main checkout and did not exercise the current worktree. The worktree-local fixture was subsequently run as recorded above.
Mutation smoke: five temporary mutations across F1–F4 were all killed by the named regressions: F1 body-use record, F2 base override edge, F3 owner-union traversal, F3 string-token union handling, and F4 asserted/nested literal unwrapping. Each mutant ran on generated `dist-test/` output and was discarded by rebuilding before the next check.

## After review corrections

Commands ran from `/tmp/ksd-wt/01`; HEAD was `368695e` plus uncommitted fixes. These are worktree results, not results on an immutable candidate SHA.

| Command | Observed result |
|---|---|
| `npm test` | Exit 0; 595 tests, 54 suites, 595 passed, 0 failed/skipped. Includes F2 inherited dispatch, F4/F5 scope, aggregate file details/reach, regex/division, shared cancellation and real child teardown, F14, and F15. |
| `npm run typecheck && npm run lint && npm run format:check` | Exit 0 for all three; Prettier: “All matched files use Prettier code style!” |
| `node dist/adapters/cli/main.js setup --check` | Exit 0, TypeScript 5.9.3 ready. |
| `node .scratch/ksd-v1-readiness/round-6-fixture.mjs` | Exit 0, Darwin arm64, Node v24.22.0; 320 callers, untracked caller indexed, 0 graph differences, 0 misses across 300 declarations and 640 references. |
| `semgrep --config p/default --metrics=off --disable-version-check --error --json src/core/impact/{query,render,session}.ts src/core/indexing/{resolve,indexer,lexical,keys}.ts src/core/graph/graph.ts src/core/workspace/{probe,scan}.ts src/adapters/cli/main.ts` | Exit 0, 0 findings, 0 errors. |

The F12 child teardown test initially failed because cancellation returned before the child stopped. The passing run above includes waiting for teardown only when all waiters aborted. The F8 regression initially reported only line 1 of two division expressions; the passing run covers both.

The full historical mutation harness was not available; targeted mutants are recorded in [findings.md](findings.md).

## Committed candidate

`m2b-final` at `c8809aa3aea7b7d2f099d73dd355e6adc0f37d11`, based on `6be6c2e`. The checks below ran on the selected candidate files before the local commit, except `check:dist`, which ran after it.

- `npm test`: exit 0; 597 tests, 54 suites, 597 pass, 0 fail, 0 skipped. Includes the two second-review regressions (computed namespace access through a barrel re-export and a live query arriving during cancelled-build teardown).
- `npm run typecheck && npm run lint && npm run format:check`: exit 0.
- `node dist/adapters/cli/main.js setup --check`: TypeScript 5.9.3 ready. `node .scratch/ksd-v1-readiness/round-6-fixture.mjs`: exit 0; 320 callers, untracked caller indexed, 0 graph differences, 0 misses across 300 declarations and 640 references.
- `npm run check:dist`: exit 0 after the commit.
- Semgrep scoped command above: 0 findings and one rule timeout on `resolve.ts`. `semgrep --config p/default --metrics=off --disable-version-check --error --timeout 30 --json src/core/indexing/resolve.ts` rechecked that file: 0 findings, 0 errors.
- GitNexus CLI could not bind the copied index in the linked worktree. `node .gitnexus/run.cjs mcp` with `detect_changes` arguments `repo: ksd-intelligence`, `scope: all`, `worktree: /private/tmp/ksd-wt/01` correctly identified the changed candidate sources before commit: 64 changed symbols, 66 affected, 16 changed files, CRITICAL risk. This is blast-radius evidence, not a correctness pass.

Acceptance verifier returned **BLOCK** on the preceding worktree evidence. The candidate SHA and `check:dist` gaps are now resolved; historical mutation, real-corpus/WSL and R8 acceptance gaps remain. No live OMP or CI claim.

## WSL handoff

`git bundle create <bundle> refs/heads/m2b-final ^6be6c2e77b5e5d4ae79e3e487b40e8fcd54cb6dc` produced a local incremental bundle. `git bundle verify <bundle>` reported OK, with tip `c8809aa3aea7b7d2f099d73dd355e6adc0f37d11` and prerequisite `6be6c2e77b5e5d4ae79e3e487b40e8fcd54cb6dc`.

- Bundle: `/tmp/ksd-m2b-round6-handoff.BH0u3I/m2b-final.bundle`
- SHA-256: `8f0c0eb549374684edd949944685474914aa68e66b51fd7a42e89b5353181ab2`
- After copying the bundle and the local tracker separately, run `git fetch /path/to/m2b-final.bundle refs/heads/m2b-final:refs/heads/m2b-round6-candidate` in the WSL checkout containing the prerequisite. Test the candidate in a disposable checkout using the pinned corpus and cohort from the [runbook](../../round-6-verification.md). This import and reference lane have not been run.
