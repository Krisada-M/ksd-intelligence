# 08: Turn M3 evidence into owner decisions

**What to build:** Turn real use into a release decision and a measured backlog. Preserve an explicit `no data` result where dogfood did not exercise a capability.

**Blocked by:** 03 — Start M3 dogfood on real repositories.

**Status:** ready-for-agent

**Requirement:** REQ-08 in the [spec](../spec.md).

- [ ] After two weeks and at least ten logged real tasks, with no open wrong `low`, summarize correctness, action changes, useful and noisy `unknown` reasons, latency, missed calls and rework. Separate measurements from owner impressions and do not invent retrospective audit data.
- [ ] Use the [M3 exit table](../../../docs/briefs/M3-dogfood.md#exit) to review the daily-use limits recorded in ticket 03 against dogfood results. Record any owner-approved changes and the decisions on propagation, anonymous members, scoping and detector demand. Keep the dogfood log running through close-out.
- [ ] Report each [optional gate](../../../docs/briefs/gated-M4b-M5-M6b.md#gate-check-round-agent-read-only) as met, not met or no data, with supporting entries or timings. A met gate is not approval to implement; M6b still needs separate owner approval. No optional build is required by this ticket.
