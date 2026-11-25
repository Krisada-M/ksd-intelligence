import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createExtension from "../../src/policy/index.js";

const stripColor = value => value.replace(/\x1b\[[0-9;]*m/g, "");
const theme = { fg: (tone, text) => `\x1b[${tone === "accent" ? 36 : 2}m${text}\x1b[0m` };

async function withExtension(config, run) {
  const dir = mkdtempSync(join(tmpdir(), "ksd-presentation-"));
  try {
    mkdirSync(join(dir, ".git"));
    if (config !== undefined) writeFileSync(join(dir, ".engineering-proxy.json"), config);
    const events = new Map();
    const commands = new Map();
    const pi = {
      setLabel() {},
      on(name, handler) { events.set(name, handler); },
      registerCommand(name, definition) { commands.set(name, definition); },
      getCommands() { return [{ name: "ponytail" }]; },
    };
    createExtension(pi, { globalConfigPath: join(dir, "missing-global.json") });
    return await run({ dir, events, commands });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("host theme decorates status command without changing copy or severity", async () => {
  await withExtension(undefined, async ({ dir, commands }) => {
    const plain = [];
    const colored = [];
    const command = commands.get("engineering-proxy").handler;
    await command("status", { cwd: dir, ui: { notify: (...args) => plain.push(args), setStatus() {} } });
    await command("status", { cwd: dir, ui: { theme, notify: (...args) => colored.push(args), setStatus() {} } });
    assert.equal(plain[0][0], "Engineering Proxy: ON; mode: BALANCED (default); project default: UNSET; global default: UNSET; session: INHERIT; Ponytail command: detected; Ponytail mode: not inspected");
    assert.equal(colored[0][1], plain[0][1]);
    assert.equal(stripColor(colored[0][0]), plain[0][0]);
    assert.match(colored[0][0], /\x1b\[2mEngineering Proxy:\x1b\[0m/);
    assert.match(colored[0][0], /\x1b\[2m; project default:\x1b\[0m/);
    assert.match(colored[0][0], /\x1b\[36mON\x1b\[0m/);
    assert.match(colored[0][0], /\x1b\[36mBALANCED\x1b\[0m/);
  });
});

test("warning stays warning and its exact notice survives decoration", async () => {
  await withExtension("{ invalid", async ({ dir, commands }) => {
    const plain = [];
    const colored = [];
    const command = commands.get("engineering-proxy").handler;
    await command("status", { cwd: dir, ui: { notify: (...args) => plain.push(args), setStatus() {} } });
    await command("status", { cwd: dir, ui: { theme, notify: (...args) => colored.push(args), setStatus() {} } });
    assert.equal(plain[0][1], "warning");
    assert.deepEqual(colored[0][1], plain[0][1]);
    assert.equal(stripColor(colored[0][0]), plain[0][0]);
    assert.match(colored[0][0], /\x1b\[36m; WARNING:\x1b\[0m/);
  });
});

test("segment retains exact plain copy without a theme", async () => {
  await withExtension(undefined, ({ dir, events }) => {
    const statuses = [];
    const ctx = { cwd: dir, ui: { setStatus: (...args) => statuses.push(args) } };
    events.get("session_start")({}, ctx);
    events.get("agent_start")({}, ctx);
    assert.deepEqual(statuses, [
      ["engineering-proxy", "○ 🛡 KSD: BALANCED"],
      ["engineering-proxy", "● 🛡 KSD: BALANCED"],
    ]);
  });
});

test("theme highlights active mode while preserving every segment character", async () => {
  await withExtension(undefined, ({ dir, events }) => {
    const plain = [];
    const colored = [];
    const plainCtx = { cwd: dir, ui: { setStatus: (_key, value) => plain.push(value) } };
    const themedCtx = { cwd: dir, ui: { theme, setStatus: (_key, value) => colored.push(value) } };
    events.get("session_start")({}, plainCtx);
    events.get("session_start")({}, themedCtx);
    events.get("agent_start")({}, plainCtx);
    events.get("agent_start")({}, themedCtx);
    assert.deepEqual(colored.map(stripColor), plain);
    assert.match(colored[0], /\x1b\[2mBALANCED\x1b\[0m/);
    assert.match(colored[1], /\x1b\[36mBALANCED\x1b\[0m/);
  });
});
