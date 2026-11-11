import test from "node:test";
import assert from "node:assert/strict";
import { KsdRuntime } from "../../src/policy/dist/runtime.js";

function createRig() {
  const counters = { reads: 0, policies: 0, statuses: [] };
  let enabled = true;
  const cache = new KsdRuntime(
    cwd => {
      counters.reads++;

      return { enabled, enforcement: "balanced", root: cwd };
    },
    config => {
      counters.policies++;

      return "Policy for " + config.enforcement;
    },
    () => false,
  );
  const ui = {
    theme: { fg: (style, text) => style + ":" + text },
    setStatus(key, value) { counters.statuses.push([key, value]); },
  };
  const ctx = { cwd: "/repo", ui };

  return { cache, counters, ctx, setEnabled(value) { enabled = value; } };
}

test("hot-path config is cached until a deliberate refresh", () => {
  const r = createRig();
  assert.equal(r.cache.getConfig("/repo").enabled, true);
  r.cache.syncStatus(r.ctx, false, "balanced");
  r.cache.syncStatus(r.ctx, true, "balanced");
  r.cache.syncStatus(r.ctx, false, "balanced");
  assert.equal(r.counters.reads, 1, "agent lifecycle should not re-read config");

  r.setEnabled(false);
  assert.equal(r.cache.getConfig("/repo").enabled, true, "cached mode stable within turn");
  assert.equal(r.cache.getConfig("/repo", true).enabled, false);
  r.cache.syncStatus(r.ctx, false, "balanced");
  assert.deepEqual(r.counters.statuses.at(-1), ["engineering-proxy", undefined]);
  assert.equal(r.counters.reads, 2);
});

test("policy construction caches per mode without leaking between modes", () => {
  const r = createRig();
  assert.equal(r.cache.getPolicy("balanced"), "Policy for balanced");
  assert.equal(r.cache.getPolicy("balanced"), "Policy for balanced");
  assert.equal(r.cache.getPolicy("adaptive"), "Policy for adaptive");
  assert.equal(r.cache.getPolicy("balanced"), "Policy for balanced");
  assert.equal(r.counters.policies, 2);
});

test("status notice participates in redraw and clears after recovery", () => {
  const r = createRig();
  r.cache.syncStatus(r.ctx, false, "balanced", "warn: stale");
  r.cache.syncStatus(r.ctx, false, "balanced", "warn: stale");
  assert.equal(r.counters.statuses.length, 1, "identical notice keeps TUI silent");
  assert.match(r.counters.statuses[0][1], /warn: stale/);

  r.cache.syncStatus(r.ctx, false, "balanced");
  assert.equal(r.counters.statuses.length, 2, "cleared notice redraws once");
  assert.doesNotMatch(r.counters.statuses[1][1], /warn/);
  r.cache.syncStatus(r.ctx, false, "balanced");
  assert.equal(r.counters.statuses.length, 2, "cleared state is stable afterwards");
});

test("two runtimes with different loaders never share config or policy caches", () => {
  const readsA = [];
  const readsB = [];
  const a = new KsdRuntime(cwd => (readsA.push(cwd), { enabled: true, enforcement: "balanced" }), () => "policy A", () => false);
  const b = new KsdRuntime(cwd => (readsB.push(cwd), { enabled: false, enforcement: "adaptive" }), () => "policy B", () => false);

  assert.equal(a.getPolicy("balanced"), "policy A");
  assert.equal(b.getPolicy("adaptive"), "policy B");
  a.getConfig("/shared", true);
  b.getConfig("/shared", true);
  assert.deepEqual(readsA, ["/shared"]);
  assert.deepEqual(readsB, ["/shared"]);
  a.getPolicy("adaptive");
  b.getPolicy("balanced");
  assert.notEqual(a.getPolicy("adaptive"), b.getPolicy("adaptive"));
});

test("duplicate status updates do not call OMP TUI again", () => {
  const r = createRig();
  r.cache.syncStatus(r.ctx, false, "balanced");
  r.cache.syncStatus(r.ctx, false, "balanced");
  r.cache.syncStatus(r.ctx, false, "balanced");
  assert.equal(r.counters.statuses.length, 1);

  r.cache.syncStatus(r.ctx, true, "balanced");
  r.cache.syncStatus(r.ctx, true, "balanced");
  assert.equal(r.counters.statuses.length, 2);
  assert.match(r.counters.statuses.at(-1)[1], /accent:●/);

  r.cache.invalidateStatus(r.ctx.ui);
  r.cache.syncStatus(r.ctx, true, "balanced");
  assert.equal(r.counters.statuses.length, 3, "UI redraw after session reset is mandatory");
});

test("mode changes update status without replacing the Ponytail status key", () => {
  const r = createRig();
  r.cache.syncStatus(r.ctx, false, "balanced");
  r.cache.syncStatus(r.ctx, false, "adaptive");
  assert.deepEqual(r.counters.statuses.map(([key]) => key), ["engineering-proxy", "engineering-proxy"]);
  assert.match(r.counters.statuses.at(-1)[1], /KSD: ADAPTIVE/);
});

test("theme replacement redraws status, theme failure degrades safely", () => {
  const r = createRig();
  r.cache.syncStatus(r.ctx, false, "balanced");
  r.ctx.ui.theme = { fg: (style, text) => "[" + style + " " + text + "]" };
  r.cache.syncStatus(r.ctx, false, "balanced");
  assert.equal(r.counters.statuses.length, 2);
  Object.defineProperty(r.ctx.ui, "theme", { get() { throw Error("Theme unavailable"); } });
  assert.doesNotThrow(() => r.cache.syncStatus(r.ctx, true, "balanced"));
  assert.match(r.counters.statuses.at(-1)[1], /^●/);
});

test("headless and UI failures cannot break agent lifecycle", () => {
  const r = createRig();
  assert.doesNotThrow(() => r.cache.syncStatus({ cwd: "/repo", ui: {} }, true, "balanced"));
  assert.doesNotThrow(() => r.cache.syncStatus({ cwd: "/repo" }, true, "balanced"));
  assert.doesNotThrow(() => r.cache.syncStatus({ cwd: "/repo", ui: { setStatus() { throw Error("dead TUI"); } } }, true, "balanced"));
});

test("config is cached per cwd and cannot bleed between repositories", () => {
  const r = createRig();
  assert.equal(r.cache.getConfig("/repo/a").root, "/repo/a");
  assert.equal(r.cache.getConfig("/repo/b").root, "/repo/b");
  assert.equal(r.counters.reads, 2);
});
