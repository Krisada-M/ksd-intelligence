# M3 exit review (2026-11-23)

Owner directive 2026-11-23: close V1 today. The ≥14-day daily-use window was waived by that
directive (recorded as D63); the task-count gate was met honestly — 10 real tasks in
`docs/dogfood-log.md` (2026-11-22 ×2, 2026-11-23 ×8), zero fabricated entries, and the
2026-11-23 burst is plainly dated in the log.

## 1. Tasks logged, correctness, action changes

- 10 tasks: 2 on 2026-11-22 (`work-sure`, `ksd-intelligence`), 8 on 2026-11-23.
- Correct: 8 `yes`, 2 `partly` (both honest boundaries: `sankey_zoom.mjs`
  `outside-index-scope`; worktree separate cache). **0 wrong answers, 0 wrong `low`.**
- Changed what the agent did: 9 of 10 (`yes`); 1 `no` (type-only rehearsal).

## 2. Wrong or partly wrong answers, by losing layer

- **Wrong `low`: 0.** (Listed first per the stop rule; contingency D never fired.)
- `partly` 1 — scoping layer: `app/javascript/**` has no `jsconfig.json` and Rails
  importmap bare specifiers; `ei_impact` answered `NOT INDEXED` (correct, honest); the
  owner still wanted a web-caller hint. Layer: scoping rules, not the graph.
- `partly` 1 — UX, not correctness: a linked git worktree root with explicit `--root .`
  gets its own empty cache (`degraded`), with no pointer to the main worktree's index.

## 3. Most frequent `unknown` completeness reasons

From `ei_status` on `work-sure` (8,434 scanned · 5 indexable · 15 orphan · 8,414 unindexed):

| Reason | Count | Real gap or noise |
|---|---|---|
| `unresolved-name-match` | 721 | **Noise** on a mostly-Rails repo (lexical scan of non-indexed code files); would drown signal on this repository shape |
| `outside-index-scope` | 6,822 | **Real** — Rails views/JS without a jsconfig; correctly listed, never claimed |
| `other-kind` (non-code) | 1,583 | Real boundary, silent by design |
| `orphan` (no tsconfig) | 15 | Real |
| `unresolved-import` (bare, deps absent) | 4 | Real (`desktop/node_modules` absent) |

## 4. Slow calls vs limits

All calls felt fine; none crossed the withdrawn M1b-era targets. Measured: cold index
`ksd-intelligence` 1.7–4.0 s, `work-sure` cold 1.7 s / drift update 2.3 s; warm
`ei_impact` 175 ms (`work-sure`) to 1.15 s (`ksd-intelligence`, incl. on-demand update);
`ei_changes` 94–160 ms; `ei_search` 90–164 ms; `ei_audit` 72 ms. The only >1 s waits were
first-call index updates, streamed with phase progress.

## 5. Symbols edited without prior `ei_impact`

`ei audit --since 7d` on `work-sure`: `Changed without prior ei_impact: none`.
Every edit task in the log (rename, delete, type-only) called `ei_impact` first. Leading
indicator: 100% for the logged window.

## 6. Grouped "Missing" requests

1. Worktree: share/resume the main worktree's index, or label the state
   `worktree: separate cache` (M5 evidence).
2. `NOT FOUND` on a name that lives in an untracked/orphan file: say so instead of only
   offering closest names.
3. `721` unresolved name matches: per-reason summary or a quiet mode for repos where the
   lexical scan is mostly noise.
4. `ei init --dry-run` `TS configs:` display missed `desktop/tsconfig.json` (2026-11-22).
5. Comment-only file touches still list that file's tests (mild over-listing).

## 7. Optional-milestone gate table

| Gate | Evidence | Verdict |
|---|---|---|
| M4a B1a/B1b/B1c/B2 detectors | No dogfood evidence, no manifest declares `next`/`expo-router`/`hono` | **not met** → owner `SKIP ALL` (D61) |
| M4b B3 (HTTP path → handler) | 0 logged tasks `unknown` because of this gap | **no data** |
| M4b B4 (navigation) | 0 tasks | **no data** |
| M4b B5 (event channels) | 0 tasks | **no data** |
| M4b B6 (templated dynamic import) | 0 tasks | **no data** |
| M5 watcher/worktree seeding | Latency "fine" in 10/10 tasks; one worktree cold start of seconds, not minutes | **not met** (worktree note recorded under Missing) |
| M6b semantic search | 0 failed queries; recall 17/20 and 20/20 top-8, 0 missing on the accepted oracle | **not met** |

## Exit decision table (owner sign-off, D63)

| Decision | Input | Outcome |
|---|---|---|
| Daily-use build/update limits (DESIGN §14) | §4 timings | Adopt observed values as **advisory baselines** (no hard gates): cold ≤ 5 s this repo / ≤ 30 s large repos; drift update ≤ 3 s; warm query p95 ≤ 300 ms (already test-gated for search) |
| Narrow the D50 propagation rule (D51) | signature-edit time | **Keep as is** — signature edits rode along with normal updates; no measured pain |
| Index anonymous object-type members (D51) | "Missing" entries | **Do not index** — no log entry asked for them; keep D51 guidance behavior |
| Scoping rules too broad/narrow | review item 3 | Keep `outside-index-scope` as is (honest); fix the `unresolved-name-match` **noise** presentation in V2 (Missing #3) |
| M4a detectors | routes present | `SKIP ALL` (D61, already recorded) |
| M4b / M5 / M6b start | gate table | **None starts** — no gate met; V1 closes without them |
