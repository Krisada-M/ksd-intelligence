# M1c — Merge KSD Engineering Proxy into the library (agent brief)

Read `AGENTS.md` first, then `docs/DESIGN.md` §6.7, §10.1 (persistent loading) and §10.2. M1 and M1b are accepted. This brief covers M1c only. Stop and report when done.

## Goal

One OMP plugin, `ksd-intelligence`, that provides everything the separate KSD Engineering Proxy v0.6.0 provided, unchanged, plus the `ei_*` tools. Installed through the OMP marketplace like KSD was. The old plugin is replaced, not run alongside.

This is a **migration, not a rewrite**. Do not improve, restyle, rename or convert KSD code in this milestone. Any change to KSD behaviour is a defect.

## Source

- Repository: `https://github.com/Krisada-M/ksd-engineering`, commit `73fc916` (v0.6.0). Clone it into the OS temp directory.
- Plugin code: `plugins/engineering-proxy/` (TS sources in `src/`, compiled runtime, JS modules, `eslint-rules/`, `test/` with 148 tests and eval fixtures, `tsconfig.json`).
- Root files that matter: `eslint.config.mjs`, `examples/`, `validate-release.js`, `docs/ACCEPTANCE.md`, `.omp-plugin/marketplace.json`, `.github/workflows/tests.yml`.

## Steps

### 1. Bring the code in with its history

Preferred: import the plugin directory with its git history into `src/policy/` (for example `git subtree add --prefix=src/policy <ksd-repo> 73fc916` after narrowing the source to `plugins/engineering-proxy`, or `git filter-repo --subdirectory-filter` on a temp clone, then merge with `--allow-unrelated-histories`). If preserving history becomes complicated, copy the files at `73fc916` instead and say so; record the source commit in `PROVENANCE.md` either way.

Target layout:

```text
src/policy/                 KSD runtime and modules, file names unchanged
src/policy/eslint-rules/
tests/policy/               KSD's test/*.test.js and test/helpers/, unchanged except import paths
tests/policy/eval/          KSD's eval fixtures
docs/policy/ACCEPTANCE.md   from KSD docs/ACCEPTANCE.md
examples/                   KSD examples (.engineering-proxy.json, eslint.config.mjs)
```

KSD files stay JavaScript where they are JavaScript. Enable what the build needs (`allowJs`, or copying JS as-is into `dist/`) without converting them.

### 2. One extension entry

`src/adapters/omp/extension.ts` becomes the single entry. It calls KSD's `createExtension(pi)` (default export of KSD's `index.js`) and then registers `ei_workflow`, in that order. A failure in either part must not prevent the other from registering; log the error through whatever KSD already uses for warnings.

Kill switches stay independent: `ENGINEERING_PROXY_DISABLED=1` disables only KSD injection and `/engineering-review`; `EI_DISABLED=1` disables only the `ei_*` tools.

### 3. Tests and the frozen contract

- All 148 KSD tests run inside `npm test` from `tests/policy/`, using KSD's isolated-home helper so a real `~/.omp/agent/engineering-proxy.json` cannot affect results. Only import paths may change; report every other edit to a KSD test as a deviation, with the reason.
- Add `tests/policy/contract.test.*`: run KSD 0.6.0 from the temp clone and the merged module side by side and compare byte for byte:
  - policy text for `balanced` and `adaptive`
  - `/engineering-review` text for both modes
  - status segment strings for each state (active/idle × mode, disabled, invalid config)
  - `/engineering-proxy status` output for a fixed set of configs (global only, project only, both, invalid)
  Then store the 0.6.0 outputs as snapshot files under `tests/policy/snapshots/` so the comparison keeps running after the temp clone is gone.
- This repo's existing tests (56) still pass.

### 4. Packaging as an OMP marketplace plugin

- Read the installed OMP docs on plugins and marketplaces (`omp://` docs, as in M1) and record: required files, how a marketplace resolves which version to install (branch head, tag, or `version` field), and how upgrade works.
- Add `.omp-plugin/marketplace.json` (plugin name `ksd-intelligence`, source `.`, version `0.1.0`) and `package.json#omp.extensions` / `#pi.extensions` pointing at the built entry, following KSD's working example.
- Built output becomes committed, as KSD did: remove `dist/` from `.gitignore` (keep `dist-test/` ignored), add `npm run check:dist` = build then `git diff --exit-code dist/`.
- Keep `ksd-check-changed` and `ksd-review-verdict` as `bin` entries and the ESLint rules as an `./eslint` export.
- If the marketplace installs from the default-branch head, propose a `release` branch workflow in the report (do not create the branch).

### 5. Live check and cut-over plan

Run in OMP non-interactively as in M1 (`omp -p --model claude-haiku-4-5 -e dist/adapters/omp/extension.js …`), with the **old KSD plugin still installed and disabled for that one run** if OMP supports a per-run disable; otherwise run in an isolated home (`HOME` pointed at a temp directory with only this extension) and say so. Verify:

| # | Check |
|---|---|
| L1 | `ei_workflow` returns a skill as in M1 S1 |
| L2 | The KSD policy text appears in the system prompt exactly once (inspect the session transcript or debug output) |
| L3 | `/engineering-proxy status` works (if slash commands cannot run in `-p`, call the command handler through the extension in a test harness and say so) |
| L4 | `ENGINEERING_PROXY_DISABLED=1` removes the policy but keeps `ei_workflow`; `EI_DISABLED=1` does the reverse |

Do **not** uninstall or reinstall any plugin on the owner's machine. Write the cut-over and rollback commands into README for the owner:

```text
cut-over:  omp plugin uninstall engineering-proxy@engineering-proxy
           omp plugin marketplace add Krisada-M/ksd-intelligence
           omp plugin install ksd-intelligence@ksd-intelligence
           (restart OMP; confirm the 🛡 KSD status and `/engineering-proxy status`)
rollback:  omp plugin uninstall ksd-intelligence@ksd-intelligence
           omp plugin install engineering-proxy@engineering-proxy
```

Adjust the exact commands to what the installed OMP docs say.

### 6. Docs

- README: one section for the policy module (commands, config files, kill switch) taken from KSD's README, plus install, cut-over and rollback. Remove the absolute personal path currently in README (`/home/mezn/...`); use `<repo>` or `~`.
- `PROVENANCE.md`: source repository, commit, license (MIT, owner's own), what was moved.
- `docs/adr/0004-merge-ksd.md`: short ADR recording D39 and D40.

## Acceptance

1. `npm test` passes: this repo's tests plus all 148 KSD tests plus the contract test. Paste the summary.
2. Contract snapshots byte-identical to 0.6.0 for every listed surface.
3. `npm run check:dist` passes on a clean tree.
4. L1–L4 observed live, or each marked NOT VERIFIED with what blocked it.
5. Marketplace behaviour (version resolution, upgrade) recorded with the doc it came from.
6. Report in the `AGENTS.md` template, listing deviations from KSD code or tests one by one.

## Do not

- Change KSD behaviour, text, command names, config file names or config keys.
- Convert KSD JavaScript to TypeScript, or refactor it.
- Install, uninstall or upgrade plugins on the owner's machine, or edit `~/.omp/**`.
- Modify the `Krisada-M/ksd-engineering` repository.
- Start M2a. Commit or push.
