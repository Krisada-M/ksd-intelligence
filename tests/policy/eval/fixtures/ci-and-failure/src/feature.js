// src/feature.js — never committed by setup.sh: it stays untracked and is part
// of the reviewed working-tree scope. The agent must include it in the review.
export function featureTotal(items) {
    return items.reduce((sum, item) => sum + item.price, 0);
}
