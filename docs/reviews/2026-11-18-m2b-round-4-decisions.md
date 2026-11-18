# M2b round 4 — decisions and the final fix round

Design reviewer (Claude). The findings are in `2026-11-18-m2b-round-4-findings.md` (F1–F15 below = findings #1–#15 there). I spot-checked F2, F6 (code path), F7, F10 and F1 against `c3b94db`: the code is as described. The reviewer could not run anything; every finding must be reproduced by a failing test before it is fixed.

The reviewer is the same model that wrote rounds 3 and 5b, so this was not the cross-vendor review the brief asks for. The findings are concrete enough to act on; the fix round is written by a different model, and the automated Claude review runs on the pull request.

**Status of M2b:** not accepted. Six findings (F1–F6) and possibly F7 can produce a wrong `low`. One wrong `low` blocks.

## Decisions

| Finding | Decision |
|---|---|
| F1 broken or unresolved imports | An import binding whose module or export does not resolve is an `unresolved-import` record **keyed by the local name and by the imported name** (and `default` → the local name). Body uses of such a binding are recorded, not dropped. A target whose simple name equals either name gets the record (subject to `common-name`, D56). |
| F2 abstract and inherited members | Class `extends`: a member that overrides a base-class member (abstract or concrete) gets an `IMPLEMENTS` edge to it, as interface implementations do (ADR 0003 updated). The base member's `interface-dispatch` gap then reaches the override through the existing rule. |
| F3 union contextual types | `ownersOfType` and `tokensOf` look through unions (and `undefined`/`null` members) and treat each member as the top-level type would be treated. A union containing `string`, `any` or `unknown` can name a declaration. |
| F4 element access on nested or asserted literals | `elementAccess` uses the same unwrapping (`as`, `satisfies`, parentheses) and the same depth rule as `fileDeclarations`, including `PropertyAssignment` containers. |
| F5 prefixes | `staticPrefix` folds left-nested `+` chains and template heads; `require(x)` uses `staticPrefix`. A root-level prefix `./` scopes to the whole index scope, not to dotfiles. |
| F6 file targets | Never fabricated. Completeness, factors and the verdict for a `path` target are the union over **every declaration in the file** (exported or not, plus the module symbol), with P1 applied once. A file with no outside callers can be `low` only when that union is complete and has no factor. Stale and failure marking applies to file answers too. |
| F7 target resolution | Bare names: candidates are the union of `d.name` and `d.simple` matches; more than one → ambiguous. `path:line`: the innermost declaration (smallest span, then deepest key); a remaining tie → ambiguous. D51 fallback: an ambiguous parent returns ambiguous with the parent candidates. |
| F8 lexical scanner | Rescan a slash as a regex after every token that cannot end an expression (add the keywords and punctuators listed, and `}` at statement start). Add the reviewer's input as a test. |
| F9 probe vs D57 | The probe uses the same readability rule as the scan (`neverReadOf`): owner-excluded code files are hashed and drift-checked. |
| F10 level words | Never alter paths, names or keys. Remove `scrubLevelWords`. The one-verdict rule is enforced on template text: the renderer builds lines from a template plus identifier slots, and the test asserts that level words outside the `ACTION` line occur only inside identifier slots. |
| F11 file reach | Reach for a file target is computed over the union of impacted symbols (distinct), not summed or maxed; a caller is listed once, at its smallest depth. |
| F12 shared build | A shared build is cancelled only when every waiting call has aborted. `untilPublished` checks the lock holder on every poll; a released lock without a publish ends the wait at once with the stale answer. |
| F13 C08 test | Assert the overload caller in `byDepth[0]` for each of the three inputs. |
| F14 escaped literals | When a new simple name enters the index, also queue files containing a `\u` or `\x` escape inside a string or template literal. |
| F15 overflow text | The overflow line names the real depth it summarises and suggests a narrower call only when one exists. |

Carried from earlier reviews:

| Item | Decision |
|---|---|
| R8 latency (p95 1,173 ms on oh-my-pi, target 300 ms) | Load `unresolved`, `name_tokens` and `gap_sites` by name or file on demand with prepared statements; nothing is read whole per query. Report the split (probe, open, load, traverse, render) before and after. If still above 300 ms after this, stop and report; never trade correctness for speed. |
| `ei init --dry-run` label | `(would create)` / `(would overwrite)`. |
| This repository's `ei.config.json` | Add `tests/fixtures/**` to `exclude`. |
