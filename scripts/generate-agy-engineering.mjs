// Derive the AGY rule from the same pinned policy used by the OMP entry.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPolicy, POLICY_MARKER, POLICY_END } from '../src/engineering/dist/policy.js';

export function renderAgyRule() {
  const lines = buildPolicy({ enforcement: 'balanced' }).split('\n');
  assert.equal(lines.shift(), POLICY_MARKER);
  assert.equal(lines.pop(), POLICY_END);
  const body = lines
    .join('\n')
    .replace(
      'Ponytail owns YAGNI/simplification and /ponytail-review; don\'t duplicate or invoke it.',
      'Ponytail owns YAGNI/simplification when present; do not duplicate it or invoke its review automatically.',
    )
    .replace('SDLC: /erosiano-dev review.', 'For SDLC review, use the erosiano-review skill.');
  assert.ok(!body.includes('/erosiano-dev') && !body.includes('/ponytail-review'));
  return (
    '---\ntrigger: always_on\n---\n\n' +
    '<!-- Generated from the pinned erosiano-dev balanced policy. Do not edit. -->\n\n' +
    body +
    '\n'
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const path = join(root, 'rules', 'engineering.md');
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--write') writeFileSync(path, renderAgyRule());
  else {
    assert.equal(args.length, 0, 'Usage: generate-agy-engineering.mjs [--write]');
    assert.equal(readFileSync(path, 'utf8'), renderAgyRule(), 'Generated AGY rule drift');
  }
}
