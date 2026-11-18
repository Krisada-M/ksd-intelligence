# Review guidance

Read by automated reviewers. The authoritative rules are `AGENTS.md`, `docs/DESIGN.md` and `docs/RISK.md`.

This library tells coding agents what a change affects. The worst defect is an answer that looks safe and is not. Rank findings in this order:

1. **A wrong `low` or `complete`:** a completeness gap stored but not applied, a stale or failed index answered as fresh, an exception turned into an empty result, a missing index read as "no callers", a changed file left out of `ei_changes`.
2. **Incremental index differs from a cold build**, or a query creates a TypeScript program.
3. **Safety:** network use outside `ei setup`; reading files the secret rule excludes; source text, tokens or home paths in the audit log or cache beyond what `docs/RISK.md` §5–§6 allow; shell strings built from input.
4. **A test that cannot fail**, or one weakened, skipped or deleted.
5. Tool text that differs from `docs/TOOLS.md`, or more than one level word in a result.

Do not comment on formatting (Prettier and ESLint run in CI) or on `dist/` (generated). Changes to `tests/golden/**`, `src/policy/**`, `tests/policy/**` and `tests/snapshots/**` are checked by the `Owner approval` workflow; flag them only if the pull request description does not explain them.
