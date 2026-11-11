/** Lightweight SDLC guidance; not an automatic release gate. */
export declare const KSD_MODES: readonly ["balanced", "adaptive"];
export type KsdMode = (typeof KSD_MODES)[number];
export declare const SDLC_PHASES: readonly string[];
export declare function buildSdlcPolicy({ mode }?: {
    mode?: KsdMode;
}): string;
