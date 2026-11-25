# V1 close-out audit

Model: `openai-codex/gpt-6.2-sol`. Round 0 baseline: fetched `origin/main` at `70c1bca`; existing `v1-closeout` was an ancestor with no unique commits and was fast-forwarded before work. No change to code, brief or golden inputs in Round 0.

## Round 0 — reconcile

| Brief assumption | Baseline evidence | Close-out decision |
|---|---|---|
| V1 close-out:3 requires M4a acceptance or a skip and M3 sign-off | DESIGN:770–772 (D61–D63); `m3-exit-review.md` §§7–8 | D61 skipped all framework detectors; D63 waived the 14-day window and retained manual route globs. No optional V1 implementation. |
| V1 close-out:9–11 and :38 describe one OMP install | DESIGN:774 (D65); `package.json` `files`, `bin`; `scripts/mcp/tools.mjs` | Two installs: OMP marketplace and npm CLI/AGY stdio. Do not equate MCP protocol tests with live AGY. |
| V1 close-out:16–21 groups `ei doctor` and `ei cache clear` with open items | CLI `run()` dispatches both; `audit.test.ts` covers cache clear and `differential.test.ts` covers the oracle | Doctor exists and requires `--deep`; cache clear exists. Leave the canary, `engine-self-check-failed`, OMP-version warning, effective per-capability switches, `ei symbol` and a 5 s query budget planned. The parser accepting a flag does not mean the flag works. |
| V1 close-out:15, :25 use docs as shipped inventory | README:3, :75, :93, :154 conflict with OMP extension registrations and MAGY1 tool listings; DESIGN:140, :188, :323, :533–541; RISK:174 | Fix stale claims: five OMP tools, lexical search, child-per-update, npm setup, AGY transport, and planned capabilities. Preserve D50 and D62. |
| V1 close-out:26 implies bin help only needs a packaging check | CLI `parseArgs` has no `help`; both `src/policy/` CLI parsers reject extra or invalid args | Add CLI help and npm entrypoint help, without editing frozen policy source or changing delegation for existing invocations. |
| V1 close-out:27–28 assume existing live behaviour fixtures and a repeatable mutation entrypoint | D58 records evals as a gate; dogfood log includes rehearsals but no eval runner. M2a/M2b/M2c/M6a measurement reports reference earlier temporary mutation scripts. | Use disposable local evaluations based on the dogfood cases. Exercise existing tests against targeted mutants; do not change owner fixtures. |
| V1 close-out:39, :45–51 assume release and V2 gating are still unchanged | DESIGN:768–775 (D58 and D60–D66); V2-README; `.github/workflows/publish.yml` | Only prepare the candidate; tagging triggers OIDC npm publication. D64 waived the five V2 module entry gates, but their value checks and compression hook prerequisite stand. |
| V1 close-out:62–67 requires reference/host evidence beyond local checks | Current directive requests differential on this repository; local host is Linux WSL2 x64; no pushed candidate | Do not claim reference-repo, macOS, CI, real AGY, or owner acceptance from a local run. |

- `docs/research/m3b-findings.md` is absent from both fetched locations: `origin/main` and `origin/research/m3b-compare` (the latter ref is absent). No severity-1 findings to apply from that source.
- No extra index data required for close-out. Existing schema 5 holds FTS5 lexical data and previous-schema handling; there is no automatic route or heuristic evidence, runtime value-flow graph, or semantic vectors.
- Applicable immutable oracles: `tests/golden/M2-impact-cases.md` (engine, freshness, zones and changed-code cases) and `tests/golden/search-queries.md` (lexical queries). Prior evidence: M2b #32 and M2c/M6a #34, not a new run. Current gate results belong to the release verification.
- Dogfood findings retained: separate worktree caches, orphan/name guidance, lexical noise in mostly non-TS repos, `init --dry-run` config display, and extra comment-only test suggestions. D63 keeps scope and propagation unchanged. Earlier wrong `low` on `Graph.incoming` was fixed under D57, not counted as a clean historical run.
- Round order: report-only Round 0, Round 1 audit/help/evals, Round 2 documentation/version/gates. Do not enable or implement V2 features.
