---
name: osmani-quality
description: Code quality, UI verification, browser DevTools testing, accessibility, API design, security hardening, performance, observability, and release readiness under KSD orchestration.
---

# Addy Osmani — KSD Quality Pack (`osmani-quality`)

Primary workflow owner for UI engineering, browser verification, security hardening, performance optimization, quality gates, and release readiness.

## Upstream Attribution & References

- Upstream repository: `https://github.com/addyosmani/agent-skills.git` (`skills/`, MIT License, Addy Osmani)
- Pinned KSD leaf skills (loaded via `ei_workflow` with `EI_OSMANI_ROOT`):
  - Spec-driven planning: `osmani:spec-driven-development`
  - Incremental implementation: `osmani:incremental-implementation`
  - Code review & quality gates: `osmani:code-review-and-quality`
  - Security & hardening: `osmani:security-and-hardening`
  - Performance optimization: `osmani:performance-optimization`
  - Frontend UI engineering: `osmani:frontend-ui-engineering`
  - Browser verification: `osmani:browser-testing-with-devtools`
  - Release readiness: `osmani:shipping-and-launch`
- Additional upstream references (when present in pinned `EI_OSMANI_ROOT`):
  - API contracts: `api-and-interface-design`
  - Observability: `observability-and-instrumentation`
  - Accessibility audit: `accessibility-engineering`

## Verification & Quality Gates

1. Use actual browser, test, lint, typecheck, and runtime evidence where applicable.
2. If a required verification tool (such as a live browser or target host runtime) is unavailable, mark that check `NOT VERIFIED` and state why.
3. Audit changes against `REQ × Code × Test × Runtime Evidence` before sign-off.
4. Preserve existing business behavior and test coverage.

## Boundaries

- KSD (`ksd-intelligence`) remains the primary orchestrator; do not enable `using-agent-skills` as a second automatic router.
- Never bypass security controls or permissions.
- Never execute skill scripts or push, merge, or deploy automatically.
