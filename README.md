# ksd-intelligence

Personal, local-first Engineering Intelligence Library for Oh My Pi (OMP). The implemented foundation includes the skill router (`M0`), OMP adapter (`M1`), workspace initialization and the merged KSD policy module. The TypeScript code index (`M2a`) is built and queried through the CLI and `ei_status`; the impact tools (`ei_impact`, `M2b`) are **not yet implemented**. A macOS/Linux CI baseline (`M1d`) runs every test. Current scope and gates: `AGENTS.md`, `docs/DESIGN.md`, `docs/briefs/M1d-platform-baseline.md` and `docs/reviews/2026-11-12-practical-roadmap.md`. The library reads allowlisted skills from local checkouts; upstream skill content is not copied into this repo.

The router only reads Markdown. It never executes skill scripts, edits code, merges or deploys: every route result has `mayMerge: false` and `mayDeploy: false`.

## 1. Clone the skill sources

Clone them yourself; the library never clones or fetches. Check out the commit you reviewed.

```bash
mkdir -p "$HOME/ei-skill-sources" && cd "$HOME/ei-skill-sources"
git clone https://github.com/mattpocock/skills.git matt
git clone https://github.com/addyosmani/agent-skills.git osmani
git clone --filter=blob:none --sparse https://github.com/cursor/plugins.git cursor-plugins
git -C cursor-plugins sparse-checkout set pstack
```

Each env var points at the **git top level of its checkout**. Skills are looked up under a fixed `rootSubpath` below that root (recorded in `skills.lock.json`):

| Provider | Env var | Points at | `rootSubpath` | Skill file |
|---|---|---|---|---|
| matt | `EI_MATT_ROOT` | `~/ei-skill-sources/matt` | `skills/engineering` | `<root>/skills/engineering/<skill>/SKILL.md` |
| poteto | `EI_POTETO_ROOT` | `~/ei-skill-sources/cursor-plugins` | `pstack/skills` | `<root>/pstack/skills/<skill>/SKILL.md` |
| osmani | `EI_OSMANI_ROOT` | `~/ei-skill-sources/osmani` | `skills` | `<root>/skills/<skill>/SKILL.md` |

```bash
export EI_MATT_ROOT="$HOME/ei-skill-sources/matt"
export EI_POTETO_ROOT="$HOME/ei-skill-sources/cursor-plugins"   # the repo root, NOT .../pstack or .../plugins
export EI_OSMANI_ROOT="$HOME/ei-skill-sources/osmani"
```

The prototype's README pointed `EI_POTETO_ROOT` at `cursor-plugins/plugins` while sparse-checking out `pstack` at the repo top, so the loader looked in a directory that does not exist. The layout above matches the checkout on the author's machine, confirmed by `sources check` (pstack's real location can still change upstream; re-run `sources check` after any update).

## 2. Build and test

Node >= 22.5 (`node:sqlite`, ADR 0005). Dev dependencies are `typescript` and `@types/node` only; there are no runtime dependencies. The engine loads its own pinned TypeScript (`package.json#eiRuntime`) by absolute path, provisioned once by `ei setup`.

```bash
npm ci
npm run typecheck
npm test          # tsc build, compile tests to dist-test/, node --test
npm run build     # src/ -> dist/
```

The baseline CI workflow runs `typecheck`, `lint`, `test` and `check:dist` on `ubuntu-latest` and `macos-latest` (Node 24, plus Bun 1.4.4, the runtime OMP 18.19.0 ships, for the engine host tests). This checks the library on two OS families, **not** every CPU architecture or real OMP integration. Those require separate acceptance evidence.

`npm test` expands `dist-test/tests/workflow/*.test.js` through the POSIX shell.

## 3. Pin and verify sources

`skills.lock.json` records, per provider, the repo URL, a commit SHA, `rootSubpath`, and the `sha256` of every allowlisted `SKILL.md`. `null` means "not pinned yet". The loader fails closed with `HASH_MISMATCH` when a pinned skill's content differs.

```bash
node dist/adapters/cli/main.js sources check            # read-only: HEAD vs lock, paths, hashes; exit 1 on any error
node dist/adapters/cli/main.js sources check --write    # pin current HEAD + hashes into skills.lock.json
```

`--write` records whatever is checked out right now. Review the skills first; pinning is not a content review. A provider is written only if its root exists, HEAD is readable and every catalog skill passes the loader's checks. Use `--lock <path>` to work on another lock file.

Error codes (loader and `sources check`): `PROVIDER_ROOT_MISSING` (env var unset or not absolute), `PROVIDER_ROOT_NOT_FOUND`, `SKILL_NOT_FOUND`, `PATH_ESCAPE` (realpath leaves the root), `INVALID_SKILL` (not a regular file, over 64 KiB, or no frontmatter), `HASH_MISMATCH`. `sources check` adds `NOT_A_GIT_CHECKOUT` and `COMMIT_MISMATCH`.

## 4. CLI

```bash
node dist/adapters/cli/main.js route --task 'fix recurring payment race condition' --stage investigate
node dist/adapters/cli/main.js route --task 'แก้บั๊กการชำระเงิน' --stage investigate --type bug
node dist/adapters/cli/main.js load  --task 'auth vulnerability' --stage verify --risk high
```

- `route` works offline and prints JSON. `load` needs the checkouts and fails closed if any selected skill is unavailable or fails its hash check.
- `--type bug|feature|refactor|security|performance|ui`: caller-asserted task type, reported as `classifiedBy: "caller"`. An invalid value is an error. Without it, an English keyword classifier runs (`"keyword"`) and falls back to `feature` (`"default"`). A `"default"` guess is shown in the rendered output; non-English or security-sensitive tasks should pass `--type`.
- `--stage` defaults to `plan`, `--risk` to `normal`.

Code index (M2a: census, declarations, edges; no agent impact tool yet):

```bash
node dist/adapters/cli/main.js setup [--check]     # install the pinned TypeScript into ~/.cache/ksd-intelligence/runtime (network, once); --check only verifies
node dist/adapters/cli/main.js index [--root <path>] [--full]   # incremental update of ~/.cache/ksd-intelligence/<repo-id>/index.sqlite; --full rebuilds cold
node dist/adapters/cli/main.js status [--root <path>] [--json]   # same text as the ei_status tool
node dist/adapters/cli/main.js doctor --deep [--root <path>] [--differential <n|all>] [--json]   # cold rebuild diffed against the index; optional find-references check
```

- The repository is the nearest directory with `ei.config.json`, else the git work-tree root. Visible files come from `git ls-files` (tracked + untracked − ignored), else a walk honouring `.gitignore`.
- Every visible file is classified `indexable`, `orphan` (no tsconfig owns it) or `unindexed` with a reason (`secret`, `excluded`, `outside-index-scope`, `other-kind`, `symlink`). Secret and excluded paths (`docs/RISK.md` §6 plus `impact.exclude`) are listed by path only; their content is never read. Secret name patterns never exclude code files.
- `index` runs in a separate engine process (Node >= 22.5 from `PATH`, else OMP's Bun) under the repository's build lock and the `impact.maxMemoryMb` limit. It extracts declarations and edges per `docs/adr/0002-stable-keys.md` and `docs/adr/0003-indexed-declarations.md`, verifies the staging database and publishes it by copy-then-rename; a failed verify keeps the previous index.
- An update re-resolves the changed files and the affected set. Inside a running engine that set is TypeScript's chained builder program plus this repository's export-surface, import and name cross-checks (`affected-set-supplemented` in the status counts what the cross-checks added). The export-surface hash is syntactic: no checker call, signature text where types are written and body or initializer text where they are inferred (`docs/adr/0003-indexed-declarations.md`). A new process, which every CLI call is, has no builder state and uses the cross-checks alone (D47). The engine child exits after a cold build, so a cold build's memory is not kept; the next request starts a new child from the published index. Both paths are tested to equal a cold build. Measurements: `docs/research/m2a-measurements.md`.
- `doctor --deep` exits 0 only when the cold rebuild equals the index and, with `--differential`, every reference TypeScript's find-references reports is an edge or a recorded unresolved/gap site.

## 5. OMP adapter

`src/adapters/omp/extension.ts` registers two read-only (`approval: "read"`) tools: `ei_workflow` (`task`, `stage`, optional `risk` and `type`) and `ei_status` (no input; the status of the index for the session's working directory). `EI_DISABLED=1` registers neither. After `npm run build`:

```bash
omp --extension ./dist/adapters/omp/extension.js
```

Or run scenarios interactively via the M1 smoke test runner:

```bash
bash scripts/m1-smoke.sh <s1|s2|s3|s4|s5|s6|s7|s8|checklist>
```

**Verification status (M1, 2026-11-11):** S1–S6 and S8 VERIFIED live on `omp/18.18.8` non-interactively (`omp -p --model claude-haiku-4-5 -e dist/adapters/omp/extension.js …`; the default Gemini provider rejected an unrelated MCP tool's schema, Claude did not). S7 PARTIAL: plugin list and skill sources checked read-only; the KSD indicator check needs an interactive TUI session. Full evidence: M1 report.

Known interaction: Caveman (`caveman@4.0.1`) is active in sessions on this machine and can compress how the agent *presents* `ei_workflow` output ("[155 lines compressed …]"); the raw tool result in the session transcript stays complete. Check this during dogfooding.

### Persistent install (marketplace, D40)

This repository is itself the OMP plugin (`.omp-plugin/marketplace.json`, plugin `ksd-intelligence@ksd-intelligence`). Development loads are explicit (`omp -e dist/adapters/omp/extension.js`); daily use installs it once (see §6) and the marketplace serves upgrades (`omp plugin upgrade`).

## 6. KSD policy module (merged from Engineering Proxy 0.6.0)

Everything the separate KSD Engineering Proxy v0.6.0 provided ships unchanged in `src/policy/` (frozen contract: `docs/DESIGN.md` §6.7, provenance: `PROVENANCE.md`, proof: `tests/policy/contract.test.js`). One extension registers it and the `ei_*` tools together.

**Commands:** `/engineering-proxy [status|balanced|adaptive|reset|global <mode|reset>|repo <mode|reset>]` and `/engineering-review [scope]`, with their 0.6.0 output text.

**Config:** global `~/.omp/agent/engineering-proxy.json`, project `.engineering-proxy.json` at the nearest `.git`/`.omp` root; keys `enabled` and `enforcement: balanced | adaptive`. Precedence: session > project > global > built-in balanced; `enabled` merges separately. An invalid config fails open (no injection; error only in `/engineering-proxy status`).

**Status segment:** `○ 🛡 KSD: BALANCED` (idle) / `● 🛡 KSD: ADAPTIVE` (active), with its 0.6.0 show/clear rules.

**Kill switches:** `ENGINEERING_PROXY_DISABLED=1` disables policy injection and `/engineering-review` only; `EI_DISABLED=1` disables the `ei_*` tools only.

**Opt-in tools:** `ksd-check-changed` and `ksd-review-verdict` (npm `bin` entries) and the ESLint rules export (`ksd-intelligence/eslint`) — same behaviour as 0.6.0.

### Install (owner)

```text
cut-over:  omp plugin uninstall engineering-proxy@engineering-proxy
           omp plugin marketplace add Krisada-M/ksd-intelligence
           omp plugin install ksd-intelligence@ksd-intelligence
           (restart OMP; confirm the 🛡 KSD status segment and /engineering-proxy status)
upgrade:   omp plugin marketplace update ksd-intelligence
           omp plugin upgrade ksd-intelligence@ksd-intelligence
rollback:  omp plugin uninstall ksd-intelligence@ksd-intelligence
           omp plugin install engineering-proxy@engineering-proxy
```

Never run both plugins at once (the policy would be injected twice). The old `Krisada-M/ksd-engineering` repository is archived, not deleted, after the cut-over.

## Rules this router follows

- One router: do not also enable `poteto-mode`, `using-agent-skills` or `ask-matt` as automatic routers. KSD Engineering Proxy policy outranks skill text; rendered output always starts with a precedence header before any skill text.
- Only allowlisted skills load; symlink escapes and files over 64 KiB are rejected; frontmatter is required.
- Skill Markdown can contain hostile instructions. The loader cannot detect them. What it enforces: fixed `mayMerge`/`mayDeploy: false`, the precedence header first, and rejection of any skill whose content differs from its pinned hash.
