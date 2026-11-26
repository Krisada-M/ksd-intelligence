export interface EngineeringExtensionOptions {
  globalConfigPath?: string;
  defaultIntelligenceMode?: "off" | "native" | "mcp" | "cli";
  label?: string;
}
export declare function createExtension(pi: unknown, options?: EngineeringExtensionOptions): void;
export default createExtension;
