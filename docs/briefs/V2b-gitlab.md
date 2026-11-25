> **DROPPED (D67, 2026-11-26).** The owner removed the GitLab adapter from V2. Kept for history; do not build from this brief.

# V2b — GitLab adapter, read-only, `ei_gitlab` (agent brief, DRAFT)

Start with Round 0 (`README.md`). Read `docs/briefs/V2-README.md`, then `docs/DESIGN.md` §6.8, §9, §12 and D16; `docs/RISK.md` §5, §6.

**Branch:** `v2b-gitlab` from `v1.0.0`.

## Goal

The agent can read the issue it is working on, the merge request it is reviewing (description, changed paths, diff) and the latest pipeline result, without the owner copying them by hand. Read-only. This is the first library code with network access.

## Round 0 additions

Besides the usual reconcile, record: the owner's GitLab host (gitlab.com or self-hosted), the API version it serves, the token scope available (`read_api` is required and sufficient), and one project the owner names for live tests. **Do not call the network in Round 0**; ask the owner for these values.

## Round 1 — client (`src/adapters/gitlab/`)

- `client.ts`: `fetch` with the configured `gitlab.host` only (reject any other origin, including redirects to another host), `PRIVATE-TOKEN` header from `process.env.GITLAB_TOKEN`, timeout 10 s, 3 retries with backoff on 429/5xx honouring `Retry-After`, response size cap 5 MB, pagination via `Link` / `x-next-page` with a page cap.
- Read calls only: issue (title, description, labels, state, linked MRs), merge request (title, description, source/target branch, changed paths, diff with a size cap, approvals state), pipeline (status, jobs with status and duration, failed job trace tail with a cap).
- Redaction: the token never appears in errors, logs, audit lines or results; job traces pass through the secret patterns before they are returned.
- No token, wrong host, 401/403/404, timeout, network off → `NOT_VERIFIED` with the reason (DESIGN §12); never cached as success.
- Tests against a local HTTP fixture server (no internet in tests): pagination, 429 with `Retry-After`, redirect to another host refused, oversize response cut and marked, token absent from every output and log line, trace redaction.
- Static check: a test fails if `fetch`, `http`, `https`, `net`, `tls`, `dns` or `undici` are imported anywhere in `src/` outside `src/adapters/gitlab/` (and the owner-run `ei setup` path, which keeps its existing exception).

## Round 2 — tool, CLI, use by V1 tools

- `ei_gitlab` with `kind: "issue" | "mr" | "pipeline"` and `ref` (number, `!12`, `#34`, or a URL on the configured host), `approval: 'read'`. Text: a compact block per kind; the diff is summarised as changed paths with line counts and is shown in full only when asked and under the budget.
- CLI `ei gitlab issue|mr|pipeline <ref> [--json]`.
- `ei_changes` gains an optional `mr` input: the base becomes the MR's target branch merge-base (fetched read-only through git if present locally; otherwise `NOT_VERIFIED` with the reason). No git write commands.
- Disabled by default; with `gitlab.enabled: false` no network code runs and V1 snapshots are unchanged.
- Audit lines record kind, ref and status, never content.

## Round 3 — live check and value check

- **Live**, on the owner's project, with the owner's token in the environment (the agent never prints it): one issue, one MR, one pipeline (passing) and one failed pipeline; paste the outputs with any personal or internal text the owner asks to hide removed. Label the OS.
- Value check: 3 tasks from real MRs, with and without the tool; report how much the owner had to paste by hand.

## Round 4 — review (different vendor), then fix

**Review focus:** any request to a host other than the configured one; token in any output, error, log or stack trace; a write method (`POST`, `PUT`, `PATCH`, `DELETE`) anywhere; unbounded reads; injection through `ref`; a failure reported as success; network code reachable while disabled.

## Do not

- Write anything to GitLab (comments, approvals, labels, pipeline retries).
- Store the token, or read it from anywhere but the environment.
- Add an HTTP client dependency.
