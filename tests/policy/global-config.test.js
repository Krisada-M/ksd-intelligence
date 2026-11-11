import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createExtension, { parseEngineeringCommand, resolveSessionMode } from "../../src/policy/index.js";
import { loadConfig, setScopedMode } from "../../src/policy/config.js";

async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ksd-global-"));
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const globalConfigPath = join(dir, ".omp", "agent", "engineering-proxy.json");
  const options = { globalConfigPath };
  try {
    await fn({ dir, repo, globalConfigPath, options });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function rig(globalConfigPath) {
  const events = new Map();
  const commands = new Map();
  const entries = [];
  const notices = [];
  const statuses = [];
  const pi = {
    on(name, fn) { events.set(name, fn); },
    registerCommand(name, entry) { commands.set(name, entry); },
    appendEntry(type, data) { entries.push({ type: "custom", customType: type, data }); },
    getCommands() { return [{ name: "ponytail" }]; },
    sendUserMessage() {},
  };
  createExtension(pi, { globalConfigPath });
  const ctx = cwd => ({
    cwd,
    sessionManager: { getBranch: () => entries },
    ui: {
      setStatus: (...args) => statuses.push(args),
      notify: (...args) => notices.push(args),
    },
  });

  const command = (args, context) => commands.get("engineering-proxy").handler(args, context);

  return { events, commands, entries, notices, statuses, ctx, command };
}

test("parser supports global, repo, reset and rejects unsupported modes", () => {
  assert.deepEqual(parseEngineeringCommand("global adaptive"), { type: "set-scoped-mode", scope: "global", mode: "adaptive" });
  assert.deepEqual(parseEngineeringCommand("repo balanced"), { type: "set-scoped-mode", scope: "repo", mode: "balanced" });
  assert.deepEqual(parseEngineeringCommand("reset"), { type: "reset-session" });
  assert.deepEqual(parseEngineeringCommand("global reset"), { type: "reset-scoped-mode", scope: "global" });
  assert.deepEqual(parseEngineeringCommand("repo reset"), { type: "reset-scoped-mode", scope: "repo" });
  assert.deepEqual(parseEngineeringCommand("global strict"), { type: "invalid" });
  assert.deepEqual(parseEngineeringCommand("repo ultra"), { type: "invalid" });
});

test("project > global > default and resets restore inheritance", () => fixture(({ repo, options }) => {
  assert.equal(loadConfig(repo, options).enforcementSource, "default");
  setScopedMode(repo, "global", "adaptive", options);
  assert.equal(loadConfig(repo, options).enforcement, "adaptive");
  assert.equal(loadConfig(repo, options).enforcementSource, "global");
  setScopedMode(repo, "repo", "balanced", options);
  assert.equal(loadConfig(repo, options).enforcement, "balanced");
  assert.equal(loadConfig(repo, options).enforcementSource, "project");
  setScopedMode(repo, "repo", null, options);
  assert.equal(loadConfig(repo, options).enforcement, "adaptive");
  setScopedMode(repo, "global", null, options);
  assert.equal(loadConfig(repo, options).enforcement, "balanced");
}));

test("scoped writes preserve enabled and unrelated keys without changing other scope", () => fixture(({ repo, globalConfigPath, options }) => {
  writeFileSync(join(repo, ".engineering-proxy.json"), '{"enabled":false,"custom":"kept"}\n');
  setScopedMode(repo, "global", "adaptive", options);
  assert.equal(readFileSync(join(repo, ".engineering-proxy.json"), "utf8"), '{"enabled":false,"custom":"kept"}\n');
  setScopedMode(repo, "repo", "balanced", options);
  assert.deepEqual(JSON.parse(readFileSync(join(repo, ".engineering-proxy.json"), "utf8")), {
    enabled: false, custom: "kept", enforcement: "balanced",
  });
  assert.equal(loadConfig(repo, options).enabled, false);
  setScopedMode(repo, "repo", null, options);
  assert.deepEqual(JSON.parse(readFileSync(join(repo, ".engineering-proxy.json"), "utf8")), { enabled: false, custom: "kept" });
  assert.equal(JSON.parse(readFileSync(globalConfigPath, "utf8")).enforcement, "adaptive");
}));

test("invalid global configuration fails closed and is never overwritten", () => fixture(({ repo, globalConfigPath, options }) => {
  mkdirSync(join(globalConfigPath, ".."), { recursive: true });
  writeFileSync(globalConfigPath, "{ invalid");
  assert.equal(loadConfig(repo, options).enabled, false);
  assert.match(loadConfig(repo, options).configError, /global/);
  assert.throws(() => setScopedMode(repo, "global", "adaptive", options), /Cannot parse/);
  assert.equal(readFileSync(globalConfigPath, "utf8"), "{ invalid");
}));

test("session > project > global and reset tombstone survives session switch", () => fixture(async ({ repo, globalConfigPath }) => {
  const h = rig(globalConfigPath);
  const ctx = h.ctx(repo);
  await h.command("global adaptive", ctx);
  h.events.get("session_start")({}, ctx);
  assert.deepEqual(h.statuses.at(-1), ["engineering-proxy", "○ 🛡 KSD: ADAPTIVE"]);
  await h.command("repo balanced", ctx);
  assert.deepEqual(h.statuses.at(-1), ["engineering-proxy", "○ 🛡 KSD: BALANCED"]);
  await h.command("adaptive", ctx);
  await h.command("global balanced", ctx);
  await h.command("repo balanced", ctx);
  assert.deepEqual(h.statuses.at(-1), ["engineering-proxy", "○ 🛡 KSD: ADAPTIVE"]);
  await h.command("reset", ctx);
  assert.deepEqual(h.entries.at(-1).data, { reset: true });
  h.events.get("session_switch")({}, ctx);
  assert.equal(resolveSessionMode(h.entries, "balanced"), "balanced");
  assert.deepEqual(h.statuses.at(-1), ["engineering-proxy", "○ 🛡 KSD: BALANCED"]);
  await h.command("repo reset", ctx);
  await h.command("global adaptive", ctx);
  assert.deepEqual(h.statuses.at(-1), ["engineering-proxy", "○ 🛡 KSD: ADAPTIVE"]);
  const event = { systemPromptOptions: { sections: { ponytail: "full" } } };
  h.events.get("before_agent_start")(event, ctx);
  assert.match(event.systemPromptOptions.sections["engineering-proxy"], /Adaptive Clean Code/);
  assert.equal(event.systemPromptOptions.sections.ponytail, "full");
  await h.command("status", ctx);
  assert.match(h.notices.at(-1)[0], /ADAPTIVE \(global\)/);
}));

test("global enabled=false is overridable by repo, but invalid global fails closed", () => fixture(({ repo, globalConfigPath, options }) => {
  mkdirSync(join(globalConfigPath, ".."), { recursive: true });
  writeFileSync(globalConfigPath, '{"enabled":false,"enforcement":"adaptive"}');
  assert.equal(loadConfig(repo, options).enabled, false);
  writeFileSync(join(repo, ".engineering-proxy.json"), '{"enabled":true}');
  assert.equal(loadConfig(repo, options).enabled, true);
  assert.equal(loadConfig(repo, options).enforcement, "adaptive");
  writeFileSync(globalConfigPath, '{"enabled":"wrong"}');
  assert.equal(loadConfig(repo, options).enabled, false);
  assert.match(loadConfig(repo, options).configError, /Invalid global/);
}));

test("global mode applies to two repositories without cross-repo leakage", () => fixture(({ dir, repo, options }) => {
  const other = join(dir, "other");
  mkdirSync(join(other, ".git"), { recursive: true });
  setScopedMode(repo, "global", "adaptive", options);
  assert.equal(loadConfig(repo, options).enforcement, "adaptive");
  assert.equal(loadConfig(other, options).enforcement, "adaptive");
  assert.equal(loadConfig(other, options).configPresent, false);
  setScopedMode(other, "repo", "balanced", options);
  assert.equal(loadConfig(repo, options).enforcement, "adaptive");
  assert.equal(loadConfig(other, options).enforcement, "balanced");
}));
