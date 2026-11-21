# 02: Accept M2b on final evidence

**What to build:** Give the owner one acceptance record for the final `ei_impact` candidate. Landing code is not acceptance.

**Blocked by:** 01 — Close M2b Round 6 findings.

**Status:** ready-for-agent

**Requirement:** REQ-02 in the [spec](../spec.md).

- [ ] Trace all [M2b acceptance criteria](../../../docs/briefs/M2b-impact.md#acceptance) to the candidate revision: local checks, C01–C26, freshness F01–F06, unknown-verdict invariant, differential doctor, mutation results, live OMP and latency. Attach exact commands and observed results.
- [ ] Record CI evidence for macOS and Linux at the candidate revision, separately from real OMP `ei_impact` output for `Graph.incoming` and an ambiguous name. Confirm that `Graph.incoming` includes its test callers and that ambiguity returns candidates instead of an answer.
- [ ] Record the independent cross-vendor review and resolution of outstanding findings; Round 4 on its own did not satisfy the cross-vendor rule. Present the proposed snapshots, including changed ones, for owner disposition.
- [ ] Owner records accepted or blocked. An unresolved wrong `low`, missed performance gate, or missing required evidence keeps M3 blocked. Any release-branch or marketplace action stays owner-controlled.
