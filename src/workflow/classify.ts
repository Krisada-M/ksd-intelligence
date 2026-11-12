import type { TaskType } from './types.js';

export interface Classification {
  type: TaskType;
  classifiedBy: 'keyword' | 'default';
}

// `words` match whole words only (short or ambiguous tokens: "auth" must not hit "author",
// "oauth" or "authority"). `stems` get a leading boundary only, so "vulnerab" matches
// "vulnerability" and "crash" matches "crashing". English only; callers pass `type` for other languages.
function rule(type: TaskType, words: string[], stems: string[]): readonly [TaskType, RegExp] {
  const alternatives = [`\\b(?:${stems.join('|')})`];
  // An empty `\b(?:)\b` would match at every word boundary.
  if (words.length > 0) alternatives.push(`\\b(?:${words.join('|')})\\b`);
  return [type, new RegExp(alternatives.join('|'), 'i')];
}

// Order is priority: the first rule that matches wins.
const RULES: ReadonlyArray<readonly [TaskType, RegExp]> = [
  rule(
    'security',
    ['auth', 'cve', 'xss', 'csrf', 'ssrf', 'sqli'],
    [
      'secur',
      'authenticat',
      'authoriz',
      'permission',
      'vulnerab',
      'secret',
      'injection',
      'exploit',
      'credential',
      'privilege',
    ],
  ),
  rule(
    'performance',
    [],
    [
      'performance',
      'performant',
      'latenc',
      'slow',
      'benchmark',
      'bottleneck',
      'leak',
      'throughput',
      'speed',
    ],
  ),
  rule(
    'ui',
    ['ui', 'ux', 'css'],
    [
      'figma',
      'visual',
      'layout',
      'frontend',
      'front-end',
      'responsive',
      'tailwind',
      'pixel',
      'stylesheet',
    ],
  ),
  rule(
    'refactor',
    [],
    ['refactor', 'cleanup', 'clean up', 'simplif', 'architectur', 'migrat', 'restructur'],
  ),
  rule(
    'bug',
    ['fix', 'fixes', 'fixed', 'fixing'],
    ['bug', 'crash', 'fail', 'regression', 'broken', 'debug', 'flak', 'race condition'],
  ),
];

export function classifyTask(task: string): Classification {
  const hit = RULES.find(([, pattern]) => pattern.test(task));
  if (!hit) return { type: 'feature', classifiedBy: 'default' };
  return { type: hit[0], classifiedBy: 'keyword' };
}
