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

String literals are not uses. They are kept only in the per-file name-token table when they equal the name of an indexed declaration, for the `string-name-match` check.

## Edge kinds

`CALLS` (the use is the callee of a call or `new` on a function), `CONSTRUCTS` (`new` on a class), `REFERENCES` (any other value or type use, including passing a function as a value and JSX element use), `IMPORTS` (file-level: this module imports that one), `IMPLEMENTS` (class to interface member, interface extension), `TESTS` (file-level: a test file reaches the target).

One enclosing symbol may have several edges to the same target; they are stored once per (source, target, kind) with the list of sites.

## Size expectation

To be measured in M2a. The scan summary reports edges stored, uses skipped by category, and the ratio, so a regression in what gets stored is visible.
