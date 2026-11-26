# PR #43 — V2c verification evidence review

**Verdict: request changes. Keep disabled.** Reviewer: `openai-codex/gpt-6.2-sol` (OpenAI); implementation author vendor: Anthropic. Reviewed `e9b16e6d87863763c5e2bf7571e5d3d04549e5ed` against `origin/main` at `c0546706084f2e60eb55e3d55b4bc658c9e78547`. `v1.0.0` is an ancestor. Read `AGENTS.md`, the common and V2c briefs, DESIGN §§6.6/7.8/11/12, RISK, the Round 0, self-review and value-check records, and the branch diff. macOS arm64, Node `v24.22.0`, npm `11.19.1`, OMP `19.2.1`. Review only; no product code changed.

## Findings

- **Blocker — Committed allowlist is not the authority.** `src/core/verify/verify.ts:93–110` executes config read from the working tree (`src/core/engine/workspace.ts:60–79`) after testing only `changedPaths.includes`. Git status failure maps to an empty list in `src/core/verify/revision.ts:50–57`; a clean status also does not prove the config is a tracked regular blob. Approval details resolve configuration from `deps.cwd`/process cwd while execution resolves `ctx.cwd` and rereads config (`src/adapters/omp/extension.ts:791–811`). The shown argv is neither redacted nor bound to the argv executed. **Fix:** Require a regular owner-approved committed config, fail closed on provenance errors, and use the same immutable, redacted approval scope for execution.
- **Blocker — Read calls can invoke Git helpers.** `src/core/verify/revision.ts:20–28,50–57` uses fixed Git argv but inherits the environment and repository Git config. `git diff` does not disable external diff/text conversion; `git status` does not disable fsmonitor. The same path runs before `report` processing and in enabled `ei_changes`, without exec-tier approval for those calls. **Fix:** Make metadata reads helper-free, with a sanitized Git environment, explicit helper disables, and bounded time/output; fail closed if evidence is incomplete.
- **Blocker — `PASS` does not prove tests ran.** `src/core/verify/report.ts:48–63` treats absent counts and all-skipped counts as success. `src/core/verify/parse.ts:101–142` accepts partial TAP and matches XML testcase text inside comments. Disposable probes returned `PASS` for zero-output exit 0, all-skipped JUnit, truncated TAP with an incomplete plan, and a JUnit comment alone. `src/core/verify/verify.ts:110–129` classifies only the captured tail and passes counts, but not extracted failure lines, to status calculation. **Fix:** Distinguish test checks from lint/typecheck and require validated, complete, non-skipped test evidence without failure markers for test `PASS`.
- **Blocker — Freshness is inferred from timestamps and incomplete tree identity.** `src/core/verify/verify.ts:150–186` stamps a result file with current HEAD based on mtime, not its producer's revision. `src/core/verify/revision.ts:50–67,80–93` substitutes untracked size/mtime for bytes, tolerates Git failures, and uses different coverage glob grammars for Git history and dirty files. A copied old report can look current; a check can change its own inputs while running. **Fix:** Bind evidence to a verified input/revision digest, use one coverage matcher, compare before and after execution, and decline current-tree claims when provenance is missing.
- **Blocker — Timeout bounds a process group, not the tree or the tool call.** `src/core/verify/run.ts:38–45,98–149` sends `SIGKILL` to the group and resolves on child `close`. A descendant outside the group can survive, and inherited pipes can hold `close` open. The test verifies only a normal in-group grandchild. **Fix:** Contain checks in an enforceable job boundary and settle on the deadline independently of inherited pipes; otherwise remove this execution mode until the timeout contract is revised.
- **Blocker — Redaction is not complete across the report boundary.** `src/core/audit/log.ts:166–175` skips short secret-named values. `src/core/verify/verify.ts:110–127,174–190` scrubs raw output before extracting final report fields; decoded JUnit names, artifact paths and summaries are not uniformly scrubbed before store/render. The prompt also shows raw configured argv. **Fix:** Use a verification-specific allowlist of inherited variables and redact final structured fields (after decoding) before every display or write; omit raw argv/output when it cannot be safely represented.
- **Should-fix — Disabled status text can differ from V1.** `src/core/kernel/config.ts:247–263` validates dormant lists when `enabled: false`. With `{"verification":{"enabled":false,"checks":[{}]}}`, `ei status` changed from `Config … ok` to `Config … 1 problems … verification.checks[0].name …`. Both `--help` outputs also advertise the new command unconditionally (`src/adapters/cli/main.ts:119`). **Fix:** Ignore dormant lists in V1 diagnostics and decide explicitly whether CLI help belongs to the compatibility contract.
- **Should-fix — The value grader does not prove final-tree support.** `evals/v2c-value.mjs:125–146` counts any earlier PASS event as support and recognizes only selected prose patterns. It does not reject missing/truncated transcripts before scoring. **Fix:** Require completed runs and match the last cited report to final tree identity; grade explicit status fields or independently label the finals.
- **Note — Known residual risks.** `npm test` running a repository script via npm's own shell and executing freshly edited tests are expected under explicit owner authorization; `shell: false` is not a sandbox. These are unacceptable under a blanket auto-allow or a claim of mandatory per-call confirmation; OMP `yolo` auto-approves the declared exec tier. Direct `spawn` instead of `execFile` is acceptable if containment holds. **Fix:** Document the owner trust model and require a per-call prompt policy for enabled execution until an isolation boundary exists.

## Acceptance evidence

- **Disabled parity — partial.** `node review-probe.mjs` (disposable comparison using compiled `origin/main` and PR artifacts) returned `5 V1 OMP registrations match exactly (mock host); CLI help adds verify`. `git diff --exit-code origin/main...HEAD -- tests/golden tests/snapshots src/policy tests/policy` exited 0; golden/snapshot assertions passed in `npm test`. `loadVerificationState` returns before Git/cache reads when disabled (`src/core/verify/verify.ts:235`). The dormant diagnostic above disproves universal parity. Release snapshot tests use the existing footer normalization; accepted snapshot bytes were not touched.
- **Mutation — VERIFIED for registration, MOCK-ONLY for the OMP host.** In a `git archive` scratch copy only, replace the registration predicate at `src/adapters/omp/extension.ts:877` with `config !== null`. `./node_modules/.bin/tsc -p tests/tsconfig.json && node scripts/copy-policy-to-dist.mjs --test-tree`, then `node --import ./tests/policy/helpers/isolated-home.js --test --test-name-pattern='not registered while verification is disabled' dist-test/tests/core/verify-tool.test.js`: `tests 1`, `pass 0`, `fail 1`, `true !== false`, exit 1. The original passed in the branch suite. Restored the scratch source; no mutation entered a branch.
- **Graph isolation — static trace.** Only `src/adapters/{cli/main,omp/extension}.ts` import verification for `ei_changes`; they compute `runChanges` first and pass note strings to `src/core/changes/render.ts:351–358,456–459`. Structured details and verdict derivation are unchanged. No verification imports from traversal, reach, factor or verdict code; the rendering seam only adds the report and `Next:` suffix.
- **Invalid names and extra fields — MOCK-ONLY at OMP boundary.** `node review-probe.mjs` sent the five requested inputs to the compiled adapter with a non-executing runner spy. Output: `INVALID_INPUT, INVALID_INPUT, INVALID_INPUT, INVALID_INPUT, NOT_VERIFIED; runner calls=0; tiers=exec/read (mock host)`. Order: shell-like name, traversal name, whitespace name, extra command, unknown name. No input was submitted to a shell. Host docs `omp://approval-mode.md` confirm the declaration contract. The live value check exercised checks under an explicit grant; interactive prompt/deny and live `report` approval were not run.
- **Runner and redaction tests — VERIFIED for the exercised cases.** `npm test` passed `timeout is ERROR and the whole process tree is gone` (one ordinary descendant PID), `secret-named variables never reach the check or the report` (synthetic values), and `a secret printed by the check is redacted` (synthetic known token shape). `src/core/verify/run.ts:98–105` has `shell: false`, `detached: true`, and a filtered child environment. The findings above limit the overall claim.
- **Network and diff review — static plus test.** No added network API in `src/`; repository sweep found only URL constants, not calls. Installer subprocess is reached from `ei setup` (`src/adapters/cli/main.ts`; `src/core/engine/typescript.ts:148–173`). `tests/core/v2-safety.test.ts` passed, but it excludes frozen policy and only checks selected API spellings; supplemental tracked-source scan included policy. Added-line credential/home-path scan found only synthetic token fixtures and no personal home path. No manifest or lockfile change. `git diff --check origin/main...HEAD` produced no output.

## Executed gates

Commands ran in the branch worktree with `CI=1`, `HUSKY=0` and a stripped inherited environment for the suite. Relevant output (local paths omitted):

```text
$ npm ci
HUSKY=0 skip install
added 100 packages, and audited 101 packages in 50s
9 moderate severity vulnerabilities
exit=0
$ npm run typecheck
> tsc -p tsconfig.json --noEmit && tsc -p tests/tsconfig.json --noEmit
exit=0
$ npm run lint
> eslint .
exit=0
$ npm run format:check
All matched files use Prettier code style!
exit=0
$ npm test
ℹ tests 768
ℹ pass 767
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
AssertionError [ERR_ASSERTION]: 50k search p95 was 400.30 ms (>= 300 ms)
exit=1
$ npm run check:dist
> npm run build && git diff --exit-code dist/ && node scripts/check-dist-untracked.mjs
> tsc -p tsconfig.json && node scripts/copy-policy-to-dist.mjs
exit=0
$ node --import ./tests/policy/helpers/isolated-home.js --test tests/packaging/npm-tarball.test.js
✔ installs in an empty directory and runs ei and the MCP server
ℹ tests 1
ℹ pass 1
ℹ fail 0
exit=0
$ semgrep scan --config p/default --metrics=off --disable-version-check --dataflow-traces src
Ran 213 rules on 87 files: 5 findings.
exit=0
```

The failing performance test is unchanged (`tests/core/search-query.test.ts`); runs shared a host. Attribution to V2c is **not verified**, and the full gate is failed. Semgrep's new findings were dynamic regex warnings in `verify/parse.ts` (internal parser literals); other flagged paths were unchanged. OpenCodeReview `ocr delegate preview --from origin/main --to HEAD` and `ocr delegate rule --from origin/main --to HEAD <changed src files>` exited 0; used rule output, not a provider verdict. An independent static reviewer corroborated the execution, redaction and false-PASS findings.

## Value check

```text
$ EI_EVAL_MODEL=anthropic/claude-sonnet-4-5 node evals/v2c-value.mjs
SUMMARY module=off runs=5 claimsPass=0 unsupported=0 false=0 verifyPass=0
SUMMARY module=on runs=5 claimsPass=1 unsupported=0 false=0 verifyPass=1
Tool report statuses with module on: 4 FAIL, 1 PASS
harness exit=0
```

All five on cases called `ei_verify`; all five returned reports matching the harness's fixture truth, versus four reports in the author's sample. The stated endpoint (unsupported pass claims) reproduced **0/5 → 0/5**. Recorded evidence improved under this restricted approval setup, not on the stated endpoint. This sample supports retesting after fixes, not enabling now. The review model did not grade itself via this harness; the harness used the author's Anthropic model.

**Not verified:** live interactive approval/denial, Linux or Windows execution, containment of escaped descendants, production-grade redaction, or universal V1 byte parity. No push, merge, tag or publish. Suggested next command after fixes: `node --import ./tests/policy/helpers/isolated-home.js --test dist-test/tests/core/verify{,-tool}.test.js` (after compiling the tests).
