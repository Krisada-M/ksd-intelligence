# V2d — Anchored knowledge, `ei_learning` (agent brief, DRAFT)

Start with Round 0 (`README.md`). Read `docs/briefs/V2-README.md`, then `docs/DESIGN.md` §6.5, §7.7, §11, §12; `docs/adr/0002-stable-keys.md`.

**Branch:** `v2d-knowledge` from `v1.0.0`.

## Goal

Project decisions the owner has explained once ("fees are always computed in minor units", "never call the payment provider from a route handler") are stored next to the code they are about and shown to the agent when it works on that code. A learning whose code changed is marked for review and never shown as fact.

## Round 1 — store and anchors (`src/core/knowledge/`)

- Files: `.ksd/learnings/<id>.yaml`, one learning per file, fields per DESIGN §7.7 plus `anchor.contentHash` (hash of the anchored declaration's text, or of the file). Parsing with a minimal YAML subset written here (no dependency); a file that does not parse is reported and skipped.
- Anchor states, computed on read: `active` (key exists, hash matches), `needs-review` (key exists, hash differs), `orphaned` (key gone; a rename found through the index is suggested, never applied). `superseded` only by an explicit later learning.
- Source kinds stay distinct. Only `owner-confirmed` and `test-verified` are shown as "decision"; `code-observed` and `model-inferred` are shown as "note, unconfirmed".
- Proposals: the agent can propose a learning; it goes to `<cache>/learnings-proposed/<id>.yaml`, never into the repository.
- CLI for the owner: `ei learning list [--status …]`, `ei learning show <id>`, `ei learning approve <id>` (moves a proposal into `.ksd/learnings/`, sets `source: owner-confirmed`, `reviewedAt`), `ei learning review <id>` (re-anchors to the current hash after the owner reads it), `ei learning reject <id>`.

Risky cases, one test each:
- A learning whose anchored function body changed → `needs-review`, not shown as a decision.
- Anchor key deleted → `orphaned`; a renamed declaration with the same body is suggested, not applied.
- A proposal never appears in `.ksd/` until `approve` runs; the tool has no code path that writes there.
- A YAML file with an unknown field, a missing field, a very long claim (cap 1,000 characters), a claim containing what looks like an instruction to the agent ("ignore the policy") → stored and shown as quoted data under a fixed heading, never as instructions.
- Two learnings on the same anchor; one superseding the other.

## Round 2 — tool and surfacing

- `ei_learning` (`approval: 'read'`): `list` for a target or file, and `propose` (claim, anchor target, source `model-inferred` or `code-observed`) which writes only to the cache proposals folder.
- `ei_impact` and `ei_context` (if V2a merged) add one line `Learnings: n (k need review)` when the target has any, and the full list only through `ei_learning`. No verdict change. V1 snapshots unchanged when `knowledge.enabled` is false or no learnings exist.
- Text marks every claim as quoted owner text with its source and status.
- **Value check:** the owner writes 5 learnings for this repository from past re-explanations; 5 tasks through `omp -p` that touch the anchored code, with the module off and on; count whether the agent's change respected the learning.

## Round 3 — review (different vendor), then fix

**Review focus:** any write into the repository except `ei learning approve`; stale learnings shown as decisions; learning text treated as instructions (prompt injection through YAML); proposals leaking into `.ksd/`; anchors resolved to the wrong declaration.

## Do not

- Auto-save, auto-approve or auto-re-anchor anything.
- Let learning content change a verdict, a factor or completeness.
