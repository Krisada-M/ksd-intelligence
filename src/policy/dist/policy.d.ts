import { type KsdMode } from "./sdlc.js";
export declare const SECTION_KEY = "engineering-proxy";
export declare const POLICY_MARKER = "[Engineering Proxy Policy]";
export declare const POLICY_END = "[End Engineering Proxy Policy]";
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
