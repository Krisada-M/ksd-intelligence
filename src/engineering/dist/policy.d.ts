import { type KsdMode } from "./sdlc.js";
export declare const SECTION_KEY = "erosiano-dev";
export declare const POLICY_MARKER = "[erosiano-dev Policy]";
export declare const POLICY_END = "[End erosiano-dev Policy]";
interface AgentStartEvent {
    systemPromptOptions?: {
        sections?: Record<string, string | undefined>;
    };
    systemPrompt?: string | string[];
}
export declare function buildPolicy({ enforcement }?: {
    enforcement?: KsdMode;
}): string;
export declare function augmentSystemPrompt(event: AgentStartEvent | undefined, policy: string | undefined, warn?: (message: string) => void): {
    systemPrompt: string | string[];
} | undefined;
export {};
