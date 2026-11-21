# 09: Close V1 with install and upgrade evidence

**What to build:** Give the owner a release candidate whose advertised capabilities, supported platforms and limitations match what was exercised.

**Blocked by:** 04 — Close M1d live OMP platform evidence; 07 — Decide and verify evidence-backed route detectors; 08 — Turn M3 evidence into owner decisions.

**Status:** ready-for-agent

**Requirement:** REQ-09 in the [spec](../spec.md).

- [ ] Run Round 0 on the [V1 close-out brief](../../../docs/briefs/V1-closeout.md). Record required milestone acceptance or explicit owner skips and M3 exit decisions. Wait for corrected-brief approval before Round 1.
- [ ] Audit claims against shipped contracts, tests, CLI/OMP parity and packaging. Show safety and kill-switch evidence. Record material architecture-document drift without restructuring code solely to match a planned tree. Mark unsupported claims as planned or gaps, not shipped.
- [ ] Record the approved close-out suite, agent-behavior evals, CI on both OS families, and isolated fresh-install and previous-schema upgrade rehearsals. A stale index must not be treated as current. Record known limits and supply exact owner checklist commands.
- [ ] Verify the owner has completed the required live release checks on both machines before calling V1 accepted. Release, merge, tag and publication remain owner-only. No V2 work starts here.
