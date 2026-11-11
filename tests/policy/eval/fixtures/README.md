# Eval fixtures — six-case Agent pilot

Eval data for the KSD engineering-proxy six-task pilot. These are NOT production tests:

- never imported by plugin code
- never run by `npm test`
- no orchestration framework, no provider calls, no npm install anywhere
- no network beyond the loopback-only server in `ui-small/`
- pure Node built-ins; POSIX assumed (realpath, no UNC)

Layout: `cases.json` is the manifest the pilot harness reads (`{ id, task, checks, rubric }` per case, `task` copied verbatim from each case's `task.txt`). Each case directory is self-contained: `task.txt` holds the literal task string shown to the Agent, plus the fixture sources it needs.

`checks/` scripts inside the fixture dirs are harness-only: the pilot runs them AFTER the Agent exits, and the task's answer text never reveals them. They are the independent verification surface; the Agent must not grade itself with them.

Broken fixtures ship deliberately wrong code and must fail their own `checks/` scripts as shipped:

- `ui-small/`: button text/aria-label are `Save`, not `Save draft` — http-check fails.
- `readable-flow/`: results are correct but nesting and missing blank-line-before-return remain — the style gate fails (result assertions alone would pass).
- `auth-tenant/`: `canRead` ignores record ownership and unauthenticated actors — can-read-checks fails.
- `payment-replay/`: handler grants on `pending`, ignores the signature, and re-grants duplicates — checks fail.
- `db-rls-missing-env/`, `ci-and-failure/`: review-only tasks; no self-check pass/fail claim is expected.

Run recipes the pilot harness uses (not the Agent's):

- `ui-small`: `node ui-small/server.mjs`, read `UI-SMALL_PORT=<port>`, then `node ui-small/checks/http-check.mjs http://127.0.0.1:<port>` plus real browser DOM inspection.
- `readable-flow`: `node readable-flow/checks/checks.mjs`.
- `auth-tenant`: `node auth-tenant/checks/can-read-checks.mjs`.
- `payment-replay`: `node payment-replay/checks/checks.mjs`.
- `db-rls-missing-env`: `node db-rls-missing-env/checks/integration-check.mjs` (exits 0 reporting 0 tests executed, 0 skipped, TEST_DATABASE_URL absent) and `node --test db-rls-missing-env/unit.test.js`.
- `ci-and-failure`: copy the directory to an isolated temp repo, run `./setup.sh` (refuses to run inside an existing git work tree), record the printed baseline sha, then `sh checks/run-tests.sh` (fails deliberately). `ci-record.json` names a stale head_sha that never matches the fixture-shaped repo.

Fixture sizes are small: each directory is a handful of files, runnable in isolation with no dependencies, so the pilot's temp copies stay cheap.
