// M1b throwaway probe. Never imported by src/. Load explicitly only:
//   omp -p --no-extensions --model claude-haiku-4-5 -e spikes/m1b/probe-extension.mjs '<prompt>'
// The probe logic lives in ./dist/ on purpose: A7 checks that an ESM entry can
// import a relative module from dist/ and start a worker from a URL next to it.
import { runFacts, runProgress, runBlock } from './dist/probe-core.js';

export default function probeExtension(pi) {
  const z = pi.zod;
  pi.registerTool({
    name: 'ei_probe',
    label: 'M1b runtime probe',
    description:
      'Throwaway M1b runtime probe. section "facts" reports runtime, worker, typescript, sqlite and module facts; ' +
      '"progress" emits three progress updates one second apart; "block" waits `seconds` seconds, emitting progress every 5 s.',
    parameters: z.object({
      section: z.enum(['facts', 'progress', 'block']),
      seconds: z.number().optional().describe('Only for section "block"'),
    }),
    approval: 'read',
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const started = Date.now();
      let text;
      try {
        if (params.section === 'facts') text = await runFacts();
        else if (params.section === 'progress') text = await runProgress(onUpdate, signal);
        else text = await runBlock(params.seconds ?? 20, onUpdate, signal);
      } catch (error) {
        text = `PROBE THREW: ${error instanceof Error ? error.stack : String(error)}`;
      }
      const header = [
        `ei_probe section=${params.section} toolCallId=${toolCallId}`,
        `execute args: signal=${signal === undefined ? 'undefined' : 'AbortSignal'} onUpdate=${typeof onUpdate} ctx=${ctx === undefined ? 'undefined' : 'object'}`,
        `elapsedMs=${Date.now() - started}`,
      ].join('\n');
      return { content: [{ type: 'text', text: `${header}\n${text}` }], details: { section: params.section } };
    },
  });
}
