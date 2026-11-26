#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STATES = new Set(["VERIFIED", "PARTIAL", "NOT_RUN", "BLOCKED", "FAILED", "FIX_REQUIRED", "UNVERIFIED"]);
const RESERVED_EXECUTION_IDS = new Set(["typecheck", "lint", "tests", "runtime", "security"]);
const COUNT_KEYS = ["passed", "failed", "skipped"];

/**
 * Strict "executable evidence present" shape. Legacy command reports without exit code or cwd
 * are accepted as input but cannot verify an executed command via this predicate.
 */
export function hasEvidence(gate) {
  const e = gate?.evidence;
  if (!e || typeof e !== "object") return false;
  if (e.type === "command") {
    return typeof e.command === "string" && !!e.command.trim() &&
      typeof e.cwd === "string" && !!e.cwd.trim() &&
      typeof e.result === "string" && !!e.result.trim() &&
      e.exitCode === 0 &&
      e.timedOut !== true && e.signal == null;
  }
  if (e.type === "source") return typeof e.path === "string" && !!e.path.trim() && typeof e.observation === "string" && !!e.observation.trim();
  if (e.type === "ci-run") return typeof e.url === "string" && /^https:\/\//.test(e.url) && e.conclusion === "success";

  return false;
}

const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function ciRunEvidenceValid(evidence, reviewedCommit) {
  if (evidence.type !== "ci-run" || evidence.conclusion !== "success") return false;
  if (typeof evidence.url !== "string" || typeof evidence.headSha !== "string" || !GIT_OID.test(evidence.headSha)) return false;
  let parsed;
  try {
    parsed = new URL(evidence.url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) return false;

  if (parsed.username || parsed.password) return false;

  return typeof reviewedCommit === "string" && GIT_OID.test(reviewedCommit) && reviewedCommit === evidence.headSha;
}

function validateTestCounts(evidence) {
  const counts = evidence.testCounts;
  if (counts === undefined) return null;
  if (counts === null || typeof counts !== "object" || Array.isArray(counts)) {
    throw new Error("testCounts must be an object when supplied");
  }
  const read = {};
  for (const key of COUNT_KEYS) {
    const value = counts[key];
    if (value === undefined) { read[key] = 0; continue; }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`testCounts.${key} must be a nonnegative integer`);
    }
    read[key] = value;

  }

  return read;
}

/**
 * A deterministic evidence summary, not a substitute for human release approval.
 * In particular, CI coverage is only VERIFIED with a successful cited CI run matching the
 * reviewed commit; supplied evidence is never authenticated.
 */
export function assessReview({ scope = "code-review", gates, requiredGates = [], reviewedCommit } = {}) {
  if (!["code-review", "release"].includes(scope)) throw new Error("Invalid scope");
  if (gates !== undefined && !Array.isArray(gates)) throw new Error("gates must be an array");
  if (!Array.isArray(requiredGates)) throw new Error("requiredGates must be an array");
  if (reviewedCommit !== undefined && !GIT_OID.test(reviewedCommit)) {
    throw new Error("reviewedCommit must be a 40- or 64-hex Git object id");
  }

  const declared = new Map();
  for (const required of requiredGates) {
    if (!required || typeof required !== "object" || Array.isArray(required)) {
      throw new Error("Each requiredGate must be an object with an id");
    }
    validateId(required, "requiredGate");
    validateFlag(required, "required", "requiredGate");
    validateFlag(required, "critical", "requiredGate");
    if (required.required === false) {
      throw new Error("A requiredGate entry cannot declare itself not required");
    }
    const id = required.id.trim();
    if (declared.has(id)) throw new Error(`Duplicate required gate id: ${id}`);
    declared.set(id, required.critical === true);
  }

  const normalized = (gates ?? []).map(gate => {
    if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
      throw new Error("Each gate must be an object with an id and a status");
    }
    validateId(gate, "gate");
    validateFlag(gate, "required", "gate");
    validateFlag(gate, "critical", "gate");
    if (gate.status === undefined || !STATES.has(gate.status)) {
      throw new Error("Each gate needs an id and a supported status");

    }

    return { ...gate, id: gate.id.trim() };
  });

  const seen = new Set();
  for (const gate of normalized) {
    if (seen.has(gate.id)) throw new Error(`Duplicate gate id: ${gate.id}`);
    seen.add(gate.id);
  }

  // Missing declared gates are synthesized as required NOT_RUN; declared critical beats supplied false.
  for (const [id, critical] of declared) {
    if (seen.has(id)) {
      const supplied = normalized.find(g => g.id === id);
      supplied.required = true;
      if (critical) supplied.critical = true;
      continue;
    }
    normalized.push({ id, status: "NOT_RUN", required: true, critical });
    seen.add(id);
  }

  if (normalized.length === 0) {
    return { verdict: "NOT_ASSESSED", gates: [], reasons: ["No gates were supplied"] };
  }

  const results = normalized.map(gate => {
    const counts = validateTestCounts(gate.evidence ?? {});
    const normalizedGate = { ...gate };

    if (gate.evidence?.type === "command" &&
        ((Number.isInteger(gate.evidence.exitCode) && gate.evidence.exitCode !== 0) || (counts !== null && counts.failed > 0))) {
      normalizedGate.status = "FAILED";
    } else if (gate.status === "VERIFIED") {
      normalizedGate.status = normalLife(gate, counts, reviewedCommit);
    }

    normalizedGate.required = normalizedGate.required !== false || normalizedGate.critical === true;
    normalizedGate.critical = normalizedGate.critical === true;

    normalizedGate.evidenceValid = normalizedGate.status === "VERIFIED";

    return normalizedGate;
  });

  const required = results.filter(g => g.required);
  if (!required.length) {
    return { verdict: "NOT_ASSESSED", gates: results, reasons: ["No required gates were supplied"] };
  }

  const failing = required.filter(g => ["FAILED", "FIX_REQUIRED"].includes(g.status));
  const missing = required.filter(g => g.status !== "VERIFIED");
  const criticalUnknown = missing.filter(g => g.critical);

  let verdict;
  if (failing.length || criticalUnknown.length) verdict = "NO_GO";
  else if (missing.length) verdict = scope === "release" ? "NO_GO" : "CONDITIONAL_GO";
  else verdict = scope === "release" ? "RELEASE_CANDIDATE" : "READY_FOR_REVIEW";

  return {
    verdict,
    gates: results,
    reasons: missing.map(g => g.id + ": " + g.status),
    disclaimer: "Reported evidence is supplied by the caller and not independently authenticated. No merge or deployment approval is granted.",
  };
}

function validateId(gate, kind) {
  if (typeof gate.id !== "string" || !gate.id.trim()) {
    throw new Error(`Each ${kind} needs a nonempty id`);
  }
}

function validateFlag(gate, key, kind) {
  if (gate[key] !== undefined && typeof gate[key] !== "boolean") {
    throw new Error(`${kind} ${key} flag must be boolean`);
  }
}

function normalLife(gate, counts, reviewedCommit) {
  const evidence = gate.evidence;
  if (!evidence || typeof evidence !== "object") return "UNVERIFIED";
  const id = gate.id;

  if (id === "ci-parity") {
    return ciRunEvidenceValid(evidence, reviewedCommit) ? "VERIFIED" : "UNVERIFIED";
  }
  if (RESERVED_EXECUTION_IDS.has(id)) {

    if (evidence.type !== "command") return "UNVERIFIED";

    return commandVerified(gate, counts);
  }
  if (evidence.type === "source") return hasEvidence(gate) ? "VERIFIED" : "UNVERIFIED";

  if (evidence.type === "command") return commandVerified(gate, counts);

  return "UNVERIFIED";
}

/**
 * A command claim verifies only under the strict shape: integer exit code 0, nonempty
 * command/cwd/result, no timeout or signal. Legacy shapes stay readable but UNVERIFIED;
 * contradictory outcomes (failing exit or failed tests) demote to FAILED even when the
 * caller said VERIFIED.
 */
function commandVerified(gate, counts) {
  const evidence = gate.evidence;
  if (Number.isInteger(evidence.exitCode) && evidence.exitCode !== 0) return "FAILED";
  if (counts !== null && counts.failed > 0) return "FAILED";
  if (!hasEvidence(gate)) return "UNVERIFIED";
  if (counts !== null && counts.skipped > 0) return "PARTIAL";
  if (counts !== null && (counts.passed === 0 || COUNT_KEYS.some(key => evidence.testCounts[key] === undefined))) return "UNVERIFIED";
  if (gate.id === "tests" && counts === null) return "UNVERIFIED";

  return "VERIFIED";
}

function main(args) {
  if (args.length !== 2 || args[0] !== "--report") {
    throw new Error("Usage: node review-verdict.js --report assessment.json");
  }
  const payload = JSON.parse(readFileSync(resolve(args[1]), "utf8"));
  const result = assessReview({
    scope: payload.scope,
    reviewedCommit: payload.reviewedCommit,
    gates: payload.gates,
    requiredGates: payload.requiredGates,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  if (result.verdict === "NO_GO" || result.verdict === "CONDITIONAL_GO") process.exitCode = 1;
  else if (result.verdict === "NOT_ASSESSED") process.exitCode = 2;
}

// Compare REAL paths so npm .bin symlinks still execute the CLI; unresolvable argv means NOT main.
function isMainModule() {
  try {

    if (!process.argv[1]) return false;

    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write("KSD review NOT ASSESSED: " + error.message + "\n");
    process.exitCode = 2;
  }
}
