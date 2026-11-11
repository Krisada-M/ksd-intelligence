# ksd-intelligence

Personal, local-first Engineering Intelligence Library for Oh My Pi (OMP). Current scope is **M0**: a skill workflow router that picks one (at most two) leaf skills from Matt Pocock, poteto/pstack and Addy Osmani per task type, SDLC stage and risk, and reads their `SKILL.md` from explicit local checkouts. Upstream skill content is **not** copied into this repo. Scope and rules: `AGENTS.md`, `docs/adr/0001-v1-scope.md`.

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

Node >= 20. Dev dependencies are `typescript` and `@types/node` only; there are no runtime dependencies.

```bash
npm ci
npm run typecheck
npm test          # tsc build, compile tests to dist-test/, node --test
npm run build     # src/ -> dist/
```

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

## 5. OMP adapter (experimental)

`src/adapters/omp/extension.ts` registers a read-only (`approval: "read"`) `ei_workflow` tool with `task`, `stage`, optional `risk` and optional `type`. After `npm run build`:

```bash
omp --extension ./dist/adapters/omp/extension.js
```

**Verification status: NOT VERIFIED against OMP.** The adapter was written against `omp://extensions.md` from the installed binary (omp/18.18.2) and the type source of the installed npm package `@oh-my-pi/pi-coding-agent` 18.14.0 (older than the binary). Only a hand-written mock of the OMP API is tested (MOCK-ONLY). Loading it in a real OMP session is M1.

## Rules this router follows

- One router: do not also enable `poteto-mode`, `using-agent-skills` or `ask-matt` as automatic routers. KSD Engineering Proxy policy outranks skill text; rendered output always starts with a precedence header before any skill text.
- Only allowlisted skills load; symlink escapes and files over 64 KiB are rejected; frontmatter is required.
- Skill Markdown can contain hostile instructions. The loader cannot detect them. What it enforces: fixed `mayMerge`/`mayDeploy: false`, the precedence header first, and rejection of any skill whose content differs from its pinned hash.
