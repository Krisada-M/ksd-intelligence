import assert from 'node:assert/strict';
import { it } from 'node:test';
import { classifyTask } from '../../src/workflow/classify.js';
import type { Classification } from '../../src/workflow/classify.js';
import { routeTask } from '../../src/workflow/router.js';
import type { TaskType } from '../../src/workflow/types.js';

const keyword = (type: TaskType): Classification => ({ type, classifiedBy: 'keyword' });

const TABLE: ReadonlyArray<readonly [string, Classification]> = [
  ['SQL injection vulnerability', keyword('security')],
  ['authentication bypass', keyword('security')],
  ['fix permissions check', keyword('security')],
  ['leaked secrets in logs', keyword('security')],
  ['CVE-2024-1234 patch', keyword('security')],
  ['XSS in comments', keyword('security')],
  ['fixes crashing checkout', keyword('bug')],
  ['debugging flaky test', keyword('bug')],
  ['bugs in parser', keyword('bug')],
  ['fix recurring payment race condition', keyword('bug')],
  ['slowness on dashboard', keyword('performance')],
  ['memory leak', keyword('performance')],
  ['fix the slow login page', keyword('performance')],
  ['fix CSS bug', keyword('ui')],
  ['refactor payment module', keyword('refactor')],
  ['add OAuth login', { type: 'feature', classifiedBy: 'default' }],
  ['แก้บั๊กการชำระเงิน', { type: 'feature', classifiedBy: 'default' }],
];

for (const [input, expected] of TABLE) {
  it(`classifies ${JSON.stringify(input)} as ${expected.type}/${expected.classifiedBy}`, () => {
    assert.deepEqual(classifyTask(input), expected);
  });
}

it('whole-word tokens do not match inside longer words', () => {
  assert.equal(classifyTask('write the author bio page').classifiedBy, 'default');
  assert.equal(classifyTask('add a test fixture helper').classifiedBy, 'default');
});

it('security outranks bug and performance when several rules match', () => {
  assert.equal(classifyTask('fix slow permission check').type, 'security');
  assert.equal(classifyTask('fix slow query').type, 'performance');
});

it('caller type wins over keywords and is reported as caller', () => {
  const r = routeTask({ task: 'แก้บั๊กการชำระเงิน', stage: 'investigate', type: 'bug' });
  assert.deepEqual(r.skillIds, ['matt:diagnosing-bugs']);
  assert.equal(r.classifiedBy, 'caller');
  assert.equal(routeTask({ task: 'fix CSS bug', type: 'security' }).type, 'security');
});

it('keyword and default classification are reported on the route result', () => {
  assert.equal(routeTask({ task: 'fix crash' }).classifiedBy, 'keyword');
  assert.equal(routeTask({ task: 'add OAuth login' }).classifiedBy, 'default');
});

it('an invalid caller type is an error, not a silent fallback', () => {
  assert.throws(() => routeTask({ task: 'fix crash', type: 'bugfix' }), /INVALID_INPUT.*type/);
  assert.throws(() => routeTask({ task: 'fix crash', type: '' }), /INVALID_INPUT.*type/);
});
