# V2c self-review

Five questions per round (lane rules) plus the lane-B exec checks. Evidence is file:line or a test name in `tests/core/verify.test.ts` / `tests/core/v2-safety.test.ts`.

## Round 1 — `src/core/verify/`

1. **Agent-facing text, golden case or snapshot changed?** No. No tool is registered in Round 1; `tests/golden/**` and `tests/snapshots/**` untouched. `sanitizeAuditText` was split into `redactSecrets` with the same order of operations (`src/core/audit/log.ts:146-177`), so audit text is unchanged; the existing audit tests cover it.
2. **Does anything feed completeness, reach, factors or a verdict?** No. `src/core/verify/**` imports only `audit/log` (redaction), `kernel/config`, `kernel/glob`, `kernel/guards`. Nothing in `impact/` or `changes/` imports it.
3. **Off by default, V1 byte-identical when off?** `defaultConfig()` still writes `"verification": { "enabled": false }` (`checks`/`reports` are absent unless configured, `src/core/kernel/config.ts:50-55`), so `ei init` output is unchanged. `runVerification` returns `NOT_VERIFIED` and runs nothing when disabled. Registration gating lands in Round 2 with its test.
4. **Network, exec or repo write outside the V2 rules?** Exec only in `src/core/verify/run.ts` (`spawn`, `shell: false`). Writes only under `<cacheDir>/verify/<check>/` (mode 0700/0600). No network (`v2-safety.test.ts` "no network API in src/").
5. **Secret or personal path in the diff?** No. Test values are synthetic (`ghp_abcdefghijklmnop1234`, `y-secret-value-123`).

### Exec checks (lane B)

| Check | Evidence |
|---|---|
| A name outside the allowlist runs nothing | `validateVerifyInput` accepts only `{check}` or `{report}` matching `VERIFY_NAME_RE` (`config.ts:145`); unknown names return `NOT_VERIFIED` before the runner. Test "a name outside the allowlist runs nothing" counts runner calls = 0 |
| Agent text never reaches the process | argv, cwd and timeout come from `verification.checks` (`verify.ts` `verifyCheck`); the request contributes only the lookup key. An uncommitted edit to `ei.config.json` refuses to run (test "an uncommitted edit to ei.config.json runs nothing") |
| No shell | `spawn(file, args, { shell: false })` (`run.ts`); sweep test "no process is started with a shell" |
| Process tree dies on timeout | `detached: true` + `process.kill(-pid, 'SIGKILL')` on timeout, cancel and leader exit (`run.ts` `killGroup`). Test "timeout is ERROR and the whole process tree is gone" asserts the grandchild pid is dead |
| Secrets stripped from environment and report | `checkEnvironment` drops every name matching the audit secret pattern; output and command pass through `redactSecrets` before storing. Tests "secret-named variables never reach the check or the report", "a secret printed by the check is redacted" |

### Residual risks (not fixed; owner should know)

- `npm run <script>` itself starts `sh -c` for the package script. "No shell" holds for what this library spawns; the script body is the repository's own, as with any test run.
- The agent can edit `package.json` scripts or test files, which the allowlisted check then executes. That is inherent to running tests; OMP's `exec` approval is the boundary, and the commit-before-run rule covers only `ei.config.json`.
- A grandchild that calls `setsid` leaves the process group and survives the kill.
- `execFile` named in V2-README is replaced by `spawn` without a shell (the primitive `execFile` wraps) to keep a 2 MB tail and a process-group kill; recorded in `v2c-round0.md`.
