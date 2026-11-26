/** Counts a runner reported; `null` fields mean the output did not say. */
export interface TestCounts {
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface ParsedResults {
  counts: TestCounts | null;
  failures: string[];
}

export const MAX_FAILURES = 10;

function sumMatches(text: string, re: RegExp): number | null {
  let total: number | null = null;
  for (const match of text.matchAll(re)) {
    total = (total ?? 0) + Number(match[1]);
  }
  return total;
}

// node:test (TAP and spec reporters): `# tests 3` / `ℹ tests 3`, summed over every summary block.
function nodeTestCounts(text: string): TestCounts | null {
  const tests = sumMatches(text, /^\s*(?:#|ℹ)\s*tests\s+(\d+)\s*$/gm);
  if (tests === null) return null;
  return {
    tests,
    passed: sumMatches(text, /^\s*(?:#|ℹ)\s*pass\s+(\d+)\s*$/gm) ?? 0,
    failed: sumMatches(text, /^\s*(?:#|ℹ)\s*fail\s+(\d+)\s*$/gm) ?? 0,
    skipped: sumMatches(text, /^\s*(?:#|ℹ)\s*(?:skipped|todo)\s+(\d+)\s*$/gm) ?? 0,
  };
}

// Jest: `Tests:       1 failed, 2 skipped, 3 passed, 6 total`.
function jestCounts(text: string): TestCounts | null {
  const line = /^\s*Tests:\s+(.*\b\d+ total)\s*$/m.exec(text)?.[1];
  if (line === undefined) return null;
  const pick = (word: string): number => Number(new RegExp(`(\\d+) ${word}`).exec(line)?.[1] ?? 0);
  return {
    tests: pick('total'),
    passed: pick('passed'),
    failed: pick('failed'),
    skipped: pick('skipped') + pick('todo'),
  };
}

// Vitest: ` Tests  1 failed | 2 passed (3)`.
function vitestCounts(text: string): TestCounts | null {
  const match = /^\s*Tests\s+(.*?)\s*\((\d+)\)\s*$/m.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const line = match[1];
  const pick = (word: string): number => Number(new RegExp(`(\\d+) ${word}`).exec(line)?.[1] ?? 0);
  return {
    tests: Number(match[2]),
    passed: pick('passed'),
    failed: pick('failed'),
    skipped: pick('skipped') + pick('todo'),
  };
}

// Mocha: `3 passing`, `1 failing`, `2 pending`.
function mochaCounts(text: string): TestCounts | null {
  const passed = sumMatches(text, /^\s*(\d+) passing\b/gm);
  if (passed === null) return null;
  const failed = sumMatches(text, /^\s*(\d+) failing\b/gm) ?? 0;
  const skipped = sumMatches(text, /^\s*(\d+) pending\b/gm) ?? 0;
  return { tests: passed + failed + skipped, passed, failed, skipped };
}

const NO_TESTS_RE = /^\s*(?:0 tests?\b|no tests? (?:found|ran|executed|to run)\b)/im;

/** Counts from a check's console output; recognised runners only, never guessed. */
export function parseOutput(text: string): ParsedResults {
  const counts =
    nodeTestCounts(text) ??
    jestCounts(text) ??
    vitestCounts(text) ??
    mochaCounts(text) ??
    (NO_TESTS_RE.test(text) ? { tests: 0, passed: 0, failed: 0, skipped: 0 } : null);
  const failures: string[] = [];
  for (const match of text.matchAll(/^\s*not ok \d+ - (.+?)\s*$/gm)) {
    const name = match[1];
    if (name === undefined || failures.includes(name)) continue;
    failures.push(name);
    if (failures.length === MAX_FAILURES) break;
  }
  return { counts, failures };
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Counts from JUnit XML: one `<testcase>` per test, failed when it holds `<failure>` or `<error>`. */
export function parseJunit(xml: string): ParsedResults {
  const counts: TestCounts = { tests: 0, passed: 0, failed: 0, skipped: 0 };
  const failures: string[] = [];
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';
    counts.tests++;
    if (/<(?:failure|error)\b/.test(body)) {
      counts.failed++;
      const name = decodeXml(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? '(unnamed)');
      if (failures.length < MAX_FAILURES) failures.push(name);
      continue;
    }
    if (/<skipped\b/.test(body)) {
      counts.skipped++;
      continue;
    }
    counts.passed++;
  }
  return { counts, failures };
}

/** Counts from a TAP file: top-level test points only (indented lines are subtests). */
export function parseTap(text: string): ParsedResults {
  const counts: TestCounts = { tests: 0, passed: 0, failed: 0, skipped: 0 };
  const failures: string[] = [];
  for (const match of text.matchAll(/^(not )?ok\b(?: \d+)?(?: - )?([^#\n]*)(#.*)?$/gm)) {
    counts.tests++;
    const directive = match[3] ?? '';
    if (/#\s*(?:skip|todo)\b/i.test(directive)) {
      counts.skipped++;
      continue;
    }
    if (match[1] === undefined) {
      counts.passed++;
      continue;
    }
    counts.failed++;
    if (failures.length < MAX_FAILURES) failures.push((match[2] ?? '').trim() || '(unnamed)');
  }
  return { counts, failures };
}
