# KSD Engineering Skills Catalog & AGY / OMP Integration

KSD (`ksd-intelligence`) acts as the **primary orchestrator** for evidence-backed code intelligence and engineering skill routing across both **Antigravity (AGY)** and **Oh My Pi (OMP)**.

## 1. Platform-Agnostic Skill Catalog

KSD ships a reusable, platform-agnostic skill catalog under `skills/` (backed by the typed registry in `src/workflow/packs.ts`) with zero runtime dependency on user-home paths:

| Skill | Role | Activation | Upstream Attribution |
|---|---|---|---|
| `ksd-intelligence` | Primary orchestrator (`ei_status`, `ei_impact`, `ei_workflow`, `ei` CLI) | Auto | Local KSD (`ksd-intelligence`, MIT) |
| `matt-sdlc` | Requirements, specs, domain modeling, TDD, implementation, debugging, REQ audit | Auto | Matt Pocock (`mattpocock/skills`, `skills/engineering/`, MIT) |
| `pstack-analysis` | Architecture, investigation, root cause, design rationale, blast radius | Auto | Lauren Tan / poteto (`cursor/plugins`, `pstack/skills/`, MIT) |
| `poteto-mode` | Deep engineering & complex multi-phase execution | **Explicit opt-in only** (`disable-model-invocation: true`) | Lauren Tan / poteto (`cursor/plugins`, `pstack/skills/poteto-mode/SKILL.md`, MIT) |
| `osmani-quality` | UI verification, browser testing, accessibility, API contracts, security, performance, quality gates, release | Auto | Addy Osmani (`addyosmani/agent-skills`, `skills/`, MIT) |

Pinned upstream leaf `SKILL.md` files continue to be read at runtime from local checkouts configured via `EI_MATT_ROOT`, `EI_POTETO_ROOT`, and `EI_OSMANI_ROOT`, verified against SHA-256 hashes in `skills.lock.json`.

### Shared Registry & Lockfile (`skills.registry.json` + `skills.lock.json`)

Both AGY and OMP consume the exact same approved upstream versions from two synchronized files:

- **`skills.registry.json`** (`src/workflow/registry.ts`): Declares upstream repositories, `rootSubpath`, pinned commit SHAs, licenses/attribution, pack dependencies (`providers`, `leafSkills`, `packs`), supported runtimes (`["agy", "omp"]`), and KSD-owned local adaptation metadata (`wrapperPath`, `localPolicyOwner`, runtime notes). Keeps upstream content strictly separated (`adaptationBoundary: "upstream-read-only"`) from frozen local KSD policy (`src/policy/`).
- **`skills.lock.json`** (`src/workflow/sources.ts`): Pins exact 40-char git commits and SHA-256 hashes for every allowlisted upstream `SKILL.md`.
- `validateRegistryConsistency()` rejects any commit/repo drift between the registry and lockfile, cyclic or missing dependencies, dropped runtime support, `poteto-mode` opt-in violations, or policy boundary violations.

## 2. Skill Routing Matrix

KSD enforces **one primary workflow owner per stage**. Secondary skills are invoked only when justified (high risk, explicit REQ compliance review, or explicit `poteto-mode` opt-in). `mayMerge` and `mayDeploy` are always `false`.

### Primary Owner per Task Type × Stage

| Task Type | `plan` | `investigate` | `implement` | `verify` | `review` | `ship` |
|---|---|---|---|---|---|---|
| `feature` | `osmani-quality` (`osmani:spec-driven-development`) | `pstack-analysis` (`poteto:how`) | `matt-sdlc` (`matt:tdd`) | `osmani-quality` (`osmani:code-review-and-quality`) | `matt-sdlc` (`matt:code-review`) | `osmani-quality` (`osmani:shipping-and-launch`) |
| `bug` | `matt-sdlc` (`matt:diagnosing-bugs`) | `matt-sdlc` (`matt:diagnosing-bugs`) | `matt-sdlc` (`matt:tdd`) | `osmani-quality` (`osmani:code-review-and-quality`) | `pstack-analysis` (`poteto:blast-radius`) | `osmani-quality` (`osmani:shipping-and-launch`) |
| `refactor` / architecture | `matt-sdlc` (`matt:codebase-design`) | `pstack-analysis` (`poteto:how`) | `osmani-quality` (`osmani:incremental-implementation`) | `osmani-quality` (`osmani:code-review-and-quality`) | `pstack-analysis` (`poteto:blast-radius`) | `osmani-quality` (`osmani:shipping-and-launch`) |
| `security` | `osmani-quality` (`osmani:security-and-hardening`) | `matt-sdlc` (`matt:diagnosing-bugs`) | `matt-sdlc` (`matt:tdd`) | `osmani-quality` (`osmani:security-and-hardening`) | `pstack-analysis` (`poteto:blast-radius`) | `osmani-quality` (`osmani:shipping-and-launch`) |
| `performance` | `osmani-quality` (`osmani:performance-optimization`) | `pstack-analysis` (`poteto:why`) | `osmani-quality` (`osmani:incremental-implementation`) | `osmani-quality` (`osmani:performance-optimization`) | `pstack-analysis` (`poteto:blast-radius`) | `osmani-quality` (`osmani:shipping-and-launch`) |
| `ui` | `osmani-quality` (`osmani:frontend-ui-engineering`) | `pstack-analysis` (`poteto:how`) | `osmani-quality` (`osmani:frontend-ui-engineering`) | `osmani-quality` (`osmani:browser-testing-with-devtools`) | `pstack-analysis` (`poteto:blast-radius`) | `osmani-quality` (`osmani:shipping-and-launch`) |

### Justified Secondary Invocations & Gates

| Trigger | Secondary Pack / Skill | Reason Code | Notes |
|---|---|---|---|
| `risk: "high"` at `review` | `pstack-analysis` (`poteto:blast-radius`) | `high-risk-review` | Deduplicated when already primary |
| `risk: "high"` at `verify` | `osmani-quality` (`osmani:security-and-hardening`) | `high-risk-verify` | Deduplicated when already primary |
| REQ mismatch / compliance terms at `review` | `matt-sdlc` (`matt:code-review`) | `requirement-compliance` | Ensures REQ audit runs even on bug/refactor/ui reviews |
| REQ mismatch / compliance terms at `verify` | `matt-sdlc` (pack note) | `requirement-compliance` | Keeps primary verification leaf skill intact |
| Explicit `potetoMode: true` (`--poteto-mode`) | `poteto-mode` (`skills/poteto-mode/SKILL.md`) | `explicit-opt-in` | Never auto-enabled from task keywords; KSD stays primary orchestrator |

### Requirement Compliance Gate (`REQ × Code × Test × Runtime Evidence`)

Active automatically on `verify`, `review`, `ship`, and on any task mentioning requirements, specs, acceptance criteria, or REQ mismatches:

1. **REQ** — Enumerate every approved requirement and constraint.
2. **Code** — Confirm implementation satisfies each requirement without out-of-scope edits.
3. **Test** — Verify automated tests cover behavior and can fail when broken.
4. **Runtime Evidence** — Attach observed output (`VERIFIED` | `MOCK-ONLY` | `NOT VERIFIED`).

## 3. Native Adapter Compatibility

### Antigravity (AGY)

- **Native Skill Discovery & Path Detection**: `detectAgyPaths()` and `discoverAgySkills()` (`src/adapters/agy/skills.ts`) dynamically detect workspace (`.agents/skills`, `.agents/skills.json`), Snap (`$ANTIGRAVITY_APP_DATA_DIR/skills`, `$SNAP_USER_COMMON/.gemini/antigravity-cli/skills`, `<realHome>/snap/antigravity-cli/common/.gemini/antigravity-cli/skills`), global (`~/.gemini/config/skills`, `~/.gemini/antigravity-cli/skills`), shared (`~/.agents/skills`), and KSD catalog (`skills/`) paths using `SNAP_REAL_HOME` / OS home — never hardcoding any username.
- **Precedence (never overwrites user customizations)**:
  `workspace .agents/skills` > `.agents/skills.json` > `snap` > `global` > `shared` > `ksd:catalog`.
- **Portable Configuration**: Copy `docs/examples/antigravity-skills.json` into a workspace's `.agents/skills.json` and point `entries[0].path` to the KSD `skills` directory (relative or explicit path; no user-home hardcoding).
- **MCP Tool Bridge**: `scripts/agy-mcp.mjs --root <REPO_ROOT> --workflow` exposes `ei_workflow` with optional `potetoMode?: boolean`, alongside `ei_status` and `ei_impact`.
- **Audit CLI**: `ei skills check --platform agy [--root <WORKSPACE>] [--detect-host]` validates discovery, registry/lock consistency, containment, frontmatter, opt-in enforcement, and absence of Cursor-only calls or recursive orchestration.

### Oh My Pi (OMP)

- **Profile, `RULES.md` & Config Awareness**: `detectOmpEnvironment()` and `discoverOmpSkills()` (`src/adapters/omp/skills.ts`) resolve the active OMP profile (`--profile` / `OMP_PROFILE` / `PI_CODING_AGENT_DIR` / `OMP_AGENT_DIR` -> `~/.omp/profiles/<name>/agent` or `~/.omp/agent`), inspect project `.omp/RULES.md` and user `<agentDir>/RULES.md`, detect `config.yml`, `settings.json`, and `engineering-proxy.json`, and preserve existing symlinked user skills (`~/.omp/agent/skills/* -> ~/.agents/skills/*`).
- **Marketplace Plugin Discovery**: `.omp-plugin/marketplace.json` declares `"source": "./"`. OMP's marketplace discovery (`@oh-my-pi/pi-coding-agent` `claude-plugins.ts`, priority 70) scans `<plugin-root>/skills/<name>/SKILL.md` automatically.
- **Precedence (never overwrites user customizations)**:
  `project .omp/skills` > active profile/user `<agentDir>/skills` > shared `~/.agents/skills` > KSD plugin `skills/` (priority 70).
- **Explicit Opt-In Enforcement**: `skills/poteto-mode/SKILL.md` declares `disable-model-invocation: true`, which OMP's `skill.ts` natively honors by hiding it from automatic prompt listing while keeping `/skill:poteto-mode` and `skill://poteto-mode` available for explicit user opt-in.
- **Extension Tool**: `src/adapters/omp/extension.ts` registers `ei_workflow` with optional `potetoMode?: boolean` (using `pi.zod.boolean()`, verified in OMP 19.0.1 `@oh-my-pi/omptype/src/zod.ts`), keeping KSD policy module registration and default `details` shape backward-compatible.
- **Audit CLI**: `ei skills check --platform omp [--root <WORKSPACE>] [--profile <name>] [--detect-host]`.

## 4. Reproducible Update Lifecycle, Rollback & GitLab CI

Updates update upstream pins **once** for both AGY and OMP while preserving all local KSD adaptations (`skills/`, `ksdAdaptation`, `src/policy/`):

```text
Check upstream -> Diff -> Validate dependencies -> Test AGY & OMP -> Approve -> Atomic Publish (+ Rollback)
```

### CLI Workflow

```bash
# 1. Inspect upstream checkouts (detects added, removed, hash-matched renames, changed skills,
#    breaking dependency removals, opt-in regressions, and unexecuted upstream scripts/hooks)
EI_MATT_ROOT="<MATT_CHECKOUT>" \
EI_POTETO_ROOT="<PSTACK_CHECKOUT>" \
EI_OSMANI_ROOT="<OSMANI_CHECKOUT>" \
ei skills diff

# 2. Stage & validate against registry/dependencies + both AGY and OMP runtimes
#    (never mutates live skills.lock.json or skills.registry.json)
ei skills sync

# 3. Review staged diff, then approve and atomically activate both lockfile & registry
#    (records a rollback snapshot first; refuses to publish blocked stages or without --approve)
ei skills publish --stage-id <stage-id> --approve

# 4. Atomic rollback to the previous approved release if needed
ei skills rollback [--release <release-id>]
```

### GitLab CI Automation (`.gitlab-ci.yml`)

- **`verify:unified-skills`** (MRs & `main`): runs `typecheck`, `lint`, `format:check`, `npm test`, `check:dist`, and `ei skills check` for both `--platform agy` and `--platform omp`.
- **`skills-update-check`** (scheduled / manual): sets `core.hooksPath=/dev/null` so upstream git hooks never run, clones upstream checkouts read-only, runs `scripts/ci/check-skills-updates.mjs` to stage and validate for both AGY and OMP, emits Markdown & JSON report artifacts, and (when `PROPOSE_MR=true` + `GITLAB_TOKEN` are set) proposes a **Draft Merge Request** with `merge_when_pipeline_succeeds: false`. Auto-merge is never enabled.

## 5. Safety, Anti-Recursion & Compatibility Guardrails

- **Single Orchestrator**: `ksd-intelligence` is always `orchestrator`. Competing automatic routers (`ask-matt`, `using-agent-skills`, `poteto-mode`, `swarm`) are never auto-enabled.
- **No Cursor-Only Leakage**: Bundled skills and the catalog auditor reject Cursor-only directives (`subagent_type: "poteto-agent"`, hardcoded Cursor model slugs, Cursor cloud `Task` parameters, `AskQuestion`).
- **No User-Home Paths**: Runtime catalog resolution uses `import.meta.url` relative to the package root; the auditor flags `/home/...`, `/Users/...`, or `C:\Users\...` paths in skill files.
- **Fail Closed on Trust, Fail Open on Advice**: Symlink escapes, oversize files (> 64 KiB), missing frontmatter, SHA-256 mismatches, or `poteto-mode` missing `disable-model-invocation: true` are rejected.
- **No Unapproved Side Effects**: Skills are instructions only; KSD never executes skill scripts, bypasses approvals, pushes, merges, or deploys.

## 6. Known Gaps & Limitations

- **Live AGY / OMP Host UI Smoke**: Automated tests verify the TypeScript catalog, router, discovery adapters, CLI subprocesses, and AGY MCP stdio protocol directly, while OMP extension tool execution is `MOCK-ONLY` until re-run inside a live OMP 19.0.1 session (`omp -p --no-extensions -e dist/adapters/omp/extension.js`). Live AGY IDE/CLI host discovery remains `NOT VERIFIED` until exercised in a real AGY workspace session.
- **Pinned Leaf Subset**: `skills.lock.json` currently pins 15 upstream leaf skills (4 Matt, 3 pstack, 8 Osmani). Additional upstream playbooks listed as references inside each pack (such as `matt:grill-with-docs`, `pstack:architect`, or `osmani:accessibility-engineering`) are documented references, not yet individually hash-pinned in `skills.lock.json` (and `accessibility-engineering` requires a newer upstream Osmani checkout than pinned commit `301b02b1`).
- **AGY `disable-model-invocation` Enforcement**: OMP enforces `disable-model-invocation: true` natively in `src/capability/skill.ts`; in AGY, `ei_workflow` enforces opt-in programmatically via `potetoMode: true`, while native AGY slash-skill hiding depends on AGY host support (users can also add `"exclude": ["poteto-mode"]` in `.agents/skills.json` if they want `poteto-mode` hidden from AGY's passive skill index).
