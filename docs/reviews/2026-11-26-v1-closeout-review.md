# V1 close-out review (PR #38, branch `v1-closeout`)

- **Date:** 2026-11-26
- **Reviewer model:** Gemini 4 Neon (Medium)
- **Reviewed head:** `ab7e8d7` (`origin/v1-closeout`) against `origin/main` (`70c1bca`)
- **Runtime:** Linux `6.18.58.1-microsoft-standard-WSL2 x86_64`, Node `v24.21.0`, npm `12.2.0`
- **Verdict:** No release blockers in shipped code, packaging, or protected paths; 1 should-fix in the non-packaged eval grader (`evals/grade.mjs`) and 4 minor notes. Owner manual gates (macOS/Linux live OMP smoke, live AGY smoke on 1.0.0, CI green on PR #38) remain separate as documented in `docs/release-checklist.md`.

---

## Findings

### Blocker

None.

### Should-fix

1. **`evals/grade.mjs:13,21-22,42-48` — `ei_impact` guidance call can mask a subsequent `run-tests` or `ask-owner` verdict.**
   - **Evidence:** `resultAt` picks the *first* `tool_execution_end` for `ei_impact` with `!event.isError`. Because guidance responses (`target-not-found`, `ambiguous-target`, `index-building`) are success-shaped (`isError` falsy), `result` has no `verdict` (`action === undefined`). In a mutation case such as `comment-only` (where `ei_changes` returns `action: 'proceed'`), a transcript with: (1) mistyped `ei_impact` → `target-not-found` (`isError: false`), (2) retried `ei_impact` → `ACTION run-tests`, (3) `edit`, (4) `ei_changes` → `ACTION proceed`, (5) final answer *without* calling `ei_eval_test`, bypasses `action === 'run-tests' || changeAction === 'run-tests'` and returns `null` (PASS). The same masking applies to `action === 'ask-owner'` at line 42.
   - **One-line fix:** Inspect all completed `ei_impact` calls before the first edit (using the last resolved verdict or aggregating any `run-tests`/`ask-owner` action across them) instead of only `events.findIndex(...)`.

### Note

1. **`evals/grade.mjs:38,44-46` — Sandbox test ordering checks `tool_execution_end` only, not `tool_execution_start`.**
   - **Evidence:** `next` slices after `Math.max(lastEdit, resultAt) + 1` and checks `completed(event, testToolName)`, which would accept a concurrently started test whose `tool_execution_start` occurred before `lastEdit` if its `tool_execution_end` landed after `lastEdit`.
   - **One-line fix:** Require the matching `tool_execution_start` (by `toolCallId`) for the passing `ei_eval_test` event to also appear after `lastEdit`.
2. **`scripts/mcp/tools.mjs:47,76` — AGY MCP tool descriptions were not updated with the new `ei_impact` / `ei_changes` guidance clarifications.**
   - **Evidence:** `src/adapters/omp/extension.ts:332,475` and `docs/TOOLS.md:51,126` added "even for comment-only edits", "when asked to review the current diff, even if you did not edit or the working tree is clean", and "A post-edit result with no tests does not waive an earlier ei_impact run-tests verdict", while `scripts/mcp/tools.mjs` retains its older shorter text (cautions are intact: "An incomplete result is not evidence of safety").
   - **One-line fix:** Mirror the comment-only edit, clean-diff review, and non-waived `run-tests` guidance into `scripts/mcp/tools.mjs:47,76` if AGY should share the same prompt guidance.
3. **`docs/TOOLS.md:81,94,157` and `docs/DESIGN.md` §13 (`M1d`) and `docs/research/v1-closeout-audit.md:64` — Minor doc/count drift.**
   - **Evidence:** `docs/TOOLS.md` example footers still show `engine 0.3.0` / `0.1.0` while line 205 shows `engine 1.0.0`; `docs/DESIGN.md` §13 row `3c | **M1d**` omits `✅` / `DONE` (unlike `AGENTS.md`); `docs/research/v1-closeout-audit.md:64` records `740 tests` from before commit `ab7e8d7` added the description-match test (now `741 tests`).
   - **One-line fix:** Align example footers in `docs/TOOLS.md` to `1.0.0`, add `✅` to `M1d` in `docs/DESIGN.md` §13, and note the post-followup test count (`741`) in `docs/research/v1-closeout-audit.md`.
4. **Branch history (`git log origin/main..HEAD`) — Scratch commit messages on `v1-closeout`.**
   - **Evidence:** Commits `d71a4cf` (`อ`), `d58bc22` (`v`), `d1574c8`, `d5de3a3`, `fa340d8` are intermediate eval-iteration commits.
   - **One-line fix:** Merge PR #38 with `--squash` as already specified in `docs/release-checklist.md:82`.

---

## Checklist verification with evidence

| # | Check | Status | Evidence |
|---|---|---|---|
| 1 | Claims in `README.md`, `docs/TOOLS.md`, `docs/DESIGN.md` match code & tests; unbuilt items marked `PLANNED (V2)` | **VERIFIED** | All 5 OMP tools (`ei_status`, `ei_search`, `ei_impact`, `ei_changes`, `ei_workflow`) and CLI counterparts exist and pass parity (`tests/core/audit.test.ts:259-308`). Pinned skill commits in `README.md:71-73` match `skills.lock.json:6,25,41`. Shipped CLI commands match `src/adapters/cli/main.ts`. Unbuilt capabilities (doctor canary / `engine-self-check-failed`, OMP-version warning, general per-capability `enabled` flags, `ei symbol`, 5 s query budget, automatic routes, heuristic bridges, watcher/worktree seeding, semantic search/embeddings, and all 5 V2 modules) are explicitly marked `PLANNED (V2)` in `README.md:143`, `docs/TOOLS.md:32,37,90,187,211`, and `docs/DESIGN.md` §§4, 6, 7.2, 7.10, 8, 9, 13, 16. |
| 2 | Eval grader requires passing sandbox test after last edit; `evals/` excluded from npm package | **PARTIAL** (grader should-fix above) / **VERIFIED** (packaging) | When the first `ei_impact` call resolves with `run-tests`, `evals/grade.mjs:38,43-47` requires `ei_eval_test` with `details.passed === true` after `lastEdit` (covered by `evals/run.test.mjs:89-112`), and `evals/test-tool.mjs` mounts the original test read-only in `bwrap` with no host fallback. However, a prior success-shaped `ei_impact` guidance call can mask a subsequent `run-tests` verdict (see Should-fix #1). `npm pack --dry-run --json` reported `entryCount: 94` and `evalHits: []` (`evals/` is excluded by `package.json#files`). |
| 3 | New tool descriptions match `docs/TOOLS.md` and do not weaken cautions | **VERIFIED** | `src/adapters/omp/extension.ts:332` (`ei_impact`) and `:475` (`ei_changes`) match `docs/TOOLS.md:51,126` verbatim (asserted by `tests/workflow/omp-extension.test.ts:85-95`). All other 3 OMP tools (`ei_workflow`, `ei_status`, `ei_search`) also match `docs/TOOLS.md:42,170,192`. Both edits tighten guidance without weakening cautions; zero callers is never described as "safe". |
| 4 | `readReleaseSnapshot` changes only the footer version in snapshots | **VERIFIED** | `tests/core/index-helpers.ts:25-37` applies `.replace(/^(— index [^\n]+ · engine )0\.2\.0$/gm, (_, prefix) => prefix + version)`. Verified across all 15 files in `tests/snapshots/`: 13 files have 1 diff (`engine 0.2.0` → `engine 1.0.0` on the anchored footer), `batch-3.txt` has 2 footer diffs, `C15.txt` has 0 diffs; no other byte changes. |
| 5 | No change to `src/policy/**`, `tests/golden/**`, `tests/policy/**`, snapshots, or runtime dependencies | **VERIFIED** | `git diff origin/main...HEAD --name-only \| grep -E '^(src/policy/\|tests/golden/\|tests/policy/\|tests/snapshots/)'` returned no matches. `package.json` has no `dependencies` field (0 runtime dependencies) and unchanged `devDependencies`. Policy bin wrappers in `src/adapters/cli/{check-changed,review-verdict,policy-bin}.ts` delegate non-`--help` calls to frozen `dist/policy/*`. |
| 6 | No secret, token, or personal path in diff | **VERIFIED** | Regex sweep of `git diff origin/main...HEAD -- . ':!dist' ':!package-lock.json'` for `/Users/`, `/home/`, `C:\`, `/mnt/c/`, private keys, and token prefixes returned zero matches. `AGENTS.md` has no injected blocks (untracked local indexer files `.agents/`, `.cgcignore`, `.claude/`, `.codegraph/` were present in the working tree and left untracked). |
| 7 | Run `npm ci`, `npm test`, `check:dist`, tarball test | **VERIFIED** (core/packaging); `bwrap` sandbox test **NOT VERIFIED** | See command results below. |

---

## Commands executed

All commands run with Node `v24.21.0` and npm `12.2.0` on Linux `6.18.58.1-microsoft-standard-WSL2 x86_64`:

- `npm ci` → exit 0 (`added 100 packages, and audited 101 packages in 41s`) — **VERIFIED**
- `npm run typecheck` → exit 0 (`tsc -p tsconfig.json --noEmit && tsc -p tests/tsconfig.json --noEmit`) — **VERIFIED**
- `npm run lint` → exit 0 (`eslint .`) — **VERIFIED**
- `npm run format:check` → exit 0 (`All matched files use Prettier code style!`) — **VERIFIED**
- `npm test` → exit 0 (`tests 741, suites 77, pass 739, fail 0, cancelled 0, skipped 2`, 41.1 s) — **VERIFIED**
- `npm run check:dist` → exit 0 (`npm run build && git diff --exit-code dist/ && node scripts/check-dist-untracked.mjs`) — **VERIFIED**
- `node --test tests/packaging/npm-tarball.test.js` → exit 0 (`tests 1, suites 1, pass 1, fail 0`) — **VERIFIED**
- `npm pack --dry-run --json` → exit 0 (`entryCount: 94`, `evalHits: []`) — **VERIFIED**
- `node --test evals/run.test.mjs` → `3 pass, 1 fail` (`sandbox blocks host files` failed with `Error: Fixture test unavailable: ENOENT` because `/usr/bin/bwrap` is not available inside this snap runtime) — **NOT VERIFIED** for Bubblewrap sandbox execution
