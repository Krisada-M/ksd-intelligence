// As shipped: results are correct but the flow is avoidably nested and the blank
// line before the non-first return is missing. Do not implement the flat solution
// here; the task is to refactor it.
export function deliveryPrice({ vip, subtotal }) {
    if (vip) {
        return 0;
    } else {
        if (subtotal >= 100) {
            return 0;
        }
        const belowThreshold = subtotal < 100;
        return 10;
    }
}
