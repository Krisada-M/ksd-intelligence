import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Single source of truth for the supported modes; exported under the historical name.
import { KSD_MODES } from "./sdlc.js";
export const SUPPORTED_MODES = KSD_MODES;
const DEFAULT = Object.freeze({ enabled: true, enforcement: "balanced" });

export function getGlobalConfigPath() {
  return join(homedir(), ".omp", "agent", "engineering-proxy.json");
}

function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function findProjectRoot(cwd) {
  // Compare real paths: HOME or cwd may be reached through a symlink (process.cwd() is always real).
  const home = realPath(resolve(homedir()));
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    // ~/.omp holds global agent state; treating it as a project marker turns HOME into a second global scope.
    // Test .omp existence first: realpath is only needed for ancestors that actually have the marker.
    if (existsSync(join(current, ".omp")) && realPath(current) !== home) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

function readScopedConfig(path, label) {
  if (!existsSync(path)) return { present: false, values: {} };

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { present: true, values: {}, error: `Cannot parse ${label}: ${error.message}` };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      (parsed.enabled !== undefined && typeof parsed.enabled !== "boolean") ||
      (parsed.enforcement !== undefined && !SUPPORTED_MODES.includes(parsed.enforcement))) {
    return { present: true, values: {}, error: `Invalid ${label} (expected enabled:boolean and enforcement:'balanced|adaptive')` };
  }

  return { present: true, values: parsed };
}

export function loadConfig(cwd, { globalConfigPath = getGlobalConfigPath() } = {}) {
  const root = findProjectRoot(cwd);
  const projectConfigPath = join(root, ".engineering-proxy.json");
  const global = readScopedConfig(globalConfigPath, "global engineering-proxy.json");
  const project = readScopedConfig(projectConfigPath, ".engineering-proxy.json");
  const configError = global.error ?? project.error;
  const enforcementSource = project.values.enforcement !== undefined ? "project"
    : global.values.enforcement !== undefined ? "global" : "default";

  return {
    ...DEFAULT,
    ...global.values,
    ...project.values,
    root,
    configPresent: project.present,
    globalConfigPresent: global.present,
    projectConfigPath,
    globalConfigPath,
    projectEnforcement: project.values.enforcement,
    globalEnforcement: global.values.enforcement,
    enforcementSource,
    ...(configError ? { enabled: false, configError } : {}),
  };
}

/** Writes only the selected scope; preserves enabled and unrelated existing keys. */
export function setScopedMode(cwd, scope, mode, { globalConfigPath = getGlobalConfigPath() } = {}) {
  if (scope !== "global" && scope !== "repo") throw new Error("Scope must be global or repo");
  if (mode !== null && !SUPPORTED_MODES.includes(mode)) throw new Error("Unsupported enforcement mode");

  const path = scope === "global" ? globalConfigPath : join(findProjectRoot(cwd), ".engineering-proxy.json");
  const existing = readScopedConfig(path, scope === "global" ? "global engineering-proxy.json" : ".engineering-proxy.json");
  if (existing.error) throw new Error(existing.error);
  if (mode === null && existing.values.enforcement === undefined) return path;

  const next = { ...existing.values };
  if (mode === null) delete next.enforcement;
  else next.enforcement = mode;

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(tempPath, path);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }

  return path;
}
