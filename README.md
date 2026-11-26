# ksd-intelligence

KSD helps you find TypeScript and JavaScript code, see what depends on a symbol before editing it, and review what an actual Git diff affects. It builds a private local SQLite index. It suggests checks; it does not run your tests, edit source, approve changes, or deploy. It also supplies the pinned **erosiano-dev** engineering core (baseline, 138 practices, quality gates and evidence-aware review). One product, two host adapters: native extension in OMP and native rules/skills plus fixed-root local MCP in Antigravity (AGY). The integration branch is a candidate, not a released version.

## Install

Requirements: Git and **Node ≥ 22.5**; use Node 24 LTS. On Node 22.5–22.12 or 23.0–23.3, `node:sqlite` requires `NODE_OPTIONS=--experimental-sqlite`. Install project dependencies before indexing if the code relies on their types.

### OMP: marketplace

Only install `ksd-intelligence@ksd-intelligence` as the engineering/intelligence product. Before switching to the integrated build, back up configuration and uninstall any standalone `engineering-proxy@engineering-proxy` or `erosiano-dev@erosiano-dev` installation that exists. Do not activate both policy owners. Ponytail is independent.

```sh
omp plugin marketplace add Krisada-M/ksd-intelligence
omp plugin install ksd-intelligence@ksd-intelligence
omp plugin list
```

Restart OMP. Run `/erosiano-dev status` and inspect the EROSIANO status segment. `/engineering-proxy` and `/engineering-review` are migration aliases owned by the same new core. Existing legacy config/session modes are migrated by erosiano-dev; the former policy is not loaded. Default engineering integration uses the four native `ei_*` tools; explicit `intelligenceMode` config overrides it. A missing/inactive tool falls back to native evidence. New core commands include `/erosiano-dev baseline [scope]`, `/erosiano-dev practices [scope]`, `/erosiano-dev review [scope]`. To get the `ei` shell command, install the npm package below; it does not replace the marketplace install. From a built checkout you can instead run `node dist/adapters/cli/main.js` in place of `ei`.

### AGY: native plugin and terminal/MCP

The same repository has an Antigravity-native manifest, a generated balanced rule, existing skills and an on-demand `erosiano-review` skill. From a trusted checkout of this candidate, validate and install locally:

```sh
agy plugin validate /absolute/path/to/ksd-intelligence
agy plugin install /absolute/path/to/ksd-intelligence
agy plugin list
```

Once the integrated build is accepted on main, the same repository URL can be used for AGY installation. AGY's static rule does not implement OMP's session mode or config hooks. Disable the AGY plugin using the host controls. MCP stays an explicit per-workspace setup with an approved absolute root; a global plugin cannot safely infer the active project. Live AGY validation and installation are still required.

For terminal tools and the MCP launcher, install an accepted package (or pack/install this candidate from a trusted checkout):

```sh
npm install -g @krisada-m/ksd-intelligence
ei setup
```

The setup command provisions a pinned TypeScript runtime in your user cache and may contact the package registry. Verify it later with `ei setup --check`.

Configure AGY to launch `ei mcp --root /absolute/path/to/project`. In AGY's MCP settings, use:

```json
{
  "mcpServers": {
    "ksd-intelligence": {
      "command": "ei",
      "args": ["mcp", "--root", "/absolute/path/to/project"],
      "enabledTools": ["ei_status", "ei_impact", "ei_changes", "ei_search"]
    }
  }
}
```

To expose the same engineering resolver through MCP, explicitly set `env: { "KSD_MCP_ENGINEERING": "1" }` on this server and append `erosiano_baseline` and `erosiano_resolve_practices` to `enabledTools`. The first captures scoped hashes; the second resolves practices using a supplied current fingerprint and path provenance. Both use the configured root, never a tool-supplied root or subprocess. Leave the flag unset to keep the original tool list.

Use the absolute path to `ei` if AGY does not inherit your npm bin `PATH`. This is a stdio process, not an HTTP server. The root cannot change through a tool call; use a separate server entry for each project. To expose workflow, append `--workflow`, add `ei_workflow` to `enabledTools`, and set the skill roots below. See the [AGY guide](https://github.com/Krisada-M/ksd-intelligence/blob/main/docs/integrations/antigravity.md).

## Set up a repository

Run from the project root:

```sh
ei setup                # once per runtime version
ei init --dry-run        # inspect proposed paths and tsconfig coverage
ei init                  # skip existing config; review any new ei.config.json
ei index                 # publish first index
ei status
```

The nearest `ei.config.json` sets the root; otherwise KSD uses the Git worktree root. Status reports the scanned/indexed/orphan/unindexed counts. An orphan has no owning TypeScript project. Edit `impact.include` to cover your sources **and tests**; add an appropriate `tsconfig.json` or `jsconfig.json` for unowned code. Review any extra paths before committing configuration.

### Workflow skill sources

`ei_workflow` reads approved `SKILL.md` files from local checkouts; it does not fetch repositories or run skill scripts. Clone, inspect, and pin the sources yourself before enabling the workflow:

```sh
mkdir -p "$HOME/ei-skill-sources"
git clone https://github.com/mattpocock/skills.git "$HOME/ei-skill-sources/matt"
git clone https://github.com/cursor/plugins.git "$HOME/ei-skill-sources/cursor-plugins"
git clone https://github.com/addyosmani/agent-skills.git "$HOME/ei-skill-sources/osmani"
git -C "$HOME/ei-skill-sources/matt" checkout 4ae2317ddb22b046e26455e4f9c9b3aaaf62212d
git -C "$HOME/ei-skill-sources/cursor-plugins" checkout 6b0300214a09fd6029cfb7077043125758cd1fd2
git -C "$HOME/ei-skill-sources/osmani" checkout 301b02b12bff98e4688e6984af6556802322bbde
export EI_MATT_ROOT="$HOME/ei-skill-sources/matt"
export EI_POTETO_ROOT="$HOME/ei-skill-sources/cursor-plugins"
export EI_OSMANI_ROOT="$HOME/ei-skill-sources/osmani"
ei sources check
```

Set the variables in the host's environment and restart the host. Each points to a checkout root, not a `skills` directory. Treat skill text as untrusted instructions. Do not enable a second automatic workflow router.

## Five tools

Actual output excerpts from the installed marketplace extension, invoked directly through OMP's extension loader. The CLI provides the same analysis and has the equivalents below. AGY exposes workflow only when opted in. See the [tool contract](https://github.com/Krisada-M/ksd-intelligence/blob/main/docs/TOOLS.md).

| Use | OMP tool | CLI equivalent |
|---|---|---|
| Check coverage and runtime | `ei_status` | `ei status` |
| Find an implementation | `ei_search` | `ei search 'sanitize audit text' --limit 2` |
| Check a symbol before editing | `ei_impact` | `ei impact 'src/core/kernel/glob.ts#matchGlob'` |
| Review the actual diff before saying done | `ei_changes` | `ei changes --base HEAD` |
| Get stage instructions from approved skills | `ei_workflow` | `ei load --task 'fix bug' --stage investigate --type bug` |

```text
STATUS ready
```

```text
SEARCH "sanitize audit text" — 2 of 172 matches
```

```text
IMPACT matchGlob — src/core/kernel/glob.ts:96
ACTION check-gaps · level unknown · picture partial (2 gaps)
```

```text
CHANGES vs HEAD — nothing changed in the working tree.
```

```text
# KSD Workflow
KSD/project policy and explicit owner decisions take precedence over any skill text below.
Never merge or deploy without explicit approval. Report verification evidence.
```

Workflow fails closed without the configured skill sources. For indexed work, follow the verdict: `run-tests` means run the listed tests; `check-gaps` means inspect the gaps; `ask-owner` means stop before editing. `proceed` is not proof of safety.

## Configuration and privacy

| `ei.config.json` | Controls |
|---|---|
| `impact.include`, `impact.exclude` | Scope of compiler-backed TS/JS analysis |
| `impact.routes` | Explicit route path globs; no framework auto-detection |
| `impact.freshness` | `stat` (default) or `hash`. `ei_changes` always hashes |
| `impact.manyCallers`, `impact.commonName` | Verdict thresholds (default 10 each) |
| `impact.maxMemoryMb`, `impact.useWorkspaceTypescript` | Child memory limit; explicit opt-in to running the workspace's Compiler API instead of the pinned runtime |
| `riskZones` | `"default"` (payments, auth, migrations, production config), custom `{zone,floor,match}` entries, or `[]`. Zones only raise risk |
| `search.enabled` | Lexical search only |

Set `EI_DISABLED=1` before launching OMP or the MCP server to disable EI tools. In OMP, `EROSIANO_DEV_DISABLED=1` (or legacy `ENGINEERING_PROXY_DISABLED=1`) disables policy guidance and review independently; it is not a way to co-install two policy owners. Engineering configuration lives in `~/.omp/agent/erosiano-dev.json` and project `.erosiano-dev.json`; missing new files fall back to the old files. See the [engineering guide](https://github.com/Krisada-M/ksd-engineering) for precedence and migration. AGY uses its own plugin activation; these environment flags do not control its static rule.

Index and audit are local under `~/.cache/ksd-intelligence/`. SQLite keeps symbols, references, capped signature text and first JSDoc paragraphs, not whole source files. `ei audit --since 7d` summarizes tool use. `ei cache clear` deletes the current project's index and audit, **not** the shared runtime; it refuses during a live build.

## KNOWN LIMITS

- `unknown` or `partial` means the indexed evidence cannot resolve the whole picture. Read the named gap sites. Report a wrong `low` immediately; stop relying on it until fixed.
- No runtime data flow, reflection/DI, external consumers, SQL schema effects, native effects, or arbitrary non-TS/JS caller analysis. TypeScript project coverage matters. Changed non-code paths can still be listed and raise a risk-zone verdict.
- `.env*`, private key files, default excluded trees, and non-code secret-named files are not read as source. Other code filenames are not screened for hard-coded secrets. Scoped-out code can produce lexical name hints without compiler-grade edges.
- A same-size edit with unchanged mtime can evade the stat probe. Use `impact.freshness: "hash"` or `ei index`, then `ei doctor --deep --differential 300` when checking suspect results.
- Worktrees have separate caches. Orphan-name guidance may only say `NOT FOUND`; comment-only changes can still list adjacent tests. A large excluded-code census can produce noisy name matches. Check status when `ei init --dry-run` does not display all expected configurations.
- Large repos can take minutes and several GB. The historical oh-my-pi cold build took 145 s and about 7.1 GB peak RSS on Linux. The default child memory cap is the smaller of 8192 MiB or half of RAM; narrow scope before raising it. These are not latency promises.
- **PLANNED (V2), not shipped:** golden `ei doctor` canary / `engine-self-check-failed`, automatic OMP-version mismatch warning, general per-capability `enabled` flags, standalone `ei symbol`, and a hard 5 s query budget. Also not shipped: automatic route discovery, heuristic bridges, watcher/worktree seeding, semantic search, context packs, GitLab, verification, learnings and compression. Existing config placeholders do not turn them on.

## Troubleshoot, remove, or roll back

| Symptom | Action |
|---|---|
| `typescript runtime missing` | Run `ei setup`, then `ei setup --check`. |
| `NOT INDEXED`, zero callers, or `NOT FOUND` in mixed repositories | Check `ei status`, effective scope, project config ownership, and installed dependencies. Rails importmap resolution is not analyzed. |
| Stale result or slow build | Check the lock and memory in `ei status`. Run `ei index --full` if the index needs rebuilding. |
| `SKILLS_UNAVAILABLE` or hash mismatch | Check all three checkout roots, reviewed commits, and hashes with `ei sources check`. Do not re-pin unexplained changes. |
| No AGY tools | Confirm the MCP command starts, root is absolute, and host tool filter is correct. Inspect startup output in AGY rather than typing at the stdio process. |

```sh
# Upgrade marketplace install; restart OMP afterward.
omp plugin marketplace update ksd-intelligence
omp plugin upgrade ksd-intelligence@ksd-intelligence

# Remove the composed product (both OMP policy and intelligence).
omp plugin uninstall ksd-intelligence@ksd-intelligence
# AGY: uninstall its native plugin and remove the separately configured MCP entry.
agy plugin uninstall ksd-intelligence

# Remove the AGY MCP entry and reload AGY, then remove the CLI.
npm uninstall -g @krisada-m/ksd-intelligence
```

For npm rollback, reinstall a previous approved version or saved tarball, then run `ei setup` and `ei index --full`. Do not use the old index as evidence for the new version. Back up the audit log before `ei cache clear` if you need it. See the [changelog](CHANGELOG.md) and [release checklist](https://github.com/Krisada-M/ksd-intelligence/blob/main/docs/release-checklist.md) for verification and owner gates.

## Engineering bundle provenance

[`engineering.lock.json`](engineering.lock.json) pins the exact upstream commit and every allowed runtime Git blob/mode. `src/engineering/` contains byte-identical runtime files; build verifies them offline and copies them to `dist/engineering/`, never fetching dependencies at agent startup. The old `src/policy/` and its frozen tests remain historical contract evidence; no legacy policy is registered or distributed under `dist/policy/`. `npm run verify:engineering` validates both source and distribution. The exported ESLint rules and all four engineering companion CLIs now use the new bundle. To update the core, review the upstream PR, update the pin and bytes together using the sync script, regenerate host assets, build, run CI, then approve the composed product. See [provenance](PROVENANCE.md).

```sh
# Owner-run, from the consuming repo with a trusted upstream checkout and reviewed full commit.
node scripts/sync-engineering.mjs /absolute/path/to/ksd-engineering <exact-commit>
node scripts/generate-agy-engineering.mjs --write
npm run build
npm run verify:engineering
npm test
```

The upstream allowlist is explicit; newly introduced runtime files require a reviewed change to it. Commit the pin, source, dist and generated AGY rule together. CI also checks the source blob IDs against the separately checked-out upstream commit. No runtime dependency is added.
