#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export function validateRelease(root) {
  const manifest = JSON.parse(readFileSync(join(root, ".omp-plugin/marketplace.json"), "utf8"));
  if (!Array.isArray(manifest.plugins) || manifest.plugins.length !== 1) {
    throw new Error("Exactly one marketplace plugin is required");
  }

  const entry = manifest.plugins[0];
  const base = resolve(root, entry.source);
  const rel = relative(root, base);
  if (!rel || rel === ".." || rel.split(/[\\/]/)[0] === ".." || isAbsolute(rel)) {
    throw new Error("Plugin source must remain inside repository");
  }

  const pkg = JSON.parse(readFileSync(join(base, "package.json"), "utf8"));
  const versions = [manifest.metadata?.version, entry.version, pkg.version];
  if (versions.some(v => typeof v !== "string" || !/^\d+\.\d+\.\d+$/.test(v))) {
    throw new Error("Missing or invalid SemVer in manifest/package");
  }
  if (new Set(versions).size !== 1) throw new Error("Marketplace metadata, plugin entry, and package versions disagree");

  const extension = pkg.omp?.extensions;
  if (!Array.isArray(extension) || extension.length !== 1 || !existsSync(resolve(base, extension[0]))) {
    throw new Error("Invalid or missing OMP extension entry point");
  }

  return { version: versions[0], extension: extension[0], source: entry.source };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.stdout.write(JSON.stringify(validateRelease(resolve(process.argv[2] || "."))) + "\n");
  } catch (error) {
    process.stderr.write("Release validation FAILED: " + error.message + "\n");
    process.exitCode = 1;
  }
}
