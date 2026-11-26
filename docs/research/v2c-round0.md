# V2c Round 0 — reconcile `docs/briefs/V2c-verify.md` with the repository

Branch `v2c-verify` from tag `v1.0.0` (`f2b0f5a`, `package.json` 1.0.0). Owner rule for this lane: mismatches are corrected here and work continues; stop only if one changes V1 behaviour or a safety rule. None does.

## OMP approval (brief "Round 0 additions")

Installed `omp --version`: `omp/19.2.1` (single binary). Read: `omp://approval-mode.md` and `omp://extensions.md` served by that binary; installed type package `@oh-my-pi/pi-coding-agent` 18.14.0 (`src/extensibility/extensions/types.ts:991-1007`, same `approval?: ToolApproval` field).

- A tool declares `approval: 'read' | 'write' | 'exec'`, a decision object, or a function of the arguments. Omitted means `exec`.
- `exec` is the tier for tools that "execute code, shell out". Modes: `always-ask` and `always-ask-cached` and `write` prompt for `exec`; `yolo` (the default) auto-approves. A call that needs a prompt with no UI (print mode, headless subagents) fails closed.
- The user is asked through the approval dock (Approve / Approve for session / Deny); `formatApprovalDetails(args)` adds lines to the prompt.
- The repo already relies on this: `evals/test-tool.mjs` registers an `exec` tool.

**Consequence:** OMP has an approval level for a process-running tool, so Round 1 **runs** allowlisted checks. `ei_verify` declares `approval` as a function: `exec` when the call names a `check`, `read` when it only reads a report file.

## 1. Statements that no longer match

| Brief | Repository | Correction applied |
|---|---|---|
| `V2c-verify.md:19` `verification.checks` in `ei.config.json` | `src/core/kernel/config.ts:48,372` `verification` is a `ToggleConfig` (`enabled` only); other keys are dropped | Add `checks` and `reports` to a `VerificationConfig`; `defaultConfig()` keeps writing only `{ "enabled": false }` so `ei init` output is unchanged |
| `V2c-verify.md:20` "a path the config names" | No such field | `verification.reports: [{ name, format: "junit" \| "tap", path, covers? }]` |
| `V2c-verify.md:20` "newer than the last commit touching the tested files" | "tested files" undefined | `covers` globs (default: every tracked file). Stale when the last commit touching them, or any uncommitted file under them, is newer than the report |
| `V2c-verify.md:38` `source: "junit" \| "pipeline"` | D67 (`docs/DESIGN.md:722`) dropped the pipeline source | `source` is replaced by `report: <name>`; no pipeline code |
| `V2c-verify.md:19` "Run with `execFile`" | `execFile` buffers all output and kills on `maxBuffer`; the brief needs a 2 MB tail and a process-tree kill | `spawn(argv[0], argv.slice(1), { shell: false, detached: true })` — the primitive `execFile` wraps, without a shell. Timeout kills the process group |
| `docs/DESIGN.md:490` "OMP tools (all `approval: 'read'`)", `docs/TOOLS.md:18` rule 8 | `ei_verify` running a check is `exec` (V2-README "Exec") | Rule 8 and §8.1 gain the one exception in Round 2 |
| `docs/DESIGN.md:461-465` `VerificationReport` | Brief needs `dirty`, counts, duration, failing tests, output tail | Fields added, none repurposed (§7 allows additions) |
| `V2c-verify.md:40` "Disabled by default" | `docs/briefs/V2a-context.md:32` sets the lane convention: disabled ⇒ not registered | `ei_verify` is registered only when `verification.enabled` is true in the config found from the session cwd |
| `src/adapters/omp/extension.ts:94` `approval: 'read'` type | Narrow literal | Widened to OMP's `ToolApproval` shape for `ei_verify` only |

## 2. Data the brief assumes the index holds

None. Verification reads git (`rev-parse`, `status`, `log`) and files; it does not use the index.

## 3. Golden cases

`tests/golden/**` covers impact only. V2c must leave all of them and every snapshot under `tests/snapshots/**` unchanged; `ei_changes` gains its line only when verification is enabled.

## 4. Dogfood log

`docs/dogfood-log.md` has no verification entries. `docs/research/v1-eval-followup.md:5` is the relevant evidence: under `--approval-mode write` headless OMP denied `bash`, so agents could not prove tests passed. That is the case `ei_verify` addresses; in that mode an `exec` tool also fails closed unless `tools.approval.ei_verify: allow` is set, which the value check does in its overlay.

## 5. Round plan

Unchanged: Round 1 core (`src/core/verify/`), Round 2 tool, CLI, `ei_changes` line, value check. Round 3 (review, different vendor) is outside this lane.

## Owner allowlist (lane B answer)

Per repository, only `test`, `typecheck`, `lint` that exist in its `package.json`, as `{"name":"<script>","command":["npm","run","<script>"],"timeoutSec":600}`, `test` as `["npm","test"]`. This repository has all three.
