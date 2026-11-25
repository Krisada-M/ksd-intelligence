# V2d self-review

Five questions per round (lane rules). Evidence: `tests/core/knowledge.test.ts` (Round 1), `tests/core/knowledge-tool.test.ts` (Round 2).

## Round 1 — `src/core/knowledge/`, `ei learning` CLI

1. **Agent-facing text, golden case or snapshot changed?** No. No tool is registered in Round 1. `ei --help` gains one `learning` line. `tests/golden/**`, `tests/snapshots/**`, `src/policy/**` untouched.
2. **Feeds completeness, reach, factors or a verdict?** No. `src/core/knowledge/**` imports only `kernel/config` (type), `kernel/guards` and `node:sqlite` types; it reads the index's `declarations`/`symbols` tables read-only. Nothing in `impact/`, `changes/` or `kernel/verdict.ts` imports it.
3. **Off by default, V1 byte-identical when off?** `knowledge.enabled` stays `false` in `defaultConfig()`; nothing reads it yet (Round 2 gates registration and the `ei_impact` line on it).
4. **Network, exec or repo write outside the V2 rules?** No network, no process. Repository writes: only `approveProposal` and `reviewLearning` in `store.ts`, reached only from the owner CLI (`ei learning approve|review`). Agent proposals: `writeProposal` → `<cache>/learnings-proposed/` (0700/0600). Test "a proposal stays in the cache until the owner approves it" asserts `.ksd` does not exist before approve.
5. **Secret or personal path in the diff?** No.

### Brief risky cases

| Case | Test |
|---|---|
| Anchored body changed → `needs-review`, not a decision | "a changed function body is needs-review and never shown as a decision" |
| Key deleted → `orphaned`, rename suggested not applied | "a deleted key is orphaned; a renamed declaration with the same body is suggested, not applied" |
| Proposal never in `.ksd/` before approve | "a proposal stays in the cache until the owner approves it", "writeProposal never writes inside the repository" |
| Unknown field, missing field, long claim, instruction-like claim | "an unknown field is reported and ignored; a missing field skips the file", "a long or instruction-like claim is shown quoted under a fixed notice, capped at 1,000" |
| Two learnings on one anchor; one superseding | "two learnings on one anchor; only an explicit supersedes retires one" |

Also: without a current index a symbol learning is `needs-review`, never `active` (stale spans could hash the wrong lines).
