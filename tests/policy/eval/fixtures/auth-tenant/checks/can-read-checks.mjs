// harness-only check for auth-tenant; never part of the Agent's task text.
// Runs AFTER the agent changes auth.js and asserts the documented contract:
// owner/same-tenant succeeds; cross-tenant, another owner's record, null and
// unauthenticated (no-id) actors fail. Designed to be imported by the pilot.

import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { canRead } = await import(path.join(here, "..", "auth.js"));

const actor = { id: "u1", tenantId: "t1" };
const record = {
    owned: { id: "r1", tenantId: "t1", ownerId: "u1" },
    crossTenant: { id: "r2", tenantId: "t2", ownerId: "u2" },
    crossTenantOwned: { id: "r4", tenantId: "t2", ownerId: "u1" },
    otherOwner: { id: "r3", tenantId: "t1", ownerId: "u2" },
};

const cases = [
    ["owner, same tenant", actor, record.owned, true],
    ["actor without user id (unauthenticated)", { tenantId: "t1" }, record.owned, false],
    ["missing actor and owner ids", { tenantId: "t1" }, { id: "r5", tenantId: "t1" }, false],
    ["empty actor and owner ids", { id: "", tenantId: "t1" }, { id: "r6", tenantId: "t1", ownerId: "" }, false],
    ["cross-tenant record", actor, record.crossTenant, false],
    ["cross-tenant record owned by actor", actor, record.crossTenantOwned, false],
    ["same tenant, another owner's record", actor, record.otherOwner, false],
    ["null actor", null, record.owned, false],
    ["undefined actor", undefined, record.owned, false],
];

let failed = 0;
for (const [name, a, rec, expected] of cases) {
    const actual = canRead(a, rec);
    const ok = actual === expected;
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"} ${name}: expected ${expected}, got ${actual}`);
}

if (failed > 0) {
    console.log(`auth-tenant checks: FAILED (${failed} case(s))`);
    process.exit(1);
}
console.log("auth-tenant checks: OK");
