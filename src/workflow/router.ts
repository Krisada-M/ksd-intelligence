import { classifyTask } from './classify.js';
import { packForSkillId } from './packs.js';
import {
  COMPLIANCE_DIMENSIONS,
  ORCHESTRATOR_SKILL_ID,
  RISKS,
  STAGES,
  TASK_TYPES,
  WorkflowError,
  isOneOf,
  type ClassifiedBy,
  type RequirementComplianceGate,
  type RouteResult,
  type SecondaryPackReason,
  type SkillId,
  type SkillPackId,
  type Stage,
  type TaskType,
} from './types.js';

// One primary skill per stage, indexed by STAGES order:
// plan, investigate, implement, verify, review, ship.
const WORKFLOWS: Readonly<
  Record<TaskType, readonly [SkillId, SkillId, SkillId, SkillId, SkillId, SkillId]>
> = {
  bug: [
    'matt:diagnosing-bugs',
    'matt:diagnosing-bugs',
    'matt:tdd',
    'osmani:code-review-and-quality',
    'poteto:blast-radius',
    'osmani:shipping-and-launch',
  ],
  feature: [
    'osmani:spec-driven-development',
    'poteto:how',
    'matt:tdd',
    'osmani:code-review-and-quality',
    'matt:code-review',
    'osmani:shipping-and-launch',
  ],
  refactor: [
    'matt:codebase-design',
    'poteto:how',
    'osmani:incremental-implementation',
    'osmani:code-review-and-quality',
    'poteto:blast-radius',
    'osmani:shipping-and-launch',
  ],
  security: [
    'osmani:security-and-hardening',
    'matt:diagnosing-bugs',
    'matt:tdd',
    'osmani:security-and-hardening',
    'poteto:blast-radius',
    'osmani:shipping-and-launch',
  ],
  performance: [
    'osmani:performance-optimization',
    'poteto:why',
    'osmani:incremental-implementation',
    'osmani:performance-optimization',
    'poteto:blast-radius',
    'osmani:shipping-and-launch',
  ],
  ui: [
    'osmani:frontend-ui-engineering',
    'poteto:how',
    'osmani:frontend-ui-engineering',
    'osmani:browser-testing-with-devtools',
    'poteto:blast-radius',
    'osmani:shipping-and-launch',
  ],
};

export interface RouteInput {
  task: string;
  stage?: string;
  risk?: string;
  // Caller-asserted task type; wins over the keyword classifier. Invalid values are an error.
  type?: string;
  // Explicit opt-in for deep multi-phase workflow (`poteto-mode`). Never enabled automatically.
  potetoMode?: boolean;
}

const REQ_COMPLIANCE_RE =
  /\b(?:req|reqs|requirement|requirements|acceptance criteria|req mismatch|spec mismatch|requirement compliance)\b/i;

export function hasRequirementComplianceSignal(task: string): boolean {
  return REQ_COMPLIANCE_RE.test(task);
}

function invalid(field: string, value: unknown, allowed: readonly string[]): WorkflowError {
  return new WorkflowError(
    'INVALID_INPUT',
    `invalid ${field} ${JSON.stringify(value)}; expected one of: ${allowed.join(', ')}`,
  );
}

function primarySkill(type: TaskType, stage: Stage): SkillId {
  const skill = WORKFLOWS[type][STAGES.indexOf(stage)];
  if (skill === undefined)
    throw new WorkflowError('INVALID_INPUT', `no workflow entry for ${type}/${stage}`);
  return skill;
}

export function routeTask(input: RouteInput): RouteResult {
  const { task, stage = 'plan', risk = 'normal', type, potetoMode = false } = input;
  if (typeof task !== 'string' || !task.trim())
    throw new WorkflowError('INVALID_INPUT', 'non-empty task required');
  if (!isOneOf(STAGES, stage)) throw invalid('stage', stage, STAGES);
  if (!isOneOf(RISKS, risk)) throw invalid('risk', risk, RISKS);
  if (type !== undefined && !isOneOf(TASK_TYPES, type)) throw invalid('type', type, TASK_TYPES);
  if (typeof potetoMode !== 'boolean') {
    throw new WorkflowError('INVALID_INPUT', 'potetoMode must be a boolean');
  }

  const cleanTask = task.trim();
  const resolved: { type: TaskType; classifiedBy: ClassifiedBy } =
    type === undefined ? classifyTask(cleanTask) : { type, classifiedBy: 'caller' };

  const primary = primarySkill(resolved.type, stage);
  const primaryPack: SkillPackId = packForSkillId(primary);
  const skillIds: SkillId[] = [primary];
  const secondaryPacks: SkillPackId[] = [];
  const secondaryReasons: Partial<Record<SkillPackId, SecondaryPackReason>> = {};

  const addSecondary = (pack: SkillPackId, reason: SecondaryPackReason): void => {
    if (pack === primaryPack || secondaryPacks.includes(pack)) return;
    secondaryPacks.push(pack);
    secondaryReasons[pack] = reason;
  };

  // High risk adds at most one extra reviewer/verifier, and only at review/verify.
  if (risk === 'high' && stage === 'review') {
    skillIds.push('poteto:blast-radius');
    addSecondary('pstack-analysis', 'high-risk-review');
  }
  if (risk === 'high' && stage === 'verify') {
    skillIds.push('osmani:security-and-hardening');
    addSecondary('osmani-quality', 'high-risk-verify');
  }

  const reqSignal = hasRequirementComplianceSignal(cleanTask);
  const stageRequiresCompliance = stage === 'verify' || stage === 'review' || stage === 'ship';
  const requirementCompliance: RequirementComplianceGate = {
    required: reqSignal || stageRequiresCompliance,
    dimensions: COMPLIANCE_DIMENSIONS,
    trigger: reqSignal ? 'keyword' : stageRequiresCompliance ? 'stage' : 'none',
  };

  // Explicit REQ mismatch / compliance review justifies invoking Matt's code-review as secondary.
  if (reqSignal && stage === 'review') {
    skillIds.push('matt:code-review');
    addSecondary('matt-sdlc', 'requirement-compliance');
  } else if (reqSignal && stage === 'verify') {
    addSecondary('matt-sdlc', 'requirement-compliance');
  }

  // `poteto-mode` is strictly opt-in; KSD remains primary orchestrator and never auto-enables it.
  const optInPacks: SkillPackId[] = [];
  if (potetoMode) {
    optInPacks.push('poteto-mode');
    addSecondary('poteto-mode', 'explicit-opt-in');
  }

  return {
    task: cleanTask,
    type: resolved.type,
    classifiedBy: resolved.classifiedBy,
    stage,
    risk,
    skillIds: [...new Set(skillIds)],
    orchestrator: ORCHESTRATOR_SKILL_ID,
    primaryPack,
    secondaryPacks,
    secondaryReasons,
    optInPacks,
    requirementCompliance,
    mayMerge: false,
    mayDeploy: false,
  };
}
