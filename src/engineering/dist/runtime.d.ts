/** In-process hot-path engine. No native processes, filesystem access or LLM calls. */
import type { KsdMode } from "./sdlc.js";
export interface KsdConfig {
    readonly enabled: boolean;
    readonly enforcement: "balanced" | "adaptive";
    readonly configError?: string;
    readonly root?: string;
    readonly configPresent?: boolean;
}
export interface KsdTheme {
    fg?(style: string, text: string): string;
}
export interface KsdUi {
    setStatus?(key: string, value: string | undefined): void;
    readonly theme?: KsdTheme;
}
export interface KsdContext {
    readonly cwd?: string;
    readonly ui?: KsdUi;
}
type LoadConfig = (cwd: string) => KsdConfig;
type BuildPolicy = (config: {
    enforcement: KsdMode;
}) => string;
type IsDisabled = () => boolean;
export declare class KsdRuntime {
    private readonly loadConfig;
    private readonly buildPolicy;
    private readonly isDisabled;
    private readonly configs;
    private readonly policies;
    private readonly statuses;
    constructor(loadConfig: LoadConfig, buildPolicy: BuildPolicy, isDisabled: IsDisabled);
    getConfig(cwd: string, refresh?: boolean): KsdConfig;
    getPolicy(mode: KsdMode): string;
    /** Redraw after session/UI resets even if status text is unchanged. */
    invalidateStatus(ui?: KsdUi): void;
    syncStatus(ctx: KsdContext | undefined, isActive: boolean, mode: KsdConfig["enforcement"], notice?: string): void;
}
export {};
