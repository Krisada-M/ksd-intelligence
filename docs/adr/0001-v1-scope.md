# ADR 0001 — V1 scope

Status: accepted (owner, 2026-11-09). Source of truth: `AGENTS.md`.

## Decision

V1 is a personal, local-first library for Oh My Pi (OMP). OMP stays in charge of permissions, model routing and sessions.

Included, in order:

| Milestone | Goal |
|---|---|
| M0 | TypeScript repo foundation; skill workflow router ported from the prototype, bugs fixed, sources pinned and hash-checked |
| M1 | `ei_workflow` smoke-tested in the real installed OMP |
| M2 | Read-only `ei_impact` on a fixture monorepo with golden tests (in-memory, content-hash cache) |
| M3 | Dogfood on the oh-my-pi repository |

Excluded until the owner says otherwise: MCP adapter, multi-OS CI, npm publishing, SBOM, compression/CCR, knowledge store, visual QA adapter, GitLab adapter, vector search, graph databases, Rust, SQLite, runtime dependencies.

## Consequences

- One milestone at a time; stop and report at the end of each.
- Zero runtime dependencies; dev dependencies limited to `typescript` and `@types/node`.
- Coexists with KSD Engineering Proxy (its policy outranks skill text); only one automatic skill router may be active.

## Open owner decision

High-risk routing currently adds one extra skill at two stages only: `poteto:blast-radius` at `review` and `osmani:security-and-hardening` at `verify`. Other stages get no high-risk addition. M0 preserves this behavior from the prototype unchanged; whether other stages (for example `implement` or `ship`) should also get a high-risk reviewer is not decided.
