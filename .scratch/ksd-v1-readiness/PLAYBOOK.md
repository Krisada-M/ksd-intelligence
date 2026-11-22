# KSD Intelligence — Agent Execution Playbook (Weak-Model-Safe)

Read this file BEFORE starting ANY ticket in `.scratch/ksd-v1-readiness/issues/`. Every rule here is concrete and non-negotiable.

---

## 1. Environment Bootstrap (Copy-Paste First)

Inside Antigravity (Snap) or a clean shell, `node`, `npm`, `bun`, and `omp` may not be on default `PATH`, and Snap rewrites `HOME` to `~/snap/antigravity-cli/common`. Always run this prefix in shell commands:

```bash
export REAL_HOME="${SNAP_REAL_HOME:-$HOME}"
export HOME="$REAL_HOME"
export PATH="$REAL_HOME/.local/share/fnm/aliases/default/bin:$REAL_HOME/.local/share/fnm/node-versions/v24.21.0/installation/bin:$REAL_HOME/.bun/bin:$PWD/node_modules/.bin:$PATH"
node -v && npm -v && bun --version && omp --version
```

Expected minimum versions: Node `>= 22.5` (v24.x), Bun `1.4.x`, OMP `19.0.1+`.

Before editing anything, sync with `origin/main`:

```bash
git fetch origin
git status --short
git log -n 5 --oneline origin/main
```

Never branch from stale local `main` when `origin/main` is ahead; branch from `origin/main` unless the ticket names an existing milestone branch.

---

## 2. Hard Red Lines (Violating Any = Immediate Failure)

1. **Protected paths — DO NOT EDIT** unless the owner explicitly approves (CI blocks PRs without label `owner-approved`):
   - `tests/golden/**`
   - `src/policy/**`
   - `tests/policy/**`
   - `tests/snapshots/**`
2. **Never weaken, skip, or delete an existing test** to get green. If an existing test fails, fix your code or stop and report with evidence.
3. **Never touch user machine config** (`~/.omp/**`, `~/.gemini/**`, `~/snap/antigravity-cli/**`) unless the owner explicitly authorizes that exact file.
4. **Never add a runtime npm dependency** without owner approval. Allowed runtime dependency: pinned `typescript` (`eiRuntime.typescript`). SQLite uses built-in `node:sqlite`.
5. **Never add network calls** in library code (only `ei setup` uses the network).
6. **Never commit secrets, tokens, or personal paths** (`/home/<user>`, `/Users/<user>`).
7. **Never `git push`, `git merge`, `git tag`, or deploy.** Commit locally only when the ticket/brief explicitly says so.
8. **Never commit indexer-injected blocks** in `AGENTS.md` / `CLAUDE.md` (GitNexus, Graft, CodeGraph). If seen, run `git checkout -- AGENTS.md`. Leave untracked `.cgcignore`, `.claude/`, `.codegraph/` untouched.
9. **Honest evidence labels (mandatory on every claim):**
   - `VERIFIED`: you ran the exact command and pasted the observed output.
   - `MOCK-ONLY`: tested against a stub/mock (never call this "OMP compatible" or "live verified").
   - `NOT VERIFIED`: not executed.
   - `PROPOSED`: drafted for owner approval (e.g., new golden cases or snapshots).

---

## 3. Repository Traps (Avoid These Known Pitfalls)

| Trap | Why It Bites Weak Models | Exact Rule |
|---|---|---|
| `dist/` drift | Marketplace plugins load committed `dist/`. Editing `src/` without rebuilding breaks CI `check:dist`. | Always run `npm run build` and stage `dist/` with `src/`. Verify `npm run check:dist`. |
| `dist-test/` path depth | Tests compile `src/` into `dist-test/src/...` (1 directory deeper than `src/` and `dist/`). | Resolve repo-root files by walking up until `package.json` exists (see `defaultLockPath()` / `defaultSkillsDir()`). |
| Global gitignore hides `SKILL.md` | `~/.config/git/ignore` may ignore `SKILL.md`. | Keep `!skills/**/SKILL.md` in `.gitignore`; check `git status -uall`. |
| `engine <version>` in impact snapshots | `engineVersion()` reads `package.json#version`, which appears in `tests/snapshots/impact/*.txt`. | Do NOT bump `package.json#version` during feature milestones; only bump in explicit release PRs with owner approval. |
| `C01–C26` golden tests vs default `riskZones` | M2b golden cases were confirmed WITHOUT risk zones. | When implementing M2c risk zones, pass `riskZones: []` explicitly in C01–C26 test setup so they remain unchanged. |
| `omp-extension.test.ts` exact `details` | `tests/workflow/omp-extension.test.ts` uses `assert.deepEqual` on default `ei_workflow` `details`. | Never add unconditional keys to existing `ei_workflow` `details` without checking `omp-extension.test.ts`. |
| Layer boundary (`src/workflow/**`) | Capabilities must not import each other (`DESIGN §5.1`). | `src/workflow/**` must NEVER import `src/core/impact/**` or `src/core/changes/**`. Stage protocol is text only. |
| Untrusted input in git / FTS5 | User strings (`base`, `query`) can contain flags (`--upload-pack`) or FTS5 operators (`NEAR`, `OR`, `"`, `*`). | Call `execFile('git', [..., '--', ...])` with fixed args (no shell); quote every FTS5 term as a literal. |

---

## 4. Standard Verification Gate (Run Before Every Commit / Report)

```bash
export HOME="${SNAP_REAL_HOME:-$HOME}"
export PATH="$HOME/.local/share/fnm/node-versions/v24.21.0/installation/bin:$HOME/.bun/bin:$PATH"

npm run typecheck
npm run lint
npm run format:check
npm test
npm run check:dist
npm run verify:skills
git grep -nE "/home/|/Users/|C:\\\\Users\\\\" -- src/ scripts/ skills/ || echo "CLEAN"
node scripts/check-protected-paths.mjs origin/main HEAD
```

All commands must exit `0` (except `check-protected-paths.mjs` only when owner explicitly approved a protected change, in which case state why in the report).

---

## 5. Required Session Report Template

End every session with this exact block (copied from `AGENTS.md`):

```text
STATUS: IMPLEMENTED | VERIFIED | PARTIAL | BLOCKED
MILESTONE: <ticket / milestone / round>
MODEL: <exact model name>
SCOPE: [exact changed paths]
ACCEPTANCE: [each criterion -> exact command + observed result -> VERIFIED | MOCK-ONLY | NOT VERIFIED | PROPOSED]
COMMANDS EXECUTED: [exact commands + key output]
RUNTIME: [OS, arch, Node version, Bun version, OMP/AGY version if used]
NOT VERIFIED: [explicit list of everything not run]
DEVIATIONS FROM BRIEF: [what and why, or "none"]
QUESTIONS FOR OWNER: [list, or "none"]
GIT: [branch, local commits, uncommitted files; confirm nothing pushed]
NEXT COMMAND: [exact single next command for the owner or next round]
```
