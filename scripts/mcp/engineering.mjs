// AGY/stdio adapter to the pinned engineering runtime. No OMP lifecycle, subprocess or root override.
import { isAbsolute } from 'node:path';
import { collectBaselineEvidence } from '../../dist/engineering/baseline.js';
import { resolvePracticeTool } from '../../dist/engineering/practice-tool.js';

const schema = (properties, required) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

export const ENGINEERING_TOOLS = Object.freeze([
  {
    name: 'erosiano_baseline',
    description:
      'Capture bounded sampled file hashes for a scope under the configured workspace. Supply relative scope and optional caller/test/config paths. Does not establish a complete semantic baseline or execute Git.',
    inputSchema: schema(
      {
        scope: { type: 'string', minLength: 1, maxLength: 1024 },
        additionalPaths: {
          type: 'array',
          maxItems: 24,
          items: { type: 'string', minLength: 1, maxLength: 1024 },
        },
      },
      ['scope'],
    ),
    annotations,
  },
  {
    name: 'erosiano_resolve_practices',
    description:
      'Resolve engineering practices from bounded supplied context. Fresh policy output requires a current baseline fingerprint and observed path provenance. Uses the fixed server root. Does not authenticate interpretations or run native checks.',
    inputSchema: schema(
      {
        context: { type: 'string', maxLength: 65536 },
        group: { type: 'string', maxLength: 64 },
        format: { type: 'string', enum: ['decisions', 'policy'] },
      },
      ['context'],
    ),
    annotations,
  },
]);

function error(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function validPath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 1024 && !isAbsolute(path);
}

export function callEngineering(root, name, args, signal) {
  if (signal?.aborted) return error('Cancelled');
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return error('INVALID_INPUT: expected an object');
  }
  try {
    if (name === 'erosiano_baseline') {
      if (
        Object.keys(args).some((key) => !['scope', 'additionalPaths'].includes(key)) ||
        !validPath(args.scope) ||
        (args.additionalPaths !== undefined &&
          (!Array.isArray(args.additionalPaths) ||
            args.additionalPaths.length > 24 ||
            !args.additionalPaths.every(validPath)))
      ) {
        return error('INVALID_INPUT: relative scoped paths only; fixed server root');
      }
      const record = collectBaselineEvidence({
        root,
        scope: args.scope,
        additionalPaths: args.additionalPaths ?? [],
      });
      const text = JSON.stringify(record);
      if (text.length > 65536) return error('NOT_ASSESSED: narrow the sampled evidence scope');
      return { content: [{ type: 'text', text }] };
    }
    if (name !== 'erosiano_resolve_practices') return error('TOOL_UNAVAILABLE');
    if (Object.keys(args).some((key) => !['context', 'group', 'format'].includes(key))) {
      return error('INVALID_INPUT: unknown argument; fixed server root');
    }
    const result = resolvePracticeTool(args, { root });
    return { content: result.content, ...(result.isError ? { isError: true } : {}) };
  } catch {
    return error('NOT_ASSESSED: invalid or inaccessible scoped engineering evidence');
  }
}
