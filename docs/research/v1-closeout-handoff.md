# V1 close-out handoff

**Status: PARTIAL.** Version 1.0.0 candidate committed on `v1-closeout`. Release is not approved. Nothing pushed, merged, tagged, or published.

## Done

- Round 0 reconciled from fetched `origin/main`; no M3b findings file was present in either requested ref.
- Round 1 fixed help on all npm bins, verified kill-switch combinations and CLI/OMP-handler parity, and added ten transcript-based evals.
- Round 2 updated release docs and manifests; protected files and runtime dependencies are unchanged. `npm ci`, typecheck, lint, format, 740/740 tests, committed `check:dist`, tarball, 11/11 mutation smoke, 300-sample differential and schema upgrade passed on Linux WSL2. [Exact evidence](v1-closeout-audit.md).
- Clean isolated HOME: real OMP CLI installed the candidate marketplace plugin. Global npm install from local tarball, setup, init, index and five calls through the real extension loader passed. This was not a model session, macOS smoke or live AGY acceptance.

## Release gate still blocked

`omp -p --model claude-haiku-4-5` exited 1 before tool execution (`No API key found`). The behaviour runner scored no cases. No saved credentials were read or copied. macOS smoke, the interactive KSD status check, live AGY on this candidate, and pushed candidate CI remain **NOT VERIFIED**.

## Next command

Use the owner's already authorized model environment and run `node evals/run.mjs`. Then follow [the owner release checklist](../release-checklist.md) for live marketplace smoke on both OS families, AGY, CI and review. Finish those gates before creating or pushing `v1.0.0`: the tag starts npm publication.
