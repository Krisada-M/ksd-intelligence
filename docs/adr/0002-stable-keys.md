# ADR 0002 — Stable keys for symbols

**Status:** accepted 2026-11-11 (D34). **Context:** every index record, edge, golden expectation and tool target refers to a symbol by key. The key must be the same for a full build and an incremental one, readable by an agent, and unambiguous.

## Form

```text
<repo-relative posix path>#<qualified name>
packages/payments/src/fee.ts#calculateFee
packages/payments/src/service.ts#PaymentService.charge
```

## Qualified name rules

| Declaration | Qualified name |
|---|---|
| Module-level function, class, interface, type alias, enum, `const`/`let`/`var` | its name |
| Arrow function or function expression assigned to a module-level variable | the variable's name |
| Class, interface or enum member | `Owner.member` |
| Static and instance member with the same name | instance: `Owner.member`; static: `Owner.static:member` |
| Getter and setter of one property | one key, `Owner.prop` |
| Member of an object literal bound to a module-level variable | `variable.member`, nested up to 3 levels (`variable.a.b.c`) |
| Property with a string- or number-literal name | the literal text, e.g. `routes.POST /charge` |
| Property with a computed, non-literal name | not a declaration; uses inside it belong to the enclosing declaration |
| Namespace member | `Namespace.member` |
| Anonymous default export | `default` |
| Named default export | its own name (the `default` export is an edge to it) |
| Overloaded function or method | **one** key; the span is the implementation, overload signatures are listed in the record |
| Merged declarations (interface + interface, namespace + function, class + interface) | **one** key; the record lists every declaration span, the first is primary |
| CommonJS `exports.x = …` / `module.exports.x = …` | `x` |
| CommonJS `module.exports = { a, b }` | members by their names |

## Enclosing symbol of a use site

The nearest enclosing declaration that is indexed under ADR 0003. A use at module top level, or inside a callback that is not itself an indexed declaration and has no indexed ancestor, belongs to the module pseudo-symbol:

```text
packages/api/src/routes.ts#<module>
```

## Collisions

After these rules, two declarations in one file can still share a qualified name only in unusual code (for example a function declared in two branches of a top-level `if`). Then the second and later ones get a suffix in source order, `name~2`, `name~3`, and the scan summary counts them as `key-collision` oddities. They never share a key silently.

## Consequences

- Keys do not contain line numbers, so moving code inside a file does not change them.
- Renaming or moving a file changes the keys of everything in it; that is a delete plus an add, which the freshness cases cover.
- An agent can pass a bare name, `Owner.member`, `path#name` or `path:line` as a target; resolution to a key is the engine's job (`docs/TOOLS.md`).
