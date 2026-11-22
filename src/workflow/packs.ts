import { existsSync } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS } from './catalog.js';
import {
  CATALOG_SKILL_NAMES,
  ORCHESTRATOR_SKILL_ID,
  SKILL_PACK_IDS,
  type ProviderId,
  type SkillId,
  type SkillPackId,
} from './types.js';

export type SkillPlatform = 'agy' | 'omp';
export type SkillActivation = 'auto' | 'opt-in';

export interface UpstreamSkillRef {
  repo: string;
  rootSubpath: string;
  license: string;
  attribution: string;
  skills: readonly string[];
}

export interface SkillPack {
  id: SkillPackId;
  owner: 'matt' | 'pstack' | 'poteto' | 'osmani';
  provider: ProviderId;
  summary: string;
  activation: SkillActivation;
  disableModelInvocation: boolean;
  // Repo-relative path to the bundled platform-agnostic skill definition.
  skillFile: string;
  primaryDomains: readonly string[];
  allowlistedLeafSkills: readonly SkillId[];
  upstream: UpstreamSkillRef;
}

export const SKILL_PACKS: Readonly<Record<SkillPackId, SkillPack>> = {
  'matt-sdlc': {
    id: 'matt-sdlc',
    owner: 'matt',
    provider: 'matt',
    summary:
      'Requirements, specifications, TDD, implementation, debugging, and REQ compliance audit',
    activation: 'auto',
    disableModelInvocation: false,
    skillFile: 'skills/matt-sdlc/SKILL.md',
    primaryDomains: [
      'requirements',
      'specs',
      'domain-modeling',
      'tdd',
      'implementation',
      'debugging',
      'req-audit',
    ],
    allowlistedLeafSkills: [
      'matt:diagnosing-bugs',
      'matt:codebase-design',
      'matt:tdd',
      'matt:code-review',
    ],
    upstream: {
      repo: PROVIDERS.matt.repo,
      rootSubpath: PROVIDERS.matt.rootSubpath,
      license: 'MIT',
      attribution: 'Matt Pocock',
      skills: [
        'grill-with-docs',
        'to-spec',
        'domain-modeling',
        'implement',
        'implement-spec',
        'tdd',
        'diagnosing-bugs',
        'code-review',
        'codebase-design',
      ],
    },
  },
  'pstack-analysis': {
    id: 'pstack-analysis',
    owner: 'pstack',
    provider: 'poteto',
    summary: 'Architecture analysis, code investigation, root cause analysis, and blast radius',
    activation: 'auto',
    disableModelInvocation: false,
    skillFile: 'skills/pstack-analysis/SKILL.md',
    primaryDomains: [
      'architecture',
      'investigation',
      'root-cause',
      'blast-radius',
      'alternatives',
      'design-rationale',
    ],
    allowlistedLeafSkills: ['poteto:how', 'poteto:why', 'poteto:blast-radius'],
    upstream: {
      repo: PROVIDERS.poteto.repo,
      rootSubpath: PROVIDERS.poteto.rootSubpath,
      license: 'MIT',
      attribution: 'Lauren Tan (poteto / pstack)',
      skills: [
        'how',
        'why',
        'architect',
        'arena',
        'blast-radius',
        'figure-it-out',
        'interrogate',
        'show-me-your-work',
      ],
    },
  },
  'poteto-mode': {
    id: 'poteto-mode',
    owner: 'poteto',
    provider: 'poteto',
    summary: 'Explicit opt-in deep engineering mode for complex multi-phase workflows',
    activation: 'opt-in',
    disableModelInvocation: true,
    skillFile: 'skills/poteto-mode/SKILL.md',
    primaryDomains: ['deep-engineering', 'multi-phase-execution'],
    // Never auto-routed into pinned leaf skills; activated only by explicit opt-in.
    allowlistedLeafSkills: [],
    upstream: {
      repo: PROVIDERS.poteto.repo,
      rootSubpath: PROVIDERS.poteto.rootSubpath,
      license: 'MIT',
      attribution: 'Lauren Tan (poteto / pstack)',
      skills: ['poteto-mode'],
    },
  },
  'osmani-quality': {
    id: 'osmani-quality',
    owner: 'osmani',
    provider: 'osmani',
    summary:
      'UI verification, security hardening, performance, quality gates, and release readiness',
    activation: 'auto',
    disableModelInvocation: false,
    skillFile: 'skills/osmani-quality/SKILL.md',
    primaryDomains: [
      'ui-verification',
      'accessibility',
      'api-contracts',
      'security',
      'performance',
      'observability',
      'quality-gates',
      'release',
    ],
    allowlistedLeafSkills: [
      'osmani:spec-driven-development',
      'osmani:incremental-implementation',
      'osmani:code-review-and-quality',
      'osmani:security-and-hardening',
      'osmani:performance-optimization',
      'osmani:frontend-ui-engineering',
      'osmani:browser-testing-with-devtools',
      'osmani:shipping-and-launch',
    ],
    upstream: {
      repo: PROVIDERS.osmani.repo,
      rootSubpath: PROVIDERS.osmani.rootSubpath,
      license: 'MIT',
      attribution: 'Addy Osmani',
      skills: [
        'spec-driven-development',
        'incremental-implementation',
        'code-review-and-quality',
        'frontend-ui-engineering',
        'browser-testing-with-devtools',
        'accessibility-engineering',
        'api-and-interface-design',
        'security-and-hardening',
        'performance-optimization',
        'observability-and-instrumentation',
        'shipping-and-launch',
      ],
    },
  },
};

// Resolves to <repo>/skills from src/workflow, dist/workflow, and dist-test/src/workflow
// without depending on user-home paths or process.cwd().
export function defaultSkillsDir(): string {
  const fallback = fileURLToPath(new URL('../../skills', import.meta.url));
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(dir, 'skills');
    if (existsSync(join(dir, 'package.json')) && existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fallback;
}

export function packForSkillId(id: SkillId): SkillPackId {
  if (id.startsWith('matt:')) return 'matt-sdlc';
  if (id.startsWith('poteto:')) return 'pstack-analysis';
  return 'osmani-quality';
}

export function listSkillPacks(options: { includeOptIn?: boolean } = {}): SkillPack[] {
  const includeOptIn = options.includeOptIn ?? true;
  return SKILL_PACK_IDS.map((id) => SKILL_PACKS[id]).filter(
    (pack) => includeOptIn || pack.activation === 'auto',
  );
}

export interface ParsedFrontmatter {
  name?: string;
  description?: string;
  disableModelInvocation: boolean;
  hide: boolean;
  raw: Record<string, string>;
}

const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseSkillFrontmatter(text: string): ParsedFrontmatter | null {
  const match = FRONTMATTER_BLOCK.exec(text);
  if (!match) return null;
  const block = match[1] ?? '';
  const raw: Record<string, string> = {};
  const lines = block.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1] ?? '';
    let value = (kv[2] ?? '').trim();
    if (value === '' || value === '>' || value === '>-' || value === '|' || value === '|-') {
      const parts: string[] = [];
      let j = i;
      while (j + 1 < lines.length && /^[ \t]+/.test(lines[j + 1] ?? '')) {
        const nextLine = (lines[j + 1] ?? '').trim();
        // Do not consume nested YAML mapping keys (e.g. `metadata:\n  author: ...`) as scalar text.
        if (value === '' && /^[A-Za-z0-9_-]+\s*:/.test(nextLine)) break;
        j += 1;
        parts.push(nextLine);
      }
      if (parts.length > 0) {
        i = j;
        value = parts.join(' ');
      } else if (value !== '') {
        value = '';
      }
    } else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    raw[key] = value;
  }

  const disableRaw = raw['disable-model-invocation'] ?? raw['disableModelInvocation'];
  const hideRaw = raw['hide'];
  return {
    name: raw['name'] || undefined,
    description: raw['description'] || undefined,
    disableModelInvocation: disableRaw === 'true',
    hide: hideRaw === 'true',
    raw,
  };
}

export type SkillAuditCode =
  | 'ROOT_NOT_FOUND'
  | 'PATH_ESCAPE'
  | 'INVALID_SKILL'
  | 'MISSING_CATALOG_SKILL'
  | 'DUPLICATE_SKILL'
  | 'USER_HOME_PATH'
  | 'AUTO_OPT_IN_VIOLATION'
  | 'INCOMPATIBLE_TOOL_CALL'
  | 'RECURSIVE_ORCHESTRATION';

export interface SkillAuditIssue {
  code: SkillAuditCode;
  skill?: string;
  file?: string;
  message: string;
}

export interface DiscoveredSkill {
  name: string;
  description: string;
  file: string;
  dir: string;
  sourceLabel: string;
  disableModelInvocation: boolean;
  hide: boolean;
  explicitOnly: boolean;
  inCatalog: boolean;
}

export interface SkillDiscoveryRoot {
  path: string;
  label: string;
  optional?: boolean;
  exclude?: readonly string[];
  includeOnly?: readonly string[];
  // User-managed skill dirs (e.g. ~/.omp/agent/skills -> ~/.agents/skills) may contain
  // legitimate symlinks outside the root and third-party skills we must preserve untouched.
  allowExternalSymlinks?: boolean;
  auditContent?: boolean;
}

export interface SkillDiscoveryResult {
  platform: SkillPlatform;
  skills: DiscoveredSkill[];
  autoVisible: DiscoveredSkill[];
  explicitOnly: DiscoveredSkill[];
  shadowed: Array<{ name: string; keptFrom: string; shadowedFrom: string }>;
  issues: SkillAuditIssue[];
}

const MAX_PACK_SKILL_BYTES = 64 * 1024;
const USER_HOME_PATH_RE =
  /(?:\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[^\s"'`]+)/;

const INCOMPATIBLE_DIRECTIVES: ReadonlyArray<readonly [RegExp, string]> = [
  [/subagent_type\s*:\s*["']poteto-agent["']/i, 'Cursor-only subagent_type "poteto-agent"'],
  [
    /\bclaude-opus-5-5-|\bclaude-fable-5-2-|\bgemini-4-carbon-high\b/i,
    'hardcoded Cursor model slug',
  ],
  [/\benvironment\s*:\s*["']cloud["']/i, 'Cursor-only cloud Task parameter'],
  [/\brun_in_background\s*:\s*true\b/i, 'Cursor-only Task parameter run_in_background'],
  [/\bAskQuestion\b/, 'Cursor-only AskQuestion tool reference'],
];

const RECURSIVE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /^(?!.*(?:do\s+\*{0,2}not\*{0,2}|don't|never|forbid|must\s+\*{0,2}not\*{0,2})).*\b(?:enable|auto-start|automatically start|invoke)\b.*\b(?:ask-matt|using-agent-skills|poteto-mode|swarm)\b/i,
    'attempts to auto-enable a competing or recursive orchestrator',
  ],
  [
    /^(?!.*(?:do\s+\*{0,2}not\*{0,2}|don't|never|forbid|must\s+\*{0,2}not\*{0,2})).*\bcall\s+ei_workflow\b.*\brecursiv/i,
    'recursive ei_workflow orchestration directive',
  ],
];

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function matchesAny(value: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return new RegExp(`^(?:${pattern})$`).test(value);
    } catch {
      return value === pattern;
    }
  });
}

export function auditSkillContent(
  name: string,
  file: string,
  text: string,
  frontmatter: ParsedFrontmatter,
): SkillAuditIssue[] {
  const issues: SkillAuditIssue[] = [];

  if (USER_HOME_PATH_RE.test(text)) {
    issues.push({
      code: 'USER_HOME_PATH',
      skill: name,
      file,
      message: `${name}: contains a hardcoded user-home path`,
    });
  }

  if (name === 'poteto-mode' && !frontmatter.disableModelInvocation) {
    issues.push({
      code: 'AUTO_OPT_IN_VIOLATION',
      skill: name,
      file,
      message: `${name}: must declare disable-model-invocation: true to remain explicit opt-in`,
    });
  }

  for (const [pattern, detail] of INCOMPATIBLE_DIRECTIVES) {
    if (pattern.test(text)) {
      issues.push({
        code: 'INCOMPATIBLE_TOOL_CALL',
        skill: name,
        file,
        message: `${name}: contains incompatible directive (${detail})`,
      });
    }
  }

  for (const line of text.split(/\r?\n/)) {
    for (const [pattern, detail] of RECURSIVE_PATTERNS) {
      if (pattern.test(line)) {
        issues.push({
          code: 'RECURSIVE_ORCHESTRATION',
          skill: name,
          file,
          message: `${name}: ${detail}`,
        });
      }
    }
  }

  return issues;
}

async function scanSingleRoot(
  root: SkillDiscoveryRoot,
): Promise<{ found: DiscoveredSkill[]; issues: SkillAuditIssue[] }> {
  const found: DiscoveredSkill[] = [];
  const issues: SkillAuditIssue[] = [];

  let realRoot: string;
  try {
    realRoot = await realpath(root.path);
    const info = await stat(realRoot);
    if (!info.isDirectory()) {
      issues.push({
        code: 'ROOT_NOT_FOUND',
        file: root.path,
        message: `${root.label}: ${root.path} is not a directory`,
      });
      return { found, issues };
    }
  } catch {
    if (!root.optional) {
      issues.push({
        code: 'ROOT_NOT_FOUND',
        file: root.path,
        message: `${root.label}: directory ${root.path} does not exist`,
      });
    }
    return { found, issues };
  }

  const entries = (await readdir(realRoot, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const seenInRoot = new Set<string>();

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (
      root.includeOnly &&
      root.includeOnly.length > 0 &&
      !matchesAny(entry.name, root.includeOnly)
    ) {
      continue;
    }
    if (root.exclude && root.exclude.length > 0 && matchesAny(entry.name, root.exclude)) {
      continue;
    }

    const candidate = resolve(realRoot, entry.name, 'SKILL.md');
    let realFile: string;
    try {
      realFile = await realpath(candidate);
    } catch {
      continue;
    }

    if (!root.allowExternalSymlinks && !isContained(realRoot, realFile)) {
      issues.push({
        code: 'PATH_ESCAPE',
        skill: entry.name,
        file: candidate,
        message: `${entry.name}: resolves to ${realFile}, outside root ${realRoot}`,
      });
      continue;
    }

    const fileInfo = await stat(realFile);
    if (!fileInfo.isFile() || fileInfo.size > MAX_PACK_SKILL_BYTES) {
      issues.push({
        code: 'INVALID_SKILL',
        skill: entry.name,
        file: realFile,
        message: `${entry.name}: SKILL.md is not a regular file within ${MAX_PACK_SKILL_BYTES} bytes`,
      });
      continue;
    }

    const text = await readFile(realFile, 'utf8');
    const frontmatter = parseSkillFrontmatter(text);
    if (!frontmatter || !frontmatter.name || !frontmatter.description) {
      issues.push({
        code: 'INVALID_SKILL',
        skill: entry.name,
        file: realFile,
        message: `${entry.name}: SKILL.md missing valid frontmatter with name and description`,
      });
      continue;
    }

    if (seenInRoot.has(frontmatter.name)) {
      issues.push({
        code: 'DUPLICATE_SKILL',
        skill: frontmatter.name,
        file: realFile,
        message: `${frontmatter.name}: duplicate skill name inside ${root.label}`,
      });
      continue;
    }
    seenInRoot.add(frontmatter.name);

    if (root.auditContent !== false) {
      issues.push(...auditSkillContent(frontmatter.name, realFile, text, frontmatter));
    }

    const explicitOnly = frontmatter.disableModelInvocation || frontmatter.hide;
    found.push({
      name: frontmatter.name,
      description: frontmatter.description,
      file: realFile,
      dir: dirname(realFile),
      sourceLabel: root.label,
      disableModelInvocation: frontmatter.disableModelInvocation,
      hide: frontmatter.hide,
      explicitOnly,
      inCatalog: (CATALOG_SKILL_NAMES as readonly string[]).includes(frontmatter.name),
    });
  }

  return { found, issues };
}

// Discovers skills across ordered roots (highest priority first).
// Earlier roots win on name collisions, preserving user customizations without overwriting them.
export async function discoverSkillsForPlatform(options: {
  platform: SkillPlatform;
  roots: readonly SkillDiscoveryRoot[];
  requireCatalog?: boolean;
}): Promise<SkillDiscoveryResult> {
  const byName = new Map<string, DiscoveredSkill>();
  const shadowed: Array<{ name: string; keptFrom: string; shadowedFrom: string }> = [];
  const issues: SkillAuditIssue[] = [];

  const seenIssues = new Set<string>();
  for (const root of options.roots) {
    const { found, issues: rootIssues } = await scanSingleRoot(root);
    for (const issue of rootIssues) {
      const key = `${issue.code}|${issue.file ?? ''}|${issue.message}`;
      if (seenIssues.has(key)) continue;
      seenIssues.add(key);
      issues.push(issue);
    }
    for (const skill of found) {
      const existing = byName.get(skill.name);
      if (existing) {
        shadowed.push({
          name: skill.name,
          keptFrom: existing.sourceLabel,
          shadowedFrom: skill.sourceLabel,
        });
        continue;
      }
      byName.set(skill.name, skill);
    }
  }

  if (options.requireCatalog) {
    for (const requiredName of CATALOG_SKILL_NAMES) {
      if (!byName.has(requiredName)) {
        issues.push({
          code: 'MISSING_CATALOG_SKILL',
          skill: requiredName,
          message: `required KSD catalog skill ${requiredName} was not discovered`,
        });
      }
    }
  }

  const skills = [...byName.values()];
  const autoVisible = skills.filter((skill) => !skill.explicitOnly);
  const explicitOnly = skills.filter((skill) => skill.explicitOnly);

  return {
    platform: options.platform,
    skills,
    autoVisible,
    explicitOnly,
    shadowed,
    issues,
  };
}

export function packSkillPath(packId: SkillPackId, skillsDir: string = defaultSkillsDir()): string {
  return join(skillsDir, packId, 'SKILL.md');
}

export function orchestratorSkillPath(skillsDir: string = defaultSkillsDir()): string {
  return join(skillsDir, ORCHESTRATOR_SKILL_ID, 'SKILL.md');
}
