# V1 close-out (agent brief, DRAFT)

Start with Round 0 (`README.md`). Runs after M2b, M2c, M6a and M4a (or the owner's decision to skip a milestone) are accepted and M3's exit decisions are recorded.

Read `docs/briefs/README.md` (common rules). Then `AGENTS.md`, `docs/DESIGN.md` §8, §13–§16, `docs/TOOLS.md`, `docs/RISK.md`, `README.md`, `PROVENANCE.md`.

**Branch:** `v1-closeout` from `origin/main`.

## Goal

One plugin, installed once from the marketplace, that the owner trusts for daily use on macOS and Linux; documents that say what exists and nothing more; a tagged release.

## Round 1 — audit and tidy (no behaviour change)

1. **Claims against code.** For every tool, CLI command, config key, completeness reason, factor, guidance and failure code in DESIGN, TOOLS, RISK and README: does it exist, is it tested, is it registered? Produce a table. Anything documented but not built is either marked `PLANNED (V2)` in the document or reported as a gap; nothing is silently deleted.
2. **Leftovers from RISK §3.3 and §4 to settle with the owner** (list each as built / not built, do not build them in this round):
   - the `ei doctor` canary and `engine-self-check-failed`;
   - `ei_status` warning when the running OMP version differs from the last smoke-verified one;
   - per-capability `enabled` flags in config;
   - `ei cache clear`, `ei symbol`;
   - the 5 s per-query budget.
3. **CLI and tools agree:** for each tool, the CLI prints the same text for the same input (one test per tool).
4. **Dead code and stale text:** unused exports, removed features still described (builder chaining, `releaseProgram`, the supplemented counter, withdrawn targets), TODO and "shortcut" comments; list them, remove only what is provably unused.
5. **Tool discovery text** (TOOLS §9): the short section the owner pastes into project instructions matches the registered descriptions.
6. **Packaging:** `.omp-plugin/marketplace.json` `source` starts with `./`; `package.json#omp.extensions` points at a built file that exists; `dist/` is complete and committed; no file in the package refers to a path outside it; `engines` is right; `bin` entries run with `--help`.
7. **Safety sweep:** no network call outside `ei setup` (and `ei embeddings install` if M6b exists) — grep for `fetch`, `http`, `https`, `net`, `dns`, `child_process` uses and justify each; no secret, token or personal path in the repository or in any snapshot; cache and audit modes `0700`/`0600`; `EI_DISABLED=1` and `ENGINEERING_PROXY_DISABLED=1` each tested alone and together.
8. Full gates: tests, typecheck, lint, format, `check:dist`, mutation smoke for every engine area, `ei doctor --deep --differential 300` on the reference repositories.

Report the table and the list of owner decisions. Stop.

## Round 2 — release candidate

After the owner answers Round 1:

1. Apply the decisions (build the small leftovers the owner wants, mark the rest `PLANNED (V2)`).
2. Version `1.0.0` in `package.json` and `marketplace.json`; `CHANGELOG.md` from the decision log and merged pull requests, by milestone.
3. README for a reader who has never seen the project: what it does, install, `ei setup`, `ei init`, the five tools with one real output each, config, kill switches, limits stated plainly (what `unknown` means, what is never analysed, memory and time on large repositories, Node ≥ 22.5), troubleshooting from the dogfood log, uninstall and rollback.
4. DESIGN status labels, roadmap table and `AGENTS.md` milestone table updated; open questions closed or moved to V2; each V2 module listed with its entry gate.
5. **Fresh-install rehearsal in an isolated home** (temp `HOME`, no existing cache): marketplace install from the branch as the docs say OMP resolves it, `ei setup`, `ei init`, `ei index` on this repository, one call of every tool through `omp -p`. Paste the transcript. Label the OS. Do not touch the owner's real `~/.omp`.
6. Upgrade rehearsal: an index written by the previous schema version is migrated or rebuilt cleanly, never read as if current.
7. `docs/release-checklist.md` for the owner: the manual steps below, with the exact commands for both machines.

Stop. Do not tag, push or publish.

## Owner steps (not for the agent)

1. Push, CI green on macOS and Linux, review, merge.
2. On macOS and on Linux/WSL2: install from the marketplace, restart OMP, run the M1 scenarios S1–S8, confirm the KSD status and `/engineering-proxy status`, call each `ei_*` tool once in a real session.
3. Tag `v1.0.0`.
4. Archive `Krisada-M/ksd-engineering` with a pointer to this repository.
5. Keep `docs/dogfood-log.md` going; a wrong `low` still stops everything (contingency D).

## Review focus (review round, different vendor)

1. A documented capability that does not exist, or an existing one that is undocumented.
2. Any network path, any write outside the cache and the repository's own `ei.config.json` (which the library never rewrites), any read of secret files.
3. Install from a clean home actually works with only what the package contains.
4. Text an agent sees (tool descriptions, results, workflow header) that overstates certainty.
5. Limits and failure modes missing from the README.

## Acceptance

1. Every documented claim is built and tested, or marked planned.
2. Fresh-install and upgrade rehearsals pasted.
3. All gates green; CI green on both OS families.
4. The owner has run the manual steps on both machines.

## Do not

- Add features beyond the owner's Round 1 decisions.
- Start any V2 module.
- Tag, publish to npm, or change the marketplace entry of the old plugin.
