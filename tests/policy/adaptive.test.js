import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createExtension, { parseEngineeringCommand, resolveSessionMode } from "../../src/policy/index.js";
import { loadConfig } from "../../src/policy/config.js";
import { augmentSystemPrompt, buildPolicy, POLICY_END, POLICY_MARKER } from "../../src/policy/policy.js";
import { buildSdlcPolicy } from "../../src/policy/sdlc.js";

function rig() {
  const events = new Map();
  const commands = new Map();
  const entries = [];
  const notices = [];
  const statuses = [];
  const pi = {
    setLabel() {},
    on(name, callback) { events.set(name, callback); },
    registerCommand(name, entry) { commands.set(name, entry); },
    appendEntry(type, data) { entries.push({ type: "custom", customType: type, data }); },
    getCommands() { return [{ name: "ponytail" }]; },
    sendUserMessage() {},
  };
  createExtension(pi);
  const ctx = dir => ({
    cwd: dir,
    sessionManager: { getBranch: () => entries },
    ui: {
      notify: (...args) => notices.push(args),
      setStatus: (...args) => statuses.push(args),
    },
  });

  return { pi, events, commands, entries, notices, statuses, ctx };
}

async function temp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ksd-adaptive-"));
  try {
    mkdirSync(join(dir, ".git"));

    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("mode parser accepts status, balanced and adaptive, rejects extras", () => {
  assert.deepEqual(parseEngineeringCommand(""), { type: "status" });
  assert.deepEqual(parseEngineeringCommand(" status "), { type: "status" });
  assert.deepEqual(parseEngineeringCommand(" ADAPTIVE "), { type: "set-mode", mode: "adaptive" });
  assert.deepEqual(parseEngineeringCommand("balanced"), { type: "set-mode", mode: "balanced" });
  assert.deepEqual(parseEngineeringCommand("adaptive please"), { type: "invalid" });
});

test("repo config accepts adaptive, rejects unsupported and malformed values", () => temp(dir => {
  writeFileSync(join(dir, ".engineering-proxy.json"), JSON.stringify({ enforcement: "adaptive" }));
  assert.equal(loadConfig(dir).enforcement, "adaptive");

  writeFileSync(join(dir, ".engineering-proxy.json"), JSON.stringify({ enforcement: "ultra" }));
  assert.equal(loadConfig(dir).enabled, false);
  assert.match(loadConfig(dir).configError, /Invalid/);
}));

test("adaptive command updates status and policy immediately, with no Ponytail mutation", async () => temp(async dir => {
  const h = rig();
  const ctx = h.ctx(dir);
  h.events.get("session_start")({}, ctx);
  await h.commands.get("engineering-proxy").handler("adaptive", ctx);

  assert.equal(h.entries.at(-1).customType, "engineering-proxy-mode");
  assert.equal(h.entries.at(-1).data.mode, "adaptive");
  assert.deepEqual(h.statuses.at(-1), ["engineering-proxy", "○ 🛡 KSD: ADAPTIVE"]);

  const event = { systemPromptOptions: { sections: { ponytail: "Ponytail preserved" } } };
  h.events.get("before_agent_start")(event, ctx);
  assert.match(event.systemPromptOptions.sections["engineering-proxy"], /flat by default/i);
  assert.doesNotMatch(event.systemPromptOptions.sections["engineering-proxy"], /SDLC workflow/, "SDLC moved to /engineering-review");
  assert.equal(event.systemPromptOptions.sections.ponytail, "Ponytail preserved");

  await h.commands.get("engineering-proxy").handler("balanced", ctx);
  h.events.get("before_agent_start")(event, ctx);
  assert.match(event.systemPromptOptions.sections["engineering-proxy"], /Balanced Clean Code/);
  assert.doesNotMatch(event.systemPromptOptions.sections["engineering-proxy"], /Adaptive Clean Code/);
  assert.deepEqual(h.statuses.at(-1), ["engineering-proxy", "○ 🛡 KSD: BALANCED"]);
}));

test("mode restores on session resume and falls back to repo default", async () => temp(async dir => {
  writeFileSync(join(dir, ".engineering-proxy.json"), JSON.stringify({ enforcement: "adaptive" }));
  const h = rig();
  const ctx = h.ctx(dir);
  h.events.get("session_start")({}, ctx);
  assert.deepEqual(h.statuses.at(-1), ["engineering-proxy", "○ 🛡 KSD: ADAPTIVE"]);

  await h.commands.get("engineering-proxy").handler("balanced", ctx);
  h.events.get("session_switch")({}, ctx);
  assert.deepEqual(h.statuses.at(-1), ["engineering-proxy", "○ 🛡 KSD: BALANCED"]);
  assert.deepEqual(resolveSessionMode(h.entries, "adaptive"), "balanced");

  h.entries.length = 0;
  h.events.get("session_tree")({}, ctx);
  assert.deepEqual(h.statuses.at(-1), ["engineering-proxy", "○ 🛡 KSD: ADAPTIVE"]);
}));

test("branch history is authoritative: only the active branch applies, faults never fall through", async () => temp(dir => {
  const h = rig();

  function session(entries) {
    const ctx = h.ctx(dir);
    const sm = ctx.sessionManager = { getBranch: () => entries };

    return { ctx, sm };
  }

  h.events.get("session_start")({}, session([{ type: "custom", customType: "engineering-proxy-mode", data: { mode: "adaptive" } }]).ctx);
  assert.deepEqual(h.statuses.at(-1), ["engineering-proxy", "○ 🛡 KSD: ADAPTIVE"]);

  // Branch B: balanced; entries visible only through getEntries must NOT rescue a nullish branch result.
  const b = h.ctx(dir);
  b.sessionManager = { getBranch: () => [], getEntries: () => [{ type: "custom", customType: "engineering-proxy-mode", data: { mode: "adaptive" } }] };
  h.events.get("session_switch")({}, b);
  assert.deepEqual(h.statuses.at(-1), ["engineering-proxy", "○ 🛡 KSD: BALANCED"], "getEntries is ignored while getBranch exists and yields no override");

  // Branch C: reset tombstone inherits repo/global (default balanced here).
  h.events.get("session_switch")({}, session([{ type: "custom", customType: "engineering-proxy-mode", data: { reset: true } }]).ctx);
  assert.deepEqual(h.statuses.at(-1), ["engineering-proxy", "○ 🛡 KSD: BALANCED"]);

  // Malformed/nullish branch data: no override, never a crash and never all-branches fallback.
  h.events.get("session_switch")({}, session("not-an-array").ctx);
  assert.deepEqual(h.statuses.at(-1), ["engineering-proxy", "○ 🛡 KSD: BALANCED"]);
  const throwing = h.ctx(dir);
  throwing.sessionManager = { getBranch() { throw new Error("branch unavailable"); } };
  h.events.get("session_branch")({}, throwing);
  assert.deepEqual(h.statuses.at(-1), ["engineering-proxy", "○ 🛡 KSD: BALANCED"]);
}));

test("two repositories with separate instances keep independent config and session state", async () => temp(async dirA => temp(async dirB => {
  writeFileSync(join(dirA, ".engineering-proxy.json"), JSON.stringify({ enforcement: "balanced" }));
  writeFileSync(join(dirB, ".engineering-proxy.json"), JSON.stringify({ enforcement: "adaptive" }));

  const mk = dir => {
    const events = new Map();
    const commands = new Map();
    const entries = [];
    const statuses = [];
    const notices = [];
    const pi = {
      setLabel() {},
      on(name, callback) { events.set(name, callback); },
      registerCommand(name, entry) { commands.set(name, entry); },
      appendEntry(type, data) { entries.push({ type: "custom", customType: type, data }); },
      getCommands() { return [{ name: "ponytail" }]; },
      sendUserMessage() {},
    };
    createExtension(pi);
    const ctx = () => ({ cwd: dir, sessionManager: { getBranch: () => entries }, ui: { notify: (...args) => notices.push(args), setStatus: (...args) => statuses.push(args) } });

    return { events, commands, entries, statuses, notices, ctx };
  };

  const instanceA = mk(dirA);
  const instanceB = mk(dirB);

  await instanceA.commands.get("engineering-proxy").handler("adaptive", instanceA.ctx());
  assert.deepEqual(instanceA.statuses.at(-1), ["engineering-proxy", "○ 🛡 KSD: ADAPTIVE"]);
  instanceB.events.get("session_start")({}, instanceB.ctx());
  assert.deepEqual(instanceB.statuses.at(-1), ["engineering-proxy", "○ 🛡 KSD: ADAPTIVE"], "repo B's default is independent of instance A's session");

  // Live config change to repo B becomes visible at B's next lifecycle boundary; A is unaffected.
  writeFileSync(join(dirB, ".engineering-proxy.json"), JSON.stringify({ enabled: false }));
  instanceB.events.get("session_start")({}, instanceB.ctx());
  assert.deepEqual(instanceB.statuses.at(-1), ["engineering-proxy", undefined]);
  instanceA.events.get("session_start")({}, instanceA.ctx());
  assert.deepEqual(instanceA.statuses.at(-1), ["engineering-proxy", "○ 🛡 KSD: ADAPTIVE"], "A replays only its own session override");

  assert.notDeepEqual(instanceA.entries, instanceB.entries, "session entry lists are per instance");
})));

test("malformed persisted session entries cannot activate a third mode", () => {
  const entries = [
    { type: "custom", customType: "engineering-proxy-mode", data: { mode: "ultra" } },
    { type: "custom", customType: "ponytail-mode", data: { mode: "off" } },
  ];
  assert.equal(resolveSessionMode(entries, "adaptive"), "adaptive");
  assert.equal(resolveSessionMode(null, "bad"), "balanced");
});

test("invalid args and disabled plugin cannot mutate current mode", async () => temp(async dir => {
  const h = rig();
  const ctx = h.ctx(dir);
  h.events.get("session_start")({}, ctx);
  await h.commands.get("engineering-proxy").handler("full", ctx);
  assert.equal(h.entries.length, 0);
  assert.match(h.notices.at(-1)[0], /Usage:/);

  // A rejected command must not leave stale status behind: refresh+status run before validation.
  writeFileSync(join(dir, ".engineering-proxy.json"), JSON.stringify({ enabled: false }));
  await h.commands.get("engineering-proxy").handler("ultra", ctx);
  assert.equal(h.entries.length, 0);
  assert.equal(h.statuses.at(-1)[1], undefined, "refresh before validation clears status even on invalid input");

  await h.commands.get("engineering-proxy").handler("adaptive", ctx);
  assert.equal(h.entries.length, 0);
  assert.match(h.notices.at(-1)[0], /disabled/);
  assert.equal(h.statuses.at(-1)[1], undefined, "status clears immediately on disabled rejection");
  h.events.get("agent_start")({}, ctx);
  assert.equal(h.statuses.at(-1)[1], undefined);
}));

test("environment disable clears status and a rejected session command appends no entry", async () => temp(async dir => {
  const h = rig();
  const ctx = h.ctx(dir);
  h.events.get("session_start")({}, ctx);
  assert.deepEqual(h.statuses.at(-1), ["engineering-proxy", "○ 🛡 KSD: BALANCED"]);
  const ponytailEvent = { systemPromptOptions: { sections: { ponytail: "Ponytail preserved" } } };
  h.events.get("before_agent_start")(ponytailEvent, ctx);
  assert.match(ponytailEvent.systemPromptOptions.sections["engineering-proxy"], /Balanced Clean Code/);

  const previous = process.env.ENGINEERING_PROXY_DISABLED;
  process.env.ENGINEERING_PROXY_DISABLED = "1";
  try {
    await h.commands.get("engineering-proxy").handler("adaptive", ctx);
    assert.equal(h.entries.length, 0, "no session entry appended by rejected command");
    assert.match(h.notices.at(-1)[0], /disabled/);
    assert.equal(h.statuses.at(-1)[1], undefined, "environment disable clears status");

    h.events.get("before_agent_start")(ponytailEvent, ctx);
    assert.equal(ponytailEvent.systemPromptOptions.sections["engineering-proxy"], undefined, "owned section removed when disabled");
    assert.equal(ponytailEvent.systemPromptOptions.sections.ponytail, "Ponytail preserved");
  } finally {
    if (previous === undefined) delete process.env.ENGINEERING_PROXY_DISABLED;
    else process.env.ENGINEERING_PROXY_DISABLED = previous;
  }
}));

test("mode remains usable when OMP session persistence API is absent", async () => temp(async dir => {
  const h = rig();
  delete h.pi.appendEntry;
  const ctx = h.ctx(dir);
  await h.commands.get("engineering-proxy").handler("adaptive", ctx);
  assert.deepEqual(h.statuses.at(-1), ["engineering-proxy", "○ 🛡 KSD: ADAPTIVE"]);
  assert.match(h.notices.at(-1)[0], /runtime only/);
}));

test("string and array prompt fallbacks replace KSD policy without duplicates", () => {
  const balanced = buildPolicy();
  const adaptive = buildPolicy({ enforcement: "adaptive" });

  // Behavioral expectation: fallback reconciliation replaces the LAST injected value with buildPolicy(mode).
  const str = augmentSystemPrompt({ systemPrompt: "Base prompt" }, balanced).systemPrompt;
  assert.equal(str.includes(balanced), true);
  const replaced = augmentSystemPrompt({ systemPrompt: str }, adaptive).systemPrompt;
  assert.equal(replaced.split(POLICY_MARKER).length - 1, 1);
  assert.equal(replaced.includes(adaptive), true);
  assert.doesNotMatch(replaced, /Balanced Clean Code/);
  assert.match(replaced, /^Base prompt/);

  const arr = augmentSystemPrompt({ systemPrompt: ["Base", balanced, "Other extension"] }, adaptive).systemPrompt;
  assert.deepEqual(arr, ["Base", adaptive, "Other extension"]);
  assert.equal(augmentSystemPrompt({ systemPrompt: arr }, adaptive), undefined);
});

test("two complete policy blocks in a string collapse to exactly one", () => {
  const first = buildPolicy();
  const second = buildPolicy({ enforcement: "adaptive" });
  const base = `Unrelated before\n\n${first}\n\nUnrelated middle\n\n${second}\n\nUnrelated after`;
  const result = augmentSystemPrompt({ systemPrompt: base }, second).systemPrompt;

  assert.equal(result.split(POLICY_MARKER).length - 1, 1);
  assert.equal(result.split(POLICY_END).length - 1, 1);
  assert.equal(result.includes("Unrelated before"), true);
  assert.equal(result.includes("Unrelated middle"), true);
  assert.equal(result.includes("Unrelated after"), true);
  assert.equal(result.includes(first + "\n\nUnrelated middle") === false, true, "no leftover owned body");

  const removed = augmentSystemPrompt({ systemPrompt: base }, undefined, () => {}).systemPrompt;
  assert.equal(removed.split(POLICY_MARKER).length - 1, 0, "disable removes zero-complete owned blocks");
  assert.equal(removed.includes("Unrelated before\n\n"), true);
  assert.match(removed, /Unrelated middle[\s\S]*Unrelated after/);
});

test("array with current and legacy elements keeps one dedicated element", () => {
  const legacy = "[Engineering Proxy Policy v0.2] numbered legacy element without an end marker";
  const current = buildPolicy();
  const result = augmentSystemPrompt({ systemPrompt: ["Base", legacy, current, "Ponytail instructions"] }, current);
  assert.deepEqual(result.systemPrompt, ["Base", current, "Ponytail instructions"]);

  const removed = augmentSystemPrompt({ systemPrompt: ["Base", legacy, current, "Ponytail instructions"] }, undefined);
  assert.deepEqual(removed.systemPrompt, ["Base", "Ponytail instructions"]);
});

test("structured section is preferred and stale owned fallback blocks transition cleanly", () => {
  const policy = buildPolicy({ enforcement: "adaptive" });
  const stale = buildPolicy();
  const event = { systemPrompt: `Unrelated\n\n${stale}\n\nPonytail instructions`, systemPromptOptions: { sections: {} } };
  const result = augmentSystemPrompt(event, policy, () => {});

  assert.equal(result.systemPrompt, "Unrelated\n\n\n\nPonytail instructions");
  assert.equal(event.systemPromptOptions.sections["engineering-proxy"], policy);
  assert.equal(result.systemPrompt.split(POLICY_MARKER).length - 1, 0, "policy lives in the section, not duplicated in the fallback");
  assert.equal(event.systemPrompt.includes(stale), true, "event field itself is untouched; host applies the returned value");
});

test("unterminated legacy policy keeps its tail, warns once and never claims replacement", () => {
  const warnings = [];
  const notify = message => warnings.push(message);
  const legacy = "Base prompt\n\n[Engineering Proxy Policy v0.1]\nold rules with unknown tail\nmore tail";
  const firstEvent = { systemPrompt: legacy };
  const first = augmentSystemPrompt(firstEvent, buildPolicy({ enforcement: "adaptive" }), notify);

  assert.equal(first, undefined, "no update while the legacy block is unterminated");
  assert.equal(firstEvent.systemPrompt, legacy, "tail unchanged byte-for-byte");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unterminated legacy policy/);

  const second = augmentSystemPrompt({ systemPrompt: legacy }, buildPolicy({ enforcement: "balanced" }), notify);
  assert.equal(second, undefined);
  assert.equal(warnings.length, 2, "warning repeats across turns on unchanged input (extension dedupes at its own layer)");
});

test("invalid SDLC modes fail closed", () => {
  assert.throws(() => buildSdlcPolicy({ mode: "ultra" }), /Invalid/);
});

test("previous-version policy in array is replaced, never duplicated", () => {
  const oldPolicy = "[Engineering Proxy Policy v0.1] legacy rules";
  const newPolicy = buildPolicy({ enforcement: "adaptive" });
  const result = augmentSystemPrompt({ systemPrompt: ["Base", oldPolicy, "ponytail"] }, newPolicy);
  assert.deepEqual(result.systemPrompt, ["Base", newPolicy, "ponytail"]);
});

test("previous-version string policy without end marker is not destructively replaced", () => {
  const warnings = [];
  // Marker as a COMPLETE line (numbered legacy) with unrelated trailing content: never guessed, never truncated.
  const legacy = "Base prompt\n\n[Engineering Proxy Policy v0.1]\nan old line of rules\nthe owner's remaining tail";
  const event = { systemPrompt: legacy };
  assert.equal(augmentSystemPrompt(event, buildPolicy({ enforcement: "adaptive" }), m => warnings.push(m)), undefined);
  assert.equal(event.systemPrompt, legacy, "entire suffix preserved");
  assert.doesNotMatch(event.systemPrompt, /Adaptive Clean Code/);
  assert.equal(warnings.length, 1);
});

test("legacy warning is notified once, visible in status, and clears after reconciliation", () => temp(dir => {
  const h = rig();
  const ctx = h.ctx(dir);
  const legacy = { systemPrompt: "Base\n[Engineering Proxy Policy v0.1]\nunowned tail" };
  h.events.get("before_agent_start")(legacy, ctx);
  h.events.get("before_agent_start")(legacy, ctx);
  assert.equal(h.notices.length, 1);
  assert.match(h.statuses.at(-1)[1], /unterminated legacy policy/);
  const event = { systemPromptOptions: { sections: {} } };
  h.events.get("before_agent_start")(event, ctx);
  assert.equal(event.systemPromptOptions.sections["engineering-proxy"], buildPolicy());
  assert.doesNotMatch(h.statuses.at(-1)[1], /unterminated legacy policy/);
}));

test("unterminated fallback prevents inserting a second policy into sections", () => {
  const warnings = [];
  const event = {
    systemPrompt: "base\n[Engineering Proxy Policy v0.1]\nunknown tail",
    systemPromptOptions: { sections: { ponytail: "untouched" } },
  };
  assert.equal(augmentSystemPrompt(event, buildPolicy(), message => warnings.push(message)), undefined);
  assert.equal(event.systemPromptOptions.sections["engineering-proxy"], undefined);
  assert.equal(event.systemPromptOptions.sections.ponytail, "untouched");
  assert.equal(warnings.length, 1);
});

test("disabled status retains unresolved legacy warning", () => temp(dir => {
  const h = rig();
  const ctx = h.ctx(dir);
  writeFileSync(join(dir, ".engineering-proxy.json"), JSON.stringify({ enabled: false }));
  h.events.get("before_agent_start")({ systemPrompt: "[Engineering Proxy Policy v0.1]\nunknown tail" }, ctx);
  assert.match(h.statuses.at(-1)[1], /unterminated legacy policy/);
}));
