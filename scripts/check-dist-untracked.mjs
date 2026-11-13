// Fails when the build produced files under dist/ that git does not track.
// `git diff --exit-code dist/` only sees tracked files, so a new module whose build output was
// never added would pass the drift check while the marketplace install (a copy of the repo)
// would be missing it at runtime.
import { execFileSync } from 'node:child_process';

const args = ['ls-files', '--others', '--exclude-standard', '--', 'dist/'];
const output = execFileSync('git', args, { encoding: 'utf8' });
const untracked = output.split('\n').filter(Boolean);

if (untracked.length > 0) {
  console.error('dist/ contains build output that is not committed:');
  for (const file of untracked) {
    console.error(`  ${file}`);
  }
  console.error('Run `git add dist/` and commit it with the source change.');
  process.exit(1);
}
