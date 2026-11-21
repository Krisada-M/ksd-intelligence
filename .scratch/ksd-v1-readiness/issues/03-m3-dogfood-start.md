# 03: Start M3 dogfood on real repositories

**What to build:** Start owner-led use with a repeatable baseline. Record whether `ei_impact` helps on real tasks, not just on a fixture.

**Blocked by:** 02 — Accept M2b on final evidence.

**Status:** ready-for-agent

**Requirement:** REQ-03 in the [spec](../spec.md).

- [ ] Reconcile the repository list in the [M3 brief](../../../docs/briefs/M3-dogfood.md#repositories) with [DESIGN §13](../../../docs/DESIGN.md#13-roadmap-and-gates): `oh-my-pi` plus one real GitLab project. The owner names and approves the read-only work clone. Use `ksd-intelligence` for supplemental smoke, not as a substitute. Do not copy work-repository source or secrets into evidence.
- [ ] Run `ei setup --check` and `ei init --dry-run`; obtain owner approval for scope before writing config. Record index counts, gap/orphan counts, runtime, cold/warm/drift timings and peak RSS. Record seeded verdict distribution, sampled `low` checks and `ei doctor --deep --differential 300` per the approved setup round.
- [ ] After setup, the owner sets daily-use limits for cold build, body-edit update and signature-edit update on the work repository. Record the approved limits in [DESIGN §14](../../../docs/DESIGN.md#14-quality-and-testing) before resolving this ticket. Use Contingency E if a measurement misses a limit.
- [ ] Start the dogfood log with the first real task and the start date. Record correctness, action change, latency, verdict and missing evidence; report measured operator friction, not just tool success.
- [ ] Apply Contingency D immediately if an incorrect `low` is found. M2c can enter Round 0 after setup, limits and the dogfood start are recorded; it does not wait for M3 exit.
