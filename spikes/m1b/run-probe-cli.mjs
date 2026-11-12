// Runs the ei_probe "facts" section outside OMP, as a baseline: `node spikes/m1b/run-probe-cli.mjs` or `bun spikes/m1b/run-probe-cli.mjs`.
import { runFacts } from './dist/probe-core.js';

console.log(await runFacts());
