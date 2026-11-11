// Exercise the packed plugin outside the checkout without network or consumer dependencies.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// M1c: plugin sources moved from plugins/engineering-proxy to src/policy; repoRoot is still two levels up from it.
const pluginDir = realpathSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "policy"));
const repoRoot = realpathSync(join(pluginDir, "..", ".."));
const rootEslint = join(repoRoot, "node_modules", ".bin", "eslint");
const parserUrl = import.meta.resolve("typescript-eslint");
const temporary = mkdtempSync(join(tmpdir(), "ksd-consumer-"));
after(() => rmSync(temporary, { force: true, recursive: true }));

let shared;

function ensureInstalled() {
  if (shared) return shared;

  const consumerPrefix = join(temporary, "consumer");
  const packDestination = join(temporary, "pack");
  mkdirSync(packDestination, { recursive: true });
  const packed = JSON.parse(execFileSync("npm", ["pack", pluginDir, "--ignore-scripts", "--json", "--pack-destination", packDestination], {
    cwd: repoRoot, encoding: "utf8", timeout: 120_000,
  }));
  const entry = Array.isArray(packed) ? packed[0] : packed["omp-engineering-proxy"];
  const tarball = join(packDestination, entry.filename);
  execFileSync("npm", ["install", "--prefix", consumerPrefix, "--ignore-scripts", "--offline", "--no-audit", "--no-fund", tarball], {
    encoding: "utf8", timeout: 180_000,
  });

  shared = { consumerPrefix, pluginRoot: realpathSync(join(consumerPrefix, "node_modules", "omp-engineering-proxy")) };
  assert.equal(shared.pluginRoot, join(realpathSync(consumerPrefix), "node_modules", "omp-engineering-proxy"));
  assert.notEqual(shared.pluginRoot, pluginDir);

  return shared;
}

test("package exports resolve and import from the installed tarball", () => {
  const { consumerPrefix, pluginRoot } = ensureInstalled();
  const probe = join(consumerPrefix, "exports-probe.mjs");
  writeFileSync(probe, `
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = ${JSON.stringify(pluginRoot)};
const entries = [
  ["omp-engineering-proxy", "index.js"],
  ["omp-engineering-proxy/eslint", "eslint-rules/index.js"],
  ["omp-engineering-proxy/index.js", "index.js"],
  ["omp-engineering-proxy/eslint-rules/index.js", "eslint-rules/index.js"],
  ["omp-engineering-proxy/policy.js", "policy.js"],
  ["omp-engineering-proxy/sdlc.js", "sdlc.js"],
  ["omp-engineering-proxy/change-scope.js", "change-scope.js"],
  ["omp-engineering-proxy/review-verdict.js", "review-verdict.js"],
  ["omp-engineering-proxy/dist/runtime.js", "dist/runtime.js"],
];
for (const [specifier, path] of entries) {
  assert.equal(realpathSync(fileURLToPath(import.meta.resolve(specifier))), realpathSync(join(root, path)), specifier);
  await import(specifier);
}
for (const path of ["package.json", "check-changed.js", "review-verdict.js"]) {
  assert.equal(realpathSync(fileURLToPath(import.meta.resolve("omp-engineering-proxy/" + path))), realpathSync(join(root, path)), path);
}
assert.equal(typeof (await import("omp-engineering-proxy")).default, "function");
assert.equal(typeof (await import("omp-engineering-proxy/eslint")).default.rules["blank-before-return"], "object");
`);
  const result = spawnSync(process.execPath, [probe], { cwd: consumerPrefix, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, `consumer imports failed: ${result.stderr}`);
  assert.equal(result.stdout, "", "importing package modules must not run CLI code");
});

test("installed CLI scripts and npm bin links return observed verdicts and exit codes", () => {
  const { consumerPrefix, pluginRoot } = ensureInstalled();
  const workDir = join(temporary, "run");
  mkdirSync(workDir);
  writeFileSync(join(workDir, "diff.patch"), [
    "diff --git a/src/one.js b/src/one.js",
    "--- /dev/null",
    "+++ b/src/one.js",
    "@@ -0,0 +1,2 @@",
    "+const ready = true;",
    "+export { ready };",
    "",
  ].join("\n"));
  writeFileSync(join(workDir, "clean.json"), JSON.stringify([{ filePath: "src/one.js", messages: [] }]));
  writeFileSync(join(workDir, "error.json"), JSON.stringify([{
    filePath: "src/one.js", messages: [{ ruleId: "engineering-proxy/blank-before-return", severity: 2, line: 1, message: "Spacing error" }],
  }]));
  writeFileSync(join(workDir, "invalid.json"), "{");
  writeFileSync(join(workDir, "verdict.json"), JSON.stringify({
    scope: "code-review",
    gates: [{ id: "typecheck", status: "VERIFIED", evidence: {
      type: "command", command: "tsc --noEmit", cwd: workDir, result: "no errors", exitCode: 0,
    } }],
  }));
  writeFileSync(join(workDir, "failed.json"), JSON.stringify({
    gates: [{ id: "typecheck", status: "VERIFIED", evidence: {
      type: "command", command: "tsc --noEmit", cwd: workDir, result: "failed", exitCode: 1,
    } }],
  }));
  writeFileSync(join(workDir, "empty.json"), JSON.stringify({ gates: [] }));

  const bin = join(consumerPrefix, "node_modules", ".bin");
  for (const [command, direct] of [["ksd-check-changed", "check-changed.js"], ["ksd-review-verdict", "review-verdict.js"]]) {
    const scripts = [[process.execPath, [join(pluginRoot, direct)]], [join(bin, command), []]];
    const cases = command === "ksd-check-changed"
      ? [
        [["--diff", "diff.patch", "--eslint-report", "clean.json"], 0, "status", "PASS"],
        [["--diff", "diff.patch", "--eslint-report", "error.json"], 1, "status", "FIX_REQUIRED"],
        [["--diff", "diff.patch", "--eslint-report", "invalid.json"], 2, null, null],
      ]
      : [
        [["--report", "verdict.json"], 0, "verdict", "READY_FOR_REVIEW"],
        [["--report", "failed.json"], 1, "verdict", "NO_GO"],
        [["--report", "empty.json"], 2, "verdict", "NOT_ASSESSED"],
        [["--report", "invalid.json"], 2, null, null],
      ];
    for (const [executable, prefix] of scripts) {
      for (const [args, exitCode, key, expected] of cases) {
        const result = spawnSync(executable, [...prefix, ...args], { cwd: workDir, encoding: "utf8", timeout: 60_000 });
        assert.equal(result.status, exitCode, `${executable} ${args.join(" ")}: ${result.stderr}`);
        if (key) assert.equal(JSON.parse(result.stdout)[key], expected);
        else assert.match(result.stderr, command === "ksd-check-changed" ? /KSD style check NOT RUN:/ : /KSD review NOT ASSESSED:/);
      }
    }
  }
});

test("host ESLint uses installed plugin with real JavaScript and TypeScript", () => {
  const { consumerPrefix } = ensureInstalled();
  writeFileSync(join(consumerPrefix, "consumer.config.mjs"), `
import tseslint from ${JSON.stringify(parserUrl)};
import engineeringProxy from "omp-engineering-proxy/eslint";
const rules = {
  "engineering-proxy/blank-before-return": "error",
  "engineering-proxy/blank-between-functions": "error",
  "engineering-proxy/prefer-guard-clauses": "warn",
};
export default [
  { files: ["**/*.js"], plugins: { "engineering-proxy": engineeringProxy }, rules },
  { files: ["**/*.ts"], languageOptions: { parser: tseslint.parser }, plugins: { "engineering-proxy": engineeringProxy }, rules },
];
`);
  const cleanJs = [
    "function pick(value) {",
    "  if (value < 0) return null;",
    "",
    "  return value;",
    "}",
    "// This comment separates implementations.",
    "function second() {",
    "  return 1;",
    "}",
  ].join("\n");
  const cleanTs = [
    "export function one(value: number): number;",
    "export function one(value: string): string;",
    "export function one(value: number | string): number | string {",
    "  return value;",
    "}",
  ].join("\n");
  const badJs = [
    "function first(value) {",
    "  if (value) {",
    "    if (value.ready) {",
    "      return value;",
    "    }",
    "  }",
    "  const fallback = null;",
    "  return fallback;",
    "}",
    "function second() {",
    "  return 1;",
    "}",
  ].join("\n");
  const badTs = [
    "export function first(value: number): number {",
    "  const next = value + 1;",
    "  const result = next * 2;",
    "  return result;",
    "}",
    "export function second(): number {",
    "  return 1;",
    "}",
  ].join("\n");
  for (const [name, source] of [["clean.js", cleanJs], ["clean.ts", cleanTs], ["bad.js", badJs], ["bad.ts", badTs]]) {
    writeFileSync(join(consumerPrefix, name), source);
  }

  const clean = spawnSync(rootEslint, ["--config", "consumer.config.mjs", "--format", "json", "clean.js", "clean.ts"], {
    cwd: consumerPrefix, encoding: "utf8", timeout: 120_000,
  });
  assert.equal(clean.status, 0, `valid guards, comments and overloads: ${clean.stderr}`);
  const cleanReports = JSON.parse(clean.stdout);
  assert.equal(cleanReports.length, 2);
  for (const report of cleanReports) assert.deepEqual(report.messages, []);

  const bad = spawnSync(rootEslint, ["--config", "consumer.config.mjs", "--format", "json", "bad.js", "bad.ts"], {
    cwd: consumerPrefix, encoding: "utf8", timeout: 120_000,
  });
  assert.equal(bad.status, 1, `spacing errors must fail: ${bad.stderr}`);
  const reports = JSON.parse(bad.stdout);
  assert.equal(reports.length, 2);
  for (const report of reports) {
    assert.ok(report.messages.some(message => message.ruleId === "engineering-proxy/blank-before-return" && message.severity === 2));
    assert.ok(report.messages.some(message => message.ruleId === "engineering-proxy/blank-between-functions" && message.severity === 2));
  }
  const js = reports.find(report => report.filePath.endsWith("bad.js"));
  assert.ok(js.messages.some(message => message.ruleId === "engineering-proxy/prefer-guard-clauses" && message.severity === 1 && !message.fix));
});
