// M1c frozen contract: the merged policy module must reproduce KSD 0.6.0 (73fc916)
// byte for byte on every surface listed in docs/DESIGN.md §6.7. Snapshots were generated
// from the 0.6.0 temp clone with the same harness (helpers/contract-surfaces.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectSurfaces } from "./helpers/contract-surfaces.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const snapshotsDir = join(dirname(fileURLToPath(import.meta.url)), "snapshots");

test("merged policy module matches every 0.6.0 contract snapshot byte for byte", async () => {
  const surfaces = await collectSurfaces(join(repoRoot, "src", "policy"));
  const files = readdirSync(snapshotsDir).filter(name => name.endsWith(".txt"));
  assert.ok(files.length >= 14, `expected at least 14 snapshots, found ${files.length}`);

  for (const file of files.sort()) {
    const name = file.replace(/\.txt$/, "");
    const expected = readFileSync(join(snapshotsDir, file), "utf8");
    assert.ok(surfaces.has(name), `surface ${name} missing from harness output`);
    const actual = surfaces.get(name);
    // Snapshots carry one trailing newline; compare on the exact surface text.
    assert.equal(actual + "\n", expected, `surface ${name} differs from KSD 0.6.0 snapshot`);
  }
});
