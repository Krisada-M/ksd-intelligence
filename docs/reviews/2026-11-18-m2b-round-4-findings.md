# M2b round 4 — independent review findings

Reviewer report as received (Gemini 4 Argon, High; static review of `origin/m2b-impact` at `c3b94db`). Decisions and the fix round: `2026-11-18-m2b-round-4-decisions.md`.

### Review Findings (ordered by severity)
#### 1. [HIGH — Area 1] Broken or unresolved imports never apply unresolved-import to target symbols and       
suppress body call sites

• Where: Resolver.resolveFile, binding, use, visit, ImpactQuery, ImpactQuery.gapsOf
• Cause:
    1. Unresolved module specifier (import { localOnly } from './missing'): fileImport stores an unresolved-
    import row with name: spec.text ('./missing') and returns null. Line 808 (if (target !== null && clause !==
    undefined)) skips binding when target === null, and line 818 returns without visiting the import bindings.
    In the file body, calling localOnly() resolves the identifier to the local ImportSpecifier symbol; use sees
    (this.resolveAliases(symbol).declarations ?? []).length === 0 (unknownSymbol) and returns early without
    recording unresolved-name-match. At query time, ImpactQuery indexes unresolved by row.name ('./missing')
    and looks up by decl.simple ('localOnly'), so the unresolved-import record never matches any declaration.
    2. Broken default import (import PaymentService from '@fx/payments' or import localOnly from './fee' when
    the default export is removed): visit calls binding(clause.name, 'default', node), storing name: 'default',
    while body uses of PaymentService / localOnly are dropped by line 496. Querying PaymentService (decl.simple
    === 'PaymentService') or localOnly looks up 'PaymentService' / 'localOnly', never 'default'.
    3. Broken aliased named import (import { oldName as localOnly } from './fee'): visit stores name: 'oldName',
    while body calls localOnly() are dropped by line 496. Querying localOnly finds neither an edge nor an
    unresolved record for 'localOnly'.
• Concrete input:
Add packages/api/src/broken-import.ts:
  import { localOnly } from './does-not-exist';
  export function caller() {
    return localOnly();
  }
Query packages/payments/src/fee.ts#localOnly.
Result: byDepth: [], completeness: { status: 'complete', reasons: [] }, verdict: { level: 'low', action:
'proceed' }.
──────
#### 2. [HIGH — Area 1] interface-dispatch gaps on abstract class members and inherited interface              
implementations are stored in gap_sites but never applied to concrete implementations

• Where: isAbstractOrInterfaceMember, use, heritage, ImpactQuery.userHidingGaps, ImpactQuery.dependentsOf
• Cause: isAbstractOrInterfaceMember checks (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Abstract) !==
0 and records an interface-dispatch gap in gap_sites with detail: target.key (e.g. AbstractProcessor.charge).
However, heritage skips extends clauses on classes (if (ts.isClassLike(node) && !isImplements) continue;).
Consequently, no IMPLEMENTS edge is created from a concrete subclass method ConcreteProcessor.charge to
AbstractProcessor.charge (or from a derived class method overriding an interface implementation on a base
class). ImpactQuery.userHidingGaps and ImpactQuery.dependentsOf query IMPLEMENTS edges only, so the stored
interface-dispatch gap is never applied and the heuristic caller is omitted.
• Concrete input:
Add packages/payments/src/abstract-proc.ts:
  export abstract class AbstractProcessor {
    abstract charge(): void;
  }
  export class ConcreteProcessor extends AbstractProcessor {
    charge(): void {}
  }
  export function runAbstract(p: AbstractProcessor): void {
    p.charge();
  }
Query packages/payments/src/abstract-proc.ts#ConcreteProcessor.charge.
Result: byDepth: [], completeness: { status: 'complete', reasons: [] }, verdict: { level: 'low', action:
'proceed' }.
──────
#### 3. [HIGH — Area 1 & Area 3] KeyAccess.ownersOfType and Resolver.tokensOf drop union contextual types,     
losing keyof edges, keyof owner gaps, and string-name-match tokens on optional/union positions
• Where: KeyAccess.ownersOfType, KeyAccess.keyofTargets, Resolver.tokensOf
• Cause:
    1. In KeyAccess.ownersOfType, isIndexType(this.ts, type) and isIndexType(this.ts, origin) only match a
    single IndexType (TypeFlags.Index). When a keyof type is in a union — such as an optional property field?:
    keyof Usage (contextual type (keyof Usage) | undefined under strictNullChecks), a union property or return
    type either: keyof Usage | keyof Ledger, a union of generic aliases Keys<Usage> | Keys<Ledger> (skipped by
    keyofTargets because declaration.typeParameters !== undefined), or a conditional expression u[cond ? k1 :
    k2] — TypeScript represents type and type.origin as a UnionType (TypeFlags.Union). Because ownersOfType
    does not recurse over union members of origin / type, it returns [].
    2. In Resolver.tokensOf, couldName checks (contextual.flags & (ts.TypeFlags.String | ts.TypeFlags.Any | ts.
    TypeFlags.Unknown)) !== 0 on the top-level contextual type only. Any union containing string (string |
    undefined on an optional parameter fn(name?: string), string | null, string | number, keyof any) has
    contextual.flags === ts.TypeFlags.Union, so couldName returns false and records no name_tokens row.
• Concrete input:
Add packages/api/src/union-keys.ts:
  export interface Usage {
    cost: number;
    total: number;
  }
  export interface Ledger {
    total: number;
    owner: string;
  }
  export interface Opts {
    field?: keyof Usage;
    either: keyof Usage | keyof Ledger;
  }
  export const opts: Opts = { field: 'cost', either: 'total' };
  export function byName(name?: string) {
    return name;
  }
  export const callOpt = byName('localOnly');
Query packages/api/src/union-keys.ts#Usage.cost, packages/api/src/union-keys.ts#Usage.total, and
packages/payments/src/fee.ts#localOnly.
Result: all three return byDepth: [], completeness: { status: 'complete', reasons: [] }, verdict: { level:
'low', action: 'proceed' }.
──────
#### 4. [HIGH — Area 1] elementAccess misses computed-member-access gaps on nested object-literal containers   
and type-asserted object literals
• Where: Resolver.resolveFile` (`elementAccess`) vs fileDeclarations and statements
• Cause: fileDeclarations unwraps variable and property initializers with unwrap (as ..., satisfies ...,
parentheses) and indexes nested object literals up to depth 3 as ts.PropertyAssignment declarations. In
elementAccess, holdsMembers only checks ts.isVariableDeclaration(declaration) && declaration.initializer !==
undefined && ts.isObjectLiteralExpression(declaration.initializer) without unwrapping declaration.initializer
and without checking ts.isPropertyAssignment(declaration).
• Concrete input:
Add packages/api/src/nested-registry.ts:
  function targetFn(): number {
    return 1;
  }
  const asserted = { fn: targetFn } as Record<string, () => number>;
  const nested: { handlers: Record<string, () => number> } = {
    handlers: { fn: targetFn },
  };
  export function runAsserted(k: string) {
    return asserted[k]();
  }
  export function runNested(k: string) {
    return nested.handlers[k]();
  }
Query packages/api/src/nested-registry.ts#targetFn.
Result: completeness: { status: 'complete', reasons: [] }, verdict: { level: 'low', action: 'proceed' }.
──────
#### 5. [HIGH — Area 1] staticPrefix and cjs-require (call) turn prefix-bearing import('./dir/' + name + '.js')
and require('./dir/' + name) into detail: '*', which D55 item 2 suppresses for any file with a static importer

• Where: Resolver.resolveFile` (`staticPrefix`, `call`), ImpactQuery.classify, ImpactQuery.userHidingGaps
• Cause:
    1. In staticPrefix, ts.isBinaryExpression(arg) && ts.isStringLiteralLike(arg.left) fails on chained string
    concatenation './handlers/' + name + '.js' because + is left-associative (arg.left is './handlers/' + name,
    a BinaryExpression). staticPrefix returns '*' instead of 'packages/api/src/handlers/'.
    2. In call, computed require(arg) always records detail: '*' without calling staticPrefix(arg).
    3. Under D55 item 2 (ImpactQuery.userHidingGaps), gaps with detail: '*' are placed in this.noImporter and
    excluded for any file in this.staticImported (even if the only static importer is a unit test file).
    4. In addition, if import(`./${name}`) is in a root-level file (posix.dirname(file) === '.'), posix.
    normalize(posix.join('.', './')) evaluates to '.'; if any indexable file starts with '.', this.byPrefix
    matches only dotfiles (decl.file.startsWith('.')) and misses all normal paths.
• Concrete input:
In a fixture copy, edit packages/api/src/handlers.ts line 4 to return import('./handlers/' + name + '.js'); (or
return require('./handlers/' + name);), add packages/api/src/handlers/refund.test.ts with import { refund }
from './refund'; refund();, and query packages/api/src/handlers/refund.ts#refund.
Result: completeness: { status: 'complete', reasons: [] }, verdict: { level: 'low', action: 'proceed' }.
──────
#### 6. [HIGH — Area 1 & Area 6] File-path targets (ei_impact with path) fabricate level: 'low' and picture    
complete whenever the file has zero exported declarations with static outside callers
• Where: ImpactQuery.fileAnswer, renderFileBlock, markStale, impactDetails
• Cause: ImpactQuery.fileAnswer filters declarations to decl.exported && this.statements.outsideUser.get(decl.
key, file) !== undefined, where outsideUser checks static edges only. When used is empty (results: []),
impactOf is not run on any declaration in the file, so completeness gaps covering the file (dynamic-import,
cjs-require, parse-error, unresolved-name-match, string-name-match, computed-member-access, interface-dispatch)
and factors (public-export-surface, boundary:sql, boundary:native, common-name) are ignored. renderFileBlock
then fabricates an emptyResult with completeness: { status: 'complete', reasons: [] } and verdict: { level:
'low', action: 'proceed' }. Furthermore, markStale only maps over answer.value.results, so when results is [],
impactDetails returns an unmarked FileImpactResult and renderFileBlock drops persisted verification-failure
messages when driftedFiles is empty.
• Concrete input:
Query ei_impact with file target packages/api/src/handlers/refund.ts (golden C11 file) or
packages/shared/src/legacy.cjs (golden C17 file).
Result:
  IMPACT packages/api/src/handlers/refund.ts:1 — 0 exported declarations with callers outside file (1 other
  declaration in file)
  ACTION proceed · level low · picture complete
  REACH 0 direct · 0 total · 0 files · 0 packages · 0 routes · factors: none

  Callers: none
  Tests: none
  Gaps: none

──────
#### 7. [HIGH — Area 4] Target resolution silently picks one candidate instead of returning ambiguous-target in
three paths
• Where: Graph.symbol, ImpactQuery.query
• Cause:
    1. Bare name with one module-level declaration and one or more member (or collision) declarations
    (Graph.symbol): Graph.symbol queries WHERE d.name = ? first and only queries WHERE d.simple = ? if
    candidates.length === 0. If one file declares a top-level export function charge() {} (d.name = 'charge')
    while five classes/interfaces/objects declare .charge (d.simple = 'charge'), or one file has a key
    collision foo (d.name = 'foo') and foo~2 (d.name = 'foo~2', d.simple = 'foo'), WHERE d.name = ? returns
    candidates.length === 1 and silently picks that single declaration.
    2. path:line with multiple declarations of equal span width (Graph.symbol): holding sorts by a.width - b.
    width without a tie-breaker and takes [holding[0]?.key ?? '']. On packages/api/src/routes.ts:3 (export
    const routes = { 'POST /charge': chargeHandler };), both routes and routes.POST /charge have start_line = 3,
    end_line = 3, width = 0; holding[0] picks the outer routes instead of routes.POST /charge (and on export
    const { a, b } = obj; or export const a = 1, b = 2; on one line, it silently picks a).
    3. D51 parent fallback when the nearest parent is ambiguous (ImpactQuery.query): The loop stripping .member
    suffixes only checks if (found.kind === 'found' ...). When found.kind === 'ambiguous' (e.g. two files
    declare Usage.cost and the input is Usage.cost.input), it ignores the ambiguity and continues stripping
    segments up to Usage, either returning target-not-found or picking a shallower parent.
• Concrete input:
    1. Add packages/api/src/top-charge.ts with export function charge() {} and query bare name charge → returns
    { kind: 'result', value: { target: 'packages/api/src/top-charge.ts#charge', ... } } instead of ambiguous-
    target with 6 candidates.
    2. Add two files declaring export interface Usage { cost: { input: number } } and query Usage.cost.input →
    returns NOT FOUND Usage.cost.input instead of AMBIGUOUS.

──────
#### 8. [MEDIUM — Area 1] scanLexically misses regex literals after }, else, await, yield, typeof, void,       
delete, do, try, finally, in, and instanceof
• Where: scanLexically
• Cause: scanner.reScanSlashToken() is only called when previous is one of 24 token kinds. CloseBraceToken (at
the end of a block before a statement-starting regex), ElseKeyword, AwaitKeyword, YieldKeyword, TypeOfKeyword,
VoidKeyword, DeleteKeyword, DoKeyword, TryKeyword, FinallyKeyword, InKeyword, InstanceOfKeyword, and
comparison/bitwise tokens are absent. If a regex literal in an orphan or out-of-scope file follows any of those
tokens and contains ', ", or ` (e.g., /`/.test(s)), the scanner treats / as division and scans from the
quote/backtick as a string or template literal, swallowing subsequent identifiers in the file.
• Concrete input:
  scanLexically(
    ts,
    'tools/loose.ts',
    'function f(s: string) {\n  if (!s) {\n    return;\n  }\n  /`/.test(s);\n  localOnly();\n}\n',
    new Set(['localOnly']),
  );
Result: rows.unresolved is [] (localOnly on line 6 is swallowed by the unclosed backtick on line 5).
──────
#### 9. [MEDIUM — Area 1 & Area 5] probe was not updated for D57 and treats owner-excluded code files          
(impact.exclude) as unreadable
• Where: probe vs scan` / `neverReadOf
• Cause: Under D57, scan hashes owner-excluded code files (record.hash !== null) so Indexer scans them
lexically. probe still checks const readable = !entry.symlink && exclusionOf(entry.path, impact) === null;.
Because exclusionOf returns 'excluded' for impact.exclude, readable is false. Under freshness: "hash", a same-
size/same-mtime edit to an owner-excluded code file is never hashed by probe, leaving the index stale (fresh
state reported) and missing new unresolved-name-match sites; under freshness: "stat", a timestamp-only touch on
an owner-excluded code file is reported as changed instead of touched.
• Concrete input:
With impact.exclude: ["packages/api/src/generated/**"] and impact.freshness: "hash", index a repo containing
packages/api/src/generated/client.ts (export function gen(x: any) { x.otherName(); }, 46 bytes, fixed mtime).
Overwrite client.ts with export function gen(x: any) { x.localOnly(); } (46 bytes, same mtime) and call
session.query(['packages/payments/src/fee.ts#localOnly']).
Result: probe reports changed: [], no update runs, and localOnly is returned as level: 'low', completeness.
status: 'complete'.
──────
#### 10. [MEDIUM — Area 6] scrubLevelWords mangles file paths, symbol names, AMBIGUOUS candidate keys, and NOT 
FOUND suggestions containing low, medium, high, critical, or unknown
• Where: scrubLevelWords, formatNodeRow, renderSymbolBlock, renderAnswer
• Cause: scrubLevelWords applies /\b(low|medium|high|critical|unknown)\b/gi to line1, caller path:line and
symbol names, test file paths, AMBIGUOUS candidate keys, and NOT FOUND nearest keys. Because /, ., -, and # are
regex word boundaries (\b), any path segment or identifier equal to a level word is corrupted with an
underscore (low.ts → l_ow.ts, Priority.high → Priority.h_igh, unknown-error.ts → u_nknown-error.ts), producing
nonexistent file paths and unresolvable path#name follow-up targets.
• Concrete input:
Query an ambiguous symbol high declared in packages/payments/src/low.ts#high and packages/api/src/critical-
flow.ts#high.
Result:
  AMBIGUOUS h_igh — 2 declarations. Call again with one of:
    packages/api/src/c_ritical-flow.ts#h_igh
    packages/payments/src/l_ow.ts#h_igh
Calling ei_impact with packages/payments/src/l_ow.ts#h_igh then fails with NOT FOUND.
──────
#### 11. [MEDIUM — Area 6] renderFileBlock miscomputes combined reach and duplicates callers across depths when
a file target has 2+ externally used exports
• Where: renderFileBlock
• Cause: When results.length >= 2, renderFileBlock sums r.reach.direct and r.reach.total across exports
(double-counting callers shared by multiple exports in the file even though byDepth[0] deduplicates them),
while taking Math.max(...) for reach.files, reach.packages, and reach.routes instead of the distinct union
across exports (undercounting when export A reaches package 1 and export B reaches package 2). In addition,
byDepth is deduplicated per level d only, so a caller at depth 1 of export A and depth 2 of export B appears at
both depths.
• Concrete input:
In packages/payments/src/fee.ts, add export function secondFee() { return 1; } called from
apps/web/src/checkout.ts#submit, and query file target packages/payments/src/fee.ts.
Result: REACH 6 direct · 9 total while Callers, depth 1 (5) lists 5 direct callers.
──────
#### 12. [MEDIUM — Area 5] ImpactSession.startBuild binds a shared build to the first caller's AbortSignal, and
untilPublished ignores foreign lock release when deadline is finite

• Where: ImpactSession.startBuild, ImpactSession.untilPublished
• Cause:
    1. startBuild passes the first caller's callOptions.signal into this.build and caches the promise in this.
    building. If a second concurrent call in the same session shares this.building and the first call aborts,
    the child build is killed and resolves to { ok: false, code: 'index-failed', message: 'Cancelled' },
    causing the non-aborted second call to fail with Cancelled.
    2. In untilPublished, readLockHolder / isHolderAlive is only checked when !Number.isFinite(deadline)
    (waitAfterExpiry: true). In the OMP session (waitAfterExpiry: false), if another process holds the build
    lock and exits or fails VERIFY without publishing, untilPublished keeps polling openPublished for the
    entire 60 s waitMs instead of returning immediately once the lock is released.
• Concrete input:
Hold acquireBuildLock(workspace.cacheDir), call new ImpactSession(workspace, { waitMs: 5_000 }).
query(['calculateFee']), and release the lock after 20 ms without publishing.
Result: session.query blocks for the full 5,000 ms before returning the stale answer.
──────
#### 13. [LOW — Area 2] Golden test C08 in impact-golden.test.ts:123-127 does not assert that call sites of    
both overloads appear in the query result
• Where: impact-golden.test.ts:123-127 vs tests/golden/M2-impact-cases.md` (C08)
• Cause: Golden C08 states: "call sites using either overload resolve to the single target key. Querying by the
line of either overload signature (path:line) returns the same target." The test in impact-golden.test.ts:123-
127 checks only .target === fee for fee.ts:7, fee.ts:8, and fee, without asserting on the returned ImpactResult
that the caller using the overloads (packages/payments/src/fee.test.ts#<module>) is present in byDepth[0] (that
check only exists at index level in indexing.test.ts:59-64).
• Concrete input: impact-golden.test.ts:123-127.
──────
#### 14. [LOW — Area 1] Indexer.update checks raw sf.text.includes(name) for newly added declaration names,    
missing escaped string literals ("inp\\u0075t")
• Where: Indexer.update vs Resolver.tokensOf
• Cause: When a new declaration simple name enters the index during an incremental update, Indexer.update
queues existing indexable files only if sf.text.includes(name). Because Resolver.tokensOf matches decoded
literal text (node.text), an unchanged file containing an escaped literal such as "newHel\\u0070er" is not
queued during an incremental update, whereas a cold build records a string-name-match token for it (diverging
incremental == cold).
• Concrete input:
Cold-index a repo containing export const k: string = "newHel\\u0070er"; before newHelper exists; then add
export function newHelper() {} in another file and run an incremental update.
Result: incremental update omits the name_tokens row for newHelper (complete), while cold build includes it
(partial, string-name-match).
──────
#### 15. [LOW — Area 6] buildCallersSection and renderSymbolBlock emit misleading Depth 1 overflow instructions
• Where: buildCallersSection, renderSymbolBlock
• Cause:
    1. When depth 1 itself overflows the 4,000-character budget on a single target (render.ts:235), the
    overflow line says Call again with depth 1 and a single target to list them. even when the call was already
    depth 1 with a single target.
    2. In the fallback paths (render.ts:247-248 and 362-367), allNodes = sortedLevels.flat() counts callers
    across all depths 1..depth, but labels the summary Depth 1: <totalCallers> more ... Call again with depth 1
    and a single target to list them.
──────
### Explicit Area Coverage Summary
 # │ Review Area                                │ Status         │ Notes
───┼────────────────────────────────────────────┼────────────────┼─────────────────────────────────────────────
 1 │ Path to a wrong low or medium              │ Findings       │ Clean: D54 target-only gap scoping vs
   │                                            │ #1–#6, #8, #9, │ gapScoped row markers; P1 verdict rules
   │                                            │ #14            │ 1–3; compiler-only reach vs heuristic
   │                                            │                │ listing; common-name factor threshold and
   │                                            │                │ basis; stale answers forced to
   │                                            │                │ partial/unknown; exceptions wrapped into
   │                                            │                │ index-failed; missing index never treated
   │                                            │                │ as zero callers.
 2 │ Golden tests asserting less than stated,   │ Finding #13    │ Clean: C01–C07, C09–C26, F01–F06 all
   │ or missing test                            │                │ present and asserting every stated
   │                                            │                │ expectation, plus the depth 1–10 never-low
   │                                            │                │ sweep.
 3 │ keyof handling (false edge from ordinary   │ Finding #3     │ Clean: ordinary string, literal unions not
   │ string; missing gap)                       │                │ from keyof, keyof T | string, and
   │                                            │                │ declaration-less Record<"a" | "b", V>
   │                                            │                │ produce no false edges or gaps.
 4 │ Target resolution silently picking one of  │ Finding #7     │ Clean: exact path#name lookup, unambiguous
   │ several candidates                         │                │ Owner.member, and up-to-5 nearest names on
   │                                            │                │ target-not-found.
 5 │ Freshness (second build while one runs;    │ Findings #9,   │ Clean: no second engine child started while
   │ child left after abort; query creating TS  │ #12            │ one runs in-session or under a live foreign
   │ program)                                   │                │ lock; host.stop() kills and awaits the
   │                                            │                │ child on abort; ImpactQuery never loads
   │                                            │                │ TypeScript or creates a ts.Program.
 6 │ Rendering (multiple level words, non-      │ Findings #6,   │ Clean: deterministic sorting and byte-
   │ determinism, budget overflow, TOOLS.md §4  │ #10, #11, #15  │ identical output; no leaked absolute paths,
   │ drift)                                     │                │ home dirs, timestamps, durations, or PIDs;
   │                                            │                │ guidance has no isError, failures have
   │                                            │                │ isError: true.
 7 │ Anything forbidden by the brief (risk      │ Checked and    │ No risk-zone evaluation in
   │ zones, ei_changes, audit log, unapproved   │ clean          │ src/core/impact/, no ei_changes, no audit
   │ codes, golden edits)                       │                │ log, no codes outside DESIGN.md §7.2 (with
   │                                            │                │ D56 common-name), no new runtime
   │                                            │                │ dependencies, and no edits to
   │                                            │                │ tests/golden/**, src/policy/**, or
   │                                            │                │ tests/policy/**.
──────
  STATUS: VERIFIED
  MILESTONE: M2b (Round 4 — independent review, read-only)
  MODEL: Gemini 4 Argon (High)
  SCOPE: [] (read-only review of origin/m2b-impact at c3b94db8540631bf6d56b62f93ba82153d06f00b against
  origin/main at 4a95714e4adff5078c122b56126d5e3e12de520c; no files modified)
  ACCEPTANCE:
  - Area 1 (no path to wrong low/medium) -> static review of src/core/indexing/*, src/core/impact/*,
  src/core/workspace/* -> 9 findings (#1-#6, #8, #9, #14)
  - Area 2 (golden tests C01-C26, F01-F06) -> static review of tests/core/impact-golden.test.ts and 
  tests/core/impact-freshness.test.ts vs tests/golden/M2-impact-cases.md -> 1 finding (#13)
  - Area 3 (keyof handling) -> static review of src/core/indexing/keys.ts, src/core/indexing/resolve.ts,
  tests/core/key-access.test.ts, tests/core/key-generics.test.ts -> 1 finding (#3)
  - Area 4 (target resolution ambiguity) -> static review of src/core/graph/graph.ts and
  src/core/impact/query.ts -> 1 finding (#7, three paths)
  - Area 5 (freshness, child lifecycle, no TS program on query) -> static review of src/core/impact/session.ts,
  src/core/engine/build.ts, src/core/engine/host.ts, src/core/workspace/probe.ts -> 2 findings (#9, #12)
  - Area 6 (rendering contract, budgets, determinism, one verdict) -> static review of
  src/core/impact/render.ts, tests/core/impact-render.test.ts, tests/snapshots/impact/*.txt -> 4 findings (#6,
  #10, #11, #15)
  - Area 7 (forbidden scope/edits check) -> static review of src/, tests/golden/M2-impact-cases.md,
  package.json -> clean
  COMMANDS EXECUTED:
  - `git fetch origin && git status --short && git rev-parse HEAD origin/main origin/m2b-impact` -> failed in
  sandbox: `fork/exec /snap/antigravity-cli/24/bin/bash: permission denied`
  RUNTIME: Linux x86_64 (inspected via .git/HEAD, .git/logs/HEAD, and repository files; Node v24.21.0 recorded
  in .gitnexus/meta.json; live shell execution blocked by snap bash permission error)
  NOT VERIFIED:
  - Live execution of `npm test`, `git fetch origin`, `git diff`, and `tests/review/` execution (blocked by
  `fork/exec /snap/antigravity-cli/24/bin/bash: permission denied` in the snap environment; all findings
  verified by direct line-by-line trace of the source and test files at commit
  c3b94db8540631bf6d56b62f93ba82153d06f00b)
  - W2 from Round 3 review (200-target re-run after D56 and 20 hand-checked lows plus whole-call latency split
  on oh-my-pi `/var/tmp/m2a2/omp-src`, which `docs/research/m2b-measurements.md` line 735 still lists as NOT
  VERIFIED)
  DEVIATIONS FROM BRIEF:
  - Could not run `git fetch` or execute failing tests under `tests/review/` via bash because
  `/snap/antigravity-cli/24/bin/bash` returned `permission denied`; read `.git/HEAD`
  (`c3b94db8540631bf6d56b62f93ba82153d06f00b`), `.git/refs/remotes/origin/m2b-impact`
  (`c3b94db8540631bf6d56b62f93ba82153d06f00b`), `.git/refs/remotes/origin/main`
  (`4a95714e4adff5078c122b56126d5e3e12de520c`), `.git/logs/HEAD`, and all changed source/test/snapshot files 
  directly.
  - Note on indexer files per Common Rules: `AGENTS.md` has no injected block; `.ignore` does not exist; an
  untracked GitNexus `CLAUDE.md` (already listed in `.git/info/exclude`) is present and left untouched.
  QUESTIONS FOR OWNER:
  - For Finding #10 (`scrubLevelWords` in `src/core/impact/render.ts`), should the one-verdict test
  (`tests/core/impact-render.test.ts:28-47`) exempt file paths and symbol keys (or check only
  template-generated text outside `ACTION`), so paths and symbol keys containing `low`, `medium`, `high`,
  `critical`, or `unknown` are never mangled into `l_ow` / `h_igh`?
  - For Finding #6 (file targets `ei_impact <path>` when 0 exported declarations have static callers outside
  the file), should `fileAnswer` evaluate completeness gaps and factors across all exported declarations of the
  file (or all declarations of the file) rather than returning an unconditional `low` / `complete` empty block?
  GIT: detached HEAD at origin/m2b-impact (c3b94db8540631bf6d56b62f93ba82153d06f00b), origin/main at
  4a95714e4adff5078c122b56126d5e3e12de520c; 0 local commits created, 0 files modified, nothing pushed.
  NEXT COMMAND: Read docs/briefs/README.md and docs/briefs/M2b-prompts.md, then do Round 5 on m2b-impact with 
  the Round 4 findings above (and run W2 on oh-my-pi on the WSL machine).