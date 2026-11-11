import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const script = resolve(import.meta.dirname, "../../src/policy/check-changed.js");
const verdictScript = resolve(import.meta.dirname, "../../src/policy/review-verdict.js");

const patchText = (dest = "src/one.ts") => (dest === null
  ? ["diff --git a/src/gone.ts b/src/gone.ts", "--- a/src/gone.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-// removed line"]
  : ["diff --git a/src/one.ts b/" + dest, "--- a/src/one.ts", "+++ b/" + dest, "@@ -0,0 +1,1 @@", "+export const x = 1;"]
).join("\n");

function run(report, { patch = "src/one.ts", script: executable = script, extra = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ksd-cli-"));
  try {
    writeFileSync(join(dir, "diff.patch"), patchText(patch));
    writeFileSync(join(dir, "eslint.json"), JSON.stringify(report.map(r => ({
      filePath: join(dir, "src", patch === "src/one.ts" ? "one.ts" : "gone.ts"),
      messages: r.messages,
    }))));

    return spawnSync(process.execPath, [executable, "--diff", "diff.patch", "--eslint-report", "eslint.json", ...extra], {
      cwd: dir,
      encoding: "utf8",
      timeout: 3000,
    });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

test("real CLI exits 1 with changed-line errors", () => {
  const out = run([{ messages: [{ line: 1, severity: 2, ruleId: "ksd/blank-before-return", message: "missing blank line" }] }]);
  assert.equal(out.status, 1, out.stderr);
  assert.equal(JSON.parse(out.stdout).status, "FIX_REQUIRED");
});

test("real CLI reports NOT_RUN when no source file was linted", () => {
  const out = run([]);
  assert.equal(out.status, 2, out.stderr);
  assert.equal(JSON.parse(out.stdout).status, "NOT_RUN");
});

test("real CLI exits 0 but warns for suggestion-only diagnostics", () => {
  const out = run([{ messages: [{ line: 1, severity: 1, ruleId: "ksd/prefer-guard-clauses", message: "consider guard" }] }]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).status, "WARN");
});

test("removed-file patches stay NOT_APPLICABLE and exit 0", () => {
  const out = run([], { patch: null });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).status, "NOT_APPLICABLE");
});

test("malformed ESLint reports exit 2 with the NOT RUN prefix", () => {
  const dir = mkdtempSync(join(tmpdir(), "ksd-cli-"));
  try {
    writeFileSync(join(dir, "diff.patch"), patchText());
    writeFileSync(join(dir, "eslint.json"), '{"filePath": "src/one.ts"}');
    const out = spawnSync(process.execPath, [script, "--diff", "diff.patch", "--eslint-report", "eslint.json"], {
      cwd: dir, encoding: "utf8", timeout: 3000,
    });
    assert.equal(out.status, 2);
    assert.match(out.stderr, /^KSD style check NOT RUN: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-changed.js runs through an npm .bin-style symlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "ksd-bin-"));
  const link = join(dir, "ksd-check-changed");
  try {
    symlinkSync(script, link);
    const out = run([{ messages: [] }], { script: link });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(JSON.parse(out.stdout).status, "PASS");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("importing the CLIs performs no CLI work", () => {
  for (const modulePath of [script, verdictScript]) {
    const out = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import(${JSON.stringify(pathToFileURL(modulePath).href)}).then(() => console.log("imported ok"))`], {
      encoding: "utf8", timeout: 5000,
    });
    assert.equal(out.status, 0, `${modulePath} import failed: ${out.stderr}`);
    assert.equal(out.stdout, "imported ok\n",
      `${modulePath} must import as a library without running CLI logic`);
  }
});

function runReview(reportObject) {
  const dir = mkdtempSync(join(tmpdir(), "ksd-verdict-"));
  try {

    writeFileSync(join(dir, "review.json"), JSON.stringify(reportObject));

    return spawnSync(process.execPath, [verdictScript, "--report", "review.json"], {
      cwd: dir, encoding: "utf8", timeout: 3000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sha40Cli = "0123456789abcdef0123456789abcdef01234567";

test("review-verdict CLI prints READY_FOR_REVIEW and exits 0 for complete observed commands", () => {
  const out = runReview({
    scope: "code-review",
    reviewedCommit: sha40Cli,
    gates: [{ id: "tests", status: "VERIFIED", evidence: {
      type: "command", command: "npm test", cwd: "repo", result: "3 passed", exitCode: 0,
      testCounts: { passed: 3, failed: 0, skipped: 0 },
    } }],
  });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).verdict, "READY_FOR_REVIEW");
});

test("review-verdict CLI exits 1 for CONDITIONAL_GO and NO_GO", () => {
  const conditional = runReview({
    reviewedCommit: sha40Cli,
    requiredGates: [{ id: "lint-contract", critical: false }],
    gates: [{ id: "tests", status: "VERIFIED", evidence: {
      type: "command", command: "npm test", cwd: "repo", result: "3 passed", exitCode: 0,
      testCounts: { passed: 3, failed: 0, skipped: 0 },
    } }],
  });
  assert.equal(conditional.status, 1, conditional.stderr);
  assert.equal(JSON.parse(conditional.stdout).verdict, "CONDITIONAL_GO");

  const failed = runReview({
    gates: [{ id: "typecheck", status: "VERIFIED", evidence: {
      type: "command", command: "npm run typecheck", cwd: "repo", result: "errors found", exitCode: 1,
    } }],
  });
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(JSON.parse(failed.stdout).verdict, "NO_GO");
});

test("review-verdict CLI exits 2 for NOT_ASSESSED and invalid input", () => {
  const empty = runReview({ gates: [] });
  assert.equal(empty.status, 2, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).verdict, "NOT_ASSESSED");

  const dir = mkdtempSync(join(tmpdir(), "ksd-verdict-"));
  try {
    writeFileSync(join(dir, "review.json"), "{not json");
    const out = spawnSync(process.execPath, [verdictScript, "--report", "review.json"], {
      cwd: dir, encoding: "utf8", timeout: 3000,
    });
    assert.equal(out.status, 2);
    assert.match(out.stderr, /^KSD review NOT ASSESSED: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
