# ADR 0003 — What is indexed

**Status:** accepted 2026-11-11 (D34). **Context:** resolving every identifier in a mid-size codebase produced 350,000–500,000 resolutions (`docs/research/index-techniques.md`). Most point at locals and parameters, which no impact question asks about. This ADR fixes what becomes a record, so index size and speed are bounded and `ei_impact` targets are predictable.

## Indexed declarations

1. Every module-level declaration, exported or not: functions, classes, interfaces, type aliases, enums, variables, namespaces.
2. Members of classes, interfaces, enums and namespaces.
3. Members of object literals bound to a module-level variable, up to 3 levels deep.
4. Default exports.

**Not indexed as declarations:** parameters, local variables and local functions, type parameters, import and re-export specifiers (these are edges), members of anonymous object types.

Consequence: a local helper function inside another function cannot be an `ei_impact` target. Asking for it by `path:line` resolves to its enclosing indexed declaration, and the answer says so.

## Indexed uses (edges)

A use site becomes an edge when, after following import aliases, it resolves to an **indexed declaration inside the index scope**. The edge runs from the use site's enclosing symbol (ADR 0002) to that declaration, with a kind and strength.

| The use resolves to | Stored as |
|---|---|
| An indexed declaration in scope | an edge |
| A local, a parameter, a type parameter | nothing |
| A declaration in a library (`node_modules`, the standard library) | nothing; counted per file as `external` in the scan summary |
| A declaration in a workspace package outside `impact.include` | nothing; the file gets reason `outside-index-scope` |
| Nothing, and it is a relative, alias or workspace import specifier | an unresolved record, reason `unresolved-import` (a completeness gap) |
| Nothing, and it is a bare package specifier (dependency not installed) | counted as `external-unresolved`; **not** a completeness gap for in-repo targets. The scan summary warns that dependencies are missing and types are degraded; calls through the resulting untyped values are caught by the name cross-check |
| Nothing, and its name equals the name of some indexed declaration | an unresolved record for the name cross-check (`unresolved-name-match`) |
| Nothing, any other name | counted as `unresolved-other` in the scan summary; not stored |

String literals are not uses, with one exception: a literal that names a property is a use of that member (`obj['k']`, `T['k']`, and the quoted or numeric key of an object literal typed by context), like the identifier forms. Other string literals are kept only in the per-file name-token table when they equal the name of an indexed declaration, for the `string-name-match` check.

**The differential oracle skips the uses of the value a shorthand property names (2026-11-14).** `findReferences` on the property of `{ x }` also lists the uses of the value `x`, which belong to the declaration of `x`, not to the property. The test skips those, counting them under `skipped`; references to the property itself (`obj.x`) are still checked.

**Documentation is not a dependency (2026-11-13, M2a review).** A reference inside a JSDoc comment (`{@link x}`, `@see x`) is documentation. The index need not hold it and the differential test against `findReferences` filters it out, reporting its count separately as `docOnly`. Where the resolver does record a JSDoc type use (JavaScript `@type`), that is a bonus, not a promise.

**Per-file use counters are statistics.** The counts of uses stored and skipped per category (scan summary, `ei_status`) are reported as approximate: TypeScript infers lazily, so a counter can differ between an incremental update and a cold build by checking order. No query, reach, factor or verdict is derived from them; those come from the `edges` table only, and `ei doctor --deep` does not compare the counters (it lists differing files as information).

**The export-surface hash is syntactic (2026-11-13, M2a review).** It is computed from the file's text alone and calls no checker, so it cannot depend on what the checker saw first. Per observable declaration it hashes the text that states the type: the signature when the types are written, the whole declaration (body or initializer) when a type is inferred. A declaration is observable when it is exported or when the text of an observable declaration names it (transitive, by identifier). Export statements, ambient modules, and imports that an inferred type names are hashed whole; JavaScript files are hashed whole. Over-reporting a change only costs re-resolution; missing one is a defect, so anything unrecognised is hashed whole. A file that holds an inferred type can change meaning when a file it imports changes, with no edit to its own text: during an update, such a file resolved because a dependency's surface changed counts as changed itself, so its dependents are re-resolved too.

## Edge kinds

`CALLS` (the use is the callee of a call or `new` on a function), `CONSTRUCTS` (`new` on a class), `REFERENCES` (any other value or type use, including passing a function as a value and JSX element use), `IMPORTS` (file-level: this module imports that one), `IMPLEMENTS` (class to interface member, interface extension), `TESTS` (file-level: a test file reaches the target).

One enclosing symbol may have several edges to the same target; they are stored once per (source, target, kind) with the list of sites.

## Size expectation

To be measured in M2a. The scan summary reports edges stored, uses skipped by category, and the ratio, so a regression in what gets stored is visible.
