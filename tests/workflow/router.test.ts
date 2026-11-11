import assert from 'node:assert/strict';
import { it } from 'node:test';
import { routeTask } from '../../src/workflow/router.js';
import { RISKS, STAGES, TASK_TYPES } from '../../src/workflow/types.js';

it('diagnoses bugs without meta-router recursion', () => {
  assert.deepEqual(routeTask({ task: 'fix payment race condition', stage: 'investigate' }).skillIds, ['matt:diagnosing-bugs']);
});

// "auth bug" is a security task whose review stage already selects blast-radius; this does NOT exercise the high-risk branch.
it('high-risk review of a security task contains poteto blast-radius once', () => {
  assert.deepEqual(routeTask({ task: 'auth bug', stage: 'review', risk: 'high' }).skillIds, ['poteto:blast-radius']);
});

it('high-risk review adds poteto blast-radius to a non-security primary skill', () => {
  assert.deepEqual(
    routeTask({ task: 'add OAuth login', stage: 'review', risk: 'high' }).skillIds,
    ['matt:code-review', 'poteto:blast-radius'],
  );
});

it('high-risk verification adds security check and never grants deploy', () => {
  const r = routeTask({ task: 'fix payment race condition', stage: 'verify', risk: 'high' });
  assert.deepEqual(r.skillIds, ['osmani:code-review-and-quality', 'osmani:security-and-hardening']);
  assert.equal(r.mayDeploy, false);
});

it('high risk adds nothing outside review and verify', () => {
  for (const stage of ['plan', 'investigate', 'implement', 'ship'] as const) {
    assert.equal(routeTask({ task: 'add OAuth login', stage, risk: 'high' }).skillIds.length, 1, stage);
  }
});

it('rejects invalid stages, risks and blank tasks', () => {
  assert.throws(() => routeTask({ task: '', stage: 'plan' }), /INVALID_INPUT/);
  assert.throws(() => routeTask({ task: '   ' }), /INVALID_INPUT/);
  assert.throws(() => routeTask({ task: 'task', stage: 'unknown' }), /INVALID_INPUT.*stage/);
  assert.throws(() => routeTask({ task: 'task', risk: 'extreme' }), /INVALID_INPUT.*risk/);
});

it('no type x stage x risk combination returns duplicate skill ids', () => {
  for (const type of TASK_TYPES) {
    for (const stage of STAGES) {
      for (const risk of RISKS) {
        const { skillIds } = routeTask({ task: 'anything', type, stage, risk });
        assert.equal(new Set(skillIds).size, skillIds.length, `${type}/${stage}/${risk}: ${skillIds.join(',')}`);
        assert.ok(skillIds.length >= 1 && skillIds.length <= 2, `${type}/${stage}/${risk}`);
      }
    }
  }
});

it('every route result has mayMerge and mayDeploy false', () => {
  for (const type of TASK_TYPES) {
    for (const risk of RISKS) {
      const r = routeTask({ task: 'x', type, stage: 'ship', risk });
      assert.equal(r.mayMerge, false);
      assert.equal(r.mayDeploy, false);
    }
  }
});
