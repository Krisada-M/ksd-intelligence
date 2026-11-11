// harness-only check for readable-flow; never part of the Agent's task text.
// Asserts results at the contract boundaries AND that this fixture's concrete
// style violations (indent >= 4 = avoidable nesting; statement immediately
// before a return with no blank line) are gone. Correct flat refactors pass;
// the shipped nested file fails.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, "..", "delivery-price.js");
const { deliveryPrice } = await import(sourcePath);

const expectations = [
    ["vip true, subtotal 0", { vip: true, subtotal: 0 }, 0],
    ["vip true, subtotal 99.99", { vip: true, subtotal: 99.99 }, 0],
    ["vip true, subtotal 100", { vip: true, subtotal: 100 }, 0],
    ["vip false, subtotal 100", { vip: false, subtotal: 100 }, 0],
    ["vip false, subtotal 101", { vip: false, subtotal: 101 }, 0],
    ["vip false, subtotal 99.99", { vip: false, subtotal: 99.99 }, 10],
    ["vip false, subtotal 0", { vip: false, subtotal: 0 }, 10],
];

let failed = 0;
console.log("result checks:");
for (const [name, input, expected] of expectations) {
    const actual = deliveryPrice({ ...input });
    const ok = actual === expected;
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"} ${name}: expected ${expected}, got ${actual}`);
}

const source = await readFile(sourcePath, "utf8");
const styleViolations = [];
const lines = source.split(/\r?\n/);
lines.forEach((line, i) => {
    // Fixture-specific flatness vocabulary: a correct flat refactor keeps every
    // line of delivery-price.js at indent <= 2.
    const isReturn = /^\s+return\b/.test(line);
    if (/^\s{4,}\S/.test(line)) {
        styleViolations.push(`line ${i + 1}: indent >= 4 (avoidable nesting / not flat)`);
    }
    if (isReturn && /^\s*(const|let|var)\b/.test(lines[i - 1] ?? "")) {
        styleViolations.push(`line ${i + 1}: missing blank line before return after a statement`);
    }
});

console.log("style checks:");
if (styleViolations.length === 0) {
    console.log("PASS no avoidable nesting; blank-line-before-return respected");
} else {
    for (const v of styleViolations) {
        console.log(`FAIL ${v}`);
    }
    failed += styleViolations.length;
}

if (failed > 0) {
    console.log(`readable-flow checks: FAILED (${failed} item(s))`);
    process.exit(1);
}
console.log("readable-flow checks: OK");
