# V1 agent-eval follow-up

## Problem

The owner observed 5/10 on OMP 19.2.1 and `openai-codex/gpt-5.6-luna`. Headless OMP denied shell execution under `--approval-mode write`, so agent requests alone could not prove a test passed. The two missing calls point to unclear production guidance. Production policy, tool result codes, golden cases, and snapshots stay unchanged.

## Baseline triage

Line references are to the owner's `/tmp/ksd-eval-ed70D4/*.jsonl`; registered descriptions are quoted below.

| Case | Class | Evidence and decision |
| --- | --- | --- |
| `search-review` | (b) guidance gap | `:32` — “Next: after your change, run the test above; call ei_changes before you report done.” The description also scoped the call to edits the agent made. With no requested edit, the agent tried `git diff` (`:22`) and hit the shell error (`:24`). No `ei_changes` result. |
| `rename` | (c) tool error | `:54` — “ACTION run-tests”; `:457` — `node --test src/subject.test.js`; `:458` — `Tool "bash" requires approval but no interactive UI available.` No passing test. |
| `delete-export` | (c) tool error | `:289` and `:397` — `node --test src/subject.test.js`; `:290` and `:398` — `Tool "bash" requires approval but no interactive UI available.` No passing test. |
| `type-widening` | (c) tool error | `:303` — `node --test src/subject.test.js`; `:304` — `Tool "bash" requires approval but no interactive UI available.` No passing test. |
| `comment-only` | (b) guidance gap | `:148` starts the edit without a prior impact call; `:253` — “CHANGES vs HEAD — 1 file, 0 symbols” and “ACTION proceed”. The impact description said “Before you change a function”; it did not say comments count. Its later exploratory test attempt also encountered the shell error (`:215`). |

No (a) false failure in these five transcripts. The grader did have a separate false-negative path: a failed first impact call masked a successful retry. The regression covers that path. It also checks that a passing test before the last edit cannot count. For (d), `delete-export:144` omitted `src/` (“File not found: caller.ts.”) and `type-widening:159` submitted malformed edit syntax (“input must begin with \"[PATH#HASH]\"”). Both recovered. No tool change for either.

The first strong-model rerun exposed another (b) gap in `comment-only`. In `/tmp/ksd-eval-6wR3qG/comment-only.jsonl:23`, `ei_impact` said “Next: after your change, run the test above; call ei_changes before you report done.” At `:163`, `ei_changes` said “Tests to run: none” for a diff with zero changed symbols. The model reported “Post-edit `ei_changes` verdict: proceed; no tests required” (`:210`). The [approved eval rule](../briefs/V1-closeout.md) requires following the pre-edit `run-tests` verdict. Clarify the two scopes in the description rather than weakening the checker.

## Guidance before and after

| Tool | Before | After |
| --- | --- | --- |
| `ei_impact` | “Before you change a function, method, class, type or exported constant, call this to see what depends on it:” | “Before editing a function, method, class, type or exported constant, call this even for comment-only edits.” |
| `ei_changes` | “After you have edited code and before you report the work as done, call this with no arguments.” | “Call with no arguments when asked to review the current diff, even if you did not edit or the working tree is clean. Also call after editing code, before reporting the work done.” Added: “A post-edit result with no tests does not waive an earlier ei_impact run-tests verdict.” |

The complete registered descriptions match [the tool contract](../TOOLS.md), checked by an adapter test. No verdict rendering changed.

## Usage

The owner runs `node evals/run.mjs` under the dedicated eval profile. In a mutation case the agent calls `ei_impact`, edits, then calls `ei_changes` and `ei_eval_test {}` as required. In a review-only case it calls `ei_impact` and `ei_changes` without editing. The model does not provide an executable, test path, flags, or environment.

## Shape and synthesis decision

`run.mjs` owns the disposable fixture, the original test file, and the per-run OMP overlay. `test-tool.mjs` registers one eval-only `exec` tool. The overlay explicitly allows only that tool; `write` approval mode stays in effect and `bash` is not exposed. Linux Bubblewrap runs the harness-owned test with a read-only fixture, empty environment, private PID and network namespaces, and bounded time and output. The original test is mounted over the fixture copy. `grade.mjs` accepts only a passing structured result from this tool after the last successful edit and before the final answer. Production and npm packaging never load the eval tool.

A transcript handoff with a separate sandbox broker would also preserve approval. It would add a second model turn and grade a request for verification rather than an actual tool call. The fixed tool keeps one turn and hides containment behind an argument-free call. Enabling generic shell was rejected because the agent can edit the code it would execute.

## Tradeoffs and risks

- The eval test tool needs a working Linux Bubblewrap with user namespaces and conventional Node runtime library paths. It never falls back to host execution. This is separate from the required macOS live product smoke.
- OMP adapter contract checked against installed `omp --version` (`19.2.1`) and matching package sources: `src/extensibility/extensions/types.ts`, `loader.ts`, `src/tools/approval.ts`, `src/config/settings.ts`, and `examples/extensions/README.md`.
- Rates, transcript locations, and release decision belong in the [release checklist](../release-checklist.md).
