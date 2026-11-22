---
name: matt-sdlc
description: Requirements, specifications, domain modeling, TDD, implementation, debugging, and REQ compliance audits under KSD orchestration.
---

# Matt Pocock — KSD SDLC Pack (`matt-sdlc`)

Primary workflow owner for requirements, specifications, TDD, feature implementation, bug diagnosis, and requirement compliance review.

## Upstream Attribution & References

- Upstream repository: `https://github.com/mattpocock/skills.git` (`skills/engineering/`, MIT License, Matt Pocock)
- Pinned KSD leaf skills (loaded via `ei_workflow` with `EI_MATT_ROOT`):
  - Bug diagnosis: `matt:diagnosing-bugs`
  - Codebase design: `matt:codebase-design`
  - Test-first development: `matt:tdd`
  - Code & requirement review: `matt:code-review`
- Upstream reference playbooks (read from pinned `EI_MATT_ROOT` checkout when needed):
  - Clarify requirements: `grill-with-docs`
  - Write specifications: `to-spec`
  - Design domain models: `domain-modeling`
  - Implement a feature: `implement`
  - Implement multi-ticket specs: `implement-spec`

## Workflow & Requirement Compliance

1. Confirm requirements, acceptance criteria, and public seams before writing code.
2. Check blast radius with `ei_impact` before modifying shared TS/JS symbols.
3. Follow red-green TDD at public seams using real assertions, never tautological tests.
4. Audit requirement compliance across all four dimensions:
   `REQ × Code × Test × Runtime Evidence`
   - **REQ**: Every approved requirement and constraint is enumerated.
   - **Code**: Implementation satisfies each requirement without out-of-scope drift.
   - **Test**: Automated tests cover behavior and can fail when broken.
   - **Runtime Evidence**: Observed execution output is reported (`VERIFIED` | `MOCK-ONLY` | `NOT VERIFIED`).

## Boundaries

- KSD (`ksd-intelligence`) remains the primary orchestrator; do not enable `ask-matt` as a second automatic router.
- Preserve existing behavior outside approved scope.
- Never weaken, skip, or delete existing tests or alter approved requirements.
- Never execute skill scripts or push, merge, or deploy without explicit authorization.
