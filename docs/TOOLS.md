# ksd-intelligence — Agent Tool Contract

> **Status:** in force, 2026-11-11 (D27, D28, D32, D35). Specifies the tools the OMP agent calls: when, with what input, and exactly what text comes back. `docs/DESIGN.md` §7 defines the typed results; this document defines the agent-facing surface on top of them.

---

## 1. Design rules

Derived from this project's principles and from what a reference project measured about agent behaviour (`docs/research/index-techniques.md`).

1. **Few tools, one moment each.** An agent under-picks from a long list. The surface is four tools, plus `ei_search` from M6a, each tied to a moment the agent already recognises.
2. **Accept the input the agent already has.** A name as it appears in code, `Class.method`, a file path, `path:line`. Never require an internal ID to get started.
3. **One verdict line first, then reach, evidence, gaps, next step.** The first two lines must be enough to act on. There is exactly one level on the page.
4. **Sufficient in one call.** Every caller comes with `path:line`. Batch input avoids a call per symbol.
5. **Bounded output.** Each tool has a character budget. Overflow is summarised with counts and the exact call that reveals more. Never truncate silently.
6. **Guidance, not errors, for expected conditions.** Ambiguous name, name not found, an index build that outlasts the wait: success-shaped responses that say what to do next. `isError` is for malfunctions and trust failures only (DESIGN §7.9).
7. **Never claim more than the evidence.** The words describe the picture ("complete", "partial") and the reach; nothing on the page says "safe".
8. **Read-only.** All tools register with `approval: 'read'`.
9. **Deterministic.** Same index and input → byte-identical text (stable ordering: depth, then path, then line).
10. **One footer line** on every result: index state, file count, TypeScript and engine versions.

## 2. Tool set

| Tool | Moment | Input | Milestone |
|---|---|---|---|
| `ei_workflow` | Starting a stage of work | `task, stage, type?, risk?` | Done (M0/M1) |
| `ei_status` | A result looks wrong, stale or empty | none | M2a |
| `ei_impact` | About to change one or more symbols | `targets[], depth?` | M2b |
| `ei_changes` | Finished changing; before reporting done | none required | M2c |
| `ei_search` | Looking for where something is implemented | `query, limit?` | M6a |

**Not tools** (CLI only, for the owner): `ei index`, `ei symbol`, `ei doctor`, `ei audit`, `ei sources check`, `ei cache …`, `ei embeddings …`.

- Symbol lookup is folded into `ei_impact`: an ambiguous or unknown name returns the candidates.
- Indexing is automatic on first query and explicit for the owner via `ei index`. The agent never decides to index.

**Planned (V2, each behind its gate in DESIGN §13):** `ei_context` (built on `ei_search`), `ei_verify`, `ei_learning`, `ei_gitlab`, `ei_retrieve`. Each must pass rules 1–2 first; a capability that can ride on an existing tool's output does that instead.

## 3. `ei_workflow`

**Description (registered text):**
> Get the engineering skill to follow for a task at a given stage (plan, investigate, implement, verify, review, ship). Call once when you start each stage. Pass `type` (bug, feature, refactor, security, performance, ui) when you know it, especially for non-English tasks. Returns instructions only; it never edits, merges or deploys.

**Input:** `task: string` · `stage: enum` · `type?: enum` · `risk?: 'normal' | 'high'`

**Output:** precedence header, then type and `classifiedBy`, then each skill with provenance and hash status, then the skill text. From M2c the header adds one line per stage naming the evidence to gather (`ei_impact` before changing a symbol; `ei_changes` before reporting done).

## 4. `ei_impact`

**Description (registered text):**
> Before you change a function, method, class, type or exported constant, call this to see what depends on it: callers by depth with file:line, how far the change reaches, the tests that reach it, and whether the picture is complete. Accepts up to 5 targets as names (`calculateFee`, `PaymentService.charge`), `path#name`, `path:line`, or a file path. Read-only.

**Input**

| Field | Type | Notes |
|---|---|---|
| `targets` | `string[]`, 1–5 | Each: bare name · qualified `Class.member` · `path#name` · `path:line` (the indexed declaration enclosing that line) · `path` (exported declarations of the file that have callers outside it, plus a count of the rest) |
| `depth` | integer 1–10, default 2 | How many levels to **list**. Completeness, reach and the verdict always use the full traversal |

**Output, one block per target (budget: 4,000 characters per target, 12,000 in total)**

```text
IMPACT calculateFee — packages/payments/src/fee.ts:12
ACTION run-tests · level medium · picture complete
REACH 4 direct · 6 total · 5 files · 3 packages · 1 route · factors: public-export-surface, route, cross-package

Callers, depth 1 (4)
  packages/payments/src/service.ts:8          PaymentService.charge   CALLS
  packages/payments/src/checkout-flow.ts:14   lazyFee                 CALLS
  packages/api/src/charge.ts:14               chargeHandler           CALLS
  apps/web/src/checkout.ts:6                  submit                  CALLS
Depth 2 (2)
  packages/api/src/routes.ts:3                routes.POST /charge     REFERENCES  route
  packages/api/src/handlers.ts:9              registry.charge         REFERENCES
Tests (1)
  packages/payments/src/fee.test.ts
Gaps: none
Next: after your change, run the test above; call ei_changes before you report done.
— index fresh · 1,204 files · ts 5.9.2 · engine 0.3.0
```

Rules for the block:

- Line 1: resolved target and declaration location. If the input was a line inside a local function, line 1 adds `(nearest indexed declaration enclosing line N)`.
- Line 2, **the only verdict**: action, level, and the state of the picture. With a risk zone: `ACTION run-tests · level high (zone payments) · picture complete`. Incomplete: `ACTION check-gaps · level unknown · picture partial (2 gaps)`.
- Line 3: reach and factors. Reach counts compiler-grade edges only.
- Callers: grouped by depth; each row is `path:line`, enclosing symbol, edge kind, then markers (`route`, `heuristic`, `boundary:sql`).
- From M4b, `Possible (heuristic)`: bridged edges (DESIGN §6.9) in their own section after compiler-grade callers, each naming the bridge and what matched, for example `apps/web/src/api.ts:22  postCharge  REQUESTS  via B3 POST /charge`. They never count toward reach, and a gap they relate to still appears under `Gaps`, annotated `bridged: n candidates`.
- Over budget: keep depth 1 complete as far as possible, then summarise: `Depth 3: 41 more in 12 files. Call again with depth 3 and a single target to list them.`
- `Gaps:` lists each completeness reason as `code path:line — what to check`, for example
  `dynamic-import packages/api/src/handlers.ts:12 — computed path; check whether it can load this file`.
- `Next:` is one sentence and names only what follows from the result. It never tells the agent to grep or re-read what the block already shows.

**Guidance responses (success-shaped)**

```text
AMBIGUOUS charge — 4 declarations. Call again with one of:
  packages/payments/src/service.ts#PaymentService.charge
  packages/payments/src/stripe.ts#StripeProcessor.charge
  packages/payments/src/manual.ts#ManualProcessor.charge
  packages/payments/src/processor.ts#PaymentProcessor.charge
```

```text
NOT FOUND calcFee. Closest names in the index:
  packages/payments/src/fee.ts#calculateFee
  packages/payments/src/fee.ts#Fee
If the symbol is new and unsaved, save the file and call again.
```

```text
INDEX BUILDING — 9,400 of 31,000 files (30%) after 60 s. Call again; the answer will use the finished index.
```

In a batch, each target gets its own block; one ambiguous target does not block the others.

**First call in a repository:** the call blocks while the index is built (typically seconds to tens of seconds), streaming progress lines through the tool's update callback, and then returns the real answer. `INDEX BUILDING` appears only if the build outlasts 60 s.

## 5. `ei_changes`

**Description (registered text):**
> After you have edited code and before you report the work as done, call this with no arguments. It reads your uncommitted changes, lists which symbols changed, what they affect, which tests to run, and any changed files it cannot analyse. Read-only.

**Input**

| Field | Type | Notes |
|---|---|---|
| `base` | string, optional | Git ref to compare against. Default: merge-base with the default branch, plus all uncommitted and untracked changes |
| `depth` | integer 1–10, default 1 | Levels of callers to list |

**Output (budget: 8,000 characters)**

```text
CHANGES vs main (merge-base 3f2a91c) — 4 files, 3 symbols
ACTION ask-owner · level critical (zones migrations, payments) · picture partial (1 gap)
REACH 5 direct · 9 total · 6 files · 3 packages · 1 route · factors: public-export-surface, cross-package, boundary:sql

Signature changed, still called (1)
  calculateFee  packages/payments/src/fee.ts:12
    packages/api/src/charge.ts:14        chargeHandler   CALLS
    apps/web/src/checkout.ts:6           submit          CALLS
Modified (2)
  roundMoney            packages/shared/src/money.ts:3     3 callers
  PaymentService.charge packages/payments/src/service.ts:8 1 caller
Not analysed (1)
  packages/api/migrations/004_add_fee_column.sql — schema change; effects on queries are not analysed
Tests to run (2)
  packages/payments/src/fee.test.ts
  packages/api/src/charge.test.ts
Gaps: outside-index-scope packages/api/migrations/004_add_fee_column.sql
Next: include this verdict and the "Not analysed" list in your report; ask the owner before proceeding.
— index fresh (full hash) · 1,204 files · ts 5.9.2 · engine 0.3.0
```

Rules:

- Section order is fixed: removed or signature-changed symbols that still have callers come first.
- Every changed file appears either under a symbol or under `Not analysed`.
- No changes: `CHANGES vs main — nothing changed in the working tree.` (success-shaped).
- Always uses a full content hash, never the stat probe.

## 6. `ei_status`

**Description (registered text):**
> Shows whether the code index is ready and how much of the repository it covers. Call this if an ei_ result looks empty, stale or wrong.

**Input:** none.

**Output (budget: 3,000 characters)**

```text
STATUS ready
Index       published 2026-11-11 08:40 · fresh · last build 9.4 s (scan 0.3 · extract 2.1 · resolve 6.6 · verify 0.4)
Coverage    1,204 scanned · 1,150 indexed · 12 orphan (no tsconfig) · 42 other kinds
Problems    2 files failed to parse · 31 unresolved imports · dependencies installed: yes · incompleteReasons: none
Gap sites   dynamic-import 4 · computed-member-access 9 · interface-dispatch 17
Skills      15/15 pinned and matching
Config      ei.config.json ok · zones: payments, auth, migrations, prod-config
Versions    engine 0.3.0 · typescript 5.9.2 (bundled) · OMP 18.18.2 (last verified 18.18.2)
```

States: `ready · building (n of m) · degraded (reason) · disabled (EI_DISABLED)`. A degraded state names the reason and the one owner action that fixes it (for example `run: ei index --full`).

## 7. `ei_search` (M6a lexical, M6b semantic)

**Description (registered text):**
> Find where something is implemented when you do not know the symbol name. Give a few words or identifiers ("retry payment webhook", "session cookie parse"). Returns ranked declarations with file:line. For a symbol you can already name, call ei_impact directly.

**Input:** `query: string` · `limit?: integer 1–20, default 8`

**Output (budget: 4,000 characters)**

```text
SEARCH "retry payment webhook" — 8 of 23 matches
  exact     packages/payments/src/webhook.ts:41      retryWebhook()            exported
  lexical   packages/payments/src/retry.ts:7         retry(attempts, fn)       exported · 6 callers
  lexical   packages/api/src/hooks/payment.ts:12     handlePaymentWebhook()    route POST /hooks/payment
  semantic  packages/payments/src/backoff.ts:3       scheduleNextAttempt()     2 callers
  …
Next: call ei_impact with the symbol you intend to change.
— index fresh · search: lexical + semantic (model installed) · 1,204 files · engine 0.6.0
```

Rules:

- Each hit: match kind, `path:line`, signature, then at most two facts (exported, caller count, route).
- Match kinds are literal: `exact` (name equals a query term), `lexical` (full-text), `semantic` (embedding similarity, M6b). Semantic hits come after exact and lexical ones of similar score and are never presented as evidence about behaviour.
- No embedding model installed: the footer says `search: lexical only`. The agent is never told to install anything.
- No matches: success-shaped `SEARCH "<query>" — no matches. Try identifiers that would appear in the code.`

## 8. Shared behaviour

| Situation | Response |
|---|---|
| No index yet | Build in the worker; the call blocks up to 60 s with streamed progress, then answers; beyond that, `INDEX BUILDING` guidance |
| Probe finds drift, this session holds the build lock | Update first (blocks up to 60 s with progress), then answer; footer says `index updated (3 files)`. If the update is still running at 60 s, answer from the published index as `picture partial (stale index)`; the update continues (D52) |
| Probe finds drift, another session holds the lock | Wait within the call's budget for it to publish; otherwise answer from the published index with `STALE INDEX` |
| Update failed, older index exists | Answer from it; line 2 becomes `ACTION check-gaps · level unknown · picture partial (stale index)`, with the drifted files under `Gaps` |
| Engine malfunction or timeout | `isError: true`, `index-failed: <message>. Retry once; if it fails again, continue without ei_impact and say so in your report.` |
| `EI_DISABLED=1` | No tools are registered |
| Target in an excluded or secret path | Guidance: `NOT INDEXED <path> — excluded by configuration` |

`details` on every result carries the typed object from DESIGN §7 (`ImpactResult[]`, `ChangesResult`, status, search hits), so tests and future UIs never parse the text.

## 9. Helping the agent choose the tools

Tool descriptions are a weak signal on their own. Two stronger, honest channels:

1. **`ei_workflow` output** reaches the agent at the start of each stage and carries the stage-protocol line (M2c).
2. **The project's own `AGENTS.md`** (in each repo the owner works on, not in this library). Suggested block for the owner to paste:

```markdown
## Code impact tools (ksd-intelligence)
- Before changing a function, method, class or exported value: call `ei_impact` with its name.
- Before saying a change is done: call `ei_changes` (no arguments) and include its verdict.
- If the picture is `partial`, check the listed gap sites before relying on the caller list.
```

The library never writes to a project's `AGENTS.md` itself.

## 10. How this contract is tested

| Layer | Check |
|---|---|
| Rendering | Snapshot tests of the text for golden cases C01, C06, C11, C13, C14, C15, C26, a batch of 3, and an over-budget case. Snapshots are reviewed by the owner like golden expectations; the agent may not update them to make a test pass |
| Budgets | Property test: no output exceeds its budget; every overflow line names the follow-up call |
| Determinism | Same input twice → identical bytes |
| One verdict | No rendered block contains more than one level word outside the `ACTION` line |
| Guidance shape | Ambiguous, not found and index-building results have no `isError` |
| Live | OMP scenarios per tool: the agent can discover it, call it with a bare name, see streamed progress on a first call, and act on the first two lines |
| Dogfood | From the audit log: calls per session, share of edited symbols that had a prior `ei_impact`, and whether the agent keeps calling after a guidance or error response |

## 11. Open questions

1. Is 4,000 characters per target the right budget? Recalibrate from the dogfood log.
2. Should `ei_changes` accept a list of paths to limit scope? Left out to keep the zero-argument call the obvious one.
