# Owner release checklist — 1.0.0

Do not tag merely because local tests pass. The tag starts npm publication. Run the checks below after reviewing [the audit](research/v1-closeout-audit.md). Only the owner pushes, opens/merges the PR, tags, publishes, and archives.

## 1. Candidate and CI

```sh
git switch v1-closeout
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
npm run check:dist
node --test tests/packaging/npm-tarball.test.js
node --test evals/run.test.mjs
```

Run agent evals on Linux with Node 24, OMP, and a working Bubblewrap (`bwrap`). The runner uses `--thinking low`, fresh fixtures, and a dedicated OMP home. The test tool cannot fall back to host execution. Log in once to the dedicated home; do not copy stored credentials into it. Run only one startup per eval home at a time: `ei setup` can fail when started concurrently. The following setup block uses a POSIX shell (`sh`), not fish:

```sh
export EI_EVAL_HOME="$(mktemp -d)"
env HOME="$EI_EVAL_HOME" USERPROFILE="$EI_EVAL_HOME" \
  XDG_CONFIG_HOME="$EI_EVAL_HOME/.config" XDG_CACHE_HOME="$EI_EVAL_HOME/.cache" \
  XDG_DATA_HOME="$EI_EVAL_HOME/.local/share" XDG_STATE_HOME="$EI_EVAL_HOME/.local/state" \
  PI_CODING_AGENT_DIR="$EI_EVAL_HOME/.omp/agent" OMP_PROFILE='' \
  omp login openai-codex
node evals/run.mjs
EI_EVAL_MODEL=openai-codex/gpt-6.2-sol node evals/run.mjs
```

The 1.0.0 eval gate requires no unresolved checker bugs, tool guidance gaps, or tool errors, and at least 9 of all 10 cases passing on the strongest available model. Record the Luna rate without gating on it. An unscored case is not a pass. See [baseline transcript triage](research/v1-eval-followup.md).

**Eval gate: VERIFIED.** Review fixes tested on Linux/WSL2 x86_64, Node 24.21.0, OMP 19.2.1, and Bubblewrap 0.11.1.

| Model | Pass rate | Transcript directory |
| --- | --- | --- |
| `openai-codex/gpt-5.6-luna` | 90% (9/10) | `/tmp/ksd-eval-nug7du` |
| `openai-codex/gpt-6.2-sol` (strong gate) | 100% (10/10) | `/tmp/ksd-eval-KTeYqT` |

Both runs scored all 10 cases. Luna's `search-review` failed the existing ordering check: its concurrent `ei_changes` call finished before `ei_impact`, and it did not call `ei_changes` again before answering. The pre-review grader gives the same result on that transcript. The eval gate does not replace either live product smoke.

After the local gate passes:

```sh
git push -u origin v1-closeout
gh pr create --base main --head v1-closeout --title 'V1 close-out: 1.0.0 release candidate' --body 'Audit, CLI packaging, release notes, and owner gates: docs/release-checklist.md.'
gh pr checks v1-closeout --watch
```

Wait for both Node 24 OS jobs, independent review, no protected-path changes or unreviewed failures, and equivalent checks on the exact head.

## 2. Live smoke on macOS and Linux/WSL2

On **each** machine, use an isolated test account or profile with its own authorized model session. Set the three reviewed skill roots from README. Run these commands in a clean temporary clone of the candidate, not a working tree with attached indexers:

```sh
git clone --branch v1-closeout https://github.com/Krisada-M/ksd-intelligence.git ksd-v1-smoke
cd ksd-v1-smoke
uname -sm
node --version
omp --version
omp plugin marketplace add "$PWD"
omp plugin install ksd-intelligence@ksd-intelligence
omp plugin list
npm ci
node dist/adapters/cli/main.js setup
node dist/adapters/cli/main.js init
node dist/adapters/cli/main.js index
for s in s1 s2 s3 s4 s5 s6; do bash scripts/m1-smoke.sh "$s" --no-extensions; done
bash scripts/m1-smoke.sh s7
bash scripts/m1-smoke.sh s8
omp -p --model claude-haiku-4-5 'In this clone, call ei_status, ei_search (query matchGlob), ei_impact (targets ["src/core/kernel/glob.ts#matchGlob"]), ei_changes (base HEAD), and ei_workflow (task fix a bug, type bug, stage investigate). Print the five raw results. Do not edit.'
omp
```

In the interactive marketplace session, confirm the EROSIANO indicator and run `/erosiano-dev status`. The legacy alias must delegate to the same owner. Verify a single engineering policy marker and the native ei_* tools. Use the printed M1 instructions (S8 is a follow-up in the S5 session); the explicit loads in S1–S6 disable discovery so they do not duplicate the installed plugin. If the test account has the old policy plugin, uninstall it first. For AGY, install the candidate tarball (`npm pack .`, `npm install -g ./krisada-m-ksd-intelligence-1.0.0.tgz` using the filename printed by npm), use [the setup guide](integrations/antigravity.md), and observe real tool discovery and calls. Record architecture, runtime versions, tool results, and status. Protocol tests alone are not live AGY evidence.

After review and both OS smoke checks:

```sh
gh pr merge v1-closeout --squash --match-head-commit "$(git rev-parse v1-closeout)"
git fetch origin
```

## 3. Npm trusted publisher and tag

The `npm` GitHub environment and `publish.yml` workflow must match the trusted publisher. With npm 12 and an authorized npm maintainer login:

```sh
npm trust github @krisada-m/ksd-intelligence --repository Krisada-M/ksd-intelligence --file publish.yml --environment npm --allow-publish
npm trust list @krisada-m/ksd-intelligence
```

Alternatively use the npm package Settings → Trusted Publisher UI with owner `Krisada-M`, repository `ksd-intelligence`, workflow `publish.yml`, environment `npm`. Do not store an npm publishing token in GitHub. Verify origin/main is the exact accepted and CI-green release revision before tagging:

```sh
git show origin/main:package.json | node -e 'const p=JSON.parse(require("node:fs").readFileSync(0,"utf8")); if (p.version !== "1.0.0") process.exit(1);'
git tag -a v1.0.0 origin/main -m 'ksd-intelligence 1.0.0'
git push origin refs/tags/v1.0.0
npm view @krisada-m/ksd-intelligence@1.0.0 version
```

Check the completed `Publish to npm` run and provenance. Then rehearse the README marketplace commands against GitHub `main` and `npm install -g @krisada-m/ksd-intelligence` against the registry.

## 4. Retire old plugin after successful cut-over

```sh
gh repo edit Krisada-M/ksd-engineering --description 'Archived: use https://github.com/Krisada-M/ksd-intelligence'
gh repo archive Krisada-M/ksd-engineering
```

Keep the old repository available for rollback. Use `EI_DISABLED=1` or `ENGINEERING_PROXY_DISABLED=1` for an immediate shutdown on the affected host; then follow README rollback. Keep logging dogfood and treat any wrong `low` as stop-ship.
