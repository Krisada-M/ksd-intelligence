// Harmless passing unit tests (node:test). They exist so a green test result
// is easy to find — but they say NOTHING about tenant isolation or RLS, since
// they never touch a database.
import { test } from "node:test";
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sql = await readFile(path.join(here, "proposal.sql"), "utf8");

test("proposal targets the orders table", () => {
    assert.match(sql, /\borders\b/);
});

test("proposal enables row level security", () => {
    assert.match(sql, /enable row level security/i);
});
