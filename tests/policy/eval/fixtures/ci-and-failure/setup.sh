#!/bin/sh
# Builds the reviewed git state for this fixture. Run ONLY inside an isolated
# temp copy of the fixture directory (it refuses to run within an existing
# git work tree, so the repository root can never be polluted):
#   1. commit a baseline that omits src/feature.js (it stays untracked)
#   2. delete src/legacy.js from the working tree (deletion-only, uncommitted)
#   3. print the baseline sha; it will not match ci-record.json's stale head_sha
set -eu
cd "$(dirname "$0")"

if [ -e .git ] || git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "refusing: fixture already inside a git work tree; run setup in a fresh temp copy"
    exit 1
fi

git init -q
# Fixture runs must be hermetic and reproducible: pin a repo-local identity so
# the baseline commit never depends on an ambient global git config (a sandbox
# without one would fail here).
git config user.name "ksd-eval"
git config user.email "ksd-eval@example.invalid"
git add task.txt src/app.js src/legacy.js tests/app.test.js ci.yml ci-record.json setup.sh checks/run-tests.sh
git commit -q -m "baseline"
rm src/legacy.js

printf 'baseline sha: '
git rev-parse HEAD
