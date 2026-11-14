# Gated milestones — M4b bridges, M5 watcher, M6b semantic search (DRAFT)

None of these starts by default (DESIGN D48). Each has a gate that only dogfood evidence can open. If no gate opens, V1 is finished without them and the close-out says so.

Read `docs/briefs/README.md` (common rules).

## Gate check round (agent, read-only)

```text
Read docs/briefs/README.md and docs/briefs/gated-M4b-M5-M6b.md, then do
the gate check. Change nothing. From docs/dogfood-log.md, `ei audit`,
and the measurement files under docs/research/, fill this table with
evidence (log entry dates, counts, timings) or "no evidence":

M4b per bridge (B3 HTTP path -> handler, B4 navigation, B5 event
channels, B6 templated dynamic import):
  - logged tasks where the answer was `unknown` because of exactly this
    gap, and the agent then found the link by hand;
  - whether the link was a literal (bridgeable) or computed (not);
  - whether the whole flow exists in the repository end to end.
  Gate: at least 3 such tasks for the bridge, literal, whole flow.

M5 watcher / worktree seeding:
  - share of calls that paid for an update, and the median wait;
  - probe time at the repository's size;
  - how often a second worktree cold-built an index that already
    existed for the same commit.
  Gate: update waits felt slow in at least 5 logged tasks AND the
  measured wait would be removed by a watcher (the update itself is not
  the cost), or duplicate cold builds cost more than 10 minutes a week.

M6b semantic search:
  - ei_search queries from the audit log that returned nothing useful,
    with what the owner was looking for;
  - whether better lexical handling (synonyms in doc comments, path
    terms) would have found it.
  Gate: at least 10 failed queries that lexical changes cannot fix, AND
  separate owner approval of a local embedding runtime and model
  (size, licence, speed measured first).

End with one line per item: gate met / not met / no data. Stop.
```

The owner records the outcome in the decision log. A gate that is met gets the brief below, starting with Round 0.

---

## M4b — one bridge at a time

Read DESIGN §6.9 in full (the six rules) and TOOLS §4 ("Possible (heuristic)"). Needs M4a. **Branch:** `m4b-<bridge id>`.

Each bridge is its own milestone with the same four rounds:

1. **Fixture flow first.** A fixture copy with the whole flow end to end (for B3: client call → route → handler → what the handler calls). The test for the complete flow is written before the bridge.
2. **The bridge.** Bridged edges have `strength: 'heuristic'`, `synthesizedBy`, `registeredAt`; they are returned only in `bridged`, rendered under `Possible (heuristic)`, never in `byDepth`, never in reach. The gap they relate to stays in `completeness.reasons`, annotated `bridged: n candidates`. Config switch `bridges: { B3: false }`.
3. **Live and measurement** on the repository whose log entries opened the gate: replay those tasks and report whether the answer would now have saved the manual search. Hand-check 20 bridged edges: true link / false link.
4. **Review, then fix** (`README.md`).

Risky cases every bridge must test:
- Literal only: a computed path, a template with a substitution, a constant from another file → no bridged edge, the gap stays.
- Scope: a match is limited to the caller's own app or package unless a literal base URL says otherwise; several matches are all listed as candidates, none preferred.
- Method and path normalisation (trailing slash, case, dynamic segments `/users/123` vs `/users/[id]`, query strings).
- A bridged edge never changes `completeness`, `reach`, `factors` other than adding `route`, or lowers a level: property test over all golden targets with the bridge on and off; every earlier golden case and snapshot is byte-identical with the bridge off, and `byDepth` identical with it on.
- Incremental == cold and doctor cover bridged edges.
- Half a flow (client call with no matching route) produces nothing.

**Review focus:** heuristic edges leaking into reach, `byDepth` or a verdict; a gap removed; guessed non-literal matches; cross-app false matches.

Stop rule: if the hand-check finds more than 1 false link in 20, the bridge does not ship.

---

## M5 — session watcher and worktree seeding

Read DESIGN §6.10. **Branch:** `m5-watcher`.

- **Watcher:** inside the OMP session only (no daemon). A recursive watch on the index scope records changed paths and, after a debounce, starts the update in the engine child so the next query is fresh. It is an optimisation: the stat probe still runs at session start, on watcher overflow or error, and at least every 60 s of activity; `ei_changes` and rebuilds still hash everything. `impact.watch: false` turns it off.
- **Worktree seeding:** a new worktree of a repository that already has an index for the same commit starts from a copy of that index and updates from there.

Risky cases, one test each:
- Correctness identical with the watcher on and off: the randomised incremental == cold test runs in both modes.
- An event storm (branch switch, `npm install`, 10,000 files) → one update, not thousands; overflow falls back to the probe.
- A missed event (simulate) costs time, never correctness: the next probe catches it.
- Platforms that cannot watch reliably (inotify limit reached, a Windows-mounted path under WSL2, a network mount) → the watcher disables itself and `ei_status` says so; queries behave as before.
- No watcher, timer or child survives the session: assert after shutdown.
- A background update never runs while another session holds the lock, and never makes a query answer from a half-written index.
- Memory: a background update on a large repository obeys the same limit and the one-process-per-update rule (D50).
- Seeding: a seeded index equals a cold build after its first update; seeding from an index with a different extractor stamp or config is refused; the seed is copied, never shared.

**Review focus:** any path where the watcher is trusted without the probe; leaked processes or handles; two builders; seeding across mismatched stamps.

Acceptance needs the measured wait removed on the repository that opened the gate, on macOS and on Linux/WSL2.

---

## M6b — semantic search

Read DESIGN §6.11 (semantic tier). **Branch:** `m6b-semantic`. Needs M6a and the owner's separate, explicit approval of one runtime and one model.

- **Round 0 also measures candidates** on the owner's machines: install size, licence, load time, embedding throughput, query time at the repository's size, memory. The owner picks one or stops.
- Embeddings of declaration text from a **local** model; stored locally; brute-force cosine search; incremental by content hash; computed in the background child; never blocks another tool.
- `ei embeddings install | status | remove`: owner-run, the only network action, never triggered by the agent or suggested in tool text. Without a model, search is lexical only and the footer says so.
- Hits labelled `semantic`, ranked after exact and lexical hits of similar score.

Risky cases, one test each:
- With no model installed: byte-identical results to M6a; no install hint in any tool text.
- Offline after install: works; a corrupt or missing model file → lexical only plus a line in `ei_status`.
- A semantic hit never feeds completeness, reach, factors or a verdict.
- Secret and excluded files are never embedded.
- Model or runtime version change invalidates stored vectors.
- Embedding work obeys the memory limit and stops when the session ends.
- The optional dependency is not required to install, build or test the plugin (CI runs without it).

**Review focus:** network use outside `ei embeddings install`; the dependency becoming required; semantic results presented as evidence; text embedded from files that must not be read.

Acceptance: the failed queries that opened the gate now succeed, and the M6a query set does not get worse.
