// As shipped: broken on purpose. It checks the tenant but IGNORES record
// ownership and lets a tenant-matched actor without a user id through — exactly
// the two bugs the task asks the agent to fix.

// Contract for canRead(actor, record), defined here once for agent and checks:
// - authenticated: actor is non-null and has a truthy id
// - same tenant: actor.tenantId === record.tenantId
// - record ownership: record.ownerId === actor.id
// No admin bypass exists in this contract.
export function canRead(actor, record) {
    if (!actor) {
        return false;
    }
    return actor.tenantId === record.tenantId;
}
