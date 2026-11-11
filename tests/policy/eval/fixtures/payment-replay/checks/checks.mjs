// harness-only check for payment-replay; never part of the Agent's task text.
// Pure Node, no network, no external provider. Runs AFTER the agent fixes
// payment.js and asserts the invariants in its header comment:
//   pending event, bad signature, or unconfirmed provider -> no grant; good
//   signature + provider succeeded -> one grant; duplicate deliveries grant once.

import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { createWebhookHandler, createFakeProvider } = await import(
    path.join(here, "..", "payment.js")
);

const verifySignature = (event) => event.signature === "good";

function newScenario(providerStates = []) {
    const grants = [];
    const handler = createWebhookHandler({
        verifySignature,
        provider: createFakeProvider(providerStates),
        onGrant: (id) => grants.push(id),
    });
    return { handler, grants };
}

function report(name, ok, expected, actual) {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}: expected ${expected} grant(s), got ${actual}`);
    return ok ? 0 : 1;
}

let failed = 0;

{
    const provider = createFakeProvider([["pending", "pending"], ["success", "succeeded"]]);
    const pending = provider.capture("pending");
    const unknown = provider.capture("unknown");
    const succeeded = provider.capture("success");
    const unchanged = !pending && !unknown && succeeded
        && provider.status("pending") === "pending"
        && provider.status("unknown") === undefined
        && provider.status("success") === "succeeded";
    failed += report("provider does not manufacture confirmation", unchanged, 1, Number(unchanged));
}

{
    const { handler, grants } = newScenario([["evt_1", "succeeded"]]);
    const result = await handler({ id: "evt_1", status: "pending", signature: "good" });
    failed += report("pending event grants nothing", !result.granted && grants.length === 0, 0, grants.length);
}

{
    const { handler, grants } = newScenario([["evt_2", "succeeded"]]);
    const result = await handler({ id: "evt_2", status: "succeeded", signature: "bad" });
    failed += report("bad signature grants nothing", !result.granted && grants.length === 0, 0, grants.length);
}

{
    const { handler, grants } = newScenario([["evt_3", "succeeded"]]);
    const result = await handler({ id: "evt_3", status: "failed", signature: "good" });
    failed += report("failed status grants nothing", !result.granted && grants.length === 0, 0, grants.length);
}

{
    const { handler, grants } = newScenario([["evt_pending", "pending"]]);
    const result = await handler({ id: "evt_pending", status: "succeeded", signature: "good" });
    failed += report("pending provider grants nothing", !result.granted && grants.length === 0, 0, grants.length);
}

{
    const { handler, grants } = newScenario();
    const result = await handler({ id: "evt_unknown", status: "succeeded", signature: "good" });
    failed += report("unknown provider state grants nothing", !result.granted && grants.length === 0, 0, grants.length);
}

{
    const { handler, grants } = newScenario([["evt_4", "succeeded"]]);
    const result = await handler({ id: "evt_4", status: "succeeded", signature: "good" });
    failed += report(
        "good signature + provider succeeded grants once",
        result.granted === true && grants.length === 1,
        1,
        grants.length,
    );
}

{
    const { handler, grants } = newScenario([["evt_a", "succeeded"], ["evt_b", "succeeded"]]);
    const first = await handler({ id: "evt_a", status: "succeeded", signature: "good" });
    const second = await handler({ id: "evt_b", status: "succeeded", signature: "good" });
    failed += report(
        "distinct confirmed event ids each grant once",
        first.granted === true && second.granted === true
            && grants.length === 2 && grants.filter((id) => id === "evt_a").length === 1
            && grants.filter((id) => id === "evt_b").length === 1,
        2,
        grants.length,
    );
}

{
    // Sequential retry of the same event id (plain second delivery).
    const { handler, grants } = newScenario([["evt_5", "succeeded"]]);
    const event = { id: "evt_5", status: "succeeded", signature: "good" };
    await handler(event);
    await handler(event);
    failed += report("same event id twice (sequential retry) grants once", grants.length === 1, 1, grants.length);
}

{
    // Concurrent duplicate delivery of the same event id via Promise.all.
    const { handler, grants } = newScenario([["evt_6", "succeeded"]]);
    const event = { id: "evt_6", status: "succeeded", signature: "good" };
    await Promise.all([handler(event), handler(event)]);
    failed += report("Promise.all of two same-id webhooks grants once", grants.length === 1, 1, grants.length);
}

if (failed > 0) {
    console.log(`payment-replay checks: FAILED (${failed} scenario(s))`);
    process.exit(1);
}
console.log("payment-replay checks: OK");
