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
  /** This caller has scoped gaps of its own; it does not change the target's picture (D54). */
  gapScoped?: boolean;
  /** This caller is in a file matched by `impact.routes`. */
  route?: boolean;
  /** Boundary markers (`boundary:sql`, `boundary:native`) on this caller's file. */
  boundaries?: string[];
  /** Set on bridged edges. */
  synthesizedBy?: string;
  /** Set on bridged edges. */
  registeredAt?: Span;
}

/** Repository-wide limits that are never completeness reasons (D55, G14). */
export interface ImpactLimits {
  /** Prefix-less `import(x)`/`require(x)` sites and dynamic prefixes naming no indexed file. */
  unboundedDynamicImports: number;
  /** Files never read by policy: excluded, secret, symlinked, outside the include scope. */
  excludedFiles: number;
  /** Indexable files whose owning tsconfig could not be read: listed, not indexed. */
  failedFiles: number;
}

export interface ImpactResult {
  /** "<repo-relative path>#<qualified name>" (ADR 0002). */
  target: string;
  /** Declaration span of `target` in the index. */
  span?: Span;
  /** Display limited by depth; analysis is always full. */
  byDepth: ImpactNode[][];
  /** Heuristic bridge edges (M4); never mixed into byDepth. */
  bridged: ImpactNode[];
  tests: string[];
  completeness: Completeness;
  reach: Reach;
  factors: string[];
  /** Repository limits carried in `details` and the footer; they never change the verdict. */
  limits: ImpactLimits;
  /** Total scanned files in the repository census (for the footer). */
  scannedFiles?: number;
  verdict: Verdict;
  freshness: { workingTreeHash: string; includesUntracked: boolean };
  engine: EngineStamp;
}

export type FactorCode =
  | 'public-export-surface'
  | 'route'
  | 'cross-package'
  | 'many-callers'
  | 'common-name'
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

export type ChangeFileStatus = 'A' | 'M' | 'D' | 'R';
export type SymbolChangeKind = 'added' | 'modified' | 'removed' | 'signature-changed';

export interface ChangedFile {
  path: string;
  status: ChangeFileStatus;
  indexed: boolean;
  oldPath?: string;
}

export interface ChangedSymbolLiveUser {
  file: string;
  line: number;
  source: string;
  reason:
    'caller' | 'unresolved-import' | 'unresolved-name-match' | 'string-name-match' | 're-export';
}

export interface ChangedSymbol {
  symbol: string;
  change: SymbolChangeKind;
  span?: Span;
  callers?: number;
  directCallers?: ImpactNode[];
  liveUsers?: ChangedSymbolLiveUser[];
}

export interface UnindexedChangeDetail {
  path: string;
  reason: string;
  status: ChangeFileStatus;
}

export interface ChangesPlanSummary {
  provided: boolean;
  plannedCount: number;
  notInPlan: {
    symbol: string;
    change: SymbolChangeKind;
    callers: number;
    liveUsers: ChangedSymbolLiveUser[];
  }[];
  unchanged: string[];
  ambiguous: { target: string; candidates: string[] }[];
}

export interface ChangesTimings {
  updateMs: number;
  baseParseMs: number;
  traverseMs: number;
  renderMs: number;
}

export interface ChangesResult {
  base: string;
  mergeBase?: string;
  changedFiles: ChangedFile[];
  changedSymbols: ChangedSymbol[];
  unindexedChanges: string[];
  unindexedDetails?: UnindexedChangeDetail[];
  impact: Pick<ImpactResult, 'byDepth' | 'tests' | 'completeness' | 'reach' | 'factors'>;
  verdict: Verdict;
  freshness: ImpactResult['freshness'];
  engine: EngineStamp;
  limits: ImpactLimits;
  scannedFiles?: number;
  indexState?: 'fresh' | 'updated' | 'stale';
  updatedFiles?: number;
  nothingChanged?: boolean;
  plan?: ChangesPlanSummary;
  timings?: ChangesTimings;
}

export type SearchMatchKind = 'exact' | 'lexical';

export interface SearchHit {
  kind: SearchMatchKind;
  /** "<repo-relative path>#<qualified name>" (ADR 0002). */
  symbol: string;
  declarationKind: string;
  span: Span;
  signature: string;
  exported: boolean;
  callers: number;
  route: boolean;
  score: number;
}

export interface SearchResult {
  query: string;
  limit: number;
  totalMatches: number;
  hits: SearchHit[];
  indexState: 'fresh' | 'updated' | 'stale';
  updatedFiles?: number;
  scannedFiles?: number;
  staleReason?: string;
  engine: EngineStamp;
}
