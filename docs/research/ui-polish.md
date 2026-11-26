# UI polish — Round 0

Model: `openai-codex/gpt-6.2-sol`. Baseline: `v1.0.0` (`f2b0f5a5fa6ffa392683fcd92dfb38414ceef9a1`). D68 and the UI brief are on `origin/main`, after the base tag; use those approved documents without changing the base in this round. D69 authorizes the lane. No product files change in Round 0.

## Architecture

The CLI (`src/adapters/cli/main.ts`) owns flags, streams, and exit codes. The Core owns the outcome and plain renderer. OMP (`src/adapters/omp/extension.ts`) assigns Core-rendered text to `content` and carries typed results separately in `details`. AGY (`scripts/mcp/tools.mjs`) currently sends the same Core-rendered text through JSON-RPC but drops the typed result. The KSD extension dispatches session and agent lifecycle events to `KsdRuntime.syncStatus`; `/engineering-proxy status` emits an independent notification.

The indexer owns scan, program, extract, resolve, verify, and publish. `buildIndex` holds the build lock and forwards old progress messages plus an opaque payload from the engine child. The cold path has per-file extraction and resolution loops, but emits only phase-entry counts today. `doctor` drives separate update, rebuild, and differential steps. `setup` invokes its existing pinned TypeScript installer; it has no honest package download fraction. These owners can report measured progress without the terminal calculating it from logs.

## OMP

`omp --version` → `omp/19.2.1`. The globally installed npm source tree is older (`18.14.0`); it was not used to infer the active binary's API. Inspected the version-matched npm distribution with `npm pack --ignore-scripts @oh-my-pi/pi-coding-agent@19.2.1` and the active runtime's bundled `extensions.md`.

- `package/src/extensibility/extensions/types.ts:1022–1028`: `ToolRenderResultOptions` exposes `expanded`, `isPartial`, and optional `spinnerFrame`.
- Same file, lines 1106–1127: `registerTool` definitions accept `renderCall(args, options, theme)` and `renderResult(result, options, theme, args?)`. `ExtensionRender` includes an object with `render(width)` rows for the terminal. Rows do not replace model `content`; Tern uses its generic card for rows.
- `package/src/modes/interactive-mode.ts:8443–8448`: host delegates expansion to `toggleToolOutputExpansion` / `setToolsExpanded`. The result renderer can choose one line when collapsed and draw the body when `expanded` is true. This is source-verified; a styled runtime call belongs to the implementation rounds.

## Antigravity CLI

Installed `antigravity-cli` snap `1.5.17`, revision `26`. [Official MCP docs](https://antigravity.google/docs/mcp#add-interactive-uis-mcp-apps) distinguish App UI resources from CLI plain `content`. Do not infer an AGY CLI human-only channel from MCP supporting structured results at the protocol level.

Real host verification: `agy --mode plan --output-format stream-json` invoked `mcp_ksd_lane_a_probe_ei_status` against the baseline stdio bridge in a disposable workspace. Only `mcp(ksd_lane_a_probe/ei_status)` was allowed via the invocation's `--settings` overlay. No permanent permission or host configuration changed. The captured wire used MCP `2026-07-28`: `server/discover`, `tools/list`, then `tools/call` with `name: ei_status`. The completed AGY event rendered `STATUS degraded (typescript runtime missing) · run: ei setup`, the expected literal text for the isolated workspace. The earlier headless attempt without the narrow rule was denied. Baseline also serves legacy `2025-11-25`, verified by `initialize` and `tools/list` over raw stdio, not by the live host. No verified CLI display-only `structuredContent` or UI-resource path; preserve plain default and consider only the brief's explicit markdown opt-in in Round 3.

## Baseline CLI output inventory

From `src/adapters/cli/main.ts:138–861`. JSON variants retain the same shape and bytes where already deterministic. `stderr` progress remains separate from stdout. A nonzero status, guidance, and a failure are distinct outcomes.

| Command | stdout | stderr / alternate paths |
| --- | --- | --- |
| `--help`, invalid command | Usage via `ei --help` | Usage on invalid command, missing subcommand or parse error |
| `setup [--check]` | TypeScript readiness, runtime path/hash, or degraded reason and fix | Top-level exception text |
| `status` | `STATUS` with index, coverage, problems, gaps, runtime, config, store, guidance; JSON; disabled line | Top-level exception text |
| `audit` | Audit summary with time window and counts; JSON | Invalid `--since` |
| `cache clear` | Removed or nothing to clear; JSON including live-lock state | Usage or live-lock refusal |
| `index` | `INDEX` error and fix, or action, elapsed, reason and status; JSON engine report | Legacy `ei index:` phase messages |
| `impact` | Bounded result, file aggregate, guidance or failure blocks; single or batch JSON | Legacy `ei impact:` progress |
| `changes` | Bounded diff result, unchanged, guidance, failure or disabled; JSON | Legacy `ei changes:` progress |
| `search` | Bounded hits, no matches, stale/other guidance, failure or disabled; JSON | Legacy `ei search:` progress |
| `doctor --deep` | Deep-diagnostic report/failure with fix; JSON report | Usage, invalid `--differential`, legacy `ei doctor:` progress |
| `init` | Paths, config action, Git/include/tsconfig and warnings; JSON | Top-level exception text |
| `route`, `load` | Route JSON; loaded workflow text | Workflow validation/IO error text |
| `skills list`, `skills check` | Discovery summary, rows, issues, registry findings; JSON | Invalid platform |
| `skills diff`, `sync`, `publish`, `rollback` | Per-command summary, findings, recommendations and/or JSON | Missing required IDs, top-level exception text |
| `sources check` | Source/pin reports | Top-level exception text |
| `mcp` | JSON-RPC only; never style stdout | Invalid root/subcommand, startup error |

## Fields and formatting boundaries

| Surface | Existing input | Gap to address |
| --- | --- | --- |
| Impact | CLI `ImpactBatch` or OMP `impactDetails(batch)`; `ImpactResult` has verdict, reach, callers, tests, gaps, engine | OMP projection flattens file responses and omits batch `index` provenance (`impact/render.ts:666–686`); pass presentation evidence separately rather than reconstruct it from text. Keep the CLI `--json` projection unchanged. |
| Changes | `ChangesResult`, with outcome distinction, reach, tests, plan, and updated/stale data | No new engine fields required; preserve unindexed file rows and the special nothing-changed result. |
| Search | `SearchResult` with total matches, bounded hits, kind and freshness | CLI has a separate `--limit` contract; `--all` for presentation must not claim results outside the retrieved set. |
| Status, audit, skills | `WorkspaceStatus`, `AuditSummary`, skill discovery and registry issues | No new engine fields required; do not change disabled or failure signals. |
| HUD | Phase names, optional untyped `files` counts, final index action/reason/timings/census | Add typed measured phase/file progress, indeterminate states for unknown totals, and last-run history written only after successful publish. Preserve old progress text for other consumers. |
| AGY | Plain MCP `content` only today | Round 3 opt-in must receive the existing Core result before plain rendering; don't parse `content` as a model. |

Baseline CLI argument parsing has no `--plain` or `--all`; those are presentation additions, not a change to analysis depth or JSON shape. Preserve legacy plain output for every command outside the brief's styling allowlist.

## Frozen KSD presentation baseline

`src/policy/src/runtime.ts:69–102` renders `● 🛡 KSD: ADAPTIVE`, `● 🛡 KSD: BALANCED`, `○ 🛡 KSD: ADAPTIVE`, `○ 🛡 KSD: BALANCED`, warning `⚠ KSD: <notice>`, or clears the segment. `src/policy/index.js:198–202` emits:

```text
Engineering Proxy: <ON|OFF>; mode: <MODE> (<source>); project default: <MODE|UNSET>; global default: <MODE|UNSET>; session: <MODE|INHERIT>; Ponytail command: <detected|not detected/unknown>; Ponytail mode: not inspected[; WARNING: <warnings>]
```

`tests/policy/contract.test.js:14–25` pins all `segment-*.txt` and `status-command-*.txt` fixtures byte for byte. `extension.test.js` also pins lifecycle and segment behavior; `global-config.test.js` pins override precedence; `performance.test.js` pins redraw/dedup behavior. Keep the existing plain channel and snapshots unchanged. Record every added human-facing representation in owner review notes; changing behavior is a hard stop.

## Round 1 architecture decision

**Usage.** `ei impact calculateFee` selects a terminal view from the existing typed batch. `ei impact calculateFee --plain` and `--json` use their existing encoders. A styled `ei index` opens one stderr HUD and feeds it observed engine phase events; the plain command still emits only the old progress messages. Later, OMP renders the same result view in `renderResult` without touching `content`.

**Shape.** `renderResultView(input: ResultView, options: ViewOptions): string[]` accepts a discriminated union over existing result types. It owns role colours, tree-layout, display width, abbreviation collisions, and list folding. The CLI alone decides whether to use it. `openHud(options): Hud` owns redraw timing and cursor cleanup; it consumes typed phase observations, including indeterminate phases. Existing Core result and transport encoders stay separate. Only the engine publish owner can record successful build history; presentation reads it.

**Synthesis.** GPT-6.2 Sol proposed surface-local renderers over existing result types. Gemini 3.8 Flash proposed a common semantic projection. Share the result view across human consumers as Gemini proposed, but take Sol's existing typed inputs and separate HUD lifecycle. Reject a second domain store, an opaque V1 payload, and any projection that serializes agent text.

**Tradeoffs and risks.** A shared primitive tree carries only human rows, not Core semantics. Measured progress can be unavailable; a beam communicates work without inventing a total. Width calculations must not cut Thai, combining clusters, or a symbol name. Control characters from repository paths are inert in the styled view. OMP and AGY transport wiring wait for Rounds 2 and 3, respectively.

**Next implementation step.** Add the consumer-visible terms, width, plain-output and HUD regressions, then wire the CLI against the view and event interfaces.

## Round 2 protected-path notes for the owner

D68 status-only diff touches `src/policy/index.js`, `src/policy/src/runtime.ts`, its shipped runtime artifacts, and policy presentation assertions. Apply the `owner-approved` label before opening the protected-path gate. No snapshot updates.

| Human-facing string | Themed display change |
| --- | --- |
| `○ 🛡 KSD: BALANCED` / `○ 🛡 KSD: ADAPTIVE` | Dim `KSD:` and the idle mode. Existing idle marker remains dim. |
| `● 🛡 KSD: BALANCED` / `● 🛡 KSD: ADAPTIVE` | Dim `KSD:` and accent the active mode. Existing active marker remains accented. |
| `⚠ KSD: <notice>` | Accent `⚠`, dim `KSD:`, preserve the exact notice. |
| `/engineering-proxy status` labels | Dim `Engineering Proxy:`, `mode:`, `project default:`, `global default:`, `session:`, `Ponytail command:`, and `Ponytail mode:`. |
| `/engineering-proxy status` values and warning | Accent `ON`, `OFF`, `BALANCED`, `ADAPTIVE`, `UNSET`, `INHERIT` in their fixed fields and accent `WARNING:`. Preserve values, punctuation, warnings, and notification severity. |

Unstyled copy, disabled clear behavior, config, enforcement, and persistence are unchanged.

## Round 3 — terminal capture and AGY comparison

The AGY bridge formats the typed summary inside its existing response boundary. A renderer that serializes all internal details would expose paths and duplicate unbounded result data. The chosen formatter adds only fixed labels and typed scalar summaries; the original bounded details stay intact in a fence longer than any backtick run in the text. The original renderers still own all guidance. No second state store or protocol extension is needed.

`ei index` and `ei status`, macOS arm64, 80 columns, with light and dark terminal palettes. Both captures emitted ANSI styling. Excerpts omit paths and variable timing:

```text
◆ index unchanged · 2 files
✓ status ready
├─ index
├─ runtime
├─ config
└─ store
```

Live OMP 19.2.1 in an 80-column Linux aarch64 PTY showed the KSD segment and command notification in both palettes. The earlier light capture also showed the collapsed result. Excerpts omit paths and unrelated UI:

```text
○ 🛡 KSD: BALANCED
Engineering Proxy: ON; mode: BALANCED (default); project default: UNSET
ei_status
⚠ status degraded · no index
```

Expanded output in both palettes was not verified. The Round 2 fixture still covers collapsed and expanded rendering without changing model content.

AGY bridge wire capture, MCP `2026-07-28`, same disposable workspace in plain and Markdown modes. Original details compared byte for byte:

```text
STATUS degraded (typescript runtime missing) · run: ei setup
```

```markdown
## ei_status

| Field | Result |
| --- | --- |
| state | degraded |
```

The Markdown response includes the full plain response under `Details`. This is a real stdio bridge capture, not a live Antigravity display capture. AGY CLI 1.5.17 (`gemini-3.8-flash-low` for the second attempt) timed out before either probe tool ran. A separate interpretation check with `openai-codex/gpt-6.2-sol` failed before scoring with `usage_limit_reached`. Live output and model behavior for the opt-in remain **NOT VERIFIED**.

Post-rebase AGY CLI 1.5.17 via `agy acp --stdio`: two sessions completed both read-only `ei_status` calls using disposable MCP servers. One session included passive stdio capture. Both wire responses showed `STATUS degraded`; only the opted-in response had the Markdown heading and the `degraded` table row. The ACP completion events omitted result content. An isolated repeat intended to score the exact next command timed out, so this proves live tool reachability and the wire distinction, not terminal rendering or model interpretation.
