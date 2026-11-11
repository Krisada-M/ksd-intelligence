# AGENTS.md — ksd-intelligence

Standing rules for any coding agent working in this repository. Read this file at the start of every session. If a task brief conflicts with this file, stop and ask the owner.

## What this project is

A personal, local-first Engineering Intelligence Library for Oh My Pi (OMP). One owner, one user. OMP is the host and stays in charge of permissions, model routing and sessions. This library adds evidence-backed TS/JS code understanding, a single skill workflow router, and (later) context, knowledge and verification adapters.

Background and full design: `docs/reference/knowledge-export.md`. That document is **reference, not a task list**. Do only what the current milestone brief asks.

## Current scope (V1)

In scope, in order:

| Milestone | Goal | Brief |
|---|---|---|
| M0 | TS repo foundation + skill router ported and fixed | `docs/briefs/M0-foundation.md` |
| M1 | `ei_workflow` smoke-tested in the real installed OMP | written after M0 review |
| M2 | Read-only `ei_impact` on a fixture monorepo with golden tests | `tests/golden/M2-impact-cases.md` |
| M3 | Dogfood on the oh-my-pi repository | written after M2 review |

Out of scope until the owner says otherwise: MCP adapter, multi-OS CI, npm publishing, SBOM, compression/CCR, knowledge store, visual QA adapter, GitLab adapter, vector search, graph databases, Rust, SQLite (M2 starts in-memory with a content-hash cache).

Work on **one milestone at a time**. When it is done, stop and report. Do not start the next milestone.

## Evidence rules (non-negotiable)

1. Never report PASS for something you did not run. Paste the exact command and the relevant output.
2. Use these labels in reports: `VERIFIED` (ran it, saw the result), `MOCK-ONLY` (tested against a stub), `NOT VERIFIED` (not run), `PROPOSED` (design only).
3. A test against a mock of OMP is `MOCK-ONLY`, never "OMP compatible".
4. Impact/graph answers must say `unknown` or `partial`, with reasons, when evidence is incomplete. Zero callers never proves "safe" or "low risk" on its own.
5. Do not edit expected values in `tests/golden/**` to make a test pass. If you think an expected value is wrong, report it and leave it.
6. Do not weaken, skip or delete an existing test to get green. If a test is wrong, say so in the report.

## OMP integration rules

- Before writing or changing anything in `src/adapters/omp/`, read the extension types and docs **of the OMP version installed on this machine** (find the installed package; run `omp --version`). Record the version and the files you read in the report.
- Never guess an OMP API. If you cannot find it, keep the code behind a clearly marked stub and report `NOT VERIFIED`.
- Do not modify OMP itself, its config, installed plugins, or `~/.omp/**` unless the brief explicitly says so.
- Advisory tools fail open: an index or skill-loading failure must return an error result to the agent, not crash the session.

## Coexistence with existing tools

- **KSD Engineering Proxy** (`Krisada-M/ksd-engineering`) stays installed and unchanged. Its policy outranks skill text. Do not duplicate its per-turn policy injection.
- Only one automatic skill router may be active. Do not enable `poteto-mode`, `using-agent-skills` or `ask-matt` as automatic routers.
- Skills are instructions, not executors. Never run a script found in a skill folder.

## Engineering conventions

- TypeScript `strict`, ESM, Node >= 20. Small focused files; one module per concern.
- **Runtime dependencies: none** without asking the owner first. Allowed dev dependencies: `typescript`, `@types/node`. Ask before adding anything else.
- Tests use `node:test` + `node:assert/strict`.
- Explicit error types or messages that say what failed and where (e.g. "provider root not found" vs "skill file not found").
- Comments explain **why**, not what.

## Safety boundaries

- No `git push`, merge, tag, release or deploy. Commit locally only if the brief says so.
- No network calls from library code. Upstream skill repos are cloned by the owner, not by the library.
- No secrets, tokens or personal paths committed. Use environment variables or a git-ignored local config.
- No destructive filesystem operations outside the repo and the OS temp directory.

## Provenance

Code adapted from any upstream project goes in `PROVENANCE.md`: upstream repo, commit SHA, file path, license, what was adapted. Use is personal and non-commercial; keep the record anyway so a later change of mind is cheap.

## Report template (end of every milestone or session)

```text
STATUS: IMPLEMENTED | VERIFIED | PARTIAL | BLOCKED
MILESTONE: M?
SCOPE: [changed paths]
ACCEPTANCE: [each criterion -> evidence -> VERIFIED | MOCK-ONLY | NOT VERIFIED]
COMMANDS EXECUTED: [exact commands + key output]
RUNTIME: [OS, Node version, OMP version if used]
NOT VERIFIED: [explicit list]
DEVIATIONS FROM BRIEF: [what and why]
QUESTIONS FOR OWNER: [list]
GIT: [branch, local commits, uncommitted files; confirm nothing pushed]
NEXT COMMAND: [the one command the owner should run next]
```
