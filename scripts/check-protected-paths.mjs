// Fails when a change touches owner-protected paths without the `owner-approved` label.
// The list mirrors AGENTS.md and docs/briefs/README.md; keep the three in step.
import { execFileSync } from 'node:child_process';

export const PROTECTED = [
  { prefix: 'tests/golden/', why: 'owner-confirmed oracle (golden cases and policies)' },
  { prefix: 'src/policy/', why: 'KSD policy module, frozen contract' },
  { prefix: 'tests/policy/', why: 'KSD policy tests and snapshots, frozen contract' },
  { prefix: 'tests/snapshots/', why: 'tool output snapshots; a change needs the owner to look at it' },
];

export function protectedChanges(paths) {
  const hits = [];
  for (const path of paths) {
    const rule = PROTECTED.find((entry) => path.startsWith(entry.prefix));
    if (rule) hits.push({ path, why: rule.why });
  }
  return hits;
}

function main() {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error('usage: check-protected-paths.mjs <base-sha> <head-sha>');
    return 2;
  }
  const output = execFileSync('git', ['diff', '--name-only', '-z', `${base}...${head}`], {
    encoding: 'utf8',
  });
  const hits = protectedChanges(output.split('\0').filter(Boolean));
  if (hits.length === 0) {
    console.log('No protected paths changed.');
    return 0;
  }
  console.log(`Protected paths changed (${hits.length}):`);
  for (const hit of hits) console.log(`  ${hit.path} — ${hit.why}`);
  if (process.env.APPROVED === 'true') {
    console.log('Label owner-approved is present: accepted.');
    return 0;
  }
  console.log(
    '\nThe owner must review these files and add the label `owner-approved` to this pull request.',
  );
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main();
