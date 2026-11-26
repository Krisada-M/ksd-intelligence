import { KSD_MODES } from "./sdlc.js";
// Keep this policy orthogonal to Ponytail's simplicity and over-engineering guidance.
export const SECTION_KEY = "erosiano-dev";
export const POLICY_MARKER = "[erosiano-dev Policy]";
export const POLICY_END = "[End erosiano-dev Policy]";
/** A complete line consisting only of a policy marker: the stable marker or a numbered legacy version. */
const COMPLETE_MARKER_LINE = /^\[(?:Engineering Proxy|erosiano-dev) Policy(?: v\d+(?:\.\d+)*)?\]\r?$/;
/** An array element is owned when it BEGINS with the stable or a numbered legacy marker (existing array contract). */
const LEADING_MARKER = /^\[(?:Engineering Proxy|erosiano-dev) Policy(?: v\d+(?:\.\d+)*)?\]/;
const changed = (next, base) => next !== base;
/**
 * Locate complete owned blocks in a string prompt: each runs from a dedicated marker line to the next
 * end-marker line. A marker line that is never closed, or one that is met again before its end, leaves the
 * block unterminated and the whole correction denied (never guess its end or drop unrelated content).
 */
function findStringBlocks(base) {
    const lines = [];
    let position = 0;
    while (position < base.length) {
        const newlineAt = base.indexOf("\n", position);
        const end = newlineAt === -1 ? base.length : newlineAt + 1;
        lines.push({ text: base.slice(position, newlineAt === -1 ? base.length : newlineAt), start: position, end });
        if (newlineAt === -1)
            break;
        position = end;
    }
    const blocks = [];
    let unterminated = false;
    let index = 0;
    while (index < lines.length) {
        const line = lines[index];
        if (!COMPLETE_MARKER_LINE.test(line.text)) {
            index += 1;
            continue;
        }
        const expectedEnd = line.text.startsWith("[Engineering Proxy Policy") ? "[End Engineering Proxy Policy]" : POLICY_END;
        let blockEnd = -1;
        for (let probe = index + 1; probe < lines.length; probe++) {
            const candidate = lines[probe];
            if (candidate.text.replace(/\r$/, "") === expectedEnd) {
                blockEnd = candidate.start + expectedEnd.length;
                index = probe + 1;
                break;
            }
            if (COMPLETE_MARKER_LINE.test(candidate.text) || candidate.text.replace(/\r$/, "") === POLICY_END || candidate.text.replace(/\r$/, "") === "[End Engineering Proxy Policy]") {
                unterminated = true;
                break;
            }
        }
        if (blockEnd < 0) {
            unterminated = true;
            break;
        }
        blocks.push({ start: line.start, end: blockEnd });
    }
    return { blocks, unterminated };
}
/** Remove every complete owned block, preserving unrelated bytes, and insert at most one policy where the first block stood. */
function reconcileString(base, policy, warn) {
    const { blocks, unterminated } = findStringBlocks(base);
    if (unterminated) {
        warn?.("erosiano-dev could not replace/remove an unterminated legacy policy; restart the session.");
        return undefined;
    }
    if (blocks.length === 0) {
        if (policy === undefined)
            return undefined; // Nothing owned to remove; keep the prompt as-is.
        if (base === "")
            return policy;
        const next = `${base}\n\n${policy}`;
        return changed(next, base) ? next : undefined;
    }
    const strippedParts = [];
    let cursor = 0;
    for (const block of blocks) {
        strippedParts.push(base.slice(cursor, block.start));
        cursor = block.end;
    }
    strippedParts.push(base.slice(cursor));
    const stripped = strippedParts.join("");
    const next = policy === undefined ? stripped : base.slice(0, blocks[0].start) + policy + stripped.slice(blocks[0].start);
    return changed(next, base) ? next : undefined;
}
export function buildPolicy({ enforcement = "balanced" } = {}) {
    if (!KSD_MODES.includes(enforcement))
        throw new Error("Unsupported KSD enforcement mode");
    const cleanCode = enforcement === "adaptive"
        ? "Adaptive Clean Code: flat by default. Guard clauses/early returns; no else after return or nesting avoidable by guards or combined conditions. Changed-code review: FIX REQUIRED for behavior-preserving fixes; WARN if behavior-sensitive. Never weaken security, transactions or error handling."
        : "Balanced Clean Code: prefer behavior-preserving guards/early returns; nesting findings are advisory.";
    return `${POLICY_MARKER}
erosiano-dev personal style. Explicit user requirements and current repo conventions take precedence.
${cleanCode}
- No nested ternaries; use if, named helper or lookup map.
- One blank before return after 2+ preceding statements in the same block; optional after one, none for first-statement return. One blank between adjacent implementations, not TS overloads.
- Prefer typed domain results (discriminated unions); throw IO/infrastructure errors, catch at boundary. Preserve project error contracts and causes.
- No any, \`as\` casts except \`as const\`, or non-null \`!\`; type guards, explicit exported return types.
- Extract helpers for reuse or clearer callers, not length. Comments: one line explaining why, not what.
- Before substantial changes, establish a scoped project baseline: instructions, native gates, maintained code/tests. Distinguish current, legacy and unknown; refresh stale evidence. Preserve architecture, contracts, validation, accessibility; no unrelated refactors. Never copy insecure legacy behavior.
- Select applicable practices after baseline via permitted resolver/catalog; never inject entire catalog.
- Ponytail owns YAGNI/simplification and /ponytail-review; don't duplicate or invoke it.
- Risky auth/authorization, payments, DB schema/queries/RLS, destructive data, secrets, concurrency: prove normal-user denial (cross-tenant/other owner/unauthenticated); preserve idempotency/replay protection, check constraints/locks/transactions/migration compatibility. Never run real payments or destructive shared-DB checks.
- Validate runtime boundaries, handle promise rejection/exhaustive states. Never weaken types, security or tests, invent APIs or fake production success.
- Never claim a check passed without running it.
Enforcement=${enforcement}: native gates authoritative; deterministic only if adopted. SDLC: /erosiano-dev review.
${POLICY_END}`;
}
/** Reconcile a string or array fallback prompt: remove owned guidance, or replace it with exactly one policy. */
function reconcileFallback(base, policy, warn) {
    if (typeof base === "string") {
        const next = reconcileString(base, policy, warn);
        return next === undefined ? undefined : { systemPrompt: next };
    }
    const owned = base
        .map((part, index) => (typeof part === "string" && LEADING_MARKER.test(part) ? index : -1))
        .filter(index => index >= 0);
    if (owned.length === 0) {
        return policy === undefined ? undefined : { systemPrompt: [...base, policy] };
    }
    if (owned.length === 1 && base[owned[0]] === policy)
        return undefined;
    if (policy === undefined) {
        return { systemPrompt: base.filter((_part, index) => !owned.includes(index)) };
    }
    // Exactly one owned element survives: unrelated order preserved, extra owned elements dropped.
    return { systemPrompt: base.flatMap((part, index) => {
            if (owned.includes(index))
                return index === owned[0] ? [policy] : [];
            return [part];
        }) };
}
export function augmentSystemPrompt(event, policy, warn) {
    const sections = event?.systemPromptOptions?.sections;
    // Do not add a structured policy if an unterminated fallback cannot be removed.
    if (sections && typeof sections === "object") {
        let failed = false;
        const fallback = event?.systemPrompt === undefined ? undefined : reconcileFallback(event.systemPrompt, undefined, message => {
            failed = true;
            warn?.(message);
        });
        delete sections["engineering-proxy"];
        if (policy === undefined || failed)
            delete sections[SECTION_KEY];
        else
            sections[SECTION_KEY] = policy;
        return fallback;
    }
    return event?.systemPrompt === undefined
        ? (policy === undefined ? undefined : { systemPrompt: policy })
        : reconcileFallback(event.systemPrompt, policy, warn);
}
