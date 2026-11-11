import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import createExtension from "../../src/policy/index.js";
import { augmentSystemPrompt, buildPolicy, POLICY_MARKER } from "../../src/policy/policy.js";
import { loadConfig, findProjectRoot } from "../../src/policy/config.js";

// Set by test/helpers/isolated-home.js via `npm test`; never fall back to the real HOME (this file creates/deletes dirs under it).
const isolatedHome = process.env.KSD_TEST_HOME;
if (!isolatedHome || isolatedHome !== process.env.HOME || isolatedHome === userInfo().homedir) {
  throw new Error("Run tests via `npm test` so HOME is isolated");
}

function harness(commandNames = ["ponytail"]) {
  const events = new Map();
  const commands = new Map();
  const sent = [];
  const notices = [];
  const statuses = [];
  const pi = {
    setLabel(label) { this.label = label; },
    on(event, fn) { events.set(event, fn); },
    registerCommand(name, entry) { commands.set(name, entry); },
    getCommands() { return commandNames.map(name => ({ name })); },
    sendUserMessage(message, options) { sent.push({ message, options }); },
  };
  createExtension(pi);
  const ctx = (cwd, idle = true) => ({ cwd, isIdle: () => idle, ui: { notify: (...args) => notices.push(args), setStatus: (...args) => statuses.push(args) } });

  return { events, commands, sent, notices, statuses, pi, ctx };
}

test("namespace does not collide with Ponytail commands or modes", () => {
  const h = harness();
  assert.deepEqual([...h.commands.keys()], ["engineering-proxy", "engineering-review"]);
  assert.deepEqual([...h.events.keys()], ["session_start", "session_tree", "session_switch", "session_branch", "agent_start", "agent_end", "before_agent_start"]);
});

test("structured sections preserve Ponytail and are stable on repeated hooks", () => {
  const h = harness();
  const dir = mkdtempSync(join(tmpdir(), "engineering-proxy-"));
  try {
    const e = { systemPromptOptions: { sections: { ponytail: "Ponytail full rules" } } };
    h.events.get("before_agent_start")(e, h.ctx(dir));
    const original = e.systemPromptOptions.sections["engineering-proxy"];
    h.events.get("before_agent_start")(e, h.ctx(dir));
    assert.equal(e.systemPromptOptions.sections.ponytail, "Ponytail full rules");
    assert.equal(e.systemPromptOptions.sections["engineering-proxy"], original);
    assert.match(original, /Ponytail owns YAGNI/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("array fallback preserves all existing policy parts and avoids duplicates", () => {
  const policy = buildPolicy();
  const start = { systemPrompt: ["base", "Ponytail instructions"] };
  const out = augmentSystemPrompt(start, policy);
  assert.deepEqual(out.systemPrompt, ["base", "Ponytail instructions", policy]);
  assert.equal(augmentSystemPrompt({ systemPrompt: out.systemPrompt }, policy), undefined);
});

test("string fallback preserves existing policy and avoids duplicates", () => {
  const policy = buildPolicy();
  const result = augmentSystemPrompt({ systemPrompt: "base Ponytail" }, policy);
  assert.equal(result.systemPrompt.split(POLICY_MARKER).length - 1, 1);
  assert.equal(augmentSystemPrompt({ systemPrompt: result.systemPrompt }, policy), undefined);
});

test("works when Ponytail is absent", async () => {
  const h = harness([]);
  const dir = mkdtempSync(join(tmpdir(), "engineering-proxy-"));
  try {
    await h.commands.get("engineering-proxy").handler("", h.ctx(dir));
    assert.match(h.notices[0][0], /not detected\/unknown/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("off mode in per-repo config prevents injection", () => {
  const dir = mkdtempSync(join(tmpdir(), "engineering-proxy-"));
  try {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".engineering-proxy.json"), JSON.stringify({ enabled: false }));
    const h = harness();
    const event = { systemPromptOptions: { sections: { ponytail: "still on" } } };
    assert.equal(h.events.get("before_agent_start")(event, h.ctx(dir)), undefined);
    assert.equal(event.systemPromptOptions.sections["engineering-proxy"], undefined);
    assert.equal(event.systemPromptOptions.sections.ponytail, "still on");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("findProjectRoot respects nested cwd and local policy", () => {
  const dir = mkdtempSync(join(tmpdir(), "engineering-proxy-"));
  try {
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, ".engineering-proxy.json"), JSON.stringify({ enabled: false, enforcement: "balanced" }));
    assert.equal(findProjectRoot(join(dir, "src")), dir);
    assert.equal(loadConfig(join(dir, "src")).enabled, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("findProjectRoot ignores the global ~/.omp agent dir but honours a project .omp", () => {
  mkdirSync(join(isolatedHome, ".omp", "agent"), { recursive: true });
  const base = mkdtempSync(join(isolatedHome, "work-"));
  const work = join(base, "plain");
  const project = join(base, "omp-project");
  mkdirSync(work);
  mkdirSync(join(project, ".omp"), { recursive: true });
  mkdirSync(join(project, "src"));
  try {
    assert.equal(findProjectRoot(work), work, "HOME must not become a project root");
    // cwd reached via its real path while HOME is a symlink (macOS tmp) must still not stop at HOME.
    assert.equal(findProjectRoot(realpathSync(work)), realpathSync(work), "symlinked HOME must not become a project root");
    assert.equal(findProjectRoot(join(project, "src")), project);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("malformed JSON disables policy with explicit warning rather than crashing", () => {
  const dir = mkdtempSync(join(tmpdir(), "engineering-proxy-"));
  try {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".engineering-proxy.json"), "{ broken");
    const config = loadConfig(dir);
    assert.equal(config.enabled, false);
    assert.ok(config.configError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("review only starts on explicit command, one request per trigger, and queues while busy", async () => {
  const h = harness(["ponytail"]);
  const dir = mkdtempSync(join(tmpdir(), "engineering-proxy-"));
  try {
    h.events.get("before_agent_start")({ systemPromptOptions: { sections: {} } }, h.ctx(dir));
    assert.equal(h.sent.length, 0);
    await h.commands.get("engineering-review").handler("apps/web/features/auth", h.ctx(dir, false));
    assert.equal(h.sent.length, 1);
    assert.match(h.sent[0].message, /apps\/web\/features\/auth/);
    assert.match(h.sent[0].message, /Scope: inspect the actual diff/);
    assert.match(h.sent[0].message, /must not be invoked here unless the user separately requested it/);
    assert.match(h.sent[0].message, /SDLC workflow/, "review carries the tier-2 SDLC checklist");
    assert.match(h.sent[0].message, /Review scope: apps\/web\/features\/auth$/, "operator scope stays last");
    assert.deepEqual(h.sent[0].options, { deliverAs: "followUp" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("disabling the extension clears a previously attached structured policy, not Ponytail", () => {
  const dir = mkdtempSync(join(tmpdir(), "engineering-proxy-"));
  try {
    mkdirSync(join(dir, ".git"));
    const h = harness();
    const event = { systemPromptOptions: { sections: { ponytail: "full", "engineering-proxy": "stale" } } };
    writeFileSync(join(dir, ".engineering-proxy.json"), JSON.stringify({ enabled: false }));
    h.events.get("before_agent_start")(event, h.ctx(dir));
    assert.equal(event.systemPromptOptions.sections["engineering-proxy"], undefined);
    assert.equal(event.systemPromptOptions.sections.ponytail, "full");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid per-repo config never silently enables guidance", () => {
  const dir = mkdtempSync(join(tmpdir(), "engineering-proxy-"));
  try {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".engineering-proxy.json"), JSON.stringify({ enabled: "false" }));
    const h = harness();
    const event = { systemPromptOptions: { sections: {} } };
    h.events.get("before_agent_start")(event, h.ctx(dir));
    assert.equal(event.systemPromptOptions.sections["engineering-proxy"], undefined);
    assert.ok(loadConfig(dir).configError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("session lifecycle shows a separate KSD status without touching Ponytail", () => {
  const h = harness(["ponytail"]);
  const dir = mkdtempSync(join(tmpdir(), "engineering-proxy-"));
  try {
    const ctx = h.ctx(dir);
    h.events.get("session_start")({}, ctx);
    h.events.get("session_switch")({}, ctx);
    h.events.get("session_branch")({}, ctx);
    assert.deepEqual(h.statuses, [
      ["engineering-proxy", "○ 🛡 KSD: BALANCED"],
      ["engineering-proxy", "○ 🛡 KSD: BALANCED"],
      ["engineering-proxy", "○ 🛡 KSD: BALANCED"],
    ]);
    assert.equal(h.sent.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("repo disabling clears KSD status while leaving Ponytail alone", () => {
  const h = harness();
  const dir = mkdtempSync(join(tmpdir(), "engineering-proxy-"));
  try {
    mkdirSync(join(dir, ".git"));
    h.events.get("session_start")({}, h.ctx(dir));
    writeFileSync(join(dir, ".engineering-proxy.json"), JSON.stringify({ enabled: false }));
    h.events.get("before_agent_start")({ systemPromptOptions: { sections: { ponytail: "full" } } }, h.ctx(dir));
    assert.deepEqual(h.statuses.at(-1), ["engineering-proxy", undefined]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid config fails closed, clears stale status and preserves session", () => {
  const h = harness();
  const dir = mkdtempSync(join(tmpdir(), "engineering-proxy-"));
  try {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".engineering-proxy.json"), "{ invalid");
    h.events.get("session_start")({}, h.ctx(dir));
    assert.deepEqual(h.statuses.at(-1), ["engineering-proxy", undefined]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("missing or throwing setStatus is non-fatal for all supported host UIs", () => {
  const h = harness();
  const dir = mkdtempSync(join(tmpdir(), "engineering-proxy-"));
  try {
    assert.doesNotThrow(() => h.events.get("session_start")({}, { cwd: dir, ui: {} }));
    assert.doesNotThrow(() => h.events.get("session_start")({}, { cwd: dir, ui: { setStatus() { throw Error("UI unavailable"); } } }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("explicit review preserves KSD status and does not overwrite built-in review key", async () => {
  const h = harness();
  const dir = mkdtempSync(join(tmpdir(), "engineering-proxy-"));
  try {
    await h.commands.get("engineering-review").handler("", h.ctx(dir));
    assert.deepEqual(h.statuses, [["engineering-proxy", "○ 🛡 KSD: BALANCED"]]);
    assert.equal(h.sent.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("agent lifecycle renders filled dot while running, hollow dot when idle", () => {
  const h = harness();
  const dir = mkdtempSync(join(tmpdir(), "engineering-proxy-"));
  try {
    const ctx = h.ctx(dir);
    h.events.get("session_start")({}, ctx);
    h.events.get("agent_start")({}, ctx);
    h.events.get("before_agent_start")({ systemPromptOptions: { sections: {} } }, ctx);
    h.events.get("agent_end")({}, ctx);

    assert.deepEqual(h.statuses.map(([, label]) => label), [
      "○ 🛡 KSD: BALANCED",
      "● 🛡 KSD: BALANCED",
      "○ 🛡 KSD: BALANCED",
    ]);
    assert.equal(h.statuses.every(([key]) => key === "engineering-proxy"), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("new session, switch and branch reset stale activity without touching Ponytail", () => {
  const h = harness();
  const dir = mkdtempSync(join(tmpdir(), "engineering-proxy-"));
  try {
    const ctx = h.ctx(dir);
    for (const lifecycleEvent of ["session_start", "session_switch", "session_branch"]) {
      h.events.get("agent_start")({}, ctx);
      h.events.get(lifecycleEvent)({}, ctx);
      assert.deepEqual(h.statuses.slice(-2), [
        ["engineering-proxy", "● 🛡 KSD: BALANCED"],
        ["engineering-proxy", "○ 🛡 KSD: BALANCED"],
      ]);
    }
    assert.equal(h.sent.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("disabled project clears status even when agent is active", () => {
  const h = harness();
  const dir = mkdtempSync(join(tmpdir(), "engineering-proxy-"));
  try {
    mkdirSync(join(dir, ".git"));
    const ctx = h.ctx(dir);
    h.events.get("agent_start")({}, ctx);
    writeFileSync(join(dir, ".engineering-proxy.json"), JSON.stringify({ enabled: false }));
    h.events.get("before_agent_start")({ systemPromptOptions: { sections: { ponytail: "full" } } }, ctx);
    assert.deepEqual(h.statuses.slice(-2), [
      ["engineering-proxy", "● 🛡 KSD: BALANCED"],
      ["engineering-proxy", undefined],
    ]);
    h.events.get("agent_end")({}, ctx);
    assert.deepEqual(h.statuses.at(-1), ["engineering-proxy", undefined]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("uses OMP theme for colored dots when available", () => {
  const h = harness();
  const dir = mkdtempSync(join(tmpdir(), "engineering-proxy-"));
  try {
    const ctx = h.ctx(dir);
    ctx.ui.theme = { fg: (tone, glyph) => "[" + tone + ":" + glyph + "]" };
    h.events.get("session_start")({}, ctx);
    h.events.get("agent_start")({}, ctx);
    h.events.get("agent_end")({}, ctx);
    assert.deepEqual(h.statuses.map(([, label]) => label), [
      "[dim:○] 🛡 KSD: BALANCED",
      "[accent:●] 🛡 KSD: BALANCED",
      "[dim:○] 🛡 KSD: BALANCED",
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("theme failures and unsupported UI never crash the activity lifecycle", () => {
  const h = harness();
  const dir = mkdtempSync(join(tmpdir(), "engineering-proxy-"));
  try {
    const ctx = h.ctx(dir);
    Object.defineProperty(ctx.ui, "theme", { get() { throw new Error("Theme unavailable"); } });
    assert.doesNotThrow(() => h.events.get("agent_start")({}, ctx));
    assert.deepEqual(h.statuses.at(-1), ["engineering-proxy", "● 🛡 KSD: BALANCED"]);
    assert.doesNotThrow(() => h.events.get("agent_end")({}, { cwd: dir, ui: { setStatus() { throw new Error("TUI disconnected"); } } }));
    assert.doesNotThrow(() => h.events.get("session_start")({}, { cwd: dir, ui: {} }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
