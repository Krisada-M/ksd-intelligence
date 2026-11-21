# 05: Review the actual change with M2c

**What to build:** Let an agent review the real diff through `ei_changes`, see risk zones and changes outside the plan, and inspect local tool-use evidence without exposing source or sensitive input.

**Blocked by:** 03 — Start M3 dogfood on real repositories.

**Status:** ready-for-agent

**Requirement:** REQ-05 in the [spec](../spec.md).

- [ ] Run Round 0 on the [M2c brief](../../../docs/briefs/M2c-changes.md). Report conflicts and missing inputs against current contracts, code and dogfood. Stop before Round 1 until the owner accepts the corrected brief.
- [ ] Demonstrate that full-hash review accounts for every changed path, including untracked, removed and unindexed changes. Risk zones never lower a verdict. Stale or incomplete data cannot be presented as complete; `Not in plan` is advisory and does not filter out changes.
- [ ] Verify the private, failure-isolated audit behavior and the text-only stage protocol without coupling workflow routing to the engine or changing KSD precedence. Confirm tests cover redaction, failures, rotation and concurrency per the approved brief.
- [ ] Pass the accepted P/X cases and prior C/F cases unchanged. Record CLI/live OMP outputs, measurements, mutation results and platform CI; submit changed snapshots for owner review.
- [ ] Resolve only after owner acceptance and after the accepted milestone is on `origin/main`. Record the owner decision and the resulting `origin/main` commit SHA for ticket 06. Only the owner pushes or merges.
