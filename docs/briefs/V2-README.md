# V2 — all five modules (owner override of the entry gates, D64)

The owner decided on 2026-11-25 to build every V2 module without waiting for the dogfood gates of DESIGN §13. This file sets the order, the rules that replace the gates, and the one-line prompts. The common rules, round types and contingencies of `docs/briefs/README.md` apply to every round.

```text
Read docs/briefs/README.md, docs/briefs/V2-README.md and docs/briefs/<brief>.md, then do Round <n>.
```

## Precondition

V1 `1.0.0` is closed first (`docs/briefs/V1-closeout.md`). Every V2 branch starts from the tagged `v1.0.0` main. Reason: V2 adds the first network code, the first writes into the repository and the first command execution; the release that the owner trusts today must exist as a fallback before any of that lands.

## Order

| # | Module | Brief | New tool | Writes / network / exec |
|---|---|---|---|---|
| V2a | Context packs | `V2a-context.md` | `ei_context` | none |
| V2c | Verification evidence | `V2c-verify.md` | `ei_verify` | **exec** (allowlisted repo scripts, OMP approval) |
| V2d | Anchored knowledge | `V2d-knowledge.md` | `ei_learning` | **writes** `.ksd/learnings/` (owner-approved only) |
| V2e | Recoverable compression | `V2e-compression.md` | `ei_retrieve` (+ hook, if OMP has one) | cache only |

This is the DESIGN §13 order without the GitLab adapter, which the owner dropped (D67). The four modules do not depend on each other and may run in parallel worktrees.

## What replaces the gates

The gates existed to stop building things that do not help. With them waived, each module instead:

1. Ships **disabled** (`"enabled": false` in `ei.config.json`); the owner turns it on per repository.
2. Has a **value check** in its last build round: a fixed set of tasks from `docs/dogfood-log.md` (or written for the module), run with the module off and on, with the difference reported in numbers. The owner reads it before turning the module on by default. A module that shows no benefit stays off; it is not deleted.
3. Leaves every V1 tool's text, golden case and snapshot unchanged when disabled. A test proves this per module.
4. Never makes a V1 answer more confident. Nothing a V2 module returns feeds completeness, reach, factors or a verdict.

## Safety rules that become live in V2

These are already in DESIGN §12 and RISK; V2 is where they start to matter.

- **Network:** none. V2 adds no network code; the owner-run `ei setup` stays the only exception. A test greps `src/` for network APIs and fails on any use outside the `ei setup` path.
- **Exec:** only `src/core/verify/**`, only commands from an allowlist the owner writes in `ei.config.json`, `execFile` without a shell, under OMP's approval for that call. No command text from the agent is ever executed.
- **Repository writes:** only `.ksd/learnings/*.yaml`, only through `ei learning approve` run by the owner. The agent can propose; it cannot write.
- **Secrets:** tokens, environment values and command output that matches secret patterns are redacted before anything is stored, logged or shown.
- `AGENTS.md` "Safety boundaries" and `REVIEW.md` get the V2 rules in Round 1 of the first module that needs them.

## Models

Strongest coding model available for build rounds; a different vendor for each review round. V2c adds attack surface (exec): its review round is not optional.

## After V2

`V2-closeout` is the same procedure as `V1-closeout.md` (claims against code, safety sweep, fresh install, upgrade rehearsal), released as `2.0.0`. The modules the value checks did not support stay shipped and disabled.
