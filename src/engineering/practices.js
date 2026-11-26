#!/usr/bin/env node
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectBaselineEvidence } from "./baseline.js";

const CATALOG_URL = new URL("./practices.json", import.meta.url);
const MAX_CONTEXT_BYTES = 256 * 1024;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit) throw new Error("Expected a bounded JSON file");
    const data = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < data.length) {
      const size = readSync(fd, data, length, data.length - length, null);
      if (!size) break;
      length += size;
    }
    if (length > limit) throw new Error("JSON input exceeds size limit");

    return JSON.parse(data.subarray(0, length).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

export function readPracticeCatalog() {
  const catalog = readJson(CATALOG_URL, MAX_CONTEXT_BYTES);
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.practices) || !Array.isArray(catalog.facets)) throw new Error("Unsupported practice catalog");
  const ids = new Set();
  const facets = new Set(catalog.facets);
  for (const rule of catalog.practices) {
    if (!isRecord(rule) || !/^(?:BL|S|C|T|A|D|R|SEC|F|B|Q|AI)\d{2}$/.test(rule.id) || ids.has(rule.id) ||
        !Number.isInteger(rule.version) || rule.version < 1 || typeof rule.title !== "string" || typeof rule.intent !== "string" ||
        !Array.isArray(rule.allOf) || !Array.isArray(rule.anyOf) || ![...rule.allOf, ...rule.anyOf].every(facet => facets.has(facet)) ||
        !Array.isArray(rule.mechanisms) || !["REQUIRED", "PREFERRED", "ADVISORY"].includes(rule.defaultLevel)) {
      throw new Error("Invalid or duplicate practice catalog entry");
    }
    ids.add(rule.id);
  }

  return catalog;
}

function applicability(rule, facts) {
  const get = name => Object.hasOwn(facts, name) ? facts[name] : undefined;
  if (rule.allOf.some(name => get(name) === false)) return "NOT_APPLICABLE";
  if (rule.anyOf.length && rule.anyOf.every(name => get(name) === false)) return "NOT_APPLICABLE";
  if (rule.allOf.some(name => get(name) === undefined)) return "UNKNOWN";
  if (rule.anyOf.length && !rule.anyOf.some(name => get(name) === true)) return "UNKNOWN";

  return "APPLICABLE";
}

function validateContext(input, catalog) {
  if (!isRecord(input) || !isRecord(input.facets)) throw new Error("Context requires a facets object with true/false observations");
  const validFacets = new Set(catalog.facets);
  const ids = new Set(catalog.practices.map(rule => rule.id));
  for (const [key, value] of Object.entries(input.facets)) {
    if (!validFacets.has(key) || typeof value !== "boolean") throw new Error("Unknown facet or non-boolean observation: " + key);
  }

  const overrides = input.projectOverrides ?? {};
  if (!isRecord(overrides)) throw new Error("projectOverrides must be an object");
  for (const [id, decision] of Object.entries(overrides)) {
    if (!ids.has(id) || !isRecord(decision) || !["required", "prefer-project", "exception"].includes(decision.disposition) ||
        typeof decision.reason !== "string" || !decision.reason.trim() ||
        typeof decision.evidence !== "string" || !decision.evidence.trim()) {
      throw new Error("Invalid or unsupported project override: " + id);
    }
  }

  const gates = input.enabledGates ?? [];
  const optionalGates = new Set(catalog.practices.filter(rule => rule.mechanisms.includes("optional-native-gate")).map(rule => rule.id));
  if (!Array.isArray(gates) || gates.some(id => !optionalGates.has(id))) throw new Error("enabledGates must contain known optional-native-gate practice IDs");
  if (input.mode !== undefined && !["balanced", "adaptive"].includes(input.mode)) throw new Error("Unsupported enforcement mode");

  return { overrides, gates: new Set(gates) };
}

/** Decisions describe supplied evidence, not an authenticated repository scan or executed gate. */
export function resolvePractices(input, catalog = readPracticeCatalog()) {
  const { overrides, gates } = validateContext(input, catalog);
  const mode = input.mode ?? "balanced";
  const decisions = catalog.practices.map(rule => {
    const status = applicability(rule, input.facets);
    const override = Object.hasOwn(overrides, rule.id) ? overrides[rule.id] : undefined;
    const nativeGate = gates.has(rule.id) && rule.mechanisms.includes("optional-native-gate");
    const decision = { id: rule.id, version: rule.version, title: rule.title, group: rule.group, intent: rule.intent, status, level: rule.defaultLevel,
      mechanisms: rule.mechanisms, safetyInvariant: rule.safetyInvariant === true, reason: "Applicable to supplied task facets" };
    if (status !== "APPLICABLE") {
      if (override?.disposition === "required" || nativeGate) {
        return { ...decision, status: "CONFLICT", level: "REQUIRED", reason: "Explicit project gate conflicts with missing or negative applicability; resolve with evidence", project: override };
      }
      return { ...decision, level: status === "NOT_APPLICABLE" ? "NOT_APPLICABLE" : "ADVISORY",
        reason: status === "UNKNOWN" ? "Missing task/baseline evidence; do not claim pass" : "Supplied facets exclude practice" };
    }

    if (override && override.disposition !== "required") {
      if (rule.safetyInvariant || rule.defaultLevel === "REQUIRED" || nativeGate) {
        return { ...decision, status: "CONFLICT", level: "REQUIRED", reason: "Project exception conflicts with required invariant or native gate; resolve explicitly", project: override };
      }
      return { ...decision, status: "SUPPRESSED", level: "ADVISORY", reason: "Scoped project convention or exception takes precedence", project: override };
    }
    if (override?.disposition === "required" || nativeGate) {
      return { ...decision, level: "REQUIRED", reason: "Explicitly supplied project rule or opted-in native gate", project: override };
    }

    if (rule.id === "S01") {
      return { ...decision, level: mode === "balanced" ? "ADVISORY" : "PREFERRED",
        reviewDisposition: mode === "adaptive" ? "FIX_REQUIRED_IF_BEHAVIOR_PRESERVING" : "ADVISORY" };
    }

    return decision;
  });

  return { schemaVersion: 1, mode, evidence: "SUPPLIED_NOT_AUTHENTICATED", decisions };
}

// A fresh hash binds the supplied interpretation to the sampled bytes, not to the truth of the interpretation.
function checkProvenance(provenance, paths) {
  if (!isRecord(provenance) || !Array.isArray(provenance.paths) || provenance.paths.length < 1 || provenance.paths.length > 24 ||
      !provenance.paths.every(path => typeof path === "string" && paths.has(path)) ||
      !["CURRENT", "LEGACY", "TRANSITIONAL", "LOCAL", "EXCEPTION", "UNKNOWN"].includes(provenance.classification) ||
      !["HIGH", "MEDIUM", "LOW", "UNKNOWN"].includes(provenance.confidence)) {
    throw new Error("Invalid or unsampled observation provenance");
  }

  return ["HIGH", "MEDIUM"].includes(provenance.confidence) && ["CURRENT", "LOCAL", "EXCEPTION"].includes(provenance.classification);
}

/** Explicit opt-in; root is the operator/host-selected root, never an untrusted context field. */
export function resolveFreshPractices(input, { root, useGit = false }, catalog = readPracticeCatalog()) {
  validateContext(input, catalog);
  const baseline = input.baseline;
  if (!isRecord(baseline) || typeof baseline.scope !== "string" || typeof baseline.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(baseline.fingerprint) || Object.hasOwn(baseline, "root") || Object.hasOwn(baseline, "useGit")) {
    throw new Error("Expected a scoped baseline fingerprint; select the root and native Git option outside the context");
  }
  const snapshot = collectBaselineEvidence({ root, scope: baseline.scope, additionalPaths: baseline.additionalPaths ?? [], useGit });
  if (!snapshot.cacheable || snapshot.fingerprint !== baseline.fingerprint) throw new Error("STALE_OR_INCOMPLETE_BASELINE: recapture and review scoped evidence");
  const paths = new Set(snapshot.evidence.map(item => item.path));
  if (!isRecord(input.observations)) throw new Error("Fresh selection requires observation provenance");

  const facets = {};
  const unresolved = [];
  for (const [name, value] of Object.entries(input.facets)) {
    if (!Object.hasOwn(input.observations, name)) throw new Error("Missing facet provenance: " + name);
    if (checkProvenance(input.observations[name], paths)) facets[name] = value;
    else unresolved.push(name);
  }
  const overrides = input.projectOverrides ?? {};
  for (const [id, decision] of Object.entries(overrides)) {
    if (!checkProvenance(decision.provenance, paths)) throw new Error("Uncertain project override: " + id);
  }
  const gates = input.enabledGates ?? [];
  if (gates.length && !isRecord(input.gateEvidence)) throw new Error("Enabled native gates require provenance");
  for (const id of gates) {
    if (!Object.hasOwn(input.gateEvidence, id) || !checkProvenance(input.gateEvidence[id], paths)) throw new Error("Uncertain native gate: " + id);
  }

  const selection = resolvePractices({ ...input, facets }, catalog);

  return { ...selection, evidence: "FRESH_SAMPLED_BYTES_SUPPLIED_SEMANTICS", baseline: { scope: snapshot.scope, fingerprint: snapshot.fingerprint, revision: snapshot.revision, coverage: snapshot.coverage },
    unresolvedFacets: unresolved.sort(), limitation: "Fresh sampled bytes only; supplied classifications, task semantics and native gate claims are not independently authenticated or executed." };
}

export function renderPracticeSelection(result) {
  const selected = result.decisions.filter(rule => rule.status === "APPLICABLE" || rule.status === "CONFLICT");
  const lines = selected.map(rule => `${rule.id} [${rule.status}/${rule.level}] ${rule.title}: ${rule.intent}${rule.status === "CONFLICT" ? " — " + rule.reason : ""}`);
  const unknown = result.decisions.filter(rule => rule.status === "UNKNOWN").map(rule => rule.id);

  return [`Practices: ${selected.length} selected/conflicting; ${unknown.length} unresolved. Evidence: ${result.evidence}; semantics not authenticated.`, ...lines, ...(unknown.length ? ["Unknown applicability: " + unknown.join(", ")] : [])].join("\n");
}

// Compose only from a fresh resolution, not arbitrary user-authored instructions.
// Never include raw observation reasons or file contents in the pack.
export function composePracticePack(selection, { group, maxChars = 6000 } = {}) {
  if (selection?.evidence !== "FRESH_SAMPLED_BYTES_SUPPLIED_SEMANTICS" || !Array.isArray(selection.decisions)) {
    throw new Error("A policy pack requires a fresh scoped practice selection");
  }
  if (!Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 12000) throw new Error("Invalid policy pack limit");
  if (group !== undefined && !selection.decisions.some(rule => rule.group === group)) throw new Error("Unknown practice group");
  const all = selection.decisions;
  const relevant = all.filter(rule => group === undefined || rule.group === group);
  const conflicts = all.filter(rule => rule.status === "CONFLICT").map(rule => rule.id);
  const unknownRequired = all.filter(rule => rule.status === "UNKNOWN" && rule.safetyInvariant).map(rule => rule.id);
  const suppressed = relevant.filter(rule => rule.status === "SUPPRESSED").map(rule => rule.id);
  const selected = relevant.filter(rule => rule.status === "APPLICABLE");
  const priority = { REQUIRED: 0, PREFERRED: 1, ADVISORY: 2 };
  selected.sort((a, b) => priority[a.level] - priority[b.level] || a.id.localeCompare(b.id, "en"));
  const prefix = [
    "Scoped erosiano-dev practice pack (not an authoritative project rule or verification).",
    "Fresh sampled bytes only; interpretations are supplied. Existing contracts, project instructions, security and native gates remain authoritative.",
    "Review current evidence before changes. Refresh this selection if relevant files, scope or task change.",
    "Mode: " + selection.mode + "; group: " + (group ?? "all") + "; sampled fingerprint: " + selection.baseline.fingerprint,
    "Conflicts across all groups: " + (conflicts.join(", ") || "none"),
    "Unknown safety/required-risk applicability across all groups: " + (unknownRequired.join(", ") || "none"),
    "Suppressed project preferences in this group: " + (suppressed.join(", ") || "none"),
    "Resolve conflicts and applicable unknown risks before claiming verification. Do not treat omitted or suppressed preferences as waived native gates.",
  ].join("\n");
  const included = [];
  const omitted = [];
  const lines = [];
  // Reserve room for a complete list of omitted IDs even in a dense all-group selection.
  const budget = maxChars - prefix.length - 1100;
  let used = 0;
  for (const rule of selected) {
    const line = rule.id + " v" + rule.version + " [" + rule.level + "] " + rule.title + ": " + rule.intent;
    if (used + line.length + 1 > budget) {
      omitted.push(rule.id);
      continue;
    }
    lines.push(line);
    included.push(rule.id);
    used += line.length + 1;
  }
  const outside = group !== undefined ? all.filter(rule => rule.group !== group && rule.status === "APPLICABLE").length : 0;
  const footer = "Omitted applicable IDs due to output bound: " + (omitted.join(", ") || "none") +
    ". Applicable outside requested group: " + outside + ". Request a narrower group or inspect omitted IDs; no omission is a pass.";
  const text = [prefix, ...lines, footer].join("\n");
  if (text.length > maxChars) {
    return { status: "NARROW_GROUP_REQUIRED", text: "Policy output exceeds bound. Request a group; no selected, conflicting or unknown rule is waived.", included: [], omitted: selected.map(rule => rule.id), conflicts, unknownRequired };
  }

  return { status: conflicts.length ? "CONFLICT" : omitted.length || outside ? "PARTIAL_PACK" : "PACK", text, included, omitted, conflicts, unknownRequired };
}

function main(args) {
  if (args.length === 2 && args[0] === "--group") {
    const catalog = readPracticeCatalog();
    const rules = catalog.practices.filter(rule => rule.group === args[1]);
    if (!rules.length) throw new Error("Unknown practice group");
    console.log(JSON.stringify(rules, null, 2));

    return;
  }
  const usage = "Usage: erosiano-practices --context context.json [--root project [--git]] [--policy [--group group]] | --group group";
  if (args[0] !== "--context" || !args[1] || args[1].startsWith("--")) throw new Error(usage);
  const options = {};
  for (let i = 2; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--git" || flag === "--policy") {
      if (Object.hasOwn(options, flag)) throw new Error(usage);
      options[flag] = true;
      continue;
    }
    if (!["--root", "--group"].includes(flag) || Object.hasOwn(options, flag) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(usage);
    options[flag] = args[++i];
  }
  if ((options["--git"] || options["--policy"]) && !options["--root"]) throw new Error(usage);
  if (options["--group"] && !options["--policy"]) throw new Error(usage);
  const input = readJson(resolve(args[1]), MAX_CONTEXT_BYTES);
  if (!options["--root"] && Object.hasOwn(input ?? {}, "baseline")) throw new Error("Fresh context requires an operator-selected --root");
  const result = options["--root"] ? resolveFreshPractices(input, { root: options["--root"], useGit: options["--git"] === true }) : resolvePractices(input);
  console.log(JSON.stringify(options["--policy"] ? composePracticePack(result, { group: options["--group"] }) : result, null, 2));
}

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
    console.error("Practice selection NOT_ASSESSED: " + error.message);
    process.exitCode = 2;
  }
}
