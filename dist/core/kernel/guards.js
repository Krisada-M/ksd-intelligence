/** The one shared object guard: proves a non-null, non-array object; its fields stay unknown. */
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
