# KSD Intelligence — V1 readiness

**Status:** ready-for-agent (planning approved; no milestone accepted by this spec)

## Problem Statement

The owner needs one local OMP plugin they can trust during everyday TS/JS changes. The current `main` contains the `ei_impact` tool, but its implementation landing did not close M2b. D59 records remaining paths to an incorrect `low`; the recorded `oh-my-pi` clean-query p95 is 1,173 ms against a target below 300 ms. Passing platform CI is also not evidence that the installed OMP plugin works on both operating systems.

## Solution

Finish and accept M2b against the existing contract. Start owner-led dogfood to quantify correctness, usefulness and latency. Deliver changed-code review first, then lexical lookup, then only framework detectors justified by evidence. Close V1 with audited claims and fresh-install and upgrade evidence. Keep optional work out of the release path unless the owner separately approves it.

## User Stories

1. As the owner, I want each D59 finding reproduced or disproved so that a green suite cannot hide a wrong `low`.
2. As a coding agent, I want the impact result to show known callers, tests and limits without presenting stale or partial evidence as complete.
3. As the owner, I want clean-query latency measured on the agreed stress corpus so that a fast small-repository run does not substitute for the real gate.
4. As the owner, I want final snapshots and live CLI/OMP evidence reviewed before I accept M2b.
5. As the owner, I want to run normal work with the plugin and see whether its answers were correct and changed what the agent did.
6. As the owner, I want separate platform evidence for the actual OMP extension and KSD policy so that Node CI does not overstate support.
7. As a coding agent, I want `ei_changes` to account for every changed path, including unindexed and untracked files, so I know what remains unchecked.
8. As a reviewer, I want risk zones and unplanned changes called out without hiding underlying gaps.
9. As the owner, I want a private local audit trail that shows tool use and outcomes without storing source or sensitive input.
10. As a coding agent, I want lexical results with provenance and freshness so that I can find code without treating a search hit as proof of behavior.
11. As a coding agent, I want verified route markers for frameworks I actually use without guessed edges or reduced completeness gaps.
12. As the owner, I want optional milestones decided from measured friction, not from a roadmap promise.
13. As the owner, I want a clean install and upgrade to match the documented capabilities, failure modes and support claims.

## Implementation Decisions

| Requirement | Outcome and gate | Ticket |
| --- | --- | --- |
| REQ-01 | Close M2b Round 6: disposition F1–F15, R8 and the two small D59 items. A known wrong `low` or a clean-query p95 at or above 300 ms on `oh-my-pi` blocks acceptance. | [01](issues/01-m2b-round-6.md) |
| REQ-02 | Collect final-revision M2b goldens, freshness, live output, CI, cross-vendor review and snapshot dispositions. Only the owner records acceptance. | [02](issues/02-m2b-acceptance.md) |
| REQ-03 | Start M3 after M2b acceptance. Reconcile the M3 brief with DESIGN §13: `oh-my-pi` and one owner-approved real GitLab project (read-only clone); `ksd-intelligence` is supplemental smoke. After setup, record owner-approved daily-use performance limits before unblocking M2c. | [03](issues/03-m3-dogfood-start.md) |
| REQ-04 | Close M1d live-platform evidence separately from the CI matrix. Record the actual runtime, revision and outcome on macOS and Linux/WSL2. | [04](issues/04-m1d-live-omp.md) |
| REQ-05 | After M3 setup, reconcile the M2c draft before implementing. Ship `ei_changes`, risk zones, the local audit log and the text-only stage protocol. M6a waits for owner acceptance and the accepted revision on `origin/main`. | [05](issues/05-m2c-changed-code-review.md) |
| REQ-06 | After M2c, reconcile the M6a draft. Lexical `ei_search` must meet the owner's pass criteria on both M3 repositories and preserve the D49 exclusion rules. Search never feeds completeness, reach or verdict. M4a waits for owner acceptance and the accepted revision on `origin/main`. | [06](issues/06-m6a-lexical-search.md) |
| REQ-07 | After M6a, reconcile M4a and decide per detector from dogfood evidence. Build only approved detectors; record an explicit owner skip when none qualify. | [07](issues/07-m4a-route-detection.md) |
| REQ-08 | Record M3 exit at two weeks and at least ten real tasks, with no open wrong `low`. Review the setup limits against real use and record optional gate outcomes; no optional implementation follows automatically. | [08](issues/08-m3-evidence-decisions.md) |
| REQ-09 | After the required milestones and M3 exit decisions, reconcile the V1 close-out draft, audit claims, rehearse install/upgrade, and hand release approval to the owner. | [09](issues/09-v1-closeout.md) |

- Follow existing brief rounds. Reconcile draft briefs against the approved contracts below; Round 0 is reconciliation only. The owner accepts corrections before Round 1. A planning ticket is not permission to start implementation early.
- Run one implementation milestone at a time. M3 continues alongside later milestones after setup. Platform smoke is independent evidence collection, not concurrent implementation.
- Preserve the OMP/CLI/core boundaries, the frozen KSD contract, the pinned TypeScript compiler, and the `node:sqlite` runtime floor in ADR 0005. Do not move modules to match the architecture diagram. Record material documentation drift in the close-out audit.
- Keep evidence and policy separate: `unknown` and stale answers remain explicit; dynamic or search matches do not become compiler-grade edges. One real wrong `low` stops work under Contingency D until fixed with a regression.
- OMP owns permissions and sessions. No changes to protected paths without owner approval; no weakening of the existing goldens or checks.

## Testing Decisions

- Reproduce D59 findings with existing fixture copies and public impact outcomes. Use the CLI as the highest deterministic seam; use actual OMP calls for registration, result text, interaction and platform behavior. Internal graph assertions supplement, not replace, consumer-visible evidence.
- Keep golden/freshness tests, seeded incremental-equals-cold, differential `findReferences`, mutation smoke and `ei doctor --deep --differential 300` as applicable. Audit and route fixtures include negative cases, not just successful wiring.
- Record commit, OS, architecture, Node/Bun and OMP version where applicable, exact commands, results and gaps. Separate historical evidence, mock-only results, current CI, live OMP and dogfood. Track the full-call p50/p95 for clean queries, and phase timings for drift; do not treat the withdrawn M1b build times as gates.
- Reuse the existing fixtures, official brief oracles, snapshots, live smokes and dogfood log. No new test framework or runtime dependency.

## Out of Scope

M4b bridges, M5 watcher/worktree seeding and M6b semantic search implementation; all V2 modules; an MCP or GitLab adapter; npm publishing; new services; new routing or policy behavior. No automatic commit, push, merge, tag, release or production operation.

## Further Notes

- Authority: [DESIGN](../../docs/DESIGN.md) §§6.2, 12–14 and D48–D59; [TOOLS](../../docs/TOOLS.md); [RISK](../../docs/RISK.md); [ADR 0005](../../docs/adr/0005-node-22-5.md); and the [milestone briefs](../../docs/briefs/README.md). These tickets organize existing work; they do not supersede the approved contracts.
- Starting evidence: local `main` at `6be6c2e`; [D59 decisions](../../docs/reviews/2026-11-18-m2b-round-4-decisions.md) explicitly withhold M2b acceptance. [M2b measurements](../../docs/research/m2b-measurements.md) record earlier macOS impact smoke, not final cross-platform or stress-corpus acceptance. The owner has not named the work repository or accepted any new snapshot here.
- First ticket: [01 — M2b Round 6](issues/01-m2b-round-6.md). Start native macOS verification with the [portable runbook](round-6-verification.md). Use the generated offline fixture when the real corpus is unavailable; it does not satisfy R8 or historical corpus parity. Transfer the local tracker outside Git only when switching hosts. Preserve the required WSL evidence.
