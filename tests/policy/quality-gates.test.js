import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChangedLines, inspectChangedScope } from "../../src/policy/change-scope.js";
import { assessReview } from "../../src/policy/review-verdict.js";

const patch = [
  "diff --git a/src/user.ts b/src/user.ts",
  "--- a/src/user.ts",
  "+++ b/src/user.ts",
  "@@ -3,0 +4,2 @@",
  "+function example() {",
  "+  return 1;",
  "diff --git a/src/old.ts b/src/old.ts",
  "--- a/src/old.ts",
  "+++ b/src/old.ts",
  "@@ -9,3 +8,0 @@",
  "-lost",
  "-missing",
  "-work",
].join("\n");

test("tracks only added lines, excluding deletion-only hunks", () => {
  const lines = parseChangedLines(patch);
  assert.deepEqual([...lines.get("src/user.ts")], [4, 5]);
  assert.equal(lines.get("src/old.ts").size, 0);
});

test("only changed-line diagnostics trigger a blocking finding", () => {
  const report = [{ filePath: "/work/src/user.ts", messages: [
    { line: 4, severity: 2, ruleId: "ksd/blank-between-functions", message: "Spacing" },
    { line: 60, severity: 2, ruleId: "other", message: "Legacy" },
  ] }];
  const actual = inspectChangedScope(patch, report, { cwd: "/work" });
  assert.equal(actual.status, "FIX_REQUIRED");
  assert.equal(actual.diagnostics.length, 1);
  assert.equal(actual.diagnostics[0].line, 4);
});

test("boundary diagnostics are included when the preceding changed line caused them", () => {
  const report = [{ filePath: "/work/src/user.ts", messages: [
    { line: 6, severity: 1, ruleId: "ksd/blank-before-return", message: "Missing blank line" },
  ] }];
  const actual = inspectChangedScope(patch, report, { cwd: "/work" });
  assert.equal(actual.status, "WARN");
});

test("missing ESLint coverage never returns PASS", () => {
  const result = inspectChangedScope(patch, [], { cwd: "/work" });
  assert.equal(result.status, "NOT_RUN");
  assert.deepEqual(result.missingFiles, ["src/user.ts"]);
});

test("clean changed-code report passes only within supplied scope", () => {
  const report = [{ filePath: "/work/src/user.ts", messages: [] }];
  const result = inspectChangedScope(patch, report, { cwd: "/work" });
  assert.equal(result.status, "PASS");
  assert.match(result.limitation, /not independently verified/);
});

test("non-source diffs are not applicable", () => {
  const p = ["diff --git a/README.md b/README.md", "--- a/README.md", "+++ b/README.md", "@@ -2,0 +3 @@", "+hi"].join("\n");
  assert.equal(inspectChangedScope(p, [], { cwd: "/work" }).status, "NOT_APPLICABLE");
});

test("rejects maliciously large hunks and malformed reports", () => {
  assert.throws(() => parseChangedLines("diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1,100001 @@"), /excessively large/);
  assert.throws(() => inspectChangedScope(patch, {}, { cwd: "/work" }), /ESLint JSON array/);
});

const sha40 = "0123456789abcdef0123456789abcdef01234567";

const good = (id, evidence) => ({
  id, required: true, critical: false, status: "VERIFIED",
  evidence: evidence ?? {
    type: "command", command: "npm test", cwd: "repo", result: "2 passed", exitCode: 0,
    testCounts: { passed: 2, failed: 0, skipped: 0 },
  },
});

test("verdict cannot be ready without gates or evidence", () => {
  assert.equal(assessReview({ gates: [] }).verdict, "NOT_ASSESSED");
  const result = assessReview({ gates: [{ id: "test", status: "VERIFIED" }] });
  assert.equal(result.verdict, "CONDITIONAL_GO");
  assert.equal(result.gates[0].status, "UNVERIFIED");
});

test("critical unknown security gate is NO_GO", () => {
  const result = assessReview({ gates: [
    good("tests"),
    { id: "auth-contract", status: "NOT_RUN", critical: true },
  ] });
  assert.equal(result.verdict, "NO_GO");
});

test("required failed checks produce NO_GO", () => {
  assert.equal(assessReview({ gates: [good("typecheck"), { id: "style", status: "FIX_REQUIRED" }] }).verdict, "NO_GO");
});

test("CI gate rejects source inspection in place of an executed CI run", () => {
  const result = assessReview({ gates: [
    good("tests"),
    good("ci-parity", { type: "source", path: ".github/workflows/test.yml", observation: "Workflow exists" }),
  ] });
  assert.equal(result.verdict, "CONDITIONAL_GO");
  assert.equal(result.gates[1].status, "UNVERIFIED");
});

test("valid CI-run claim can produce review-ready, never deployment approval", () => {
  const result = assessReview({
    reviewedCommit: sha40,
    gates: [
      good("tests"),
      good("ci-parity", { type: "ci-run", url: "https://github.com/example/repo/actions/runs/1", conclusion: "success", headSha: sha40 }),
    ],
  });
  assert.equal(result.verdict, "READY_FOR_REVIEW");
  assert.match(result.disclaimer, /No merge or deployment approval/);
});

test("release with incomplete noncritical gate remains NO_GO", () => {
  const result = assessReview({ scope: "release", gates: [
    good("tests"),
    { id: "ci-parity", status: "NOT_RUN" },
  ] });
  assert.equal(result.verdict, "NO_GO");
});

test("critical gate cannot be bypassed by marking required false", () => {
  const report = assessReview({ gates: [
    good("tests"),
    { id: "security", required: false, critical: true, status: "NOT_RUN" },
  ] });
  assert.equal(report.verdict, "NO_GO");
  assert.equal(report.gates[1].required, true);
});

test("fatal parser errors cannot be hidden by changed-line filtering", () => {
  const report = [{ filePath: "/work/src/user.ts", messages: [
    { line: 1, fatal: true, severity: 2, ruleId: null, message: "Parsing error" },
  ] }];
  const result = inspectChangedScope(patch, report, { cwd: "/work" });
  assert.equal(result.status, "FIX_REQUIRED");
  assert.equal(result.diagnostics[0].message, "Parsing error");
});

test("symlinked cwd still matches ESLint paths reported under the real directory", () => {
  const real = realpathSync(mkdtempSync(join(tmpdir(), "ksd-real-")));
  const link = `${real}-link`;
  symlinkSync(real, link, "dir");
  try {
    const report = [{ filePath: join(real, "src/user.ts"), messages: [
      { line: 4, severity: 2, ruleId: "ksd/blank-between-functions", message: "Spacing" },
    ] }];
    const viaLink = inspectChangedScope(patch, report, { cwd: link });
    assert.equal(viaLink.status, "FIX_REQUIRED", "symlink mismatch must not degrade to NOT_RUN");
    assert.deepEqual(viaLink.missingFiles, []);
  } finally {
    rmSync(link, { force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

// --- 4a: real Git patch parsing ---

const ksdGit = (dir, args) => {
  const out = spawnSync("git", args, { cwd: dir, encoding: "utf8" });

  if (out.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${out.stderr}`);

  return out.stdout;
};

test("parses a real Git patch for quoted and backslash filenames (quotePath on and off)", (t) => {
  const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {

    t.skip("git is unavailable in this environment; real-repo parsing cannot be verified");

    return;
  }
  const onPosix = process.platform !== "win32";
  const names = ["a b.js", "ไทย.ts", `quote".js`, ...(onPosix ? ["back\\slash.js", "x:notes.js"] : [])];
  const dir = mkdtempSync(join(tmpdir(), "ksd-git-"));
  try {
    ksdGit(dir, ["init"]);
    ksdGit(dir, ["config", "user.email", "test@example.com"]);
    ksdGit(dir, ["config", "user.name", "Test"]);
    for (const name of names) writeFileSync(join(dir, name), "one\n");
    ksdGit(dir, ["add", "-A"]);
    ksdGit(dir, ["commit", "-m", "base"]);
    for (const name of names) writeFileSync(join(dir, name), "one\ntwo\n");
    for (const quotePath of ["true", "false"]) {
      const diff = ksdGit(dir, ["-c", `core.quotePath=${quotePath}`, "diff", "--no-ext-diff", "--no-textconv", "-U0", "HEAD"]);
      const lines = parseChangedLines(diff);
      const expected = onPosix
        ? new Map([["a b.js", [2]], ["ไทย.ts", [2]], [`quote".js`, [2]], ["back\\slash.js", [2]], ["x:notes.js", [2]]])
        : new Map([["a b.js", [2]], ["ไทย.ts", [2]], [`quote".js`, [2]]]);
      assert.deepEqual([...lines.keys()].sort(), [...expected.keys()].sort(), `core.quotePath=${quotePath}`);
      for (const [name, added] of expected) assert.deepEqual([...(lines.get(name) ?? [])], added, name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real Git edits and renames retain unquoted paths containing b/ delimiters", () => {
  const dir = mkdtempSync(join(tmpdir(), "ksd-git-delimiters-"));
  const edited = "plain b/edit.js";
  const oldName = "old b/path.js";
  const newName = "new b/path.js";
  const binary = "binary b/file.dat";
  const many = "many b/lines.js";
  try {
    ksdGit(dir, ["init"]);
    ksdGit(dir, ["config", "user.email", "test@example.com"]);
    ksdGit(dir, ["config", "user.name", "Test"]);
    mkdirSync(join(dir, "plain b"), { recursive: true });
    mkdirSync(join(dir, "old b"), { recursive: true });
    mkdirSync(join(dir, "new b"), { recursive: true });
    mkdirSync(join(dir, "binary b"), { recursive: true });
    mkdirSync(join(dir, "many b"), { recursive: true });
    writeFileSync(join(dir, edited), "before\n");
    writeFileSync(join(dir, oldName), "one\ntwo\nthree\nfour\nfive\n");
    writeFileSync(join(dir, binary), Buffer.from([0, 1, 2]));
    writeFileSync(join(dir, many), "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
    ksdGit(dir, ["add", "-A"]);
    ksdGit(dir, ["commit", "-m", "base"]);
    writeFileSync(join(dir, edited), "before\nafter\n");
    writeFileSync(join(dir, binary), Buffer.from([0, 1, 3]));
    writeFileSync(join(dir, many), "one\nchanged\nthree\nfour\nfive\nsix\nseven\nadded\n");
    ksdGit(dir, ["mv", oldName, newName]);
    writeFileSync(join(dir, newName), "one\ntwo\nthree\nfour\nfive\nsix\n");
    ksdGit(dir, ["add", "-A"]);
    const diff = ksdGit(dir, ["diff", "--cached", "--find-renames", "--no-ext-diff", "--no-textconv", "-U0", "HEAD"]);
    const lines = parseChangedLines(diff);
    assert.deepEqual([...lines.get(edited)], [2]);
    assert.deepEqual([...lines.get(newName)], [6]);
    assert.deepEqual([...lines.get(many)], [2, 8]);
    const report = [edited, newName, many].map(file => ({
      filePath: join(dir, file),
      messages: [{ line: file === newName ? 6 : 2, severity: 2, ruleId: "ksd/example", message: "Changed" }],
    }));
    assert.equal(inspectChangedScope(diff, report, { cwd: dir }).status, "FIX_REQUIRED");
    const untracked = "plain b/untracked.js";
    writeFileSync(join(dir, untracked), "fresh\n");
    const noIndex = spawnSync("git", ["diff", "--no-index", "-U0", "--", "/dev/null", untracked], { cwd: dir, encoding: "utf8" });
    assert.equal(noIndex.status, 1, noIndex.stderr);
    assert.deepEqual([...parseChangedLines(noIndex.stdout).get(untracked)], [1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects empty, overlapping, and out-of-order Git hunks", () => {
  const header = "diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n";
  for (const body of [
    "@@ -0,0 +0,0 @@",
    "@@ -0 +1 @@\n-old\n+new",
    "@@ -1 +1 @@\n-old\n+new\n@@ -1 +2 @@\n-old\n+new",
    "@@ -1 +1 @@\n-old\n+new\n@@ -2 +1 @@\n-old\n+new",
    "@@ -3 +3 @@\n-old\n+new\n@@ -1 +1 @@\n-old\n+new",
    "@@ -1 +3 @@\n-old\n+new",
    "@@ -1 +1 @@\n-old\n+new\n@@ -3 +100 @@\n-old\n+new",
    "@@ -1 +1 @@\n-old\n+new\n@@ -2,0 +4 @@\n+new",
  ]) {
    assert.throws(() => inspectChangedScope(header + body, [], { cwd: "/work" }), /hunk/i);
  }
});

test("an added source line resembling a header cannot change filenames", () => {
  const p = [
    "diff --git a/src/x.js b/src/x.js",
    "--- a/src/x.js",
    "+++ b/src/x.js",
    "@@ -0,0 +1,2 @@",
    "+real change",
    "+++ b/fake.js",
  ].join("\n");
  const lines = parseChangedLines(p);
  assert.deepEqual([...lines.keys()], ["src/x.js"]);
  assert.deepEqual([...lines.get("src/x.js")], [1, 2]);
});

test("rejects context-bearing hunks, custom prefixes and combined diffs", () => {
  const file = ["diff --git a/x.js b/x.js", "--- a/x.js", "+++ b/x.js"];
  assert.throws(() => parseChangedLines([...file, "@@ -1,3 +0,0 @@", "-a", " ctx", "-b"].join("\n")), /context/i);
  assert.throws(() => parseChangedLines(["diff --git prefix/x.js prefix/x.js", "--- prefix/x.js", "+++ prefix/x.js", "@@ -1,2 +2 @@", "-a", "+b"].join("\n")), /Git diff --git header/i);
  assert.throws(() => parseChangedLines(["diff --cc a/x.js b/x.js", "+++ b/x.js", "@@ -1,1 +1,1 @@"].join("\n")), /combined/i);
  assert.throws(() => parseChangedLines(["diff --combined a/x.js b/x.js"].join("\n")), /combined/i);
  assert.throws(() => parseChangedLines(["diff --raw a/x.js b/x.js"].join("\n")), /Unsupported Git diff header/i);
});

test("rejects truncated hunks and malformed counts promptly", () => {
  assert.throws(() => parseChangedLines([
    "diff --git a/x.js b/x.js", "--- a/x.js", "+++ b/x.js",
    "@@ -1,1 +1,3 @@", "+only one", "diff --git a/y.js b/y.js",
  ].join("\n")), /truncated/i);
  assert.throws(() => parseChangedLines([
    "diff --git a/x.js b/x.js", "--- a/x.js", "+++ b/x.js",
    "@@ -1, +2,3 @@", "+x",
  ].join("\n")), /Malformed Git diff hunk header/i);
  assert.throws(() => parseChangedLines([
    "diff --git a/x.js b/x.js", "--- a/x.js", "+++ b/x.js",
    "@@ -1 +1,2 @@", "garbage without prefixes",
  ].join("\n")), /truncated/i);
});

test("rejects overflow hunk starts without hanging", () => {
  const header = ["diff --git a/big.js b/big.js", "--- a/big.js", "+++ b/big.js"];
  assert.throws(() => parseChangedLines([
    ...header, `@@ -0,0 +${Number.MAX_SAFE_INTEGER},4 @@`, "+overflow body",
  ].join("\n")), /safe integer/i);
  assert.throws(() => parseChangedLines([
    ...header, `@@ -0,0 +${Number.MAX_SAFE_INTEGER},2 @@`, "+one", "+two",
  ].join("\n")), /safe integer/i);
  assert.throws(() => parseChangedLines([
    ...header, `@@ -0,0 +${Number.MAX_SAFE_INTEGER} @@`, "+one",
  ].join("\n")), /safe integer/i);
  assert.throws(() => parseChangedLines([
    ...header, `@@ -${Number.MAX_SAFE_INTEGER} +0,0 @@`, "-one",
  ].join("\n")), /safe integer/i);
  assert.throws(() => parseChangedLines([
    ...header, "@@ -0,0 +1,4 @@", "+1", "+2",
  ].join("\n")), /truncated/i);
  assert.throws(() => parseChangedLines([
    ...header, "@@ -0,0 +0,2 @@", "+1",
  ].join("\n")), /hunk start/i);
});

test("rejects NUL bytes, unsafe destinations, invalid quoting and invalid UTF-8", () => {
  assert.throws(() => parseChangedLines("diff --git a/x\u0000.js b/x.js"), /NUL/i);
  assert.throws(() => parseChangedLines([
    "diff --git a/x.js b/x.js", "--- a/x.js", "+++ b//abs/x.js", "@@ -1 +1 @@", "-a", "+b",
  ].join("\n")), /relative repository path/i);
  assert.throws(() => parseChangedLines([
    "diff --git a/x.js b/x.js", "--- a/x.js", "+++ b/C:/x.js", "@@ -1 +1 @@", "-a", "+b",
  ].join("\n")), /relative repository path/i);
  assert.throws(() => parseChangedLines([
    "diff --git a/x.js b/x.js", "--- a/x.js", "+++ b/../x.js", "@@ -1 +1 @@", "-a", "+b",
  ].join("\n")), /escapes repository/i);
  assert.throws(() => parseChangedLines('diff --git a/a.js b/a.js\n--- a/a.js\n+++ "b/unterminated.js'), /quoted/i);
  assert.throws(() => parseChangedLines([
    "diff --git a/a.js b/a.js", "--- a/a.js", '+++ "b/a.js"garbage',
    "@@ -0,0 +1 @@", "+new",
  ].join("\n")), /label|quoted/i);
  assert.throws(() => parseChangedLines([
    "diff --git a/a.js b/a.js", "--- a/a.js", '+++ "b/a.js"\tgarbage',
    "@@ -0,0 +1 @@", "+new",
  ].join("\n")), /label|quoted/i);
  assert.throws(() => parseChangedLines([
    "diff --git a/x.js b/x.js", "--- a/x.js", "+++ \"b/\\344\\270\\255\\377.js\"", "@@ -1 +1 @@", "-a", "+b",
  ].join("\n")), /UTF-8/i);
  assert.equal(parseChangedLines("").size, 0);
  assert.throws(() => parseChangedLines("plain garbage text"), /recognizable Git patch/i);
});

test("accepts Git's tab delimiter after a quoted path label", () => {
  const input = [
    'diff --git "a/a b.js" "b/a b.js"', '--- "a/a b.js"\t', '+++ "b/a b.js"\t',
    "@@ -0,0 +1 @@", "+new",
  ].join("\n");
  assert.deepEqual([...parseChangedLines(input).get("a b.js")], [1]);
});

test("parses CRLF patches, no-newline markers, and rename edits; untracked no-index diffs parse", (t) => {
  const crlf = [
    "diff --git a/one.js b/one.js", "--- a/one.js", "+++ b/one.js", "@@ -1 +1,2 @@",
    "-before", "+after line one", "+after line two",
  ].join("\r\n");
  assert.deepEqual([...parseChangedLines(crlf).get("one.js")], [1, 2]);

  const noNewline = [
    "diff --git a/two.js b/two.js", "--- a/two.js", "+++ b/two.js", "@@ -0,0 +1,1 @@",
    "+final", "\\ No newline at end of file",
  ].join("\n");
  assert.deepEqual([...parseChangedLines(noNewline).get("two.js")], [1]);

  const rename = [
    "diff --git a/old.ts b/new.ts",
    "similarity index 88%",
    "rename from old.ts",
    "rename to new.ts",
    "--- a/old.ts",
    "+++ b/new.ts",
    "@@ -1,1 +1,2 @@",
    "-old line",
    "+replacement one",
    "+replacement two",
  ].join("\n");
  const renamed = parseChangedLines(rename);
  assert.deepEqual([...renamed.keys()], ["new.ts"]);
  assert.deepEqual([...renamed.get("new.ts")], [1, 2]);

  const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {

    t.skip("git is unavailable in this environment; no-index parsing cannot be verified");

    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "ksd-noindex-"));
  try {
    mkdirSync(join(dir, "untracked"), { recursive: true });
    writeFileSync(join(dir, "untracked/new.js"), "fresh\n");
    const out = spawnSync("git", [
      "diff", "--no-index", "--no-ext-diff", "--no-textconv", "-U0", "--", "/dev/null", "untracked/new.js",
    ], { cwd: dir, encoding: "utf8" });
    if (out.status !== 1) throw new Error(`expected no-index exit 1, got ${out.status}: ${out.stderr}`);
    const lines = parseChangedLines(out.stdout);
    assert.deepEqual([...lines.keys()], ["untracked/new.js"]);
    assert.deepEqual([...lines.get("untracked/new.js")], [1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deletion-only and rename-only changes stay NOT_APPLICABLE as style verdicts", () => {
  const deletionOnly = [
    "diff --git a/legacy.ts b/legacy.ts", "--- a/legacy.ts", "+++ b/legacy.ts",
    "@@ -5,2 +4,0 @@", "-lost", "-gone",
  ].join("\n");
  assert.equal(inspectChangedScope(deletionOnly, [], { cwd: "/work" }).status, "NOT_APPLICABLE");
  const cosmetic = ["diff --git a/notes.md b/notes.md", "--- a/notes.md", "+++ b/notes.md", "@@ -1 +1 @@", "-a", "+b"].join("\n");
  assert.equal(inspectChangedScope(cosmetic, [], { cwd: "/work" }).status, "NOT_APPLICABLE");
});

// --- 4b: ESLint report trust boundary ---

test("ignored-file locationless warnings leave the changed file uncovered", () => {
  const report = [{ filePath: "/work/src/user.ts", messages: [
    { message: "File ignored because no matching configuration was supplied for this file.", severity: 1, ruleId: null },
  ] }];
  const result = inspectChangedScope(patch, report, { cwd: "/work" });
  assert.equal(result.status, "NOT_RUN", "ignored-file warnings can never prove PASS");
  assert.deepEqual(result.missingFiles, ["src/user.ts"]);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].severity, "warning");
  assert.equal(result.diagnostics[0].line, null);
});

test("invalid reports are rejected before scope decisions", () => {
  const docPatch = ["diff --git a/README.md b/README.md", "--- a/README.md", "+++ b/README.md", "@@ -1,1 +1 @@", "-a", "+b"].join("\n");
  assert.throws(() => inspectChangedScope(docPatch, {}, { cwd: "/work" }), /ESLint JSON array/);
  assert.throws(() => inspectChangedScope(docPatch, "nope", { cwd: "/work" }), /ESLint JSON array/);
  assert.throws(() => inspectChangedScope(docPatch, [null], { cwd: "/work" }), /entry must be an object/i);
  assert.throws(() => inspectChangedScope(docPatch, [{ messages: [] }], { cwd: "/work" }), /filePath/i);
  assert.throws(() => inspectChangedScope(docPatch, [{ filePath: "README.md" }], { cwd: "/work" }), /messages/i);
  assert.throws(() => inspectChangedScope(docPatch, [{ filePath: "README.md", messages: [7] }], { cwd: "/work" }), /diagnostic must be an object/i);
  assert.throws(() => inspectChangedScope(docPatch, [{ filePath: "README.md", messages: [{ severity: 1, fatal: null }] }], { cwd: "/work" }), /fatal/i);
  assert.throws(() => inspectChangedScope(docPatch, [{ filePath: "README.md", messages: [{ severity: 2, line: null }] }], { cwd: "/work" }), /line/i);
  assert.throws(() => inspectChangedScope(docPatch, [{ filePath: "README.md", messages: [{ severity: 3, message: "x" }] }], { cwd: "/work" }), /severity/);
  assert.throws(() => inspectChangedScope(docPatch, [{ filePath: "README.md", messages: [{ line: 0, severity: 1 }] }], { cwd: "/work" }), /line/);
  assert.throws(() => inspectChangedScope(docPatch, [{ filePath: "README.md", messages: [{ line: "3", severity: 1 }] }], { cwd: "/work" }), /line/);
  assert.throws(() => inspectChangedScope(docPatch, [{ filePath: "README.md", messages: [{ severity: 1, ruleId: 7 }] }], { cwd: "/work" }), /ruleId/i);
  assert.throws(() => inspectChangedScope(docPatch, [{ filePath: "README.md", messages: [{ severity: 1, message: "w" }], errorCount: 2 }], { cwd: "/work" }), /errorCount/);
  assert.throws(() => inspectChangedScope(docPatch, [{ filePath: "README.md", messages: [{ severity: 1, message: "w" }], warningCount: 0 }], { cwd: "/work" }), /warningCount/);
  assert.throws(() => inspectChangedScope(docPatch, [{ filePath: "README.md", messages: [{ severity: 2, message: "e", fatal: true, line: 3 }], fatalErrorCount: 0 }], { cwd: "/work" }), /fatalErrorCount/);
});

test("duplicate canonical report entries are rejected even when the later report is empty", () => {
  const duplicated = [
    { filePath: "/work/src/user.ts", messages: [{ line: 4, severity: 2, message: "Spacing", ruleId: "ksd/x" }] },
    { filePath: "/work/src/user.ts", messages: [] },
  ];
  assert.throws(() => inspectChangedScope(patch, duplicated, { cwd: "/work" }), /Duplicate/i);
});

test("rejects hunk body lines outside or exceeding declared counts", () => {
  const header = "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n";
  for (const body of ["+stray", "@@ -0,0 +1,1 @@\n+first\n+extra", "@@ -1,1 +0,0 @@\n+wrong\n-old"]) {
    assert.throws(() => parseChangedLines(header + body), /hunk|malformed/i);
  }
});

test("rejects extra file headers after a hunk and duplicate section headers", () => {
  const header = "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n";
  for (const extra of ["+++ b/fake.js", "--- a/fake.js", "--- a/a.js\n+++ b/a.js"]) {
    assert.throws(() => parseChangedLines(`${header}@@ -0,0 +1 @@\n+first\n${extra}`), /header|hunk|malformed/i);
  }
  assert.throws(() => parseChangedLines(`${header}+++ b/other.js`), /header|hunk|malformed/i);
});

test("rejects file labels that disagree with the decoded Git header", () => {
  for (const labels of [
    ["--- a/wrong.js", "+++ b/right.js"],
    ["--- a/left.js", "+++ b/wrong.js"],
    ["--- /dev/null", "+++ b/wrong.js"],
    ["--- a/wrong.js", "+++ /dev/null"],
  ]) {
    const input = ["diff --git a/left.js b/right.js", ...labels, "@@ -1 +1 @@", "-old", "+new"].join("\n");
    assert.throws(() => inspectChangedScope(input, [], { cwd: "/work" }), /label|path|header/i);
  }
});

test("accepts matching new and deleted file labels but rejects invalid null pairs", () => {
  const header = "diff --git a/a.js b/a.js\n";
  const added = `${header}--- /dev/null\n+++ b/a.js\n@@ -0,0 +1 @@\n+new`;
  const removed = `${header}--- a/a.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-old`;
  assert.deepEqual([...parseChangedLines(added).get("a.js")], [1]);
  assert.equal(inspectChangedScope(removed, [], { cwd: "/work" }).status, "NOT_APPLICABLE");
  assert.throws(() => parseChangedLines(`${header}--- /dev/null\n+++ /dev/null\n@@ -0,0 +1 @@\n+new`), /label|header/i);
  assert.throws(() => parseChangedLines(`${header}--- /dev/null\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new`), /new file/i);
});

test("rejects garbage and incomplete metadata-only Git sections", () => {
  for (const suffix of [
    "garbage", "index nonsense", "rename from a.js", "--- a/a.js", "index 1234567..7654321 100644",
    "--- a/a.js\n+++ b/a.js\ngarbage", "--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\ngarbage",
  ]) {
    const input = `diff --git a/a.js b/a.js\n${suffix}`;
    assert.throws(() => inspectChangedScope(input, [], { cwd: "/work" }), /Git|patch|header|metadata|section/i);
  }
});

test("accepts metadata-only renames, mode changes, binary diffs and empty new files", () => {
  for (const input of [
    "diff --git a/old.js b/new.js\nsimilarity index 100%\nrename from old.js\nrename to new.js",
    "diff --git a/a.js b/a.js\nold mode 100644\nnew mode 100755",
    "diff --git a/a.js b/a.js\nindex 1234567..7654321 100644\nBinary files a/a.js and b/a.js differ",
    "diff --git a/a.js b/a.js\nnew file mode 100644\nindex 0000000..e69de29",
  ]) {
    assert.equal(inspectChangedScope(input, [], { cwd: "/work" }).status, "NOT_APPLICABLE");
  }
});

test("parses real Git renames with independently quoted sides and literal UTF-8", (t) => {
  const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    t.skip("git is unavailable in this environment; real-repo rename parsing cannot be verified");

    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "ksd-git-rename-"));
  try {
    ksdGit(dir, ["init"]);
    ksdGit(dir, ["config", "user.email", "test@example.com"]);
    ksdGit(dir, ["config", "user.name", "Test"]);
    const pairs = [["old plain.js", 'new "ไทย".js'], ['old "ไทย".js', "new plain.js"]];
    for (const [old] of pairs) writeFileSync(join(dir, old), [1, 2, 3, 4, 5].map(n => `${old} line ${n}`).join("\n") + "\n");
    ksdGit(dir, ["add", "-A"]);
    ksdGit(dir, ["commit", "-m", "base"]);
    for (const [old, renamed] of pairs) {
      ksdGit(dir, ["mv", old, renamed]);
      writeFileSync(join(dir, renamed), [1, 2, 3, 4, 5].map(n => `${old} line ${n}`).join("\n") + "\nadded\n");
    }
    for (const quotePath of ["true", "false"]) {
      const diff = ksdGit(dir, ["-c", `core.quotePath=${quotePath}`, "diff", "--no-ext-diff", "--no-textconv", "-M", "-U0", "HEAD"]);
      const lines = parseChangedLines(diff);
      assert.deepEqual([...lines.keys()].sort(), pairs.map(([, renamed]) => renamed).sort());
      for (const [, renamed] of pairs) assert.deepEqual([...lines.get(renamed)], [6]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canonicalizes relative and absolute report paths against changed symlink identities", () => {
  const dir = mkdtempSync(join(tmpdir(), "ksd-report-links-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "user.ts"), "code\n");
    symlinkSync(join(dir, "src"), join(dir, "alias"), "dir");
    const aliasPatch = [
      "diff --git a/alias/user.ts b/alias/user.ts", "--- a/alias/user.ts", "+++ b/alias/user.ts",
      "@@ -0,0 +1 @@", "+code",
    ].join("\n");
    for (const filePath of ["src/user.ts", "alias/user.ts", join(dir, "src", "user.ts"), join(dir, "alias", "user.ts")]) {
      const result = inspectChangedScope(aliasPatch, [{ filePath, messages: [{ line: 1, severity: 2, message: "error" }] }], { cwd: dir });
      assert.equal(result.status, "FIX_REQUIRED", filePath);
      assert.deepEqual(result.missingFiles, []);
    }
    assert.throws(() => inspectChangedScope(aliasPatch, [
      { filePath: "alias/user.ts", messages: [{ line: 1, severity: 2, message: "error" }] },
      { filePath: join(dir, "src", "user.ts"), messages: [] },
    ], { cwd: dir }), /Duplicate/i);
    const docsPatch = "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -0,0 +1 @@\n+docs";
    assert.throws(() => inspectChangedScope(docsPatch, [
      { filePath: "alias/user.ts", messages: [] },
      { filePath: join(dir, "src", "user.ts"), messages: [] },
    ], { cwd: dir }), /Duplicate/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preserves every locationless warning and marks the file uncovered alongside diagnostics", () => {
  for (const other of [
    { line: 4, severity: 2, message: "located error" },
    { line: 60, severity: 1, message: "out-of-scope warning" },
    { severity: 2, fatal: true, message: "fatal" },
  ]) {
    const report = [{ filePath: "/work/src/user.ts", messages: [
      { severity: 1, message: "ignored one" },
      other,
      { severity: 1, message: "ignored two" },
    ] }];
    const result = inspectChangedScope(patch, report, { cwd: "/work" });
    assert.equal(result.status, "NOT_RUN");
    assert.deepEqual(result.missingFiles, ["src/user.ts"]);
    assert.deepEqual(result.diagnostics.filter(item => item.severity === "warning").map(item => item.message), ["ignored one", "ignored two"]);
    if (other.severity === 2) assert.ok(result.diagnostics.some(item => item.message === other.message));
  }
});
