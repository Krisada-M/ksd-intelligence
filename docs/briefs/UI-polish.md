# UI polish — CLI, OMP tool results, KSD status, AGY (agent brief)

**Decision:** D68. **Branch:** `ui-polish` from tag `v1.0.0`. **Release:** `1.1.0`. Not a V2 module; independent of V2.

Read `docs/briefs/README.md` (common rules), `AGENTS.md`, `docs/DESIGN.md` §6.7 and §7, `docs/TOOLS.md`, `docs/release-checklist.md`.

## Goal

Output that a person can scan in two seconds: the action and level first, colour and symbols for risk, aligned columns, long lists folded. Four surfaces, in this order: the `ei` CLI in a terminal, tool results in the OMP TUI, the KSD status segment and `/engineering-proxy status`, and Antigravity.

## The rule that decides everything

**The text the model reads does not change.** Every byte of a tool's `content` text, every snapshot, golden case and TOOLS.md example stays as it is. Styling lives in a separate presentation layer that reads the structured `details` a tool already returns, and is used only where a human looks at it. A test per surface proves the agent-facing text is byte-identical with styling on and off.

Reason: the eval gate (≥ 9/10) and the golden oracle were earned on today's text. A prettier answer that changes what the agent reads must be re-earned, and is not what this brief is for.

## Look — compact tree (owner's choice, 2026-11-26)

One shared style module, `src/adapters/ui/` (no new dependency; ANSI written by hand), used by every surface:

- **First line:** status symbol, target, action, level. `⚠ calculateFee  run-tests · medium`. Symbol and colour by action: `✓ proceed` green, `⚠ run-tests` yellow, `? check-gaps` / `unknown` magenta, `✗ ask-owner` red; level `critical` bold red. The word is always printed; colour never carries meaning alone (colour-blind safe, copy-paste keeps meaning).
- **Body:** a tree with `├─ │ └─`. Sections are its branches: `reach`, `callers` (nested by depth), `tests`, `gaps`, `next`. Section names dim; values normal.
- **Rows:** name first, then the location shortened from the left (`checkout.ts:4`, full path when two rows would collide). Row markers (`gap`, `route`, `test`) as short coloured tags at the end. Names are never cut in the middle.
- **Long lists:** first 10 rows of a section, then `└─ + 17 more (--all)`.
- **Footer:** one dim line (`index fresh · 26 files · engine 1.1.0`).
- **Fallbacks:** ASCII tree `|- | \-` and symbols `ok ! ? x` when the terminal is not UTF-8 or `EI_ASCII=1`. Width-aware: below 60 columns the location moves to its own indented line instead of being truncated. Thai and wide characters are measured by display width, not string length.
- `ei changes` uses the same tree with one branch per changed symbol; `ei status` one branch per area (index, runtime, config, store).

Mock of `ei impact calculateFee` (the plain text stays the current snapshot):

```text
⚠ calculateFee  run-tests · medium · complete
├─ reach    5 → 8 · 7 files · 3 pkgs · 1 route
├─ factors  public-export-surface · route · cross-package
├─ callers
│  ├─ depth 1
│  │  ├─ submit           checkout.ts:4
│  │  ├─ chargeHandler    charge.ts:3        gap
│  │  └─ + 3 more
│  └─ depth 2
│     ├─ registry.charge  handlers.ts:7      gap
│     └─ routes.POST      routes.ts:3        route
├─ tests    fee.test.ts
└─ next     run the test above, then ei_changes before you report done
index fresh · 26 files · ts 5.9.3 · engine 1.1.0
```

### HUD for long-running commands: `ei index`, `ei setup`, `ei doctor` (owner's choice, 2026-11-26)

Results everywhere else use the compact tree above. Only commands the owner waits on get the HUD.

While running, on a TTY only, an animated block on **stderr**, redrawn in place at most 10 times a second:

```text
▌ei index  ksd-intelligence · cold          3.1s
  last run 4.8s · why: package.json changed

 ◆ scan     ████████████████ 1,240
 ◆ program  ████████████████ ok
 ◈ extract  ██████████▌·····  760/1240
 ◇ publish  ················

 files/s ⣀⣤⣶⣿⣶⣤⣶⣿⣿⣶⣤⣀⣤⣶   612
 › src/core/impact/session.ts
```

- **Header:** command, repository, build kind (`cold` / `update`), elapsed time; second line the previous run's duration and, for a cold build, the engine's reason.
- **Phase rows** (`◇` waiting, `◈` running, `◆` done): bars fill with eighth-block precision (`▏▎▍▌▋▊▉█`) and a colour ramp green → blue → violet → pink along the bar.
- **Honest progress only.** A phase with a known total shows `done/total`. TypeScript program creation has no measurable progress: it shows a moving scan beam and the word `building`, never a percentage. No ETA is computed; the previous run's time is shown as a fact.
- **Throughput line:** braille sparkline of files per second over the last ~2 s windows, with the current number. A dip is where the time goes.
- **Ticker:** the file or step the engine is on.

When done, on stdout:

```text
◆ index built  cold · 1,240 files · 4.2s  −0.6s vs last

 timeline  ━━━━━━━━━━━━━━━━━━━━━━━
           scan program extract pub
 files/s   ⣀⣤⣶⣿⣶⣤⣶⣿⣿⣶⣤⣀
 coverage  ███████████████▌ 97%
           1,203 indexed · 37 outside scope · 0 errors

 › ready for ei impact
```

The timeline is one bar split by phase in proportion to measured time. Other outcomes keep the tree shapes: `◆ index updated` (with a `drift` line), `◆ index unchanged 0.06s`, and `✗ index failed` with the engine's reason verbatim, which index is still in use, and the next command; a failed build is never shown as current. `ei setup` and `ei doctor` use the same header, rows and summary.

**Engine change needed:** the engine host sends counts with its existing progress events (`{ phase, done, total, file? }`). Internal protocol only; `ei doctor --deep --differential 300` must still show zero differences, and index results do not change. The previous run's duration and phase times come from a small `runs.json` in the cache (last 20 runs), written after a successful publish.

**Colour tiers:** truecolor (`COLORTERM=truecolor|24bit`) gets the full ramp; 256-colour gets the nearest ramp; 16-colour or no braille glyphs falls back to the plain tree (`✓ index built …`) with plain bars. Animation off (plain lines, no redraw) when stderr is not a TTY, with `--plain`, `NO_COLOR`, `TERM=dumb`, `CI` set, or `EI_NO_ANIMATION=1`. Below 60 columns: header, current phase row and ticker only. Ctrl-C restores the cursor and clears the block.

No other command gets charts or bars: impact, changes, search, status and audit stay trees.

## Surfaces

### 1. CLI (`ei`)

- Styled only when stdout is a TTY. Plain (today's exact text) when piped, with `--plain`, with `NO_COLOR` set, or `TERM=dumb`. `FORCE_COLOR` turns styling on. `--json` never changes.
- Commands: `status`, `impact`, `changes`, `search`, `doctor`, `audit`, `skills list|check`. `ei setup` and `ei index`: progress line and result tree as in the section above.
- Snapshots keep testing the plain path. New tests: HUD rendering from a recorded sequence of `{ phase, done, total, file }` events (determinate and indeterminate rows, eighth-block fill, redraw rate, each colour tier, Ctrl-C cursor restore, every switch-off condition, `runs.json` written only after a successful publish); styled output for each command against a recorded fixture with `FORCE_COLOR=1` and fixed widths (50, 80, 120); `NO_COLOR` wins over `FORCE_COLOR`; ASCII fallback; a path with Thai characters aligns by display width.

### 2. OMP tool results

- Round 0: read the installed OMP's extension types (`omp --version`, the package's `extensions/types.ts` and examples) and record whether a tool can supply its own TUI rendering of the call and of the result, separate from the text sent to the model. Record the exact API names and files. **Never guess** (AGENTS.md).
- If it can: implement the renderer for `ei_impact`, `ei_changes`, `ei_search`, `ei_status` from `details`, collapsed to the header line by default and expanded on demand, if OMP supports that. The `content` text is unchanged.
- If it cannot: nothing is built for this surface; say so in the report. Do not put ANSI or decoration into `content`.

### 3. KSD status segment and `/engineering-proxy status`

These are the frozen policy contract (DESIGN §6.7). The owner asked for this change (D68), which unfreezes **presentation only**: colour, symbol, order and spacing. Every word, mode name, config key and command stays. The change lives in `src/policy/**`, so the pull request needs the `owner-approved` label; tests in `tests/policy/**` that match exact strings are updated only where the visible text changes, each change listed in the PR. Behaviour (enforcement, modes, persistence) does not change; the existing policy tests that check behaviour must pass untouched.

### 4. Antigravity

- Round 0: record how AGY displays MCP tool results (plain text or markdown) and whether the installed AGY and the MCP version it speaks support structured content or UI resources. Evidence: AGY docs and one real call.
- Default: **no change** to the MCP `content` text, because the model reads it. If AGY supports a display-only channel (structured content shown to the user, or a UI resource), render there from the same `details`. If it supports only text, offer an opt-in `KSD_MCP_MARKDOWN=1` that adds markdown headings and a table to the text, and run the eval-style checks on it before recommending it. Off by default.

## Rounds

- **Round 0 (no changes):** the OMP and AGY facts above, a list of every output the CLI prints today, and which `details` fields each renderer needs that a tool does not return yet (adding a field to `details` is allowed; changing `content` is not). Report and stop.
- **Round 1:** shared style module and the CLI. Gates below. Stop.
- **Round 2:** OMP renderer (if possible) and the KSD status presentation. Stop.
- **Round 3:** AGY per Round 0, screenshots or terminal captures of all four surfaces in `docs/research/ui-polish.md` (light and dark terminal, 80 columns), version `1.1.0`, CHANGELOG. Stop.
- **Round 4:** cross-vendor review, then fixes.

## Gates (every round)

`npm ci`, typecheck, lint, format:check, `npm test`, `check:dist`, tarball test; the byte-identity tests for agent-facing text; and `node evals/run.mjs` with the strong model still ≥ 9/10 after Round 2.

## Do not

- Change any tool's `content` text, TOOLS.md, snapshots or golden cases.
- Add a runtime dependency (no chalk, ink, blessed): ANSI by hand, or ask the owner first.
- Change any KSD policy behaviour, mode, command name or config key.
- Colour as the only carrier of meaning.

---

## Prompts

### Round 0

```text
Read docs/briefs/README.md and docs/briefs/UI-polish.md. Do Round 0 only
on branch ui-polish from tag v1.0.0. Change nothing in the repository.

Record with evidence (file paths, API names, versions, one real call):
(1) whether the installed OMP lets a tool render its call and result in
the TUI separately from the text sent to the model, and how collapse /
expand works; (2) how the installed AGY shows MCP tool results and
whether structured content or UI resources are supported; (3) every
output the ei CLI prints today; (4) which details fields each renderer
needs that tools do not return yet; (5) the exact KSD status and
/engineering-proxy status strings and which tests pin them.

Report in the AGENTS.md template with the exact model. Stop.
```

### Rounds 1–3 (one per session)

```text
Read docs/briefs/README.md, docs/briefs/UI-polish.md and the Round 0
report in docs/research/ui-polish.md. Do Round <n> only, on branch
ui-polish. The text the model reads must stay byte-identical: prove it
with a test for every surface you touch. Run every gate in the brief and
paste the output; after Round 2 also run node evals/run.mjs with the
strong model (>= 9/10). Commit with dist/. No push. Report and stop.
```
