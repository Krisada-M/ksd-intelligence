export const TASK_TYPES = ['bug', 'feature', 'refactor', 'security', 'performance', 'ui'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const STAGES = ['plan', 'investigate', 'implement', 'verify', 'review', 'ship'] as const;
export type Stage = (typeof STAGES)[number];

export const RISKS = ['normal', 'high'] as const;
export type Risk = (typeof RISKS)[number];

export const PROVIDER_IDS = ['matt', 'poteto', 'osmani'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const SKILL_IDS = [
  'matt:diagnosing-bugs',
  'matt:codebase-design',
  'matt:tdd',
  'matt:code-review',
  'poteto:how',
  'poteto:why',
  'poteto:blast-radius',
  'osmani:spec-driven-development',
  'osmani:incremental-implementation',
  'osmani:code-review-and-quality',
  'osmani:security-and-hardening',
  'osmani:performance-optimization',
  'osmani:frontend-ui-engineering',
  'osmani:browser-testing-with-devtools',
  'osmani:shipping-and-launch',
] as const;
export type SkillId = (typeof SKILL_IDS)[number];

// "caller" = the calling agent passed `type`; "default" = no keyword matched, feature was assumed.
export type ClassifiedBy = 'caller' | 'keyword' | 'default';

export interface RouteResult {
  task: string;
  type: TaskType;
  classifiedBy: ClassifiedBy;
  stage: Stage;
  risk: Risk;
  skillIds: SkillId[];
  // Literal `false`: no skill content or caller input can make the router grant these.
  mayMerge: false;
  mayDeploy: false;
}

export type HashStatus = 'verified' | 'unpinned';

export interface LoadedSkill {
  id: string;
  file: string;
  baseDir: string;
  text: string;
  sha256: string;
  hash: HashStatus;
}

export type WorkflowErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_ALLOWLISTED'
  | 'PROVIDER_ROOT_MISSING'
  | 'PROVIDER_ROOT_NOT_FOUND'
  | 'SKILL_NOT_FOUND'
  | 'PATH_ESCAPE'
  | 'INVALID_SKILL'
  | 'HASH_MISMATCH'
  | 'LOCK_INVALID'
  | 'SKILLS_UNAVAILABLE';

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  // Message without the code prefix, for tables that show the code in its own column.
  readonly detail: string;

  constructor(code: WorkflowErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'WorkflowError';
    this.code = code;
    this.detail = detail;
  }
}

export interface MissingSkill {
  id: string;
  code: WorkflowErrorCode;
  reason: string;
}

export type Workflow = RouteResult & {
  loaded: LoadedSkill[];
  missing: MissingSkill[];
  ready: boolean;
};

export function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return list.some((item) => item === value);
}
