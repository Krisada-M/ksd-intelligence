import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateRelease } from "../../validate-release.js";

function fixture({ metadata = "0.2.0", plugin = "0.2.0", packageVersion = "0.2.0", source = "./plugins/engineering-proxy" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ksd-release-"));
  mkdirSync(join(root, ".omp-plugin"));
  mkdirSync(join(root, "plugins/engineering-proxy"), { recursive: true });
  writeFileSync(join(root, ".omp-plugin/marketplace.json"), JSON.stringify({
    metadata: { version: metadata },
    plugins: [{ name: "engineering-proxy", source, version: plugin }],
  }));
  writeFileSync(join(root, "plugins/engineering-proxy/package.json"), JSON.stringify({
    version: packageVersion,
    omp: { extensions: ["./index.js"] },
  }));
  writeFileSync(join(root, "plugins/engineering-proxy/index.js"), "export default () => {};");

  return root;
}

test("marketplace and package versions match an existing OMP entrypoint", () => {
  const dir = fixture();
  try {
    assert.deepEqual(validateRelease(dir), {
      version: "0.2.0",
      source: "./plugins/engineering-proxy",
      extension: "./index.js",
    });
  } finally { rmSync(dir, { force: true, recursive: true }); }
});

test("version mismatches fail before publishing", () => {
  const dir = fixture({ plugin: "0.1.0" });
  try {
    assert.throws(() => validateRelease(dir), /versions disagree/);
  } finally { rmSync(dir, { force: true, recursive: true }); }
});

test("missing OMP entrypoint fails closed", () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, "plugins/engineering-proxy/package.json"), JSON.stringify({
      version: "0.2.0", omp: { extensions: ["./missing.js"] },
    }));
    assert.throws(() => validateRelease(dir), /Invalid or missing/);
  } finally { rmSync(dir, { force: true, recursive: true }); }
});

test("plugin source cannot escape repository root", () => {
  const dir = fixture({ source: "../../outside" });
  try {
    assert.throws(() => validateRelease(dir), /inside repository/);
  } finally { rmSync(dir, { force: true, recursive: true }); }
});
