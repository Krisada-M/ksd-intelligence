// As shipped: broken on purpose. Grants on `pending` events, never consults
// verifySignature, and re-grants on duplicate/retry deliveries (no per-event-id
// dedupe, so concurrent Promise.all duplicates also double-grant).

// Invariants the fixed handler must respect (checked by the pilot, not listed
// in the agent's task answer): grant only after verifySignature(event) is truthy
// AND the fake provider has recorded success for that event id; exactly one grant
// per event id, including concurrent duplicate deliveries.
//
// Fake-provider state is pre-seeded independently of webhook delivery.
// status(id) reads that state; capture(id) only reports whether it is already
// succeeded. Neither method changes pending or unknown state to succeeded.
// A pending or failed event must not grant, even if provider state is succeeded.
export function createWebhookHandler({ verifySignature, provider, onGrant }) {
    return async function handleWebhook(event) {
        if (event.status === "failed") {
            return { granted: false, reason: "status-failed" };
        }
        const captured = provider.capture(event.id);
        if (!captured) {
            return { granted: false, reason: "provider-not-succeeded" };
        }
        onGrant(event.id);
        return { granted: true, reason: "granted" };
    };
}

// Provider state is represented as [event id, status] pairs.
export function createFakeProvider(initialStates = []) {
    const state = new Map(initialStates);
    return {
        status(id) {
            return state.get(id);
        },
        capture(id) {
            return state.get(id) === "succeeded";
        },
    };
}
