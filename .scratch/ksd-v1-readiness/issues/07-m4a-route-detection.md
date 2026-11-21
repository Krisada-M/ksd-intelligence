# 07: Decide and verify evidence-backed route detectors

**What to build:** Show trustworthy route markers in the existing tools for frameworks the owner uses. If no detector has a real workflow behind it, record an explicit skip instead of adding guesses.

**Blocked by:** 06 — Find code with lexical search.

**Status:** ready-for-agent

**Requirement:** REQ-07 in the [spec](../spec.md).

- [ ] Run Round 0 on the [M4a brief](../../../docs/briefs/M4a-routes.md). Cite a dogfood case or `no evidence` per Next.js, Expo Router and Hono detector; reconcile the brief with DESIGN and the currently indexed data. Owner accepts the corrected brief and approves each detector or records a skip before any build round.
- [ ] For approved detectors, demonstrate route facts end to end in the existing impact/review/search/status surfaces per the reconciled brief. A route never removes a gap, lowers a level or adds an edge to compiler-grade reach. Keep manual route globs additive.
- [ ] For approved detectors, show negative fixtures, incremental-equals-cold and doctor coverage, and the hand-checked sample with no false routes and any misses explained. Record live OMP, performance, mutation and platform CI evidence.
- [ ] No bridges. Resolve the ticket with accepted detector evidence or a recorded owner skip; lack of evidence alone does not silently skip M4a.
