// Prints tool-execution events from an `omp --mode json` stream, with raw tool result text.
// Usage: node spikes/m1b/extract-events.mjs <events.jsonl>
import { readFileSync } from 'node:fs';

const lines = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean);
const types = new Map();
const textOf = result => (result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');

for (const line of lines) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  types.set(event.type, (types.get(event.type) ?? 0) + 1);
  if (!String(event.type).startsWith('tool_')) continue;
  const at = event.timestamp ?? event.ts ?? '';
  const name = event.toolName ?? event.name ?? '?';
  const args = event.args ?? event.params;
  console.log(`--- ${event.type} tool=${name} id=${event.toolCallId ?? ''} ${at}`);
  if (args) console.log(`args=${JSON.stringify(args).slice(0, 400)}`);
  const result = event.result ?? event.partialResult;
  if (result) {
    if (event.isError !== undefined || result.isError !== undefined) console.log(`isError=${event.isError ?? result.isError}`);
    console.log(textOf(result));
  }
}
console.log(`--- event type counts: ${JSON.stringify(Object.fromEntries(types))}`);
