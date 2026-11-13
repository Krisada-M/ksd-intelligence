# M2a.2 measurements

## Result and scope

**PARTIAL.** Linux tests pass (426/426). In the final round (first section below) the surface hash is syntactic and the per-file semantic check is gone; `ei doctor --deep` on oh-my-pi exits 0 with 0 graph and 0 surface-hash differences, and a 300-declaration differential covers 7,640 of 7,640 references. The DESIGN §14 time targets still FAIL and macOS is NOT VERIFIED. Sections after "History" describe earlier builds. These measurements do not accept M2a.2 or authorize M2b.

The corpus is oh-my-pi commit `04cd1a7549a02d62ad1d24826198d52507595683`, with installed dependencies. The base scan found 10,502 visible files, 6,761 indexable files, 21 orphans, 23 packages and 41 tsconfigs. Conflicting compiler options produced five programs. The edit sequence temporarily added one indexable file.

Runtime: Linux WSL2 `6.18.58.1-microsoft-standard-WSL2`, x86_64, AMD Ryzen 7 8700F, 12 available logical CPUs, 15,994 MiB RAM, ext4 temporary checkout. Node `24.21.0`; TypeScript `5.9.3`; OMP `18.20.0`, with embedded Bun `1.4.4`. Standalone Bun `1.4.2` was not the measured Bun runtime.

macOS, other architectures, cross-OS canonical comparison and a new live OMP tool smoke are **NOT VERIFIED**. CLI execution is not live OMP compatibility evidence.

## Final round (2026-11-14): syntactic surface hash, no per-file semantic check

Model: `openai-codex/gpt-6-astra`; effort is not exposed. Not Claude Opus 5.5 `xhigh` as the brief asks. No independent reviewer ran. Everything below was measured on this machine only.

### What the export-surface hash was

Before this round `surfaceOf` (in `resolve.ts`) hashed, per indexed declaration, the signature hash, **checker output**: `typeToString` of the value type, of the declared type and of the base types, run through a canonicalizer (`type-text.ts`) that sorted union and intersection operands; and the module's export map from `getExportsOfModule`. Type strings of inferred types depend on what the checker had already seen, which is why `resolveFile` first called `getSemanticDiagnostics(sf)`. That call was the "semantic check".

### What it is now

`src/core/indexing/surface.ts` computes the hash from syntax alone and calls no checker. Per observable declaration it hashes the text that states the type: the signature (up to the body or initializer) when every type is written, the whole declaration when a type is inferred (no return type, unannotated parameter, unannotated variable, unannotated class member). A declaration is observable when it is exported, or when an observable declaration's text names it (transitive, by identifier). Export statements, ambient modules, and imports an observable inferred type names are hashed whole; JavaScript files are hashed whole; anything unrecognised is hashed whole. Over-reporting costs re-resolution; missing a change is the defect, so every rule rounds up. `type-text.ts` and its test were deleted.

An inferred type can change with no edit to its file (it names something from an imported file). With no builder state in a new process (D47) nothing else would notice, so during an update a file that holds an inferred-type declaration, and that has an edge from such a declaration into a file whose surface changed, counts as changed itself, and its dependents are re-resolved. A test where the change travels `b.ts` → `a.ts` (inferred) → `c.ts`, and fails without this rule; a control file with a written type does not carry the change.

Cost of rounding up: a signature edit on the same oh-my-pi file re-resolves 2,171 files (the earlier checker-based surface: 479). Before the propagation was limited to edges from inferred declarations it re-resolved 4,525.

### Required checks after removing the semantic check

- `npm test`: **426 tests, 23 suites, 426 pass, 0 fail, 0 cancelled, 0 skipped.** This includes the seeded randomised incremental == cold runs (seeds 1 and 2, a tight-memory seed, a new-session-per-step seed; 12 steps each, counters compared strictly), F01–F06 on the fixture, the fixture differential, and the new surface tests (13 unit tests of the hash, 1 chain test).
- `ei doctor --deep --differential 300` on oh-my-pi (final build, exit **0**): update step `cold` (extractor stamp changed, the code had changed); **0 graph differences** (declarations, edges, unresolved, gap sites, name tokens, exports, files, and the per-file surface hash, which is part of the compared `file_index` row); 0 differing use counters. Differential: 300 declarations, **7,640 references, 7,640 covered, 0 misses** (the earlier 2,526 came from a 50-declaration sample; a different declaration count reshuffles the seeded sample, which is why a 50-sample now gives a different total, 633). Skipped by reason: 301 definitions, 849 targets that are not indexed declarations, 777 declaration names of related symbols, 9 uses of the value a shorthand property names, 2 mapped-type keys; 13 references inside JSDoc counted as `docOnly`. Doctor wall 463 s, max RSS 7,811,068 KiB.

### The larger sample found resolver gaps

A 300-declaration differential first returned **12 misses in 7,651 references**. Resolver and oracle changes, each with a test seen failing first:

- Resolver gap (8 misses): a string or numeric literal that names a property was not a use: `Model["input"]` (indexed access type) and quoted or numeric keys of an object literal typed by context (`{ "a": v, 11: v }`). Now uses (ADR 0003 amended).
- Oracle (1 miss class, 3 references): `findReferences` on the property of `{ x }` also lists the uses of the value `x`; those belong to `x`, not the property. The test skips them under their own reason; references to the property itself are still checked.
- Oracle (2 misses): two object literals typed by `Record<1 | 2 | …, V>` each list the other's key; the key has no declaration to be a use of. Skipped only when the contextual property has no declaration. A broader first version of this skip also removed 3,185 correctly covered references; it was narrowed to the declaration-less case and re-run (the 3,185 are checked again).

These two oracle skips narrow what the differential checks; they are listed for review.

### The child exits after a cold build

The engine child sends `retire` with the result of a cold `index`; the host closes its stdin and does not start the next child until the old one has exited. Tests: the child is gone and `lastExit.reason` is `retired` after a cold build; the next request starts a second child from the published index; an update does not retire its child. The test fails when the retire is removed.

One host on oh-my-pi (`host-updates.mjs`, one process per child, 7,997 MiB limit): cold build in the first child, then, in one child started from the published index, a body edit each time:

| Step | Wall (s) | Files resolved | Peak RSS (MiB) | RSS after the reply (MiB) |
| --- | ---: | ---: | ---: | ---: |
| Cold build (child 1, exits after) | 129.4 | 6,761 | 7,007 | child gone |
| **Update 1** (child 2, new from the published index) | 26.3 | 1 | 4,594 | 4,626 |
| **Update 2** (same child, started right after update 1) | 282.5 | 5,121 | 7,524 | 7,512 |
| Idle 240 s | — | — | — | 4,819 |
| Update 3 (same child, after the pause) | 9.1 | 4 | 5,019 | 5,019 |

Update 2 began while the first semantic pass of the child's builder (D43, started after update 1) was still running: an update waits for that pass (`session.drained`) before it starts, so its program phase was 225.2 s, and it re-resolved the builder's conservative first affected set (5,121 files). That path is slower than starting a new process (about 27 s for the same edit) and, at 7,524 MiB, uses nearly all of the 7,997 MiB limit. Update 3, after the pass had finished, is the fast path the builder exists for (9.1 s, 4 files). In an agent session the second update inside a few minutes of the first would exceed the 60 s tool limit; whether to keep the child after an update is an owner decision (see the report).

### Cold build and edits: 3 runs each on oh-my-pi

Each command a new Node process (`/usr/bin/time`), the production engine host, lock and publisher, on one idle machine (no other work during the runs). Median and range of 3.

| Operation | Wall median (s) | Wall range (s) | Max RSS median (MiB) | RSS range (MiB) | Files resolved |
| --- | ---: | ---: | ---: | ---: | --- |
| Cold `index --full` | 138.3 | 138.0–142.3 | 7,072 | 7,061–7,104 | 6,761 |
| Body edit | 27.1 | 26.7–27.4 | 4,596 | 4,591–4,646 | 1 |
| Signature edit | 92.4 | 85.6–92.9 | 6,085 | 5,634–6,175 | 2,171 |
| Add file | 62.3 | 60.6–63.5 | 5,437 | 5,399–5,450 | 1,237 |
| Rename file | 64.2 | 61.1–65.9 | 5,418 | 5,403–5,420 | 1,237 |

Peak RSS over everything: 7,104 MiB in a cold build (the limit is 7,997 MiB). The earlier single cold run took 173.9 s and the earliest 217.5 s; removing the per-file check made the cold build about 20% faster in resolve (155.9 s to 117.8 s in one run each) but not close to the 60 s target. The checker's lazy work did not disappear; it moved into the queries.

### One phase table, reconciled with wall time

The same single runs (run 1), reported by the engine in the index report, in seconds:

| Run | scan | program | extract | resolve | verify | publish | Sum | Process wall | Not in a phase |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Cold | 2.49 | 16.88 | 1.42 | 117.82 | 2.14 | 0.06 | 140.80 | 142.29 | 1.49 |
| Body edit | 2.34 | 19.96 | 0.20 | 0.21 | 1.81 | 0.05 | 24.56 | 27.10 | 2.54 |

The phases are sequential and account for 99% of the cold wall time; the rest is process start, config, the TypeScript runtime check and the status the CLI prints (a probe of 10,502 files takes about 2 to 3 s: the no-drift command took 2.9 s; [INFERENCE] that probe is most of the unaccounted time). The earlier report's "resolve 292 s inside a 174 s build" mixed two runs: 292 s was the inclusive CPU time of `resolveFile` in a separate `--cpu-prof` run (378 s total, inflated by profiling), not the resolve phase of the 174 s build, whose resolve phase was 155.9 s. A single body edit spends 20 s of its 27 s in `program` (creating five TypeScript programs over 6,761 files), not in resolving: the resolve phase for one file is 0.21 s.

### D49 and the request time limit (from the last round), confirmed in

- D49: `scan.ts` excludes `*credentials*` and `secrets/**` only for non-code files and `.env*`, `*.pem`, `*.key` always; test `D49: secret name patterns never exclude code; secret data files stay unread` passes; mutation M01 (drop the code-kind guard) is killed.
- Request limit: every host request has a limit (default 60 s, per-request `timeoutMs`, owner commands 1 h); a hung child is killed and reported `timeout`. The "default limit ignored" mutation now **fails** its test in 5 s: the two hang tests bound the wait themselves (`within(...)`), so a missing limit is a failed assertion and the host is stopped, not a hung run.

### Mutation smoke on the final code

33 one-line mutations of the compiled test tree (earlier ones plus the new surface, propagation, retire and oracle rules): **33 killed**, none survived or hung. A first version of one surface mutation only renamed a tag and survived; it was replaced by one that removes the line and is killed.

### Build used for the timings

The CLI and host timings above were taken before the last edit, which narrowed the mapped-type oracle skip in `differential.ts`. That file is used only by `doctor`; the extractor stamp hashes it, so the final doctor run rebuilt the index cold. The final doctor result above is from the final build. Not measured on the final build: the CLI and host timing tables.

### Not verified

macOS and other architectures; cross-OS canonical comparison; a live OMP tool call for part 2; a Bun cold build to completion; impact-query latency (no query tool yet); the 60 s cold-build and 3 s update targets (FAIL).

## History: earlier rounds (superseded)

The sections below describe earlier builds. Several describe code removed in the final round (the per-file semantic check, canonical type text, the checker-based surface hash); their numbers are kept as a record, not as the present state.

## Production CLI: post-contextual-property fix

Each command used a new Node process and the production engine host, lock and copy-then-rename publisher. The sequence was: cold build, body edit, signature edit, add file, rename file, then doctor. The body edit inserted `void 0` into `buildModel`; the signature edit added an optional number parameter. The added file imported `buildModel` and returned it from an exported function.

| Operation | Index duration (s) | Process wall (s) | Maximum RSS (KiB) | Resolved files |
| --- | ---: | ---: | ---: | ---: |
| Cold `index --full` | 210.05 | 210.39 | 7,283,052 | 6,761 |
| Body edit, new session | 37.57 | 37.89 | 4,705,192 | 1 |
| Signature edit, new session | 70.21 | 70.51 | 5,333,880 | 479 |
| Add file | 107.86 | 108.16 | 5,620,468 | 1,238 |
| Rename file | 105.96 | 106.27 | 5,674,668 | 1,237 |
| Doctor, differential 50 | — | 294.22 | 7,690,660 | 6,762 cold |

Doctor exited **1**, not zero. The shell sequence's final cleanup exited zero; that exit does not indicate doctor success. Sources were restored after this run without another index update, so its retained cache subsequently has source drift.

### Equality failure

Doctor returned 18 canonical difference lines: nine active-only and nine cold-only `file_index` rows. The other canonical tables matched. Surface hashes and use counters remain part of equality; they were not removed to make the check pass.

| File | Difference, active to cold |
| --- | --- |
| `packages/ai/src/judgment/native.ts` | Surface hash differs |
| `packages/catalog/src/compat/axes.ts` | Surface hash differs |
| `packages/tui/test/agents-hub.test.ts` | Surface hash differs |
| `packages/tui/test/model-picker-native.test.ts` | Surface hash differs |
| `packages/agent/test/remote-compaction.test.ts` | Local uses 1,849 to 1,848 |
| `packages/ai/src/providers/transform-messages.ts` | Local uses 947 to 945 |
| `packages/ai/src/stream.ts` | Local uses 1,886 to 1,887 |
| `packages/ai/test/bedrock-haiku-thinking-off.test.ts` | Local uses 12 to 11 |
| `packages/coding-agent/test/advisor/advisor.test.ts` | Indexed uses 9,374 to 9,375 |

A separate checker-history probe reproduced inferred type-content differences in the two TUI test files, not merely union-printing order. It did not reproduce every surface mismatch. The exact cause of the counter mismatches remains unresolved. These differences can affect invalidation and must not be dismissed as harmless formatting.

### Differential references

The sample covered 50 declarations and 2,528 references: 2,526 covered, two misses. Definition sites (50) and declaration names of related symbols (122) were classified separately.

| Miss | Declaration | Cause observed in this run |
| --- | --- | --- |
| `packages/tui/src/key-hint-format.ts:14` | `formatKeyHint` in the same file | Language-service reference is a JSDoc `{@link formatKeyHint}`; no matching recorded use or gap |
| `packages/tui/src/key-hint-format.ts:105` | `formatKeyHint` in the same file | Language-service reference is a JSDoc `{@link formatKeyHint}`; no matching recorded use or gap |

The contextual-property fix reduced the earlier sample's 58 misses to two. This is a sampled result, not whole-repository completeness.

## In-session Node measurements: earlier build

These numbers precede the contextual-property fix. They characterize builder retention and cannot be substituted for final-build timings. The runner retained semantic builders and waited for their initial background pass before editing.

| Operation | Duration (ms) | Builder-affected/resolved files |
| --- | ---: | ---: |
| Cold publication | 135,854 | 6,761 resolved |
| Background builder baseline, separately timed | 124,686 | — |
| Same-session no-drift, stat | 464 | 0 |
| Same-session no-drift, hash | 4,328 | 0 |
| First body update | 145,614 | 5,121 |
| Second body update | 4,778 | 4 |
| Third body update, hash freshness | 8,373 | 4 |
| Signature update | 25,750 | 479 |
| Restore signature | 25,648 | 479 |

The first body update had a much larger affected set; this is observed, not a proven root-cause diagnosis. The affected-set supplement counter was zero in these updates. Sampled peak RSS was 7,768 MiB, with an engine budget of 7,997 MiB. The entire run took 476,305 ms.

Published database size was 148,942,848 bytes after cold build, 157,270,016 bytes after the first body update, and 157,954,048 bytes after the signature update. Cold records included 163,182 declarations including module records, 581,267 edges, 14,116 unresolved records, 21,547 gap sites, 108,531 name tokens, 8,908 external imports and 36,561 exports.

Cold phase times (ms): scan 1,572; program 15,280; extract 1,033; resolve 115,912; verify 1,650; publish 44. Second-body phase times: scan 416; program 1,164; extract 154; resolve 1,026; verify 1,754; publish 20. Publication remains copy-then-rename, not an in-place database update.

## Bun: bounded failed attempts

These runs used the same earlier build as the in-session Node measurements. A standalone supervisor sampled RSS every 250 ms; this is distinct from the production host's one-second watchdog.

| RSS budget (MiB) | Elapsed before kill (ms) | Sampled peak RSS (MiB) | Result |
| --- | ---: | ---: | --- |
| 7,997 | 51,789 | 8,028 | SIGKILL by supervisor |
| 10,500 | 95,224 | 10,563 | SIGKILL by supervisor |

Neither attempt completed the measured sequence. The retained second attempt contains only a staging database and WAL, not a published index. The first attempt's cache was replaced by the second attempt; its publication phase is unknown. No completed Bun cold time, no-drift load or update timings are claimed.

## Target comparison

Targets are from `docs/DESIGN.md` section 14, not revised by this report.

| Target | Evidence | Outcome |
| --- | --- | --- |
| Node cold build below 60 s | Final round, 3 runs: median 138.3 s (138.0–142.3), new process each | FAIL |
| Existing-program body update below 3 s | Child alive, third body edit 9.1 s (4 files); the second took 282.5 s (see final round) | FAIL |
| New-session drift query below 15 s | Final round, body edit: median 27.1 s (26.7–27.4), 1 file | FAIL |
| Clean-probe query p95 below 300 ms | Status reads only: p95 186.98 ms (earlier round). No impact-query latency collected | NOT VERIFIED for queries |
| Bun accepted as slower | Both bounded attempts killed at the RSS watchdog | Completion NOT VERIFIED |

## Correctness and quality evidence

The recorded full run was `npm test > /var/tmp/m2a2/final-tests.log 2>&1`: **405 tests, 21 suites, 405 passed, zero failed, skipped, cancelled or todo**, duration 10,954.451936 ms. It included F01–F05 (also F06), fixture differential coverage and four short randomized runs: seeds 1 and 2, seed 1 with a tight memory budget, and seed 1 with a new session each step. Each used 12 steps. The optional long randomized run was not executed.

Fixture doctor and differential checks passed. The real-repository doctor above did not. Tests also covered inherited tsconfig includes, project references, home-relative status text with absolute details, staging failure recovery, and D49 code-kind exclusions.

Mutation smoke attempted 19 mutations: 17 killed, one survived, and one anchor did not apply. Removing the D49 kind guard was killed (six tests passed, one failed). The survivor removed the duplicate-property-name canonicalization guard; duplicate named properties were not covered by that mutation's two tests. It is not claimed globally equivalent. The external-use counter mutation did not apply and is NOT VERIFIED.

`npm run typecheck`, `npm run lint`, and `npm run format:check` passed in the recorded gate run. Format output: `All matched files use Prettier code style!` The `check:dist` gate passed with built output staged in a temporary Git index, leaving the real index unchanged. Ordinary cleanliness against HEAD is not claimed: Part 2 source and 11 new generated JavaScript files remain uncommitted. No independent reviewer ran; delegate startup failed because no model was configured.

## Commands and retained local evidence

Paths below are local evidence locations, not repository inputs or committed personal paths. Temporary runners were invoked with Bash or Node, not fish syntax.

```sh
npm test > /var/tmp/m2a2/final-tests.log 2>&1
npm run typecheck
npm run lint
npm run format:check
bash /var/tmp/m2a2/doctor-seq.sh "$PWD" 50
```

The doctor sequence invoked:

```sh
node "$REPO/dist/adapters/cli/main.js" index --root "$OMP_SRC" --full
node "$REPO/dist/adapters/cli/main.js" index --root "$OMP_SRC"
node "$REPO/dist/adapters/cli/main.js" doctor --deep --root "$OMP_SRC" --differential 50 --json
```

The middle command ran after each of the four edits. Evidence: `/var/tmp/m2a2/doctor-seq.log`, `doctor.json`, and `doctor.err`. The disposable sequence script restores its checkout; do not use it on an owner's working checkout.

The earlier in-session measurement command was:

```sh
node /var/tmp/m2a2/acceptance-runner.mjs supervise "$PWD/dist" \
  "$HOME/.cache/ksd-intelligence/runtime/typescript-5.9.3/node_modules/typescript/lib/typescript.js" \
  /var/tmp/m2a2/omp-src /var/tmp/m2a2/omp-cache "$(command -v node)" node 7997 \
  > /var/tmp/m2a2/run-node.jsonl 2> /var/tmp/m2a2/run-node.err
```

Bun evidence: `run-bun.jsonl`, `run-bun.err`, `run-bun-10500.jsonl`, and `run-bun-10500.err` in the same evidence directory. The TypeScript builder characterization compared `noCheck` on/off and internal `releaseProgram()` on/off. All three tested combinations retained the same affected-file sequence. `releaseProgram()` is a guarded, non-public TypeScript API, covered against the pinned runtime; upgrading TypeScript requires rechecking it.

## Acceptance disposition

1. Linux suite, including short randomized and fixture differential tests: VERIFIED PASS for the recorded build.
2. F01–F05 index equality: VERIFIED PASS.
3. Fixture differential: VERIFIED PASS; real-corpus misses enumerated above.
4. Fixture doctor: VERIFIED PASS; real-corpus doctor: VERIFIED FAIL.
5. Measurements: recorded here, with failed attempts and unavailable values explicit.
6. macOS/Linux cross-family comparison: NOT VERIFIED; Linux only.
7. Final session report must preserve these failures and must not label M2a.2 accepted.

Continuation model: `openai-codex/gpt-6-astra`; effort setting is not exposed. This differs from the brief's requested Claude Opus 5.5 `xhigh`; that model/effort is not claimed for this continuation.

## Continuation: checker-history investigation

The results above describe the recorded baseline, before the following continuation fixes.

The diagnostic command used the same 19-config program (6,584 root files), four target files and 241 warm-up files:

```sh
EI_DIAGNOSTICS=1 node --max-old-space-size=7997 /var/tmp/m2a2/surface-diag2.mjs \
  "$PWD/dist" \
  "$HOME/.cache/ksd-intelligence/runtime/typescript-5.9.3/node_modules/typescript/lib/typescript.js" \
  /var/tmp/m2a2/omp-src /var/tmp/m2a2/omp-cache/index.sqlite \
  packages/tui/test/agents-hub.test.ts 241
```

Whole-program semantic checking before either query order produced zero differences across 695 type lines. Preparation cost 128,297 ms and 120,092 ms. This was a diagnostic experiment, not the chosen implementation.

Replacing `EI_DIAGNOSTICS=1` with `EI_DIAGNOSTICS=file` checked each target file after the warm-up queries, immediately before reading its surface. This removed the sampled inferred type-content differences. One remaining difference in `axes.ts#isEffortTier` exposed an independent canonicalization bug: the union sorter treated `value is` as part of one union operand, producing invalid predicate text. The fix keeps the predicate prefix outside the sorted type. A regression failed before that fix and passed afterward.

Resolution now asks TypeScript to finish the file's semantic checking before walking its uses. This avoids prematurely caching contextual inference through arbitrary use-query order. This change does not remove surface hashes or counters from doctor equality.

A new-session no-drift measurement on the preceding build returned `unchanged`, zero resolved files, scan 2,844 ms, zero program/extract/resolve/verify/publish time, wall 3.25 s, maximum RSS 225,072 KiB. Twenty status reads over the clean stat probe had p95 199.365 ms, minimum 169.161 ms and maximum 227.010 ms. This measures status, not the future impact tool. It is not a timing for the semantic-checking fix.

Recreating the prior edit state first caused a timestamp-only publish. That exposed another bug: it reset the recorded program count to zero and cleared an outstanding doctor failure without resolving any file. Timestamp-only publication now preserves the graph's program count, build timestamp and failure marker. Its new regression failed with `'0' !== '1'` before the fix. The temporary `STATUS ready` observed before the fix was not evidence that doctor equality recovered.

The focused check after these fixes passed 28 tests in six suites, with no failures:

```sh
node_modules/.bin/tsc -p tests/tsconfig.json
node --test dist-test/tests/core/type-text.test.js \
  dist-test/tests/core/resolve-counts.test.js \
  dist-test/tests/core/indexing.test.js \
  dist-test/tests/core/differential.test.js
```

The real edit-sequence rerun uses `acceptance-cli.mjs`, which restores only its own changed file and two possible test-file names. Unlike the earlier disposable runner, it does not run checkout-wide Git cleanup. Its doctor exit status becomes the runner's exit status.

## Final run (after the continuation fixes)

Gates on the final build: `npm test` **408 tests, 408 pass, 0 fail**; `npm run lint` and `npm run format:check` clean. Real-repo sequence on the same oh-my-pi checkout, each command a new Node process:

| Operation | Wall (s) | Max RSS (KiB) | Resolved files |
| --- | ---: | ---: | ---: |
| Cold `index --full` | 217.5 | 7,985,436 | 6,761 |
| No drift | 3.12 | 209,824 | 0 |
| Body edit | 30.1 | 4,722,268 | 1 |
| Signature edit | 56.9 | 5,465,644 | 479 |
| Add file | 91.9 | 5,993,676 | 1,237 |
| Rename file | 92.6 | 5,959,644 | 1,237 |
| Doctor, differential 50 | 301.1 | 7,784,208 | cold rebuild |

Cold-build RSS is within 12 MiB of the 7,997 MiB engine limit. Twenty clean-probe status reads: p95 187.0 ms (min 156.6, max 224.9). These are status reads, not impact-query latency.

**Doctor still exits 1.** 10 difference lines in 5 files, all in the `file_index` use counters; declarations, edges, unresolved, gap sites, name tokens, exports and every export-surface hash now match:

| File | Counter, active to cold |
| --- | --- |
| `packages/agent/test/remote-compaction.test.ts` | local 1,850 to 1,848 |
| `packages/ai/src/providers/transform-messages.ts` | local 931 to 930 |
| `packages/ai/src/stream.ts` | local 1,886 to 1,887 |
| `packages/ai/test/bedrock-haiku-thinking-off.test.ts` | local 13 to 11 |
| `packages/coding-agent/test/advisor/advisor.test.ts` | indexed 9,374 to 9,375 |

Two earlier count mismatches were real bugs and are fixed with failing-first tests: duplicate union-instantiation targets of one declaration were counted several times, and the type-predicate canonicalization above. What remains was traced with a per-use classification probe on cold versus warmed checkers: for `remote-compaction` a contextually typed property assignment resolves to its own test-file property from cold but to a property in `packages/agent/src/compaction/openai.ts` after warm-up; for `advisor` one use reaches an extra `PropertySignature` in `openai-responses-wire.ts` (14 versus 15 hits). This is TypeScript's lazy, checking-order-dependent inference. Calling `getSemanticDiagnostics` on the file first (now done) is not enough because the inference crosses files; whole-program checking removed the surface differences in the earlier probe but costs 120–128 s per program.

The two differential misses are unchanged: JSDoc `{@link formatKeyHint}` references at `key-hint-format.ts:14` and `:105`. Cause: TypeScript attaches those comments to no node the resolver visits, while `findReferences` scans comment text. Not fixed.

## Review round (owner decisions, M2a part 2)

Model: `openai-codex/gpt-6-astra`; effort is not exposed. Not Claude Opus 5.5 `xhigh` as the brief asks. No independent reviewer ran.

### Changes made

1. **Per-file use counters left the equality check.** `ei doctor --deep` compares the graph tables and every export-surface hash; the use counters are listed as one informational line (`Use counters differ in N files (informational ...)`) and never change the exit status, status, verdict or any query. A test corrupts every counter and asserts no graph, status or doctor result changes; strict comparison remains in the fixture helper (`canonicalLines(db, { counters: true })`).
2. **JSDoc references are documentation, not dependencies (ADR 0003).** The differential test filters references that sit inside a JSDoc comment and reports them as `docOnly`. A test proves a JSDoc `{@link}` to an indexed declaration is counted as `docOnly`, not a miss.
3. **Per-request time limit in the engine host (D35).** Every request has a limit (default 60 s, `timeoutMs` per request; owner commands 1 h). A child that does not answer is killed and the request fails with `reason: 'timeout'`, naming the operation and the limit. Tests: a hung child is killed at the limit and reported; a request with no limit still gets the default.
4. **D49 rule in `scan.ts` confirmed.** Name patterns (`*credentials*`, `secrets/**`) exclude only non-code files; `.env*`, `*.pem`, `*.key` always. Test `D49: secret name patterns never exclude code; secret data files stay unread` passes; mutation M01 (drop the code-kind guard) is killed.

### Real-repository result after these changes

Same oh-my-pi checkout, each command a new Node process (`/usr/bin/time`), production engine host and publisher. Exit status of every command was 0.

| Operation | Wall (s) | Max RSS (KiB) | Resolved files |
| --- | ---: | ---: | ---: |
| Cold `index --full` | 173.86 | 7,975,760 | 6,761 |
| No drift | 2.93 | 226,708 | 0 |
| Body edit | 26.47 | 4,717,372 | 1 |
| Signature edit | 51.63 | 5,485,664 | 479 |
| Add file | 80.40 | 5,969,336 | 1,237 |
| Rename file | 80.35 | 5,784,368 | 1,237 |
| `doctor --deep --differential 50` | 230.94 | 7,796,416 | 6,762 (cold rebuild) |

**`ei doctor --deep` exits 0.** Canonical graph differences: **0** (declarations, edges, unresolved, gap sites, name tokens, exports, files, every export-surface hash). Counter differences (informational, not equality): 5 files: `packages/agent/test/remote-compaction.test.ts`, `packages/ai/src/providers/transform-messages.ts`, `packages/ai/src/stream.ts`, `packages/ai/test/bedrock-haiku-thinking-off.test.ts`, `packages/coding-agent/test/advisor/advisor.test.ts`.

Differential (D36): 50 sampled declarations, 2,526 references, **2,526 covered, 0 misses**; skipped: 50 definitions, 122 declaration names of related symbols; 2 references inside JSDoc counted as `docOnly`. The earlier two misses (`key-hint-format.ts:14` and `:105`) were exactly these.

Run-to-run variation on one machine is large (cold 173.9 s here, 217.5 s earlier, 210.4 s before that); no single timing is a stable figure.

### Where cold-build time goes

Three instrumented cold builds on the same checkout, Node 24.21, heap flag 7,997 MiB.

| Run | Total (s) | Scan | Program | Extract | Resolve | Verify | Publish |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| CLI, new process (review run) | 173.6 | 2.1 | 14.9 | 1.1 | 155.9 | 1.7 | 0.03 |
| Engine host, child, 1 s RSS sampler | 312.2 | 3.7 | 32.2 | 1.8 | 271.2 | 2.2 | 0.04 |
| In-process with `--cpu-prof` (inflated by profiling) | 378.1 | 3.8 | 30.2 | 2.9 | 334.7 | 3.1 | 0.05 |

Per-phase peak RSS in the host run (MiB): scan 214, program 3,551, extract 3,680, resolve 7,678, verify 4,988, publish 5,002. Peak 7,678 MiB; the limit is 7,997.

Inclusive CPU time from the `.cpuprofile` of the third run (378.1 s total):

| Function | Inclusive (s) |
| --- | ---: |
| `Resolver.resolveFile` (whole resolve phase) | 292.6 |
| `getSemanticDiagnostics` (our per-file call, before walking uses) | 208.0 |
| `surfaceOf` (export-surface text via `typeToString`) | 37.2 |
| `createProgram` (parse 20.5, bind 10.2) | 25.9 |
| `typeToString` | 17.1 |
| `getSymbolAtLocation` | 12.7 |
| `getPropertyOfType` | 10.2 |

Self time: garbage collection 34.5 s; `records.write` 8.8 s; `splitTop` in type-text 6.9 s.

**Dominant cause of the gap to the M1b figure (28.5 s Node, one program).** About 71% of resolve is TypeScript's semantic check of every file (`getSemanticDiagnostics`, 208 s of 292 s) that `resolveFile` runs first to make use classification and surface hashes independent of query order (see the continuation section). M1b's resolve (21.7 s) ran no whole-file check and one program; this build has five programs, canonical surface text, and the check. The check is not a small fix to remove: without it four sampled surface hashes differed between an update and a cold build. It was not changed. [INFERENCE] Removing it would not leave 378 − 208 s: the checker's lazy work would move into the later queries; no such run was made.

### Live set and what holds the peak

Cold build in process with `--expose-gc`, forced collection at each phase boundary (MiB):

| Point | Heap used | RSS |
| --- | ---: | ---: |
| start of extract (five programs built) | 3,236 | 3,528 |
| start of resolve | 3,329 | 3,644 |
| start of verify | 4,181 | 7,430 |
| after publish (builders alive) | 4,102 | 7,424 |
| after builders drained | 4,105 | 5,277 |
| after release | 113 | 5,175 |

The programs (about 3.2 GB of live heap) are built before extract. Resolve adds about 0.9 GB of live checker state, and the V8 heap grows to 6.1 GB total with garbage and free space; RSS reaches 7.4 GB. After release the heap is 113 MB but RSS stays at 5.2 GB: freed memory is not returned to the OS in the measured process. The extract records are written in batches and are not what holds the peak. Cold-build RSS 7,676 to 7,985 MiB means the build fits the 7,997 MiB limit with about 12 to 320 MiB of margin; a larger repository fails with `memory-limit` guidance, not a crash.

### In-session timings (engine child kept alive) versus a new process

| Step | Child alive | New process (review run) |
| --- | ---: | ---: |
| Cold | 312.2 s | 173.9 s |
| No drift | 33.3 s (RSS 5,622 MiB) | 2.9 s |
| First body edit after the cold build | 480.2 s, 5,121 files, peak 7,675 MiB | 26.5 s, 1 file |
| Second body edit | 14.8 s, 4 files | n/a (each step is a new process) |
| Third body edit | 16.2 s, 4 files | n/a |
| Signature edit | 66.8 s, 479 files | 51.6 s, 479 files |
| Add file | 124.5 s, 1,237 files | 80.4 s |
| Rename file | 118.9 s, 1,237 files | 80.4 s |

The child-alive build holds TypeScript's builder (D47) and about 5 to 7.7 GB resident; its first update after a cold build re-resolved 5,121 files (every file the builder treats as affected) and took 480 s, while a new session resolved one. Second and third body edits resolved four files in about 15 s each. In a retained session the no-drift scan phase took 33 s against 2.9 s in a new process; the cause is not isolated (the child sits at 5.6 GB against a 7,997 MiB heap limit; GC pressure is a hypothesis, not measured). These in-session numbers argue for the new-session path as the faster one on this repository, until the builder cost is reduced.

### Mutation smoke (rerun on the final code)

26 one-line mutations of the compiled test tree, each followed by the tests that should catch it:

- Killed: **26 of 26**. The earlier survivor (duplicate property names sorted) is killed by a new test (`{ a: B; a: A; }` versus `{ a: A; a: B; }` are different). The earlier non-applying external-use counter mutation is replaced by a use-count mutation (`counts.external++` removed) that is killed.
- Added in this round: JSDoc references not filtered, doctor comparing counters strictly, hung child reported as `stopped` instead of `timeout`, timeout message lost, timestamp-only publish resetting the build time, and clearing the failure marker.
- One mutation (default limit ignored, 1 h instead of the request limit) hangs the test: the test runner marks the test `cancelled` at its own timeout (`fail 0, cancelled 2`), and the engine child stays alive until the process is killed. The mutation is detected, but the harness reports `fail 0`. A test whose child outlives a failed assertion leaves a process behind; it ends when the test runner is killed. Not changed.

### Not verified

- macOS and other architectures. Cross-OS canonical comparison.
- A live OMP tool call for part 2 (`ei_status`, `omp -p`). Part 1's live check is separate.
- Bun cold build to completion (killed at the RSS watchdog at 8,028 and 10,563 MiB).
- Impact-query latency (no query tool yet).
- The 60 s cold-build and 3 s body-update targets: both FAIL on this repository.

