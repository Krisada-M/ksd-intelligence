---
name: erosiano-review
description: Review scoped changes using the shared erosiano-dev engineering standard, project baseline, code impact and actual verification evidence. Use when reviewing a diff or assessing release readiness.
---

# Evidence-based engineering review

Use the enabled plugin's generated balanced engineering rule. Project instructions, contracts and native safety gates take precedence over personal preferences. Do not reproduce the entire practice catalog.

1. Identify the requested scope, acceptance criteria, affected contracts and risk. Read applicable instructions, maintained code, callers, tests and native gate configuration. Distinguish current, legacy, transitional, local, exception and unknown observations, with evidence and confidence.
2. If the explicitly configured workspace MCP is available, check its fixed root and index status; use `ei_search`, `ei_impact` and `ei_changes` for discovery and impact. Partial or degraded evidence is not a safety verdict. If unavailable, inspect source and tests directly.
3. For a scoped practice selection, use the approved terminal companions `erosiano-baseline` and `erosiano-practices` from the same installed KSD package. Capture the actual scope and relevant caller/test/config files, then provide the snapshot fingerprint and path-based observation provenance. Never invent a fingerprint or supply another repository root. If the engineering MCP tools are explicitly configured, use them instead. A stale or incomplete baseline must be refreshed or reported unknown.
4. Inspect tracked and intended untracked changes, including deletion/rename effects. Determine required native checks from the repository. Verify only through AGY's permitted tools, and record commands, cwd, exit status, counts and exact reviewed revision. Never infer PASS from a test definition, skipped check, admin-only access or synthetic fixture.
5. Escalate authentication, tenant isolation, payment replay, database migration, secrets and concurrency based on behavior. Check normal-user denial and failure paths; never execute real payments or destructive shared-database tests.
6. Report severity, file/line evidence, affected contracts, verification results, remaining unknowns, rollback impact and approval blockers. Do not merge, publish or deploy.

AGY does not emulate OMP's command/session lifecycle. Do not invoke OMP slash commands or change host tool permissions. No automatic execution of bundled scripts or installation of dependencies.
