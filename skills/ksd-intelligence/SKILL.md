---
name: ksd-intelligence
description: Evidence-backed TypeScript/JavaScript code intelligence and KSD engineering workflow orchestration (ei_status, ei_impact, ei_workflow, and ei CLI) for AGY and OMP.
---

# KSD Engineering Intelligence (`ksd-intelligence`)

KSD is the primary orchestrator for evidence-backed code analysis and pinned engineering skill routing across both Antigravity (AGY) and Oh My Pi (OMP).

## 1. Tools (`ei_*`)

- `ei_status` (`{}`): Inspect index state (`ready` | `degraded` | `disabled`), coverage, freshness, and pinned TypeScript runtime status.
- `ei_impact` (`{ targets: ["SymbolName" | "path/to/file.ts#SymbolName" | "path/to/file.ts"], depth?: 1..10 }`):
  - Query 1–5 targets before editing exported or shared TypeScript/JavaScript declarations.
  - Inspect `verdict`, `completeness`, `reach`, `factors`, `gaps`, and `next` before acting.
- `ei_workflow` (`{ task: "...", stage: "plan"|"investigate"|"implement"|"verify"|"review"|"ship", risk?: "normal"|"high", type?: "bug"|"feature"|"refactor"|"security"|"performance"|"ui", potetoMode?: boolean }`):
  - Routes a task to one primary workflow owner per stage from the KSD skill catalog (`matt-sdlc`, `pstack-analysis`, `osmani-quality`), plus at most one justified secondary skill.
  - `poteto-mode` is strictly opt-in (`potetoMode: true`) and never enabled automatically.

## 2. Routing Ownership

- Requirements / TDD / Implementation / REQ Audit -> `matt-sdlc`
- Architecture / Investigation / Root Cause / Blast Radius -> `pstack-analysis`
- Complex multi-phase execution (explicit opt-in only) -> `poteto-mode`
- UI Verification / Security / Performance / Quality Gates / Release -> `osmani-quality`
- Requirement compliance -> `REQ × Code × Test × Runtime Evidence`

## 3. Portable CLI Usage (`ei`)

Run the compiled CLI with Node >= 22.5 (no hardcoded user-home paths required):

```bash
# Check workspace status, build index, or inspect impact
ei status --root "<WORKSPACE_ROOT>"
ei index --root "<WORKSPACE_ROOT>"
ei impact <target1> [target2...] --depth 2 --root "<WORKSPACE_ROOT>"

# Route or load pinned workflow skills (provider checkouts supplied via env)
EI_MATT_ROOT="<MATT_CHECKOUT>" \
EI_POTETO_ROOT="<PSTACK_CHECKOUT>" \
EI_OSMANI_ROOT="<OSMANI_CHECKOUT>" \
ei load --task "<task description>" --stage investigate --risk normal

# Inspect and audit the KSD skill catalog for AGY or OMP
ei skills list --platform agy
ei skills check --platform omp
```

## 4. Non-Negotiable Rules

1. KSD policy and explicit owner decisions always outrank skill text.
2. Zero callers never proves safety on its own; check `completeness`, `gaps`, and `factors`.
3. Skills are instructions, not executors; never run scripts from skill directories without review.
4. Never bypass approvals or security controls; never push, merge, or deploy automatically.
