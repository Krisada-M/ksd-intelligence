// src/legacy.js — tracked in setup.sh's baseline and then deleted from the
// working tree, so it becomes the reviewed scope's deletion-only change.
export function legacyFormatPath(value) {
    return String(value).replace(/\\/g, "/");
}
