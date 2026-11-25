# V2c — Verification evidence, `ei_verify` (agent brief, DRAFT)

Start with Round 0 (`README.md`). Read `docs/briefs/V2-README.md`, then `docs/DESIGN.md` §6.6, §7.8, §12; `docs/RISK.md`.

**Branch:** `v2c-verify` from `v1.0.0`.

## Goal

When the agent says "tests pass", there is a record of what ran, on which revision, with which exit code. `ei_verify` runs an owner-approved check or reads an existing result and returns `PASS · FAIL · SKIPPED · ERROR · NOT_VERIFIED`. It never infers `PASS`.

## Round 0 additions

Read the installed OMP extension types and record which approval levels a tool can declare and how the user is asked. If OMP has no approval level for a tool that runs a process, `ei_verify` in Round 1 **only reads** results (sources 2–4 below) and running stays with OMP's own shell tool; say which applies.

## Round 1 — checks and reports (`src/core/verify/`)

Sources, in this order:

1. **Run an allowlisted check.** `verification.checks` in `ei.config.json`: `{ "name": "unit", "command": ["npm", "test"], "timeoutSec": 600 }`. Run with `execFile` (no shell), `cwd` = repository root, environment inherited minus variables matching secret patterns, output captured with a cap (2 MB, tail kept), timeout kills the process tree. The agent passes only a check **name**; any other input is rejected. The tool declares the approval level found in Round 0.
2. **Read a JUnit XML or TAP file** at a path the config names, if newer than the last commit touching the tested files.
3. Otherwise `NOT_VERIFIED` with the reason.

- `VerificationReport` per DESIGN §7.8; `revision` = `git rev-parse HEAD` plus a `dirty` flag (uncommitted changes make the report say so on line 1).
- Status rules: exit 0 and no failed test → `PASS`; non-zero or failed tests → `FAIL`; timeout or spawn error → `ERROR`; check not configured → `NOT_VERIFIED`. A run with zero tests executed is `SKIPPED`, never `PASS`.
- Reports stored in the cache dir, last 10 per check (DESIGN §11); output redacted before storing.

Risky cases, one test each:
- A check name not in the allowlist; a name containing `;`, spaces or a path → rejected, nothing runs.
- Exit 0 with "0 tests" output → `SKIPPED`.
- A test runner that prints PASS but exits 1 → `FAIL`.
- Timeout → `ERROR`, process tree gone (assert pids).
- An environment variable `GITLAB_TOKEN=x` or `*_SECRET=y` is not passed to the check and does not appear in the report.
- Dirty working tree → reported on line 1.
- A stale JUnit file older than the source change → not used.

## Round 2 — tool, CLI, value check

- `ei_verify` with `check` (name) or `source: "junit" | "pipeline"`; CLI `ei verify <check> [--json]`; text: line 1 `VERIFY <name> — <STATUS> · <revision>[ · dirty]`, then exit code, duration, counts, the failing tests (max 10), the output tail (max 40 lines), the footer.
- `ei_changes` text gains, when a report exists for the current revision, one line naming it; when none exists, `Next:` asks for `ei_verify`. No verdict changes.
- Disabled by default; V1 snapshots unchanged when disabled.
- **Value check:** 5 tasks through `omp -p` where the agent must report test status; with the module off and on, count claims of passing tests made without a report.

## Round 3 — review (different vendor), then fix

**Review focus:** any path from agent input to a command line; shell use; environment or output leaking secrets; `PASS` from anything but an exit code with tests run; orphan processes; reports surviving a revision change as if current.

## Do not

- Run anything not in the owner's allowlist, or build a command from agent text.
- Retry a failing check to get a pass.
- Write outside the cache dir.
