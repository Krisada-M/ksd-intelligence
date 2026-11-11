# M1b — Runtime spike (agent brief)

Read `AGENTS.md` first. M1 is accepted. This brief covers M1b only. **It produces facts, not product code.** Stop and report when done.

## Why

The index design depends on things nobody has checked inside OMP's extension runtime: worker threads, a built-in SQLite, how `typescript` loads, how much memory a real project needs, and whether a tool can stream progress. Decisions D30, D31 and D35 and the storage choice in `docs/DESIGN.md` §11 are provisional until these are measured.

## Rules

- All spike code lives under `spikes/m1b/` and is never imported by `src/`. It may be deleted after the report.
- `typescript` may be added as a dependency now (owner-approved, D30), pinned to an exact version. No other new dependency.
- Read-only towards any project you measure. Do not modify OMP, `~/.omp/**`, or the measured repository. Write only under the OS temp directory and `spikes/m1b/out/`.
- Label every finding `VERIFIED` (ran it, pasted output) or `NOT VERIFIED`.

## Part A — inside a loaded extension

Write a throwaway extension `spikes/m1b/probe-extension.mjs` that registers one read-only tool, `ei_probe`, and load it with `omp --extension`. If OMP has a non-interactive mode (found in M1), use it; otherwise prepare the script and checklist and report `PARTIAL — owner run required`.

`ei_probe` reports, as text:

| # | Fact | How |
|---|---|---|
| A1 | Runtime name and version; `process.versions`; platform; whether `Bun` or `Deno` globals exist | read globals |
| A2 | Worker threads | start a `node:worker_threads` worker that echoes a message, then terminate it; report success, startup time, and whether `resourceLimits` is honoured (allocate past a small cap and observe) |
| A3 | Loading `typescript` | `import('typescript')` resolved from the extension's own location; report version and resolved path; then the same inside the worker |
| A4 | Built-in SQLite | try `node:sqlite`, then `bun:sqlite`; open an in-memory database; create an FTS5 table, insert, `MATCH` query; report which module worked, SQLite version, WAL support on a temp file |
| A5 | Progress streaming | call the `onUpdate` callback three times one second apart before returning; report whether the session showed the updates and what the callback's argument shape must be (from the installed types) |
| A6 | Blocking tolerance | a call that returns after 20 s and one after 60 s: does OMP time out, cancel, or wait? Is `signal` aborted? |
| A7 | Module format and paths | does the extension load as ESM from `dist/`; do relative imports and `new URL(…, import.meta.url)` for the worker file work |

## Part B — cost on a real project

Run from the CLI (plain Node, and also under the runtime found in A1 if it is not Node), using the scripts in `docs/research/experiments/` as a starting point.

Pick **one real TypeScript project with `node_modules` installed** (the owner names it; if none is named, use the oh-my-pi checkout after `npm ci`/`bun install` in a temp copy, and say so). Measure and report:

| # | Measurement |
|---|---|
| B1 | Files, lines, number of `tsconfig` projects, whether project references are used |
| B2 | Per project and total: create-program time, resolve-pass time restricted to ADR 0003's indexed uses, peak RSS |
| B3 | Same in a worker with a 1.5 GB and a 3 GB cap: does it complete? |
| B4 | Builder program: time for a one-file body edit, a signature edit, and a global `.d.ts` edit; affected-file counts |
| B5 | Persisting build info: can builder state be written and read back so a new process avoids a cold resolve? Time saved, file size |
| B6 | Affected-set experiment re-run with project references and a `paths` alias (extend `ts-affected.cjs`) |
| B7 | Probe cost: time to list visible files (tracked + untracked, ignore rules applied) and `stat` them all |
| B8 | Records stored versus uses skipped, by ADR 0003 category |

## Deliverable

`docs/research/m1b-runtime-facts.md`: one table per part, each row with the command, the key output and a `VERIFIED` / `NOT VERIFIED` label, followed by a short "implications" list naming which lines of `docs/DESIGN.md` (§6.2.1, §11, D30, D31, D35) hold, and which must change. Do not edit `docs/DESIGN.md` yourself; the owner applies the changes after review.

## Acceptance

1. A1–A7 and B1–B8 each have evidence or an explicit `NOT VERIFIED` with the reason.
2. A clear answer to four questions: Can the engine run in a worker here? Which SQLite, if any? What memory cap is realistic for the measured project? Can a tool block for 60 s with visible progress?
3. No change under `src/` or `tests/`; `npm test` still passes (paste the summary).
4. Report in the `AGENTS.md` template.

## Do not

- Start M2a, or create anything under `src/core/`.
- Leave the probe extension loaded by default, or change OMP configuration.
- Commit or push.
