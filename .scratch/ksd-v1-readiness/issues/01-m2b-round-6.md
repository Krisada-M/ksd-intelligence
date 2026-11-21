# 01: Close M2b Round 6 findings

**What to build:** Make `ei_impact` safe to bring to acceptance: address the D59 findings without hiding gaps or changing the golden oracle, and measure the complete clean-query path on `oh-my-pi`.

**Blocked by:** No predecessor ticket. Confirm the base before implementation. Native fixture verification does not need a WSL handoff.

**Status:** blocked on acceptance evidence

**Requirement:** REQ-01 in the [spec](../spec.md).

- [x] Verify the owner-confirmed Round 6 base `6be6c2e77b5e5d4ae79e3e487b40e8fcd54cb6dc` on the execution host and use `m2b-final` based on it. The historical Round 6 prompt names `origin/m2b-impact`; that ref lacks the D58 workflows and D59 decisions now on `origin/main`. This changes the base only, not the Round 6 checks. Import relevant W2 measurement evidence only if absent from the confirmed base.
- [x] Use the [portable verification runbook](../round-6-verification.md) on macOS or WSL. If the pinned real corpus is unavailable, run the generated fixture locally and mark reference-corpus checks NOT VERIFIED. If switching hosts, the owner copies `.scratch/ksd-v1-readiness/` outside Git with the base SHA and cohort artifacts. Return the tested candidate SHA, OS and evidence paths under `## Comments` in this ticket. Do not include private source or secrets.
- [ ] Use the approved [Round 6 procedure](../../../docs/briefs/M2b-prompts.md#round-6--final-fix-round-after-the-independent-review) and [D59 decisions](../../../docs/reviews/2026-11-18-m2b-round-4-decisions.md), including both small items. Start with findings F1–F7 and record failing fixture-copy output before each fix that reproduces. Where a finding does not reproduce, leave it unchanged and show the evidence.
- [ ] Pass the unaffected golden, incremental-equals-cold, update-soundness and fixture differential checks and the mutation smoke required by Round 6. Re-propose changed snapshots with reasons. Do not edit the oracle to fit the implementation.
- [ ] On the pinned `oh-my-pi` corpus, rerun the same 200 targets, report verdict and reason counts, hand-check 20 `low` results against `findReferences`, and run `ei doctor --deep --differential 300`. Any wrong `low` blocks. Run these checks natively on Mac when the same inputs are available and keep the WSL result required by the brief separately identified.
- [ ] Record the R8 before/after phase split and whole-call p50/p95 for 20 clean targets on the same host and corpus. If p95 is not below 300 ms, stop and report; do not loosen the freshness or completeness contract. Synthetic results, missing inputs or a Mac-only run do not pass the WSL evidence gate.

## Comments

- 2026-11-21: The owner confirmed `6be6c2e77b5e5d4ae79e3e487b40e8fcd54cb6dc` as the Round 6 base. `git fetch --quiet origin` exited 0, and `origin/main` resolved to that SHA. The local `m2b-final` and `integration/ksd-v1` branches were created from it.
- W2 evidence is not recorded as verified in the base, and no local or remote-tracking `m2b-impact-w2` branch was found. WSL/reference-corpus evidence remains NOT VERIFIED.
- Local candidate `c8809aa3aea7b7d2f099d73dd355e6adc0f37d11` on `m2b-final`, macOS arm64 / Node `v24.22.0` / TypeScript `5.9.3`: `npm test` reported 597 passed, 0 failed. Typecheck, lint, format, post-commit `check:dist`, setup and the worktree-local synthetic fixture passed. See [checks](../evidence/01/checks.md) and [findings](../evidence/01/findings.md).
- NOT VERIFIED: original full mutation campaign, pinned 200-target replay and 20 `low` audits, real-corpus differential, WSL, R8 phase split and individual whole-call p95. The [synthetic R8 profile](../evidence/01/r8-split.md) is not a substitute. F1/F2/F4/F7 red results were reproduced retrospectively and do not prove test-first ordering.
- No merge or push. Integration branch remains at the confirmed base. Ticket 02 remains blocked by this ticket.
