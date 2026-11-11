// harness-only post-hoc check for ui-small; never part of the Agent's task text.
// Verifies the SERVED HTML: the save button keeps its element/id/click wiring and
// both the visible text and the aria-label read exactly `Save draft`.
// (Pilot additionally inspects the real DOM/behavior with browser tooling.)
import assert from "node:assert";

const base = process.argv[2];
if (!base) {
    console.error("usage: node checks/http-check.mjs http://127.0.0.1:<port>");
    process.exit(2);
}

const res = await fetch(`${base.replace(/\/$/, "")}/`);
assert.equal(res.status, 200);
const html = await res.text();

assert.match(html, /<button[^>]*\bid="save-btn"/);
assert.match(html, /aria-label="Save draft"/);
assert.match(html, /<button[^>]*>Save draft</);
assert.match(html, /getElementById\(['"]save-btn['"]\)/);
assert.match(html, /save-status/);
assert.match(html, /Draft saved/);

console.log("ui-small http-check: OK");
