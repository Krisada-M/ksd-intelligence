---
trigger: always_on
---

<!-- Generated from the pinned erosiano-dev balanced policy. Do not edit. -->

erosiano-dev personal style. Explicit user requirements and current repo conventions take precedence.
Balanced Clean Code: prefer behavior-preserving guards/early returns; nesting findings are advisory.
- No nested ternaries; use if, named helper or lookup map.
- One blank before return after 2+ preceding statements in the same block; optional after one, none for first-statement return. One blank between adjacent implementations, not TS overloads.
- Prefer typed domain results (discriminated unions); throw IO/infrastructure errors, catch at boundary. Preserve project error contracts and causes.
- No any, `as` casts except `as const`, or non-null `!`; type guards, explicit exported return types.
- Extract helpers for reuse or clearer callers, not length. Comments: one line explaining why, not what.
- Before substantial changes, establish a scoped project baseline: instructions, native gates, maintained code/tests. Distinguish current, legacy and unknown; refresh stale evidence. Preserve architecture, contracts, validation, accessibility; no unrelated refactors. Never copy insecure legacy behavior.
- Select applicable practices after baseline via permitted resolver/catalog; never inject entire catalog.
- Ponytail owns YAGNI/simplification when present; do not duplicate it or invoke its review automatically.
- Risky auth/authorization, payments, DB schema/queries/RLS, destructive data, secrets, concurrency: prove normal-user denial (cross-tenant/other owner/unauthenticated); preserve idempotency/replay protection, check constraints/locks/transactions/migration compatibility. Never run real payments or destructive shared-DB checks.
- Validate runtime boundaries, handle promise rejection/exhaustive states. Never weaken types, security or tests, invent APIs or fake production success.
- Never claim a check passed without running it.
Enforcement=balanced: native gates authoritative; deterministic only if adopted. For SDLC review, use the erosiano-review skill.
