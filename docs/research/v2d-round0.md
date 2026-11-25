# V2d Round 0 — reconcile `docs/briefs/V2d-knowledge.md` with the repository

Branch `v2d-knowledge` from tag `v1.0.0` (`f2b0f5a`). Worktree `../ksd-laneB-v2d` (a second lane-B worktree, so the V2c value check could keep using `../ksd-laneB`'s `dist/`). Owner rule for this lane: mismatches are corrected here and work continues; stop only if one changes V1 behaviour or a safety rule. None does.

## 1. Statements that no longer match

| Brief | Repository | Correction applied |
|---|---|---|
| `V2d-knowledge.md:13` `anchor.contentHash` | `docs/DESIGN.md:451` names `anchor.signatureHash?` | `contentHash` is added (fields may be added, §7); `signatureHash` is not used |
| `V2d-knowledge.md:13` "hash of the anchored declaration's text" | A rename changes the text, so a plain hash cannot find "a renamed declaration with the same body" (`:21`) | `contentHash` = SHA-256 of the declaration's lines with its own simple name replaced by a placeholder. A body edit changes it; a pure rename does not, which is what the orphan suggestion matches on |
| `V2d-knowledge.md:14` states `active · needs-review · orphaned · superseded` | `docs/DESIGN.md:453` `status: 'active' \| 'needs-review' \| 'superseded'`; `:257` "changed or missing anchor → needs-review" | Computed state adds `orphaned`. Status is computed on read, never stored |
| `V2d-knowledge.md:13` minimal YAML subset | No YAML code in `src/` | Subset written here: `key: value` scalars (plain or double-quoted), one nested `anchor:` map, `#` comments. Anything else is a parse error and the file is skipped |
| `V2d-knowledge.md:29` "`ei_impact` and `ei_context` (if V2a merged)" | V2a is lane A, not on this branch | Only `ei_impact` gets the line |
| `V2d-knowledge.md:31` "the owner writes 5 learnings" | Lane-B owner answer | The agent drafts 5 from DESIGN decisions as **proposals** with `source: model-inferred`, labelled "agent-drafted, owner approval pending". `ei learning approve` is never run by the agent |
| `V2d-knowledge.md:16` proposals never in the repository | Proposals are not learnings, so with only proposals the on/off value check would be identical | `ei_learning list` and the `ei_impact` line also count **proposals**, in a separate group labelled "agent-drafted, owner approval pending", always as unconfirmed notes |
| `docs/TOOLS.md:18` rule 8 "All tools register with `approval: 'read'`" | `ei_learning` is `read` (`V2d-knowledge.md:28`); `propose` writes only the private cache, like the audit log | No exception needed |
| `V2d-knowledge.md:28` "Disabled" | `docs/briefs/V2a-context.md:32` lane convention: disabled ⇒ not registered | `ei_learning` registers only when `knowledge.enabled` is true at load; the `ei_impact` line appears only when enabled |

## 2. Data the brief assumes the index holds

- Symbol anchors resolve through the index (`declarations` table: key, file, `start_line`, `end_line`; `src/storage/sqlite.ts:58-73`). Present.
- No declaration-body hash is stored in the index (`sig_hash` is the signature surface only). The content hash is computed from the file text at read time, using the index's span. If the index cannot be made fresh, a symbol learning is `needs-review` (never shown as a decision).

## 3. Golden cases

None concern learnings. With `knowledge.enabled` false (default) or no learnings, every snapshot and golden result must be byte-identical; a test covers it.

## 4. Dogfood log

No entries about re-explained decisions. The value-check learnings are drafted from DESIGN decisions instead (owner answer).

## 5. Round plan

Unchanged: Round 1 store, YAML subset, anchors, CLI; Round 2 tool, `ei_impact` line, value check. Round 3 review is outside this lane.
