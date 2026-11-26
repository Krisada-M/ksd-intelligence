#!/usr/bin/env node
import { runPolicyBin } from './policy-bin.js';
await runPolicyBin(new URL('../../engineering/check-changed.js', import.meta.url), 'ksd-check-changed --diff git.patch --eslint-report eslint.json');
