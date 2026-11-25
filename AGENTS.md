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
| 2 | M1 ✅ | `ei_workflow` smoke-tested in the real installed OMP | `docs/briefs/M1-omp-smoke.md` |
| 3 | M1b ✅ | Runtime spike: facts only, no product code | `docs/briefs/M1b-runtime-spike.md` |
| 3b | M1c ✅ | Merge KSD Engineering Proxy as `src/policy/`; one plugin; marketplace packaging | `docs/briefs/M1c-ksd-merge.md` |
| 3c | M1d ✅ | macOS + Linux CI baseline; live smoke remains a separate release gate | `docs/briefs/M1d-platform-baseline.md` |
| 4 | M2a ✅ | Engine host, store, scan, index, `ei_status` (two parts, stop between) | `docs/briefs/M2a-index.md` |
| 5 | M2b ✅ | `ei_impact` passing the engine golden cases (merged #32) | `docs/briefs/M2b-impact.md` |
| 6 | M3 ✅ | Exit decisions recorded (D63); owner-led dogfood continues | `docs/briefs/M3-dogfood.md` |
| 6b | M3b | Comparative research only; no findings used for this candidate | `docs/briefs/M3b-compare.md` |
| 7 | M2c ✅ | Risk zones, `ei_changes`, audit log and stage protocol (#34) | `docs/briefs/M2c-changes.md` |
| 8 | M6a ✅ | `ei_search`, lexical only (#34, D62) | `docs/briefs/M6a-search.md` |
| 9 | M4a | Framework route detection skipped for V1 (D61) | `docs/briefs/M4a-routes.md` |
| 10 | M4b · M5 · M6b | PLANNED (V2); gates not met (D63) | `docs/briefs/gated-M4b-M5-M6b.md` |
| 11 | MAGY1 ✅ | Local AGY stdio bridge; live host acceptance tracked separately | `docs/briefs/MAGY1-mcp.md` |
| 12 | V1 close-out | 1.0.0 candidate; owner release gates remain | `docs/briefs/V1-closeout.md`, `docs/release-checklist.md` |

## V2 (owner override of the entry gates, D64; starts after `v1.0.0`)

| Order | Module | Goal | Brief |
|---|---|---|---|
| V2a | Context packs | `ei_context`: what to read for a task, suggest only | `docs/briefs/V2a-context.md` (draft) |
| V2b | GitLab adapter | `ei_gitlab`: read-only issues, MRs, pipelines; first network code | `docs/briefs/V2b-gitlab.md` (draft) |
| V2c | Verification evidence | `ei_verify`: run allowlisted checks or read results; never infer PASS | `docs/briefs/V2c-verify.md` (draft) |
| V2d | Anchored knowledge | `ei_learning`: owner-approved learnings in `.ksd/learnings/` | `docs/briefs/V2d-knowledge.md` (draft) |
| V2e | Recoverable compression | `ei_retrieve` + OMP hook if one exists; byte-exact recovery | `docs/briefs/V2e-compression.md` (draft) |

Order, the rules that replace the gates, and the V2 safety rules: `docs/briefs/V2-README.md`. Each module ships disabled and must leave V1 output unchanged when disabled.

Round order, common rules and the one-line prompts are in `docs/briefs/README.md`. A draft brief starts with its Round 0 (reconcile) and is not built from until the owner accepts the corrections. A milestone without a brief is not started. Design for all of them is in `docs/DESIGN.md`; tool text in `docs/TOOLS.md`.

Out of scope until the owner says otherwise: MCP adapters other than the explicitly approved MAGY1 AGY stdio bridge, SBOM, visual QA adapter, graph database servers, external vector or embedding services, Rust. Compression, knowledge, verification and the GitLab adapter are in scope only as V2 modules under their briefs, after `v1.0.0`.

**Owner-directed integration exception (2026-11-19):** MAGY1 is approved as a self-contained adapter-only milestone with brief `docs/briefs/MAGY1-mcp.md`. It may reuse the existing compiled KSD Core but must not alter policy, OMP behavior, index contracts or golden results; it requires a Draft PR, the existing quality gates and five documented self-review passes. AGY live-host support remains NOT VERIFIED until a separate manual smoke check.

Work on **one milestone at a time**. M1d establishes CI before M2a; CI is a baseline, not proof that the index/impact engine works. When a milestone is done, stop and report. Do not start the next milestone.

## Evidence rules (non-negotiable)

1. Never report PASS for something you did not run. Paste the exact command and the relevant output.
2. Use these labels in reports: `VERIFIED` (ran it, saw the result), `MOCK-ONLY` (tested against a stub), `NOT VERIFIED` (not run), `PROPOSED` (design only).
3. A test against a mock of OMP is `MOCK-ONLY`, never "OMP compatible".
4. Impact/graph answers must say `unknown` or `partial`, with reasons, when evidence is incomplete. Zero callers never proves "safe" or "low risk" on its own.
5. Do not describe a macOS/Linux CI result as live OMP compatibility or as verification of an engine that does not yet exist. Record OS and architecture; require separate live OMP smoke on both OS families before claiming full support.
6. Do not edit expected values in `tests/golden/**` to make a test pass. If you think an expected value is wrong, report it and leave it. CI enforces this: a pull request touching `tests/golden/**`, `src/policy/**`, `tests/policy/**` or `tests/snapshots/**` fails until the owner adds the `owner-approved` label.
7. Do not weaken, skip or delete an existing test to get green. If a test is wrong, say so in the report.

## OMP integration rules

- Before writing or changing anything in `src/adapters/omp/`, read the extension types and docs **of the OMP version installed on this machine** (find the installed package; run `omp --version`). Record the version and the files you read in the report.
- Never guess an OMP API. If you cannot find it, keep the code behind a clearly marked stub and report `NOT VERIFIED`.
- Do not modify OMP itself, its config, installed plugins, or `~/.omp/**` unless the brief explicitly says so.
- Advisory tools fail open: an index or skill-loading failure must return an error result to the agent, not crash the session.

## Coexistence with existing tools

- **KSD policy module** (`src/policy/`, merged from KSD Engineering Proxy in M1c): its commands, config files, status text and policy text are a frozen contract (`docs/DESIGN.md` §6.7). Changing any of them is a defect unless the owner asks for it. Its policy outranks skill text.
- Only one automatic skill router may be active. Do not enable `poteto-mode`, `using-agent-skills` or `ask-matt` as automatic routers.
- Skills are instructions, not executors. Never run a script found in a skill folder.

## Engineering conventions

- TypeScript `strict`, ESM, Node >= 20. Small focused files; one module per concern.
- **Runtime dependencies: none** without asking the owner first. Approved: `typescript`, pinned to an exact version (from M1b). Anticipated, still needing the owner's yes in its milestone: an optional local embedding runtime (M6b). The runtime's built-in SQLite is not a dependency. Allowed dev dependencies: `typescript`, `@types/node`. Ask before adding anything else.
- Tests use `node:test` + `node:assert/strict`.
- Explicit error types or messages that say what failed and where (e.g. "provider root not found" vs "skill file not found").
- Comments explain **why**, not what.

## Safety boundaries

- Other code-intelligence tools (GitNexus, Graft, CodeGraph) may index this repo and write into it. (Owner: run GitNexus here with `gitnexus analyze --index-only` so it stops injecting into `AGENTS.md`/`CLAUDE.md`.) Never commit their edits: revert any block they inject into `AGENTS.md`, and put their local ignore patterns in `.git/info/exclude`, not in tracked files. Report such edits when you see them.

- No `git push`, merge, tag, release or deploy. Commit locally only if the brief says so.
- No network calls from library code. Upstream skill repos are cloned by the owner, not by the library. Exceptions: owner-run `ei setup`, and from V2b the GitLab adapter under `src/adapters/gitlab/` when enabled. From V2c, processes run only from the owner's check allowlist, without a shell. From V2d, the only repository writes are `.ksd/learnings/*.yaml` through the owner's `ei learning approve`.
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
