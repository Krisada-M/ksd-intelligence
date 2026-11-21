# 04: Close M1d live OMP platform evidence

**What to build:** Let the owner distinguish a green Node CI matrix from a working installed OMP extension and KSD policy on each supported OS family.

**Blocked by:** 02 — Accept M2b on final evidence.

**Status:** ready-for-agent

**Requirement:** REQ-04 in the [spec](../spec.md).

- [ ] Run the applicable [M1d live acceptance checks](../../../docs/briefs/M1d-platform-baseline.md#acceptance) for `ei_workflow` and KSD on macOS and Linux/WSL2 at the accepted candidate or current `main` revision. Keep the manual TUI status checks separate from non-interactive output.
- [ ] Record OS, architecture, checkout revision, Node/Bun/OMP versions, commands and observed tool/policy behavior. Show that policy is injected once and that status/commands work in a real session. Keep engine runtime checks and CI evidence separately identified.
- [ ] Use an isolated OMP home or an owner-run session. Do not modify the owner's real OMP config or plugins. If a host or live check is unavailable, mark that OS NOT VERIFIED and do not claim full support.
