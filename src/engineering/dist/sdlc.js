/** Lightweight SDLC guidance; not an automatic release gate. */
export const KSD_MODES = Object.freeze(["balanced", "adaptive"]);
export const SDLC_PHASES = Object.freeze([
    "Requirements",
    "Design",
    "Implementation",
    "Verification",
    "Delivery",
]);
const REVIEW_GUIDANCE = "Review ownership/authorization by testing normal-user denial (cross-tenant, another owner's record, unauthenticated); a service-role or admin success alone never proves isolation. Where payments are affected, preserve confirmation, idempotency and replay protection and never execute real provider transactions. Where databases are affected, check constraints, locks and transaction boundaries, and migration compatibility with existing data; review deletion scope, cascades and recovery paths. Never invent TTL, provider, or retention semantics, and never run real payment or destructive shared-database checks.";
export function buildSdlcPolicy({ mode = "balanced" } = {}) {
    if (!KSD_MODES.includes(mode))
        throw new Error("Invalid SDLC policy mode");
    return [
        "SDLC workflow (proportional to the actual change; never fabricate evidence or create unnecessary documents):",
        "1. Requirements: identify intent, acceptance criteria, affected users/contracts and unknowns before changing behavior. State a short acceptance note for UI/cosmetic work and focused checks instead of document ceremony.",
        "2. Design: inspect existing callers, architecture, data flow and invariants. Compare only relevant alternatives; avoid speculative abstraction or redesign.",
        "3. Implementation: smallest behavior-preserving change, guard clauses where clearer, no unrelated churn. Apply repo conventions and Ponytail simplification without duplicating it.",
        "4. Verification: select tests by impact; verify negative/error cases, contracts, types and security when relevant. Distinguish skipped, missing, and actually executed gates.",
        "5. Delivery: summarize changed files, test commands/results, remaining risks, rollback impact and explicit approval blockers. Never automatically push, merge or deploy.",
        "Escalate on behavior in either mode, not filenames: Auth, Payments, Database/schema/query changes, row-level security/authorization, destructive data operations, secrets and concurrency require stronger design and security evidence. " + REVIEW_GUIDANCE,
        "When a requirement is unclear, ask or mark it UNKNOWN instead of inventing policy, TTL, database state or provider behavior.",
        mode === "adaptive"
            ? "Adaptive emphasis: use the lightest sufficient SDLC evidence for each change, but escalate on risky contracts or behavior. Keep control flow flat where semantics allow."
            : "Balanced emphasis: preserve the repository's established checkpoints, with explicit evidence for all applicable gates.",
    ].join("\n");
}
