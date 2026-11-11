# AGENTS.md — ksd-intelligence

Standing rules for any coding agent working in this repository. Read this file at the start of every session. If a task brief conflicts with this file, stop and ask the owner.

## What this project is

A personal, local-first Engineering Intelligence Library for Oh My Pi (OMP). One owner, one user. OMP is the host and stays in charge of permissions, model routing and sessions. This library adds evidence-backed TS/JS code understanding, a single skill workflow router, and (later) context, knowledge and verification adapters.

Authoritative design: `docs/DESIGN.md` (contracts, codes, decisions, gates), with `docs/TOOLS.md` (agent-facing tool text), `docs/RISK.md` (risk containment, in force), `docs/adr/` (stable keys, indexed declarations) and `tests/golden/` (owner-confirmed oracle). Historical background: `docs/reference/knowledge-export.md`. Neither is a task list. Do only what the current milestone brief asks. If a brief conflicts with `docs/DESIGN.md`, stop and ask.

## Current scope (V1)

In scope, in order:

| Order | Milestone | Goal | Brief |
|---|---|---|---|
| 1 | M0 ✅ | TS repo foundation + skill router ported and fixed | `docs/briefs/M0-foundation.md` |
| 2 | M1 | `ei_workflow` smoke-tested in the real installed OMP | `docs/briefs/M1-omp-smoke.md` |
| 3 | M1b | Runtime spike: facts only, no product code | `docs/briefs/M1b-runtime-spike.md` |
| 4 | M2a | Codebase scan, whole-scope index, store, `ei_status` | written after M1b review |
| 5 | M2b | `ei_impact` passing the engine golden cases | written after M2a review |
| 6 | M3 | Dogfood on real repositories (owner-led, continues alongside later milestones) | written after M2b review |
| 7 | M4a | Route detection (Next.js, Expo Router, Hono) | written when scheduled |
| 8 | M2c | Risk zones, `ei_changes`, audit log | written when scheduled |
| 9 | M6a | `ei_search`, lexical | written when scheduled |
| 10 | M4b | Heuristic bridges, one flow at a time | written when scheduled |
| 11 | M5 | Session watcher, worktree seeding | written when scheduled |
| 12 | M6b | Semantic search (optional local embeddings) | written when scheduled |

A milestone without a brief is not started. Design for all of them is in `docs/DESIGN.md`; tool text in `docs/TOOLS.md`.

Out of scope until the owner says otherwise: MCP adapter, multi-OS CI, npm publishing, SBOM, compression/CCR, knowledge store, visual QA adapter, GitLab adapter, graph database servers, external vector or embedding services, Rust.

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
- **Runtime dependencies: none** without asking the owner first. Approved: `typescript`, pinned to an exact version (from M1b). Anticipated, still needing the owner's yes in its milestone: an optional local embedding runtime (M6b). The runtime's built-in SQLite is not a dependency. Allowed dev dependencies: `typescript`, `@types/node`. Ask before adding anything else.
- Tests use `node:test` + `node:assert/strict`.
- Explicit error types or messages that say what failed and where (e.g. "provider root not found" vs "skill file not found").
- Comments explain **why**, not what.

## Safety boundaries

- Other code-intelligence tools (GitNexus, Graft, CodeGraph) may index this repo and write into it. Never commit their edits: revert any block they inject into `AGENTS.md`, and put their local ignore patterns in `.git/info/exclude`, not in tracked files. Report such edits when you see them.

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
