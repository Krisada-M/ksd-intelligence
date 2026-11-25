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
node evals/run.mjs
git push -u origin v1-closeout
gh pr create --base main --head v1-closeout --title 'V1 close-out: 1.0.0 release candidate' --body 'Audit, CLI packaging, release notes, and owner gates: docs/release-checklist.md.'
gh pr checks v1-closeout --watch
```

Wait for both Node 24 OS jobs, independent review, no protected-path changes or unreviewed failures, and equivalent checks on the exact head. The eval runner uses OMP's `3b-ctx16k` selector for local `ollama/granite4.2:3b-ctx16k` in an isolated HOME. Confirm it is available with `omp models find granite4.2`. Review any failed cases rather than assuming a zero denominator is a success.

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

In the interactive marketplace session, confirm the 🛡 KSD indicator and run `/engineering-proxy status`. Use the printed M1 instructions (S8 is a follow-up in the S5 session); the explicit loads in S1–S6 disable discovery so they do not duplicate the installed plugin. If the test account has the old policy plugin, uninstall it first. For AGY, install the candidate tarball (`npm pack .`, `npm install -g ./krisada-m-ksd-intelligence-1.0.0.tgz` using the filename printed by npm), use [the setup guide](integrations/antigravity.md), and observe real tool discovery and calls. Record architecture, runtime versions, tool results, and status. Protocol tests alone are not live AGY evidence.

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
