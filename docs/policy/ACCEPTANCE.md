# Engineering Proxy v0.6.0 — Acceptance & evidence

Evidence names below are test titles in `plugins/engineering-proxy/test/`. CI runs them on Ubuntu and macOS with Node 22.13 and 24.

## Implemented and unit-testable

| ID | Requirement | Current evidence |
|---|---|---|
| AC01 | Never register Ponytail command names or overwrite Ponytail mode | "namespace does not collide with Ponytail commands or modes"; "adaptive command updates status and policy immediately, with no Ponytail mutation" |
| AC02 | Add policy under `engineering-proxy`, preserve the `ponytail` section | "structured sections preserve Ponytail and are stable on repeated hooks" |
| AC03 | No duplicate policy in structured, array or string prompts, including after a version upgrade | "array fallback preserves all existing policy parts and avoids duplicates"; "string fallback preserves existing policy and avoids duplicates"; "previous-version policy in array is replaced, never duplicated" |
| AC04 | Work when Ponytail is not installed | "works when Ponytail is absent" |
| AC05 | Per-repo disable; missing or invalid config never crashes OMP and never silently enables guidance | "malformed JSON disables policy with explicit warning rather than crashing"; "invalid per-repo config never silently enables guidance" |
| AC06 | No blank before a first-statement return; blank optional after one statement; exactly one blank after two or more statements | "first-statement guard return has no leading blank; later returns need exactly one"; "return after one statement may hug it; after two or more it needs exactly one blank" |
| AC07 | Function spacing: exactly one blank between implementations; comments and TS overloads respected | "exactly-one blank enforced: zero and two are both errors, comments block false positives"; "TS overload groups stay untouched and full members still need exactly one blank" |
| AC08 | Nested-if detection never autofixes | "prefer-guard-clauses is warning-only with no autofix, and deep nesting stays single-message" |
| AC09 | Review launches only on an explicit command and carries the SDLC checklist | "review only starts on explicit command, one request per trigger, and queues while busy" |
| AC10 | Per-turn policy is the personal style profile; the SDLC checklist is not injected every turn | "adaptive command updates status and policy immediately, with no Ponytail mutation" |
| AC11 | Mode precedence: session > project > global > balanced, restored on session resume | "mode restores on session resume and falls back to repo default" |
| AC12 | The installed tarball works in a host ESLint setup | "host ESLint uses installed plugin with real JavaScript and TypeScript" |
| AC13 | Review verdicts never report readiness without executed evidence | "omitted declared critical gates are synthesized as NOT_RUN and force NO_GO"; "VERIFIED with a failing exit code normalizes to FAILED and NO_GO" |

## Observed in a live session

- WSL, OMP with Ponytail installed: the policy was injected exactly once into a live system prompt (v0.5.1, adaptive). The v0.6.0 upgrade installed through the marketplace, and its `buildPolicy` output was checked offline; a fresh v0.6.0 session has not been observed yet.

## NOT VERIFIED — live environment required

- macOS marketplace installation and a live v0.6.0 session on either platform.
- Live Ponytail lite/full/ultra/off switching across sessions and subagents.
- The full ESLint profile (`examples/eslint.config.mjs`) wired into a real host repository's lint-staged; whole-tree adoption on an existing codebase needs changed-line gating through `check-changed`.
- Error handling, helper extraction and comment rules exist only as prompt guidance; no lint rule checks them.

The plugin does not hold approval authority or change Git or production state. Keep human review and repository CI authoritative.
