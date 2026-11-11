import { loadConfig, setScopedMode, SUPPORTED_MODES } from "./config.js";
import { buildSdlcPolicy } from "./sdlc.js";
import { augmentSystemPrompt, buildPolicy, SECTION_KEY } from "./policy.js";
import { KsdRuntime } from "./dist/runtime.js";

const MODE_ENTRY = "engineering-proxy-mode";
const isDisabledByEnv = () => process.env.ENGINEERING_PROXY_DISABLED === "1";

export function parseEngineeringCommand(input) {
  const words = String(input ?? "").trim().toLowerCase().split(/\s+/);
  if (words.length === 1) {
    if (words[0] === "" || words[0] === "status") return { type: "status" };
    if (SUPPORTED_MODES.includes(words[0])) return { type: "set-mode", mode: words[0] };
    if (words[0] === "reset") return { type: "reset-session" };
  }
  if (words.length === 2 && ["global", "repo"].includes(words[0])) {
    if (SUPPORTED_MODES.includes(words[1])) return { type: "set-scoped-mode", scope: words[0], mode: words[1] };
    if (words[1] === "reset") return { type: "reset-scoped-mode", scope: words[0] };
  }

  return { type: "invalid" };
}

function sessionOverride(entries) {
  if (!Array.isArray(entries)) return null;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry?.customType !== MODE_ENTRY) continue;
    if (entry.data?.reset === true) return null;
    if (SUPPORTED_MODES.includes(entry.data?.mode)) return entry.data.mode;
  }

  return null;
}

export function resolveSessionMode(entries, fallback = "balanced") {
  const defaultMode = SUPPORTED_MODES.includes(fallback) ? fallback : "balanced";

  return sessionOverride(entries) ?? defaultMode;
}

const REVIEW_INSTRUCTIONS = `Review the current requested change as Engineering Proxy. This delegation does not run any review code for you: perform the inspection yourself through your permitted tools, following OMP permissions and approvals.

1. Requirements: state the acceptance criteria and what the change must not break. Check requirements, relevant callers and contracts.
2. Scope: inspect the actual diff of tracked changes against the operator's stated base (or HEAD for worktree review), plus intended untracked files (NUL-safe discovery, \`git diff --no-index --no-ext-diff --no-textconv -U0 -- /dev/null <path>\`; exit 1 means differences), deletions and renames. Never stage user files to manufacture scope. A path keyword is a hint, not proof that other files are low risk.
3. Checks: discover the repository's existing check commands first and inspect their safety; declare the applicable required and critical gates, then select typecheck/lint/tests/runtime/CI checks and execute only through permitted tools. Record exact cwd, exit code, output and pass/fail/skip counts. Missing or denied commands and credentials are NOT_RUN or BLOCKED. Never run migrations, database resets or real payments in shared environments.
4. Evidence: a skipped test without required environment is NOT_RUN, not PASS. A CI YAML file is not proof its job exercised the change; inspect actual relevant job and step execution for the reviewed commit and distinguish dirty/untracked behavior it cannot cover. Source-only inspection cannot verify an executed gate. Optional installed ksd-check-changed and ksd-review-verdict validators may be invoked through approved OMP tools with supplied reports and required gates; they do not run checks or authenticate evidence. A tiny review needs no report file: report the observed evidence directly.
5. Risk: escalate Auth, Payments, Database/schema/query changes, RLS/authorization, destructive data operations, secrets and concurrency based on behavior, not filenames. For auth check normal-user denial (cross-tenant, another owner's record, unauthenticated; service-role success is not isolation proof). For payments preserve confirmation, idempotency and replay protection. For databases check constraints, locks, transaction boundaries and migration compatibility. For deletions check scope, cascades and recovery.
6. Style: independently verify the KSD style profile from the Engineering Proxy policy (guard clauses, no nested ternaries, result-vs-throw error split, strict types, why-only comments, blank-line rules), repo conventions and type safety. Review changed scope, not unrelated code.
Report: acceptance criteria, affected contracts/risk, findings anchored to files with severity, exact observed check evidence (commands and results), and missing/denied/skipped/failed checks — then delivery and rollback implications. Never label release or merge readiness with unresolved required or security gates; no auto release/merge/push/deploy. Ponytail review must not be invoked here unless the user separately requested it; do not report a pass you did not observe.`;

export function createExtension(pi, { globalConfigPath } = {}) {
  pi.setLabel?.("Engineering Proxy");
  // One runtime per extension instance: caches must not leak between hosts or tests.
  const runtime = new KsdRuntime(cwd => loadConfig(cwd, { globalConfigPath }), buildPolicy, isDisabledByEnv);

  let isActive = false;
  let selectedSessionMode = null;
  let lastWarning = null;
  const effectiveMode = config => selectedSessionMode ?? config.enforcement;

  const refreshConfig = ctx => runtime.getConfig(ctx?.cwd ?? process.cwd(), true);

  const updateStatus = (ctx, config, notice) => runtime.syncStatus(ctx, isActive, effectiveMode(config), notice);

  function notifyWarningOnce(ctx, message) {
    if (lastWarning === message) return;
    lastWarning = message;
    ctx?.ui?.notify?.(`${message} (${SECTION_KEY})`, "warning");
  }

  function clearWarning() {
    lastWarning = null;
  }

  /**
   * Reconcile the prompt in one call for both enabled and disabled paths.
   * `undefined` policy removes owned guidance; a failed legacy reconciliation is stored and notified
   * once per unchanged warning, never claimed as success.
   */
  function reconcilePrompt(event, ctx, policy) {
    let warned = false;
    const result = augmentSystemPrompt(event, policy, message => {
      warned = true;
      notifyWarningOnce(ctx, message);
    });

    if (warned) return { result, warned: true };
    clearWarning();

    return { result, warned: false };
  }

  function restoreSession(ctx) {
    isActive = false;
    const config = refreshConfig(ctx);
    runtime.invalidateStatus(ctx?.ui);
    const sessionManager = ctx?.sessionManager;

    // getBranch() is authoritative: nullish/malformed/throwing branch data means no session override,
    // never a fallback to all-branches entries.
    if (typeof sessionManager?.getBranch === "function") {
      try {
        selectedSessionMode = sessionOverride(sessionManager.getBranch());
      } catch {
        selectedSessionMode = null;
      }
    } else {
      try {
        selectedSessionMode = sessionOverride(sessionManager?.getEntries?.() ?? []);
      } catch {
        selectedSessionMode = null;
      }
    }

    updateStatus(ctx, config, lastWarning ?? undefined);
  }

  for (const eventName of ["session_start", "session_tree", "session_switch", "session_branch"]) {
    pi.on(eventName, (_event, ctx) => restoreSession(ctx));
  }

  pi.on("agent_start", (_event, ctx) => {
    isActive = true;
    updateStatus(ctx, runtime.getConfig(ctx?.cwd ?? process.cwd()), lastWarning ?? undefined);
  });

  pi.on("agent_end", (_event, ctx) => {
    isActive = false;
    updateStatus(ctx, runtime.getConfig(ctx?.cwd ?? process.cwd()), lastWarning ?? undefined);
  });

  pi.on("before_agent_start", (event, ctx) => {
    const config = refreshConfig(ctx);
    const policy = !config.enabled || isDisabledByEnv() ? undefined : runtime.getPolicy(effectiveMode(config));
    const { result } = reconcilePrompt(event, ctx, policy);
    updateStatus(ctx, config, lastWarning ?? undefined);

    return result;
  });

  pi.registerCommand("engineering-proxy", {
    description: "Engineering policy: status, session mode/reset, global mode/reset, repo mode/reset",
    handler: async (args, ctx) => {
      // Refresh and draw status BEFORE any validation or disabled early return, so a rejected
      // command cannot leave stale status behind.
      const config = refreshConfig(ctx);
      updateStatus(ctx, config, lastWarning ?? undefined);
      const parsed = parseEngineeringCommand(args);
      const enabled = config.enabled && !isDisabledByEnv();

      if (parsed.type === "invalid") {
        ctx.ui?.notify?.("Usage: /engineering-proxy [status|balanced|adaptive|reset|global <balanced|adaptive|reset>|repo <balanced|adaptive|reset>]", "warning");

        return;
      }

      if (parsed.type === "set-mode" || parsed.type === "reset-session") {
        if (!enabled && parsed.type === "set-mode") {
          ctx.ui?.notify?.("Engineering Proxy is disabled; mode unchanged.", "warning");

          return;
        }

        selectedSessionMode = parsed.type === "reset-session" ? null : parsed.mode;
        let persisted = false;
        try {
          if (typeof pi.appendEntry === "function") {
            pi.appendEntry(MODE_ENTRY, parsed.type === "reset-session" ? { reset: true } : { mode: selectedSessionMode });
            persisted = true;
          }
        } catch {
          // Runtime policy still updates, but session mode cannot be replayed.
        }

        updateStatus(ctx, config, lastWarning ?? undefined);
        const effective = effectiveMode(config);
        ctx.ui?.notify?.(`KSD mode: ${effective.toUpperCase()} (${persisted ? "saved in session" : "runtime only; session persistence unavailable"})`, persisted ? "info" : "warning");

        return;
      }

      if (parsed.type === "set-scoped-mode" || parsed.type === "reset-scoped-mode") {
        const mode = parsed.type === "reset-scoped-mode" ? null : parsed.mode;
        try {
          const path = setScopedMode(ctx.cwd, parsed.scope, mode, { globalConfigPath });
          const next = refreshConfig(ctx);
          updateStatus(ctx, next, lastWarning ?? undefined);
          ctx.ui?.notify?.(`KSD ${parsed.scope} ${mode ?? "reset"} saved to ${path}; effective: ${effectiveMode(next).toUpperCase()} (${selectedSessionMode ? "session" : next.enforcementSource})`, "info");
        } catch (error) {
          ctx.ui?.notify?.(`KSD ${parsed.scope} update failed: ${error.message}`, "warning");
        }

        return;
      }

      const names = pi.getCommands?.() ?? [];
      const ponytailFound = Array.isArray(names) && names.some(command => command?.name === "ponytail");
      const msg = `Engineering Proxy: ${enabled ? "ON" : "OFF"}; mode: ${effectiveMode(config).toUpperCase()} (${selectedSessionMode ? "session" : config.enforcementSource}); project default: ${(config.projectEnforcement ?? "unset").toUpperCase()}; global default: ${(config.globalEnforcement ?? "unset").toUpperCase()}; session: ${(selectedSessionMode ?? "inherit").toUpperCase()}; Ponytail command: ${ponytailFound ? "detected" : "not detected/unknown"}; Ponytail mode: not inspected`;
      const warnings = [config.configError, lastWarning].filter(Boolean);
      ctx.ui?.notify?.(warnings.length ? `${msg}; WARNING: ${warnings.join("; ")}` : msg, warnings.length ? "warning" : "info");
    },
  });

  pi.registerCommand("engineering-review", {
    description: "Request a scoped, evidence-based engineering review (Ponytail optional)",
    handler: async (args, ctx) => {
      const config = refreshConfig(ctx);
      updateStatus(ctx, config, lastWarning ?? undefined);
      if (!config.enabled || isDisabledByEnv()) {
        ctx.ui?.notify?.("Engineering Proxy is disabled for this project", "warning");

        return;
      }
      const scope = typeof args === "string" && args.trim() ? `\nReview scope: ${args.trim()}` : "";
      const message = `${REVIEW_INSTRUCTIONS}\n\n${buildSdlcPolicy({ mode: effectiveMode(config) })}${scope}`;
      // Explicit operator command only: no automatic Ponytail invocation.
      if (ctx.isIdle?.() === false) {
        pi.sendUserMessage(message, { deliverAs: "followUp" });
      } else {
        pi.sendUserMessage(message);
      }
    },
  });
}

export default createExtension;
