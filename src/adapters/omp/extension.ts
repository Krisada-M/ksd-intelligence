/**
 * Experimental OMP adapter for the `ei_workflow` tool.
 *
 * STATUS: NOT VERIFIED against OMP at runtime (M1 does the live smoke test).
 *
 * What was read to write this (see README "OMP adapter"):
 *  - OMP binary on this machine: omp/18.18.2 (`omp --version`).
 *  - Docs bundled in that binary: `omp://extensions.md` (registerTool, `execute` signature, `approval`).
 *  - Type source from the globally installed npm package @oh-my-pi/pi-coding-agent 18.14.0
 *    (older than the binary): src/extensibility/extensions/types.ts (`ToolDefinition`, `ExtensionAPI`),
 *    ../pi-agent-core/src/types.ts (`AgentToolResult`, `ToolApproval`), ../omptype/src/zod.ts.
 *
 * The OMP types are copied below as a minimal local interface because this repo has no OMP dependency.
 * If OMP changes these shapes, this file will not notice until it is loaded in OMP.
 */
import { rootsFromEnv } from '../../workflow/catalog.js';
import { prepareWorkflow } from '../../workflow/loader.js';
import { renderWorkflow } from '../../workflow/render.js';
import { defaultLockPath, readLock } from '../../workflow/sources.js';
import { RISKS, STAGES, TASK_TYPES } from '../../workflow/types.js';

interface SchemaLike {
  optional(): SchemaLike;
  describe(text: string): SchemaLike;
}

interface SchemaBuilder {
  string(): SchemaLike;
  enum(values: readonly string[]): SchemaLike;
  object(shape: Record<string, SchemaLike>): SchemaLike;
}

interface ToolParams {
  task: string;
  stage: string;
  risk?: string;
  type?: string;
}

interface ToolResult {
  content: { type: 'text'; text: string }[];
  details?: unknown;
  isError?: boolean;
}

interface OmpToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: SchemaLike;
  approval: 'read';
  execute(toolCallId: string, params: ToolParams, signal: AbortSignal | undefined): Promise<ToolResult>;
}

export interface OmpExtensionApi {
  zod: SchemaBuilder;
  registerTool(tool: OmpToolDefinition): void;
}

export interface ExtensionDeps {
  env?: NodeJS.ProcessEnv;
  lockPath?: string;
}

function errorResult(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

// Advisory tool: every failure becomes an error result for the agent, never a crashed session.
export default function eiWorkflowExtension(pi: OmpExtensionApi, deps: ExtensionDeps = {}): void {
  const z = pi.zod;
  const env = deps.env ?? process.env;
  const lockPath = deps.lockPath ?? defaultLockPath();

  pi.registerTool({
    name: 'ei_workflow',
    label: 'KSD Skills Workflow',
    description:
      'Choose and read allowlisted Matt Pocock, poteto and Addy Osmani skills for an engineering task and stage. ' +
      'Pass `type` when you can classify the task yourself (including non-English text); otherwise a keyword guess is used and reported.',
    parameters: z.object({
      task: z.string(),
      stage: z.enum(STAGES),
      risk: z.enum(RISKS).optional(),
      type: z.enum(TASK_TYPES).optional().describe('Caller-asserted task type; overrides the keyword classifier'),
    }),
    approval: 'read',
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) return errorResult('Cancelled');
      try {
        const workflow = await prepareWorkflow({
          ...params,
          strict: true,
          roots: rootsFromEnv(env),
          lock: await readLock(lockPath),
        });
        return {
          content: [{ type: 'text', text: renderWorkflow(workflow) }],
          details: {
            type: workflow.type,
            classifiedBy: workflow.classifiedBy,
            stage: workflow.stage,
            skillIds: workflow.skillIds,
            ready: workflow.ready,
          },
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  });
}
