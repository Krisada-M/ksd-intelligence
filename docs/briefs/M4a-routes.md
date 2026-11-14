# M4a — Route detection (agent brief, DRAFT, gated per detector)

**Draft and gated.** Start with Round 0 (`README.md`). A detector is built only if the dogfood log shows a real workflow that needs it (DESIGN §13 row M4a). Round 0 must list, per detector, the evidence or "no evidence"; the owner strikes the detectors without evidence before Round 1.

Read `docs/briefs/README.md` (common rules). Then `docs/DESIGN.md` §6.9 (B1, B2 and the six rules), §7.2 (factor `route`, `reach.routes`), §9 (`impact.routes`, `bridges`); `docs/TOOLS.md` §4, §5, §7; golden cases C12, C25 and P2.

**Branch:** `m4a-routes` from `origin/main`.

## Goal

Without any `impact.routes` configuration, the index knows which files and handlers are HTTP routes or screens, so `ei_impact` and `ei_changes` report the `route` factor, count `reach.routes`, and mark rows with `route METHOD /path`. Detection is from file conventions and literal paths only. It adds the factor; it never changes completeness and never adds an edge that the compiler did not resolve.

## Detectors

| ID | Framework | Recognised from |
|---|---|---|
| B1a | Next.js app router | a package that depends on `next`; files `page`, `layout`, `route`, `default`, `loading`, `error`, `not-found`, `template` under its `app/` or `src/app/`; exported `GET`, `POST`, … in `route` files |
| B1b | Next.js pages router | `pages/` or `src/pages/`, `pages/api/**` handlers |
| B1c | Expo Router | a package that depends on `expo-router`; files under `app/`, `+api` files, `_layout` |
| B2 | Hono | literal `app.get/post/put/patch/delete/all/on('/path', handler)`, `app.route('/prefix', sub)`, `basePath('/x')`, on values whose type is Hono's (from the checker) |

Each can be switched off (`bridges: { B1: false, B2: false }`). `impact.routes` globs keep working and are additive.

## Round 1 — file-convention routes (B1a, B1b, B1c as approved)

- Route records in the index: file, framework, kind (page, layout, api), path pattern, methods, the handler declaration's stable key. Part of incremental == cold and `ei doctor --deep`.
- Path pattern from the file path: dynamic `[id]`, catch-all `[...slug]`, optional `[[...slug]]`, route groups `(group)` removed, parallel `@slot` removed, intercepting `(.)x` kept as written and marked, `index` collapsed, Expo `(tabs)` groups and `+api`.
- Factor `route` when the target or an impacted symbol is a route handler or lives in a route file; `reach.routes` counts distinct routes.

Risky cases, one test each (fixture copies; do not edit the base fixture):
- A `page.tsx` or `route.ts` **outside** an `app/` directory, or in a package that does not depend on the framework → not a route.
- `app/` inside `node_modules`, `dist`, a test fixture directory or an excluded path → not a route.
- A `route.ts` exporting `GET` and a helper: only `GET` is a handler; the helper is ordinary code.
- `export { GET } from './impl'` and `export const POST = handler` → handler resolved to the real declaration.
- A page with a default export through a barrel.
- Both `app/` and `pages/` in one package.
- Two packages with the same route path → two routes, each scoped to its package.
- A monorepo where `next` is declared only in the root `package.json`.
- A route file that fails to parse → no route record, the existing `parse-error` gap, nothing guessed.
- Detector disabled in config → records absent, config globs still work.
- Golden C12 and C25 pass unchanged; every M2b and M2c snapshot is unchanged for repositories without these frameworks.

## Round 2 — Hono (B2, if approved)

- Route records from literal registrations; the handler edge already exists from the compiler. Composition through `app.route('/prefix', sub)` and `basePath` joins prefixes when both sides are literal and the sub-app resolves to one declaration.

Risky cases, one test each:
- `app.get(path, h)` with a non-literal path, a template literal with a substitution, or a path from a constant: **no route record**; record a gap site `computed-member-access` at the registration so handlers registered there are partial. Never guess.
- A method called `get` on something that is not a Hono app (a `Map`, an HTTP client, a custom class) → nothing recorded. The receiver's type decides, not the method name.
- Chained registrations `app.get(...).post(...)`; several handlers and middleware in one call (each is reachable; the last is the handler).
- `app.route()` with a sub-app imported from another package; a sub-app mounted twice under different prefixes → two routes.
- `app.on(['GET', 'POST'], '/x', h)` and `app.all`.
- A handler defined inline (arrow function): the route's handler is the enclosing indexed declaration.

## Round 3 — tool text, live, measurements

- `ei_impact` rows carry `route` and `route METHOD /path` markers per TOOLS §4; `ei_changes` likewise; `ei_search` facts show the route (TOOLS §7); `ei_status` reports routes by detector. Changed snapshots are PROPOSED.
- **Live (label the OS)** on the M3 work repository or a fixture copy: `ei_impact` on a function reached by a route, with no `impact.routes` configured; paste it.
- On each reference repository: routes found per detector; 20 sampled by hand against the framework's real routing (list misses and false routes); change in the low / medium / unknown distribution over the 200 seeded targets. A target that moves from `low` to `medium` because of a real route is correct; one that moves because of a false route is a defect.
- Build-time and database-size change; `docs/research/m4a-measurements.md`.
- Mutation smoke: framework dependency check removed; non-literal path accepted; route counted when the detector is off; route detection changing completeness; receiver type ignored for Hono.

## Round 4 — review, then fix

Use the round types in `README.md`.

**Review focus**
1. False routes (wrong directory, wrong package, wrong receiver type, generated or vendored code).
2. Missed routes for the conventions listed, and silent guesses for non-literal paths.
3. Any effect on completeness, on compiler-grade reach, or any new edge.
4. Golden C12, C25 and all earlier snapshots unchanged where no framework is present.
5. Incremental == cold for route records after adding, renaming and deleting route files.
6. Config switches and the additive behaviour of `impact.routes`.

## Acceptance

1. Tests green, including the negative cases; incremental == cold and doctor cover route records.
2. Hand-checked sample: no false route; misses listed with cause.
3. Live output pasted; measurements written; mutation smoke clean.
4. CI green on macOS and Linux after the owner pushes.

## Do not

- Create `REQUESTS`, `NAVIGATES` or `EMITS_TO` edges, or match `fetch` paths to routes (that is M4b, gated).
- Let a detected route remove a gap or lower a level.
- Add a detector the owner struck in Round 0.
