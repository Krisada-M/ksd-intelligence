---
name: pstack-analysis
description: Architecture analysis, code investigation, root cause analysis, blast radius assessment, and design trade-off reasoning under KSD orchestration.
---

# pstack — KSD Analysis Pack (`pstack-analysis`)

Primary workflow owner for architecture review, deep code investigation, design rationale, and blast-radius assessment.

## Upstream Attribution & References

- Upstream repository: `https://github.com/cursor/plugins.git` (`pstack/skills/`, MIT License, Lauren Tan / poteto)
- Pinned KSD leaf skills (loaded via `ei_workflow` with `EI_POTETO_ROOT`):
  - Existing implementation trace: `poteto:how`
  - Design rationale: `poteto:why`
  - Change impact & blast radius: `poteto:blast-radius`
- Upstream reference playbooks (read from pinned `EI_POTETO_ROOT` checkout when needed):
  - Architecture boundaries: `architect`
  - Compare alternatives: `arena`
  - Complex investigation: `figure-it-out`
  - Challenge assumptions: `interrogate`
  - Verifiable evidence trail: `show-me-your-work`

## Workflow

1. Prefer source-backed investigation and `ei_impact` before proposing or making edits.
2. Trace concrete data shapes, call graphs, dependencies, and completeness gaps.
3. Report uncertainty, hidden assumptions, and regression risks explicitly; never claim "safe" from incomplete evidence.
4. Distinguish observed facts (`VERIFIED`) from mocked checks (`MOCK-ONLY`) and unrun areas (`NOT VERIFIED`).

## Boundaries

- KSD (`ksd-intelligence`) remains the primary orchestrator.
- Do **not** automatically start `poteto-mode` or `swarm`.
- Do **not** invoke Cursor-only subagent parameters or hardcoded model slugs.
- Never execute skill scripts or push, merge, or deploy without explicit authorization.
