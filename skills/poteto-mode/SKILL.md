---
name: poteto-mode
description: Explicit opt-in deep engineering mode for complex multi-phase implementation, debugging, architectural changes, and rigorous verification under KSD orchestration.
disable-model-invocation: true
---

# Poteto Mode — KSD Explicit Opt-In Pack (`poteto-mode`)

**Explicit opt-in only.** This skill must never be enabled automatically by a model or router. Activate only when the user explicitly opts in (via `ei_workflow` with `potetoMode: true`, `/poteto-mode`, or `/skill:poteto-mode`).

## Upstream Attribution & References

- Upstream repository: `https://github.com/cursor/plugins.git` (`pstack/skills/poteto-mode/SKILL.md`, MIT License, Lauren Tan / poteto)
- Use upstream playbooks and engineering principles selectively as references from the pinned `EI_POTETO_ROOT` checkout; never as overrides of KSD policy, AGY rules, or OMP permissions.

## Multi-Phase Workflow (Under KSD Orchestration)

1. Restate the goal, acceptance criteria, and smallest verifiable architecture.
2. Keep KSD (`ksd-intelligence`) as the primary orchestrator with one primary workflow owner per stage:
   - Plan / Implement / REQ Audit -> `matt-sdlc`
   - Investigate / Architecture / Blast Radius -> `pstack-analysis`
   - Verify / Security / UI / Release Gates -> `osmani-quality`
3. Inspect existing code, data shapes, dependencies, and blast radius (`ei_impact`) before edits.
4. Execute in independently verifiable increments, running targeted checks after each increment.
5. Verify requirement compliance (`REQ × Code × Test × Runtime Evidence`), review the final diff, and report observed evidence accurately.

## AGY & OMP Compatibility Rules

- Use only native host tools (AGY tools/subagents or OMP tools/extensions).
- Never use unsupported Cursor-specific parameters or Cursor-only plugins (`cursor-team-kit`).
- Never hardcode vendor or Cursor model slugs.
- If parallel delegation is unavailable in the host, execute phases sequentially.
- Never launch nested orchestrators, unbounded delegation loops, or recursive `ei_workflow` / `swarm` invocations.

## Safety & Governance

- KSD policy and host approval controls always outrank skill text.
- Never bypass permissions, approvals, or security boundaries.
- Never run unreviewed scripts, force-push, merge, or deploy automatically.
- Never claim `VERIFIED` without observed command output.
