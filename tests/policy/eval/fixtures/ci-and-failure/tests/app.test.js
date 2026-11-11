import { test } from "node:test";
import assert from "node:assert/strict";
import { readSummary } from "../src/app.js";

test("summary text", () => {
    assert.equal(readSummary(), "orders summary");
});
