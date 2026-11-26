#!/usr/bin/env node
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { devNull } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_FILES = 64;
const MAX_ADDITIONAL_PATHS = 24;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_DIRECTORY_ENTRIES = 256;
const KNOWN_FILES = [
  "AGENTS.md", "README.md", "CONTRIBUTING.md", "package.json", "tsconfig.json", "jsconfig.json",
  "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", ".eslintrc.json", "biome.json", "biome.jsonc",
  ".prettierrc", ".prettierrc.json", "vitest.config.ts", "vitest.config.js", "jest.config.js", "jest.config.ts",
  ".erosiano-dev.json", ".engineering-proxy.json", ".editorconfig", "turbo.json", "nx.json", "tsconfig.base.json",
  "Makefile", "Dockerfile", "compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml",
  "pnpm-workspace.yaml", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock",
  "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "Gemfile", "composer.json", "pom.xml",
];
const SKIP_DIRECTORIES = new Set([".git", "node_modules", ".venv", "vendor", "dist", "build", ".cache", ".omp", ".next"]);
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|rb|php|sql|css|html|vue|svelte)$/i;
const SECRET_NAME = /(?:^\.env(?:\.|$)|(?:credential|secret|password|token|private.?key)|\.(?:pem|key|p12|pfx)$)/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
const EXPLICIT_EVIDENCE = /\.(?:md|jsonc?|ya?ml|toml|ini|xml|sh)$/i;

function supportedEvidence(path) {
  const name = basename(path);

  return SOURCE_FILE.test(name) || KNOWN_FILES.includes(name) || EXPLICIT_EVIDENCE.test(name);
}

const sha256 = data => createHash("sha256").update(data).digest("hex");

function within(root, path) {
  const rel = relative(root, path);

  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}

function info(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

function safePath(root, requested) {
  if (typeof requested !== "string" || !requested || CONTROL.test(requested)) throw new Error("Invalid scope path");
  const path = resolve(root, requested);
  if (!within(root, path)) throw new Error("Scope is outside the project root");
  const rel = relative(root, path);
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    if (SECRET_NAME.test(part) || SKIP_DIRECTORIES.has(part)) throw new Error("Excluded scope path");
    current = join(current, part);
    const metadata = info(current);
    if (!metadata || metadata.isSymbolicLink()) throw new Error("Missing or symlinked scope path");
  }

  return path;
}

/** Read only bounded regular files at their canonical in-root paths. Never emit file contents. */
function boundedRead(root, path) {
  const metadata = info(path);
  if (!metadata) return { status: "absent" };
  if (!metadata.isFile() || metadata.isSymbolicLink() || !within(root, path) || realpathSync(path) !== path) return { status: "excluded" };
  if (metadata.size > MAX_FILE_BYTES) return { status: "oversize" };

  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > MAX_FILE_BYTES || before.ino !== metadata.ino || before.dev !== metadata.dev) return { status: "changed" };
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (!read) break;
      length += read;
    }
    const after = fstatSync(fd);
    if (length > MAX_FILE_BYTES || before.size !== length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return { status: "changed" };

    return { status: "read", bytes: buffer.subarray(0, length) };
  } finally {
    closeSync(fd);
  }
}

function revision(root) {
  try {
    const gitDir = info(join(root, ".git"));
    if (!gitDir?.isDirectory() || gitDir.isSymbolicLink()) return { status: "unknown", reason: "No local Git metadata directory (linked worktrees require agent evidence)" };
    const head = boundedRead(root, join(root, ".git", "HEAD"));
    if (head.status !== "read") return { status: "unknown", reason: "HEAD unavailable" };
    const value = head.bytes.toString("utf8").trim();
    if (/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)) return { status: "observed", head: value, branch: null };
    const match = /^ref: (refs\/heads\/[A-Za-z0-9._/-]+)$/.exec(value);
    if (!match || match[1].split("/").some(part => part === "." || part === ".." || part === "")) return { status: "unknown", reason: "Unsupported HEAD reference" };
    const ref = boundedRead(root, join(root, ".git", match[1]));
    let commit = ref.status === "read" ? ref.bytes.toString("utf8").trim() : undefined;
    if (ref.status === "absent") {
      const packed = boundedRead(root, join(root, ".git", "packed-refs"));
      const line = packed.status === "read" ? packed.bytes.toString("utf8").split("\n").find(entry => entry.endsWith(" " + match[1])) : undefined;
      commit = line?.split(" ")[0];
    }
    if (!commit || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit)) return { status: "unknown", reason: "Branch reference unavailable" };

    return { status: "observed", head: commit, branch: match[1] };
  } catch {
    return { status: "unknown", reason: "Git metadata unreadable" };
  }
}

// Opt-in only for the operator-invoked CLI. Never invoked during an ordinary agent turn.
// Git handles its own linked-worktree metadata. No shell, no repository hooks or inherited GIT_* overrides.
function nativeRevision(root) {
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  const run = args => spawnSync("git", ["-C", root, ...args], { env, encoding: "utf8", timeout: 2000, maxBuffer: 16384, shell: false });
  try {
    const result = run(["rev-parse", "--show-toplevel", "HEAD"]);
    if (result.error || result.status !== 0) return { status: "unknown", reason: "Native Git revision unavailable" };
    const [top, head, ...rest] = result.stdout.trimEnd().split("\n");
    if (rest.length || !top || CONTROL.test(top) || realpathSync(top) !== root || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head ?? "")) {
      return { status: "unknown", reason: "Native Git root or revision did not match" };
    }
    const symbolic = run(["symbolic-ref", "--quiet", "HEAD"]);
    if (symbolic.error) return { status: "unknown", reason: "Native Git branch unavailable" };
    const branch = symbolic.status === 0 ? symbolic.stdout.trim() : null;
    if (symbolic.status !== 0 && symbolic.status !== 1) return { status: "unknown", reason: "Native Git branch unavailable" };
    if (branch !== null && !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(branch)) return { status: "unknown", reason: "Unsupported native Git reference" };

    return { status: "observed", head, branch };
  } catch {
    return { status: "unknown", reason: "Native Git metadata unreadable" };
  }
}

function directorySample(path) {
  const dir = opendirSync(path);
  const entries = [];
  let scanned = 0;
  let truncated = false;
  try {
    while (true) {
      const entry = dir.readSync();
      if (!entry) break;
      scanned++;
      if (scanned > MAX_DIRECTORY_ENTRIES) {
        truncated = true;
        break;
      }
      if (CONTROL.test(entry.name) || SECRET_NAME.test(entry.name) || SKIP_DIRECTORIES.has(entry.name)) continue;
      const kind = entry.isFile() ? "file" : entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "other";
      entries.push({ name: entry.name, kind });
    }
  } finally {
    dir.closeSync();
  }
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  return { entries, truncated };
}

function role(path) {
  const name = basename(path);
  if (["AGENTS.md", "README.md", "CONTRIBUTING.md"].includes(name)) return "instruction";
  if (KNOWN_FILES.includes(name) || path.split(sep).includes("workflows")) return "tooling";
  if (/(?:^|[.])(?:test|spec)\.[^.]+$/.test(name)) return "test";

  return "source";
}

/** A bounded snapshot of sampled evidence, not an inferred or complete project convention baseline. */
export function collectBaselineEvidence({ root, scope = ".", additionalPaths = [], useGit = false }) {
  if (typeof root !== "string" || !root || typeof scope !== "string" || !scope) throw new Error("Expected project root and scope");
  if (!Array.isArray(additionalPaths) || additionalPaths.length > MAX_ADDITIONAL_PATHS) throw new Error("Too many explicit evidence paths");
  if (typeof useGit !== "boolean") throw new Error("Invalid native Git option");

  const requestedRoot = resolve(root);
  const canonicalRoot = realpathSync(requestedRoot);
  if (!info(canonicalRoot)?.isDirectory()) throw new Error("Project root must be a directory");
  // Absolute cwd values can use a symlink alias of the operator-selected root (not a scope symlink).
  const scoped = isAbsolute(scope) && within(requestedRoot, resolve(scope)) ? relative(requestedRoot, resolve(scope)) || "." : scope;
  const target = safePath(canonicalRoot, scoped);
  const targetInfo = info(target);
  if (!targetInfo?.isFile() && !targetInfo?.isDirectory()) throw new Error("Scope must be a file or directory");
  if (targetInfo.isFile() && !supportedEvidence(target)) throw new Error("Unsupported evidence file type");

  const targetDirectory = targetInfo.isDirectory() ? target : dirname(target);
  const evidence = [];
  const unknowns = [];
  const candidates = new Set();
  const readRevision = useGit ? nativeRevision : revision;
  const revisionBefore = readRevision(canonicalRoot);
  if (targetInfo.isFile()) candidates.add(target);
  // Callers, test files and CI/tooling beyond the direct sample must be explicit and bounded.
  const explicit = new Set();
  for (const requested of additionalPaths) {
    if (typeof requested !== "string" || isAbsolute(requested)) throw new Error("Additional evidence paths must be relative to the project root");
    const path = safePath(canonicalRoot, requested);
    if (!info(path)?.isFile() || !supportedEvidence(path)) throw new Error("Unsupported additional evidence file");
    explicit.add(relative(canonicalRoot, path));
    candidates.add(path);
  }
  let current = targetDirectory;
  while (true) {
    for (const name of KNOWN_FILES) {
      if (candidates.size >= MAX_FILES) {
        unknowns.push("Evidence file cap reached");
        break;
      }
      const path = join(current, name);
      try {
        if (info(path)) candidates.add(path);
      } catch {
        unknowns.push("Tooling evidence inaccessible");
      }
    }
    if (current === canonicalRoot || candidates.size >= MAX_FILES) break;
    current = dirname(current);
  }
  let directory;
  try {
    const sample = directorySample(targetDirectory);
    directory = { path: relative(canonicalRoot, targetDirectory) || ".", fingerprint: sha256(JSON.stringify(sample.entries)), count: sample.entries.length, truncated: sample.truncated };
    if (sample.truncated) unknowns.push("Directory inventory truncated");
    for (const entry of sample.entries) {
      if (!SOURCE_FILE.test(entry.name)) continue;
      if (entry.kind !== "file") {
        unknowns.push("Nonregular source evidence excluded");
        continue;
      }
      if (candidates.size >= MAX_FILES) {
        unknowns.push("Source sample cap reached");
        break;
      }
      candidates.add(join(targetDirectory, entry.name));
    }
  } catch {
    unknowns.push("Directory inventory unavailable");
  }
  for (const path of [...candidates].sort()) {
    const rel = relative(canonicalRoot, path);
    try {
      const result = boundedRead(canonicalRoot, path);
      if (result.status !== "read") {
        unknowns.push("Evidence " + result.status + ": " + rel);
        continue;
      }
      evidence.push({ path: rel, role: role(path), sha256: sha256(result.bytes), bytes: result.bytes.length });
    } catch {
      unknowns.push("Evidence unreadable: " + rel);
    }
  }
  const revisionAfter = readRevision(canonicalRoot);
  if (revisionBefore.status !== "observed" || revisionAfter.status !== "observed" || JSON.stringify(revisionBefore) !== JSON.stringify(revisionAfter)) unknowns.push("Git revision unavailable or changed during discovery");
  const record = { schemaVersion: 1, root: canonicalRoot, scope: relative(canonicalRoot, target) || ".", revision: revisionAfter,
    additionalPaths: [...explicit].sort(), revisionSource: useGit ? "native-git" : "local-metadata",
    evidence, directory, unknowns: [...new Set(unknowns)], confidence: "LOW", coverage: "SAMPLED_EVIDENCE_ONLY" };
  const fingerprint = sha256(JSON.stringify(record));

  return { ...record, fingerprint, cacheable: record.unknowns.length === 0 };
}

export class ScopedBaselineCache {
  #entries = new Map();

  capture(input) {
    const snapshot = collectBaselineEvidence(input);
    const key = JSON.stringify([snapshot.root, snapshot.scope, snapshot.additionalPaths, snapshot.revisionSource]);
    const previous = this.#entries.get(key);
    const matched = snapshot.cacheable && previous?.cacheable && previous.fingerprint === snapshot.fingerprint;
    this.#entries.delete(key);
    if (snapshot.cacheable) this.#entries.set(key, snapshot);
    if (this.#entries.size > 16) this.#entries.delete(this.#entries.keys().next().value);

    return { ...snapshot, freshness: matched ? "MATCHED_SCOPED_EVIDENCE" : "NEW_OR_INCOMPLETE_EVIDENCE" };
  }

  clear() {
    this.#entries.clear();
  }
}

export function summarizeBaselineEvidence(record) {
  const paths = record.evidence.slice(0, 12).map(item => item.path);

  return JSON.stringify({ scope: record.scope, revision: record.revision, sampled: record.evidence.length, examplePaths: paths,
    fingerprint: record.fingerprint, freshness: record.freshness, confidence: record.confidence, unknowns: record.unknowns.slice(0, 8),
    limitation: "Only sampled bytes and direct directory inventory matched, not all dirty/untracked files, callers, or conventions. Discover remaining evidence through approved tools." });
}

function main(args) {
  const usage = "Usage: erosiano-baseline --root project --scope relative-path [--include relative-file]... [--git]";
  if (args.length < 4 || args[0] !== "--root" || args[2] !== "--scope") throw new Error(usage);
  const additionalPaths = [];
  let useGit = false;
  for (let i = 4; i < args.length; i++) {
    if (args[i] === "--git" && !useGit) {
      useGit = true;
      continue;
    }
    if (args[i] !== "--include" || i + 1 >= args.length || args[i + 1].startsWith("--")) throw new Error(usage);
    additionalPaths.push(args[++i]);
  }
  console.log(JSON.stringify(collectBaselineEvidence({ root: args[1], scope: args[3], additionalPaths, useGit }), null, 2));
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
    console.error("Baseline evidence NOT_ASSESSED: " + error.message);
    process.exitCode = 2;
  }
}
