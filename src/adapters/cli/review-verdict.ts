#!/usr/bin/env node
import { runPolicyBin } from './policy-bin.js';

await runPolicyBin(
  new URL('../../engineering/review-verdict.js', import.meta.url),
  'ksd-review-verdict --report assessment.json',
);
