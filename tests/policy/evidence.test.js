import test from "node:test";
import assert from "node:assert/strict";
import { assessReview, hasEvidence } from "../../src/policy/review-verdict.js";

const sha40 = "0123456789abcdef0123456789abcdef01234567";
const sha64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const command = (over = {}, counts) => ({
  type: "command", command: "npm test", cwd: "repo", result: "exit ok", exitCode: 0,
  ...(counts ? { testCounts: counts } : {}),
  ...over,
});

const good = (id, evidence = command(), over = {}) => ({
  id, required: true, critical: false, status: "VERIFIED", evidence, ...over,
});

test("hasEvidence demands the strict command shape for executable evidence", () => {
  assert.equal(hasEvidence({ evidence: command() }), true);
  assert.equal(hasEvidence({ evidence: command({}, { passed: 2, failed: 0, skipped: 0 }) }), true);
  assert.equal(hasEvidence({ evidence: { type: "command", command: "npm test", result: "2 passed" } }), false, "legacy reports cannot verify");
  assert.equal(hasEvidence({ evidence: { ...command(), exitCode: 1 } }), false);
  assert.equal(hasEvidence({ evidence: command({ timedOut: true }) }), false);
  assert.equal(hasEvidence({ evidence: command({ signal: "SIGTERM" }) }), false);
});

test("VERIFIED with a failing exit code normalizes to FAILED and NO_GO", () => {
  const report = assessReview({ gates: [good("typecheck", command({ exitCode: 1 }))] });
  assert.equal(report.gates[0].status, "FAILED", report.gates[0].status);
  assert.equal(report.verdict, "NO_GO");
});

test("positive testCounts.failed forces FAILED even when the caller says VERIFIED", () => {
  const report = assessReview({ gates: [good("tests", command({}, { passed: 2, failed: 1, skipped: 0 }))] });
  assert.equal(report.gates[0].status, "FAILED");
  assert.equal(report.verdict, "NO_GO");
});

test("concrete command failures override partial and blocked claims", () => {
  for (const [status, evidence] of [
    ["PARTIAL", command({ exitCode: 1 })],
    ["BLOCKED", command({}, { passed: 2, failed: 1, skipped: 0 })],
  ]) {
    const report = assessReview({ gates: [good("tests", evidence, { status })] });
    assert.equal(report.gates[0].status, "FAILED");
    assert.equal(report.verdict, "NO_GO");
  }
});

test("legacy command reports without exit code or cwd stay readable but UNVERIFIED", () => {
  const report = assessReview({
    gates: [good("typecheck", { type: "command", command: "npm run typecheck", result: "no errors" })],
  });
  assert.equal(report.gates[0].status, "UNVERIFIED");
  assert.equal(report.verdict, "CONDITIONAL_GO");
});

test("timedOut or a non-null signal cannot verify completion", () => {
  assert.equal(assessReview({ gates: [good("lint", command({ timedOut: true }))] }).gates[0].status, "UNVERIFIED");
  assert.equal(assessReview({ gates: [good("lint", command({ signal: "SIGTERM" }))] }).gates[0].status, "UNVERIFIED");
});

test("positive skipped counts normalize VERIFIED to PARTIAL", () => {
  const report = assessReview({ gates: [good("tests", command({}, { passed: 6, failed: 0, skipped: 2 }))] });
  assert.equal(report.gates[0].status, "PARTIAL");
  assert.equal(report.verdict, "CONDITIONAL_GO");
});

test("the reserved tests gate requires all three counts and at least one pass", () => {
  assert.equal(assessReview({ gates: [good("tests", command({}, { passed: 0, failed: 0, skipped: 0 }))] }).gates[0].status, "UNVERIFIED");
  assert.equal(assessReview({ gates: [good("tests", command({}, { passed: 4, failed: 0, skipped: 4 }))] }).verdict, "CONDITIONAL_GO");
  assert.equal(assessReview({ gates: [good("tests", { type: "command", command: "npm test", cwd: "repo", result: "exit ok", exitCode: 0 })] }).gates[0].status, "UNVERIFIED");
  assert.equal(assessReview({ gates: [good("tests", command({}, { passed: 3, failed: 0, skipped: 0 }))] }).verdict, "READY_FOR_REVIEW");
});

test("partial counts and malformed source evidence cannot verify a gate", () => {
  const partial = assessReview({ gates: [good("tests", command({}, { passed: 3 }))] });
  assert.equal(partial.gates[0].status, "UNVERIFIED");
  const source = assessReview({ gates: [good("inspection", { type: "source" })] });
  assert.equal(source.gates[0].status, "UNVERIFIED");
});

test("incomplete supplied counts cannot verify custom or reserved command gates", () => {
  for (const id of ["integration", "lint", "tests"]) {
    for (const counts of [{ failed: 0, skipped: 0 }, { passed: 3, skipped: 0 }, { passed: 3, failed: 0 }, {}]) {
      const report = assessReview({ gates: [good(id, command({}, counts))] });
      assert.equal(report.gates[0].status, "UNVERIFIED", `${id}: ${JSON.stringify(counts)}`);
      assert.equal(report.verdict, "CONDITIONAL_GO");
    }
  }
});

test("skips remain PARTIAL with zero passes or incomplete counts", () => {
  for (const id of ["integration", "lint", "tests"]) {
    for (const counts of [
      { passed: 0, failed: 0, skipped: 4 },
      { passed: 0, skipped: 4 },
      { skipped: 4 },
    ]) {
      const report = assessReview({ gates: [good(id, command({}, counts))] });
      assert.equal(report.gates[0].status, "PARTIAL", `${id}: ${JSON.stringify(counts)}`);
      assert.equal(report.verdict, "CONDITIONAL_GO");
    }
  }
});

test("failure and critical precedence apply with incomplete counts", () => {
  for (const id of ["integration", "lint", "tests"]) {
    const failed = assessReview({ gates: [good(id, command({}, { failed: 1 }))] });
    assert.equal(failed.gates[0].status, "FAILED");
    assert.equal(failed.verdict, "NO_GO");

    const critical = assessReview({
      gates: [good(id, command({}, { passed: 1 }), { required: false, critical: false })],
      requiredGates: [{ id, critical: true }],
    });
    assert.equal(critical.gates[0].status, "UNVERIFIED");
    assert.equal(critical.gates[0].required, true);
    assert.equal(critical.gates[0].critical, true);
    assert.equal(critical.verdict, "NO_GO");
  }
});

test("malformed test counts are rejected even when supplied counts report failure", () => {
  for (const counts of [null, [], { passed: -1, failed: 1 }, { failed: 1, skipped: "4" }]) {
    assert.throws(() => assessReview({ gates: [good("integration", command({ testCounts: counts }))] }), /testCounts/);
  }
});

test("declared required gate cannot be marked optional by supplied evidence", () => {
  const report = assessReview({
    requiredGates: [{ id: "lint" }],
    gates: [good("lint", command({ exitCode: 1 }), { required: false })],
  });
  assert.equal(report.gates[0].required, true);
  assert.equal(report.verdict, "NO_GO");
});

test("source-only evidence cannot verify reserved execution gates", () => {
  const report = assessReview({ gates: [good("tests", {
    type: "source", path: "test/unit.test.js", observation: "tests exist and look thorough",
  })] });
  assert.equal(report.gates[0].status, "UNVERIFIED");
});

test("custom inspection gates may still use source evidence", () => {
  const report = assessReview({ gates: [good("auth-contract", {
    type: "source", path: "src/auth.ts", observation: "denial cases examined",
  })] });
  assert.equal(report.gates[0].status, "VERIFIED");
  assert.equal(report.verdict, "READY_FOR_REVIEW");
});

test("omitted declared critical gates are synthesized as NOT_RUN and force NO_GO", () => {
  const report = assessReview({
    gates: [good("tests")],
    requiredGates: [{ id: "auth-contract", critical: true }],
  });
  const missing = report.gates.find(g => g.id === "auth-contract");
  assert.equal(missing.status, "NOT_RUN");
  assert.equal(missing.critical, true);
  assert.equal(report.verdict, "NO_GO");
});

test("a declared critical gate cannot be downgraded by a supplied false flag", () => {
  const report = assessReview({
    gates: [good("auth-contract", command(), { required: false, critical: false })],
    requiredGates: [{ id: "auth-contract", critical: true }],
  });
  assert.equal(report.gates[0].critical, true);
  assert.equal(report.gates[0].required, true);
});

test("ci-parity rejects source evidence and needs an https, credential-free URL", () => {
  const source = assessReview({ gates: [good("ci-parity", {
    type: "source", path: ".github/workflows/test.yml", observation: "workflow exists",
  })] });
  assert.equal(source.gates[0].status, "UNVERIFIED");

  const insecure = assessReview({ reviewedCommit: sha40, gates: [good("ci-parity", {
    type: "ci-run", url: "http://ci.example.invalid/run/1", conclusion: "success", headSha: sha40,
  })] });
  assert.equal(insecure.gates[0].status, "UNVERIFIED");

  const withCredentials = assessReview({ reviewedCommit: sha40, gates: [good("ci-parity", {
    type: "ci-run", url: "https://user:secret@ci.example.invalid/run/1", conclusion: "success", headSha: sha40,
  })] });
  assert.equal(withCredentials.gates[0].status, "UNVERIFIED");

  const unparseable = assessReview({ reviewedCommit: sha40, gates: [good("ci-parity", {
    type: "ci-run", url: "not a url at all", conclusion: "success", headSha: sha40,
  })] });
  assert.equal(unparseable.gates[0].status, "UNVERIFIED");
});

test("ci-parity needs a matching reviewedCommit (40- and 64-hex both accepted)", () => {
  for (const sha of [sha40, sha64]) {
    const rival = assessReview({ reviewedCommit: sha, gates: [good("ci-parity", {
      type: "ci-run", url: "https://ci.example.invalid/run/1", conclusion: "success",
      headSha: sha === sha40 ? sha64 : sha40,
    })] });
    assert.equal(rival.gates[0].status, "UNVERIFIED", `${sha.slice(0, 4)} mismatch must not verify`);

    const matching = assessReview({ reviewedCommit: sha, gates: [good("ci-parity", {
      type: "ci-run", url: "https://ci.example.invalid/run/1", conclusion: "success", headSha: sha,
    })] });
    assert.equal(matching.gates[0].status, "VERIFIED");
  }

  const noCommit = assessReview({ gates: [good("ci-parity", {
    type: "ci-run", url: "https://ci.example.invalid/run/1", conclusion: "success", headSha: sha40,
  })] });
  assert.equal(noCommit.gates[0].status, "UNVERIFIED");
});

test("gate ids are trimmed; empty and duplicate ids after trimming are rejected", () => {
  const report = assessReview({ gates: [good(" ci-parity ", {
    type: "source", path: "docs/ci.yml", observation: "workflow checked by hand",
  })], reviewedCommit: sha40 });
  assert.equal(report.gates[0].status, "UNVERIFIED", "trimmed ci-parity still needs ci-run evidence");

  assert.throws(() => assessReview({ gates: [{ id: "  ", status: "NOT_RUN" }] }), /id/i);
  assert.throws(() => assessReview({ gates: [good("typecheck"), good(" typecheck ")] }), /Duplicate/i);
  assert.throws(() => assessReview({
    gates: [good("tests")], requiredGates: [{ id: "auth" }, { id: " auth " }],
  }), /Duplicate/i);
});

test("nonboolean required/critical flags are rejected", () => {
  assert.throws(() => assessReview({ gates: [good("security", command(), { required: "false" })] }), /required/);
  assert.throws(() => assessReview({ gates: [good("security", command(), { critical: "false" })] }), /critical/);
  assert.throws(() => assessReview({ gates: [good("tests")], requiredGates: [{ id: "auth", critical: "false" }] }), /critical/);
  assert.throws(() => assessReview({ gates: [good("tests")], requiredGates: [{ id: "auth", required: "false" }] }), /required/);
});

test("invalid scopes, gates arrays, requiredGates and reviewedCommit are rejected", () => {
  assert.throws(() => assessReview({ scope: "audit", gates: [] }), /Invalid scope/i);
  assert.throws(() => assessReview({ gates: "not an array" }), /gates/i);
  assert.throws(() => assessReview({ gates: [], requiredGates: "nope" }), /requiredGates/i);
  assert.throws(() => assessReview({ reviewedCommit: "0".repeat(39), gates: [] }), /reviewedCommit/i);
});

test("gates may be omitted entirely; omitted gates with requiredGates still assess", () => {
  assert.equal(assessReview({ gates: [] }).verdict, "NOT_ASSESSED");
  const synthesized = assessReview({ requiredGates: [{ id: "auth-contract", critical: true }] });
  assert.equal(synthesized.verdict, "NO_GO");
  assert.equal(synthesized.gates[0].id, "auth-contract");
  assert.equal(synthesized.gates[0].status, "NOT_RUN");
});

test("UNVERIFIED input status is accepted and stays missing for release", () => {
  const release = assessReview({ scope: "release", gates: [
    good("tests"), { id: "security", status: "UNVERIFIED" },
  ] });
  assert.equal(release.verdict, "NO_GO");
});

test("release with every gate verified stays a release candidate, never approval", () => {
  const report = assessReview({ scope: "release", reviewedCommit: sha40, gates: [
    good("tests", command({}, { passed: 3, failed: 0, skipped: 0 })),
    good("security", command({ command: "npm audit --json" })),
    good("ci-parity", { type: "ci-run", url: "https://ci.example.invalid/run/1", conclusion: "success", headSha: sha40 }),
  ] });
  assert.equal(report.verdict, "RELEASE_CANDIDATE");
  assert.match(report.disclaimer, /not independently authenticated/);
  assert.match(report.disclaimer, /No merge or deployment approval/);
});
