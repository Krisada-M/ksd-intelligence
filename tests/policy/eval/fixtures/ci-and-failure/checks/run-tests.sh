#!/bin/sh
# harness-only; runs AFTER the agent leaves the review, or by an approved tool
# during it. Executes the local test suite, which is deliberately failing as
# shipped (exit != 0). Never part of the agent's task answer.
set -eu
cd "$(dirname "$0")/.."
exec node --test tests/app.test.js
