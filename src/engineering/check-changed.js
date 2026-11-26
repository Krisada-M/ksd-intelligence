#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectChangedScope } from "./change-scope.js";

function main(args) {
  if (args.length !== 4 || args[0] !== "--diff" || args[2] !== "--eslint-report") {
    throw new Error("Usage: node check-changed.js --diff git.patch --eslint-report eslint.json");
  }

  const patch = readFileSync(resolve(args[1]), "utf8");
  const report = JSON.parse(readFileSync(resolve(args[3]), "utf8"));
  const result = inspectChangedScope(patch, report);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");

  if (result.status === "FIX_REQUIRED") process.exitCode = 1;
  if (result.status === "NOT_RUN") process.exitCode = 2;
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
    process.stderr.write("KSD style check NOT RUN: " + error.message + "\n");
    process.exitCode = 2;
  }
}
