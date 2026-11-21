# Round 6 verification — macOS and WSL

Run the same Node 24 CLI and TypeScript 5.9.3 checks from a disposable checkout on either host. Only the local corpus path changes. Keep native macOS, Linux/WSL and live OMP results separate. No benchmark or platform gate is waived by this runbook.

## 1. Fixture lane — works offline on either host

- Use the existing fixture-copy tests for D59 red/green, the golden and freshness cases, update soundness, differential coverage and mutation smoke. Run the repository's `npm test`, typecheck, lint, format and dist checks on the candidate. Do not use a synthetic pass to mark a D59 finding fixed: that finding needs its own reproducer.
- If the real corpus is unavailable, run the synthetic end-to-end check from the `ksd-intelligence` root. It needs a current `dist/` and the verified pinned compiler from `ei setup --check`. It creates a disposable Git corpus and HOME, exercises the real CLI and SQLite engine, then removes only its own temp directory. It makes no network calls.

```sh
node dist/adapters/cli/main.js setup --check
node .scratch/ksd-v1-readiness/round-6-fixture.mjs
```

The generated corpus asserts all 320 compiler callers, detection of a new untracked caller, incremental/cold equality and a 300-declaration differential with no misses. It is synthetic correctness evidence, **not** the `oh-my-pi` corpus, R8 latency evidence, a live OMP smoke or Linux verification.

## 2. Reference lane — same real inputs on both hosts

1. Put `oh-my-pi` at commit `04cd1a7549a02d62ad1d24826198d52507595683` in a disposable checkout on the host under test. On Mac, use an existing local checkout or an owner-provided Git bundle. Do not fetch from library or verification code. Use the pinned upstream lockfile with native dependencies installed from approved sources (`bun install --frozen-lockfile --ignore-scripts` is an owner-run setup step, not part of the offline checks). Do not reuse Linux `node_modules` on Mac. Reuse the WSL scope config and verify the same indexed file set before comparing cohorts. The historical census was 10,502 visible / 6,761 indexable files; explain differences, do not trim scope to make the target pass.
2. Bring the ordered 200-target manifest (`before.json.targets.json`), the 20 mixed-size timing target keys, and the historical reference-audit/measurement scripts or their documented method. Keep these inputs beside the local ticket and record their SHA-256 digests. If the historical manifest is unavailable, a fresh seed-1 cohort from the pinned baseline is useful for a new paired run; report historical cohort parity as **NOT VERIFIED**. Do not resample from the candidate index or silently drop missing keys.
3. Use a separate lab HOME with the verified pinned compiler, no global EI config and a fresh cache. Record the engine and corpus SHAs, OS/architecture, Node/TypeScript versions and compiler hash, scope config, and cohort hashes. Export `CORPUS` and `EVIDENCE_DIR` to absolute paths; create the evidence directory outside the corpus before running:

```sh
node dist/adapters/cli/main.js setup --check
node dist/adapters/cli/main.js index --root "$CORPUS" --full --json > "$EVIDENCE_DIR/index.json"
node dist/adapters/cli/main.js status --root "$CORPUS" --json > "$EVIDENCE_DIR/status.json"
node dist/adapters/cli/main.js doctor --root "$CORPUS" --deep --differential 300 --json > "$EVIDENCE_DIR/doctor.json"
```

4. Follow the approved Round 6 checks on that corpus: replay the same 200 targets, audit 20 `low` results against TypeScript `findReferences`, and capture the R8 split (probe, open, load, traverse, render) and whole-call p50/p95 on the same 20 no-drift targets. Compare before/after on the **same host**, using the same engine-call boundary and inputs. Do not use shell process launch or a bare graph-query timer for the gate. Required: p95 **<300 ms**, no wrong `low`, and doctor exits 0 with no graph differences or differential misses. Also record the one-file body-edit wall time and freshness outcome; use a disposable checkout and restore the baseline before clean-query measurements.
5. If corpus, dependencies, scope or cohort cannot be reproduced, keep the corresponding acceptance item **NOT VERIFIED** and use the fixture lane for development. Run the required `Graph.incoming` and ambiguity calls separately through actual OMP on the candidate. A Mac run records macOS results only; preserve the WSL evidence requested by the Round 6 brief and the separate Linux CI/live smoke gates.

## Recorded baseline — macOS arm64

Node 24.22.0, TypeScript 5.9.3. `npm test` reported 567 pass, 0 fail, 0 skipped. `node .scratch/ksd-v1-readiness/round-6-fixture.mjs` reported 320 compiler callers, the new untracked caller indexed, 0 graph differences and 0 misses over 300 sampled declarations (640 references). The pinned real corpus and historical cohort were unavailable locally. R8, WSL and live OMP remain NOT VERIFIED by this run.
