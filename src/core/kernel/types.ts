// Shared contracts, copied from docs/DESIGN.md §7.1, §7.2, §7.4 and §7.9.
// Fields may be added, never repurposed. Types only: no logic belongs here.

export type Strength = 'compiler' | 'syntax-exact' | 'scope-resolved' | 'heuristic' | 'unknown';

export interface Span {
  file: string;
  startLine: number;
  endLine: number;
}

/** On every result. */
export interface EngineStamp {
  version: string;
  typescript: string;
  extractor: string;
}

export type CompletenessStatus = 'complete' | 'partial' | 'unknown';

export interface Completeness {
  status: CompletenessStatus;
  /** Each entry reads "<ReasonCode>: <detail>". */
  reasons: string[];
}

/** Over compiler-grade edges, full traversal. */
export interface Reach {
  /** Depth-1 callers. */
  direct: number;
  /** Unique impacted symbols, all depths. */
  total: number;
  files: number;
  packages: number;
  /** An impacted symbol lives in another package than the target. */
  crossPackage: boolean;
  routes: number;
}

export type Level = 'low' | 'medium' | 'high' | 'critical' | 'unknown';

export type Action = 'proceed' | 'run-tests' | 'check-gaps' | 'ask-owner';

export interface Verdict {
  level: Level;
  action: Action;
  /** Risk zones that applied (M2c). */
  zones: string[];
  requiredActions: string[];
  /** Which completeness reasons, factors and zones produced it. */
  basis: string[];
}

/** NAVIGATES, REQUESTS and EMITS_TO are bridge kinds (M4), heuristic only. */
export type EdgeKind =
  | 'CALLS'
  | 'REFERENCES'
  | 'IMPORTS'
  | 'CONSTRUCTS'
  | 'IMPLEMENTS'
  | 'TESTS'
  | 'REQUESTS'
  | 'NAVIGATES'
  | 'EMITS_TO';

export interface ImpactNode {
  symbol: string;
  via: EdgeKind;
  strength: Strength;
  span: Span;
  /** Set on bridged edges. */
  synthesizedBy?: string;
  /** Set on bridged edges. */
  registeredAt?: Span;
}

export interface ImpactResult {
  /** "<repo-relative path>#<qualified name>" (ADR 0002). */
  target: string;
  /** Display limited by depth; analysis is always full. */
  byDepth: ImpactNode[][];
  /** Heuristic bridge edges (M4); never mixed into byDepth. */
  bridged: ImpactNode[];
  tests: string[];
  completeness: Completeness;
  reach: Reach;
  factors: string[];
  verdict: Verdict;
  freshness: { workingTreeHash: string; includesUntracked: boolean };
  engine: EngineStamp;
}

export type FactorCode =
  | 'public-export-surface'
  | 'route'
  | 'cross-package'
  | 'many-callers'
  | 'boundary:sql'
  | 'boundary:native';

export type ReasonCode =
  | 'dynamic-import'
  | 'computed-member-access'
  | 'interface-dispatch'
  | 'parse-error'
  | 'unsupported-syntax'
  | 'cjs-require'
  | 'unresolved-import'
  | 'unresolved-name-match'
  | 'string-name-match'
  | 'outside-index-scope'
  | 'depth-limit'
  | 'stale-index'
  | 'engine-self-check-failed';

export type GuidanceCode = 'index-building' | 'ambiguous-target' | 'target-not-found';

/** §7.9 failure examples: impact `index-failed` plus the shared trust and input failures. */
export type FailureCode =
  'index-failed' | 'INVALID_INPUT' | 'HASH_MISMATCH' | 'PATH_ESCAPE' | 'LOCK_INVALID';

/**
 * Every engine call ends in one of three outcomes (§7.9, D24). The adapter maps them to OMP
 * results; capabilities never set `isError` themselves.
 */
export type Outcome<T> =
  | { kind: 'result'; value: T }
  | {
      kind: 'guidance';
      code: GuidanceCode;
      /** What the agent should do next. */
      message: string;
      /** `ambiguous-target`: the exact candidate keys. */
      candidates?: string[];
      /** `target-not-found`: the nearest known names. */
      nearest?: string[];
    }
  | {
      kind: 'failure';
      code: FailureCode;
      message: string;
      /** Malfunctions tell the agent to retry once. */
      retry?: boolean;
    };
