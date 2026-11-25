# Lane B handoff

Lane B builds V2c (`v2c-verify`) and V2d (`v2d-knowledge`), each from tag `v1.0.0` (`f2b0f5a`), each rebased onto `origin/main` before it is finished. Worktrees: `../ksd-laneB` (V2c) and `../ksd-laneB-v2d` (V2d). Nothing pushed, tagged or merged.

## Done

- V2c Rounds 0–2 on `v2c-verify` (see that branch's `docs/research/v2c-*.md`). Gates green; evals 10/10 (`openai-codex/gpt-6.2-sol`).
- V2d Rounds 0–2 on this branch: `docs/research/v2d-round0.md`, `v2d-selfreview.md`, `v2d-value-check.md`. Gates green; evals 10/10 (`openai-codex/gpt-6.2-sol`).

## Next command

```sh
git log --oneline origin/main..v2c-verify; git log --oneline origin/main..v2d-knowledge
```

## Open questions for the owner

- The five value-check learnings are proposals (`model-inferred`, agent-drafted, owner approval pending) in the throwaway clones only; none was approved. Approve real ones with `ei learning approve <id>` if you want them in `.ksd/learnings/`.
- Both branches add `readProjectConfigSync` to `src/core/engine/workspace.ts` and a `cwd` field to `ExtensionDeps` with identical text; merging the second branch may need a trivial conflict resolution in `extension.ts`.
- Round 3 (different-vendor review) for both modules is outside this lane.
