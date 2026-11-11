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
type BuildPolicy = (config: { enforcement: KsdMode }) => string;
type IsDisabled = () => boolean;

type StatusCache = { value: string | undefined; theme: KsdTheme | undefined; notice?: string };

export class KsdRuntime {
  private readonly configs = new Map<string, KsdConfig>();
  private readonly policies = new Map<string, string>();
  private readonly statuses = new WeakMap<KsdUi, StatusCache>();

  constructor(
    private readonly loadConfig: LoadConfig,
    private readonly buildPolicy: BuildPolicy,
    private readonly isDisabled: IsDisabled,
  ) {}

  getConfig(cwd: string, refresh = false): KsdConfig {
    const known = this.configs.get(cwd);
    if (!refresh && known) return known;

    const next = this.loadConfig(cwd);
    this.configs.set(cwd, next);

    return next;
  }

  getPolicy(mode: KsdMode): string {
    const existing = this.policies.get(mode);
    if (existing !== undefined) return existing;

    // The single-field config object is allocated only on a two-mode cache miss.
    const policy = this.buildPolicy({ enforcement: mode });
    this.policies.set(mode, policy);

    return policy;
  }

  /** Redraw after session/UI resets even if status text is unchanged. */
  invalidateStatus(ui?: KsdUi): void {
    if (ui) this.statuses.delete(ui);
  }

  syncStatus(ctx: KsdContext | undefined, isActive: boolean, mode: KsdConfig["enforcement"], notice?: string): void {
    const ui = ctx?.ui;
    if (typeof ui?.setStatus !== "function" || !ctx?.cwd) return;

    try {
      const config = this.getConfig(ctx.cwd);
      const enabled = config.enabled && !this.isDisabled();
      let theme: KsdTheme | undefined;
      try {
        theme = ui.theme;
      } catch {
        // Missing theme must never break headless/early-start UIs.
      }

      let status: string | undefined;
      if (enabled) {
        const dot = isActive ? "●" : "○";
        let colored = dot;
        try {
          if (typeof theme?.fg === "function") {
            colored = theme.fg(isActive ? "accent" : "dim", dot);
          }
        } catch {
          // Theme rendering is optional.
        }
        status = `${colored} 🛡 KSD: ${mode.toUpperCase()}`;
        if (notice) status += `; ${notice}`;
      }
      else if (notice) status = `⚠ KSD: ${notice}`;

      const before = this.statuses.get(ui);
      if (before && before.value === status && before.theme === theme) return;

      ui.setStatus("engineering-proxy", status);
      this.statuses.set(ui, { value: status, theme, notice });
    } catch {
      // Decorative UI must never cause a coding session to fail.
    }
  }
}
