// Shared harness for the M1c frozen-contract snapshots (docs/DESIGN.md §6.7).
// Runs KSD's module — the 0.6.0 temp clone or the merged src/policy — through the same
// mocks and returns every contract surface as a string, so the generator and the
// contract test cannot drift apart.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makePi() {
  const handlers = new Map();
  const commands = new Map();
  const sent = [];
  const notified = [];
  return {
    handlers,
    commands,
    sent,
    notified,
    setLabel: () => {},
    on: (name, fn) => handlers.set(name, fn),
    registerCommand: (name, def) => commands.set(name, def),
    getCommands: () => [],
    sendUserMessage: (message) => sent.push(message),
    appendEntry: () => {},
  };
}

function makeCtx(repo, pi) {
  const statuses = [];
  return {
    cwd: repo,
    pi,
    ui: {
      statuses,
      notify: (message) => pi.notified.push(message),
      setStatus: (_key, value) => statuses.push(value),
    },
    sessionManager: undefined,
    isIdle: () => true,
  };
}

function start(moduleDir, repo) {
  // import() fresh per repo: index.js caches nothing global, but a fresh instance keeps
  // selectedSessionMode isolated between drives.
  const pi = makePi();
  const ctx = makeCtx(repo, pi);
  return { pi, ctx };
}

export async function collectSurfaces(moduleDir) {
  // Isolated HOME so the developer's real global engineering-proxy.json cannot leak in.
  const home = mkdtempSync(join(tmpdir(), "ksd-contract-home-"));
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.ENGINEERING_PROXY_DISABLED;

  const surfaces = new Map();
  const moduleUrl = (name) => new URL(`file://${join(moduleDir, name)}`).href;
  try {
    const policyModule = await import(moduleUrl("policy.js"));
    const configModule = await import(moduleUrl("config.js"));

    surfaces.set("policy-balanced", policyModule.buildPolicy({ enforcement: "balanced" }));
    surfaces.set("policy-adaptive", policyModule.buildPolicy({ enforcement: "adaptive" }));

    const makeRepo = (name, projectConfig) => {
      const repo = join(home, name);
      mkdirSync(join(repo, ".git"), { recursive: true });
      if (projectConfig !== undefined) {
        writeFileSync(join(repo, ".engineering-proxy.json"), projectConfig);
      }
      return repo;
    };

    const drive = async (repo, commandName, commandArg) => {
      const indexModule = await import(`${moduleUrl("index.js")}?repo=${encodeURIComponent(repo)}`);
      const pi = makePi();
      const ctx = makeCtx(repo, pi);
      indexModule.createExtension(pi);
      pi.handlers.get("session_start")?.({}, ctx);
      await pi.commands.get(commandName).handler(commandArg, ctx);
      return { pi, ctx };
    };

    // /engineering-review text per mode (project file selects the mode).
    for (const mode of ["balanced", "adaptive"]) {
      const repo = makeRepo(`review-${mode}`, JSON.stringify({ enforcement: mode }));
      const { pi } = await drive(repo, "engineering-proxy", "status"); // warm config, no session override
      const review = await drive(repo, "engineering-review", "");
      void pi;
      surfaces.set(`review-${mode}`, review.pi.sent.join("\n---\n"));
    }

    // /engineering-proxy status output for the fixed config set.
    const globalOnly = makeRepo("global-only");
    configModule.setScopedMode(globalOnly, "global", "adaptive");
    surfaces.set("status-command-global", (await drive(globalOnly, "engineering-proxy", "status")).pi.notified.join("\n"));

    const projectOnly = makeRepo("project-only", JSON.stringify({ enforcement: "adaptive" }));
    surfaces.set("status-command-project", (await drive(projectOnly, "engineering-proxy", "status")).pi.notified.join("\n"));

    const both = makeRepo("both", JSON.stringify({ enforcement: "adaptive" }));
    configModule.setScopedMode(both, "global", "balanced");
    surfaces.set("status-command-both", (await drive(both, "engineering-proxy", "status")).pi.notified.join("\n"));

    const invalid = makeRepo("invalid", "{ invalid");
    surfaces.set("status-command-invalid", (await drive(invalid, "engineering-proxy", "status")).pi.notified.join("\n"));

    // Status segment per state, driven through the real event handlers.
    const segmentFor = async (repo) => {
      const indexModule = await import(`${moduleUrl("index.js")}?repo=seg-${encodeURIComponent(repo)}`);
      const pi = makePi();
      const ctx = makeCtx(repo, pi);
      indexModule.createExtension(pi);
      pi.handlers.get("session_start")?.({}, ctx);
      const idle = ctx.ui.statuses.at(-1);
      pi.handlers.get("agent_start")?.({}, ctx);
      return { idle, active: ctx.ui.statuses.at(-1) };
    };

    for (const mode of ["balanced", "adaptive"]) {
      const repo = makeRepo(`segment-${mode}`, JSON.stringify({ enforcement: mode }));
      const { idle, active } = await segmentFor(repo);
      surfaces.set(`segment-idle-${mode}`, idle ?? "(no status)");
      surfaces.set(`segment-active-${mode}`, active ?? "(no status)");
    }

    const disabledRepo = makeRepo("segment-disabled", JSON.stringify({ enabled: false }));
    surfaces.set("segment-disabled", (await segmentFor(disabledRepo)).idle ?? "(no status)");

    const invalidRepo = makeRepo("segment-invalid", "{ invalid");
    surfaces.set("segment-invalid", (await segmentFor(invalidRepo)).idle ?? "(no status)");

    return surfaces;
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevProfile;
    rmSync(home, { recursive: true, force: true });
  }
}
