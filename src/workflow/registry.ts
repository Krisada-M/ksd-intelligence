import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, lookupSkill } from './catalog.js';
import {
  SKILL_PACKS,
  defaultSkillsDir,
  parseSkillFrontmatter,
  type SkillActivation,
  type SkillPlatform,
} from './packs.js';
import type { SkillsLock } from './sources.js';
import {
  ORCHESTRATOR_SKILL_ID,
  PROVIDER_IDS,
  SKILL_PACK_IDS,
  WorkflowError,
  isOneOf,
  type OrchestratorSkillId,
  type ProviderId,
  type SkillId,
  type SkillPackId,
} from './types.js';

export interface RegistryProvider {
  repo: string;
  commit: string | null;
  rootSubpath: string;
  license: string;
  attribution: string;
  adaptationBoundary: 'upstream-read-only';
}

export interface RegistryPackDependencies {
  providers: ProviderId[];
  leafSkills: SkillId[];
  packs: SkillPackId[];
}

export interface RegistryPackAdaptation {
  wrapperPath: string;
  localPolicyOwner: OrchestratorSkillId;
  runtimeNotes: Record<SkillPlatform, string>;
}

export interface RegistryPack {
  id: SkillPackId;
  owner: 'matt' | 'pstack' | 'poteto' | 'osmani';
  provider: ProviderId;
  activation: SkillActivation;
  disableModelInvocation: boolean;
  supportedRuntimes: SkillPlatform[];
  dependencies: RegistryPackDependencies;
  upstream: {
    repo: string;
    rootSubpath: string;
    sourcePaths: string[];
  };
  ksdAdaptation: RegistryPackAdaptation;
}

export interface SkillRegistry {
  version: 1;
  orchestrator: OrchestratorSkillId;
  lockfile: 'skills.lock.json';
  providers: Record<ProviderId, RegistryProvider>;
  packs: Record<SkillPackId, RegistryPack>;
}

export type RegistryValidationCode =
  | 'REGISTRY_LOCK_DRIFT'
  | 'MISSING_DEPENDENCY'
  | 'CYCLIC_DEPENDENCY'
  | 'RUNTIME_UNSUPPORTED'
  | 'MISSING_WRAPPER'
  | 'POLICY_BOUNDARY_VIOLATION'
  | 'OPT_IN_VIOLATION';

export interface RegistryValidationIssue {
  code: RegistryValidationCode;
  subject: string;
  message: string;
}

const COMMIT = /^[0-9a-f]{40}$/;
const RUNTIMES: readonly SkillPlatform[] = ['agy', 'omp'];
const ACTIVATIONS: readonly SkillActivation[] = ['auto', 'opt-in'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function registryError(message: string): WorkflowError {
  return new WorkflowError('LOCK_INVALID', `registry: ${message}`);
}

export function defaultRegistryPath(): string {
  const fallback = fileURLToPath(new URL('../../skills.registry.json', import.meta.url));
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(dir, 'skills.registry.json');
    if (existsSync(join(dir, 'package.json')) && existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fallback;
}

function parseProvider(provider: ProviderId, raw: unknown): RegistryProvider {
  const where = `providers.${provider}`;
  if (!isRecord(raw)) throw registryError(`${where} must be an object`);
  const info = PROVIDERS[provider];
  if (raw.repo !== info.repo) {
    throw registryError(`${where}.repo is ${JSON.stringify(raw.repo)}, expected ${info.repo}`);
  }
  if (raw.rootSubpath !== info.rootSubpath) {
    throw registryError(
      `${where}.rootSubpath is ${JSON.stringify(raw.rootSubpath)}, expected ${info.rootSubpath}`,
    );
  }
  const commit = raw.commit;
  if (commit !== null && !(typeof commit === 'string' && COMMIT.test(commit))) {
    throw registryError(`${where}.commit must be null or a 40-char lowercase hex SHA`);
  }
  if (typeof raw.license !== 'string' || !raw.license.trim()) {
    throw registryError(`${where}.license must be a non-empty string`);
  }
  if (typeof raw.attribution !== 'string' || !raw.attribution.trim()) {
    throw registryError(`${where}.attribution must be a non-empty string`);
  }
  if (raw.adaptationBoundary !== 'upstream-read-only') {
    throw registryError(`${where}.adaptationBoundary must be "upstream-read-only"`);
  }
  return {
    repo: info.repo,
    commit,
    rootSubpath: info.rootSubpath,
    license: raw.license,
    attribution: raw.attribution,
    adaptationBoundary: 'upstream-read-only',
  };
}

function parseStringArray(where: string, raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string' || !item.trim())) {
    throw registryError(`${where} must be an array of non-empty strings`);
  }
  return [...raw];
}

function parsePack(packId: SkillPackId, raw: unknown): RegistryPack {
  const where = `packs.${packId}`;
  if (!isRecord(raw)) throw registryError(`${where} must be an object`);
  if (raw.id !== packId) throw registryError(`${where}.id must equal ${packId}`);

  const expected = SKILL_PACKS[packId];
  if (raw.owner !== expected.owner) {
    throw registryError(`${where}.owner must be ${expected.owner}`);
  }
  if (!isOneOf(PROVIDER_IDS, raw.provider) || raw.provider !== expected.provider) {
    throw registryError(`${where}.provider must be ${expected.provider}`);
  }
  if (!isOneOf(ACTIVATIONS, raw.activation)) {
    throw registryError(`${where}.activation must be "auto" or "opt-in"`);
  }
  if (typeof raw.disableModelInvocation !== 'boolean') {
    throw registryError(`${where}.disableModelInvocation must be a boolean`);
  }

  const rawRuntimes = parseStringArray(`${where}.supportedRuntimes`, raw.supportedRuntimes);
  const supportedRuntimes: SkillPlatform[] = [];
  for (const rt of rawRuntimes) {
    if (!isOneOf(RUNTIMES, rt)) throw registryError(`${where}.supportedRuntimes has invalid ${rt}`);
    if (!supportedRuntimes.includes(rt)) supportedRuntimes.push(rt);
  }

  if (!isRecord(raw.dependencies)) throw registryError(`${where}.dependencies must be an object`);
  const depProviders = parseStringArray(
    `${where}.dependencies.providers`,
    raw.dependencies.providers,
  ).map((value) => {
    if (!isOneOf(PROVIDER_IDS, value)) {
      throw registryError(`${where}.dependencies.providers has unknown provider ${value}`);
    }
    return value;
  });
  const depLeafSkills = parseStringArray(
    `${where}.dependencies.leafSkills`,
    raw.dependencies.leafSkills,
  ).map((value) => {
    if (!lookupSkill(value)) {
      throw registryError(`${where}.dependencies.leafSkills has non-allowlisted skill ${value}`);
    }
    return value as SkillId;
  });
  const depPacks = parseStringArray(`${where}.dependencies.packs`, raw.dependencies.packs).map(
    (value) => {
      if (!isOneOf(SKILL_PACK_IDS, value)) {
        throw registryError(`${where}.dependencies.packs has unknown pack ${value}`);
      }
      return value;
    },
  );

  if (!isRecord(raw.upstream)) throw registryError(`${where}.upstream must be an object`);
  const info = PROVIDERS[expected.provider];
  if (raw.upstream.repo !== info.repo) {
    throw registryError(`${where}.upstream.repo must equal ${info.repo}`);
  }
  if (raw.upstream.rootSubpath !== info.rootSubpath) {
    throw registryError(`${where}.upstream.rootSubpath must equal ${info.rootSubpath}`);
  }
  const sourcePaths = parseStringArray(`${where}.upstream.sourcePaths`, raw.upstream.sourcePaths);
  for (const sourcePath of sourcePaths) {
    if (isAbsolute(sourcePath) || sourcePath.split(/[\\/]/).includes('..')) {
      throw registryError(`${where}.upstream.sourcePaths has unsafe path ${sourcePath}`);
    }
  }

  if (!isRecord(raw.ksdAdaptation)) throw registryError(`${where}.ksdAdaptation must be an object`);
  if (typeof raw.ksdAdaptation.wrapperPath !== 'string' || !raw.ksdAdaptation.wrapperPath.trim()) {
    throw registryError(`${where}.ksdAdaptation.wrapperPath must be a non-empty string`);
  }
  if (
    isAbsolute(raw.ksdAdaptation.wrapperPath) ||
    raw.ksdAdaptation.wrapperPath.split(/[\\/]/).includes('..')
  ) {
    throw registryError(`${where}.ksdAdaptation.wrapperPath must be repo-relative`);
  }
  if (raw.ksdAdaptation.localPolicyOwner !== ORCHESTRATOR_SKILL_ID) {
    throw registryError(`${where}.ksdAdaptation.localPolicyOwner must be ${ORCHESTRATOR_SKILL_ID}`);
  }
  if (!isRecord(raw.ksdAdaptation.runtimeNotes)) {
    throw registryError(`${where}.ksdAdaptation.runtimeNotes must be an object`);
  }
  const agyNote = raw.ksdAdaptation.runtimeNotes.agy;
  const ompNote = raw.ksdAdaptation.runtimeNotes.omp;
  if (
    typeof agyNote !== 'string' ||
    !agyNote.trim() ||
    typeof ompNote !== 'string' ||
    !ompNote.trim()
  ) {
    throw registryError(`${where}.ksdAdaptation.runtimeNotes must include agy and omp notes`);
  }

  return {
    id: packId,
    owner: expected.owner,
    provider: expected.provider,
    activation: raw.activation,
    disableModelInvocation: raw.disableModelInvocation,
    supportedRuntimes,
    dependencies: {
      providers: depProviders,
      leafSkills: depLeafSkills,
      packs: depPacks,
    },
    upstream: {
      repo: info.repo,
      rootSubpath: info.rootSubpath,
      sourcePaths,
    },
    ksdAdaptation: {
      wrapperPath: raw.ksdAdaptation.wrapperPath,
      localPolicyOwner: ORCHESTRATOR_SKILL_ID,
      runtimeNotes: { agy: agyNote, omp: ompNote },
    },
  };
}

export function parseRegistry(text: string): SkillRegistry {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw registryError(
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(raw) || raw.version !== 1) throw registryError('version must be 1');
  if (raw.orchestrator !== ORCHESTRATOR_SKILL_ID) {
    throw registryError(`orchestrator must be ${ORCHESTRATOR_SKILL_ID}`);
  }
  if (raw.lockfile !== 'skills.lock.json') {
    throw registryError('lockfile must be "skills.lock.json"');
  }
  if (!isRecord(raw.providers)) throw registryError('providers must be an object');
  if (!isRecord(raw.packs)) throw registryError('packs must be an object');

  const extraPacks = Object.keys(raw.packs).filter((id) => !isOneOf(SKILL_PACK_IDS, id));
  if (extraPacks.length > 0) {
    throw registryError(`unknown packs: ${extraPacks.join(', ')}`);
  }

  return {
    version: 1,
    orchestrator: ORCHESTRATOR_SKILL_ID,
    lockfile: 'skills.lock.json',
    providers: {
      matt: parseProvider('matt', raw.providers.matt),
      poteto: parseProvider('poteto', raw.providers.poteto),
      osmani: parseProvider('osmani', raw.providers.osmani),
    },
    packs: {
      'matt-sdlc': parsePack('matt-sdlc', raw.packs['matt-sdlc']),
      'pstack-analysis': parsePack('pstack-analysis', raw.packs['pstack-analysis']),
      'poteto-mode': parsePack('poteto-mode', raw.packs['poteto-mode']),
      'osmani-quality': parsePack('osmani-quality', raw.packs['osmani-quality']),
    },
  };
}

export async function readRegistry(path: string = defaultRegistryPath()): Promise<SkillRegistry> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw registryError(
      `cannot read registry ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseRegistry(text);
}

export async function writeRegistry(path: string, registry: SkillRegistry): Promise<void> {
  await writeFile(path, `${JSON.stringify(registry, null, 2)}\n`);
}

function detectPackCycle(registry: SkillRegistry): SkillPackId[] | null {
  const state = new Map<SkillPackId, 'visiting' | 'done'>();
  const stack: SkillPackId[] = [];

  const visit = (id: SkillPackId): SkillPackId[] | null => {
    const current = state.get(id);
    if (current === 'visiting') {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    if (current === 'done') return null;
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of registry.packs[id].dependencies.packs) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };

  for (const id of SKILL_PACK_IDS) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

export async function validateRegistryConsistency(
  registry: SkillRegistry,
  lock: SkillsLock,
  options: { skillsDir?: string } = {},
): Promise<RegistryValidationIssue[]> {
  const issues: RegistryValidationIssue[] = [];
  const skillsDir = options.skillsDir ?? defaultSkillsDir();
  const repoRoot = dirname(skillsDir);

  for (const provider of PROVIDER_IDS) {
    const regProv = registry.providers[provider];
    const lockProv = lock.providers[provider];
    if (regProv.commit !== lockProv.commit) {
      issues.push({
        code: 'REGISTRY_LOCK_DRIFT',
        subject: `providers.${provider}`,
        message: `registry pins commit ${String(regProv.commit)}, lockfile pins ${String(lockProv.commit)}`,
      });
    }
    if (regProv.repo !== lockProv.repo || regProv.rootSubpath !== lockProv.rootSubpath) {
      issues.push({
        code: 'REGISTRY_LOCK_DRIFT',
        subject: `providers.${provider}`,
        message: `registry repo/rootSubpath disagrees with skills.lock.json`,
      });
    }
  }

  const cycle = detectPackCycle(registry);
  if (cycle) {
    issues.push({
      code: 'CYCLIC_DEPENDENCY',
      subject: cycle.join(' -> '),
      message: `cyclic pack dependency detected: ${cycle.join(' -> ')}`,
    });
  }

  for (const packId of SKILL_PACK_IDS) {
    const pack = registry.packs[packId];

    for (const runtime of RUNTIMES) {
      if (!pack.supportedRuntimes.includes(runtime)) {
        issues.push({
          code: 'RUNTIME_UNSUPPORTED',
          subject: packId,
          message: `${packId} must support both AGY and OMP (missing ${runtime})`,
        });
      }
    }

    if (
      packId === 'poteto-mode' &&
      (pack.activation !== 'opt-in' || !pack.disableModelInvocation)
    ) {
      issues.push({
        code: 'OPT_IN_VIOLATION',
        subject: packId,
        message: `poteto-mode must remain activation="opt-in" and disableModelInvocation=true`,
      });
    }

    // Upstream content must remain separated from local policy files under src/policy/.
    if (pack.ksdAdaptation.wrapperPath.startsWith('src/policy/')) {
      issues.push({
        code: 'POLICY_BOUNDARY_VIOLATION',
        subject: packId,
        message: `${packId} wrapperPath cannot reside inside frozen src/policy/`,
      });
    }

    for (const leafId of pack.dependencies.leafSkills) {
      const entry = lookupSkill(leafId);
      if (!entry || !(leafId in lock.providers[entry.provider].skills)) {
        issues.push({
          code: 'MISSING_DEPENDENCY',
          subject: `${packId}:${leafId}`,
          message: `${packId} depends on leaf skill ${leafId}, which is missing from lockfile`,
        });
      }
    }

    const wrapperAbs = resolve(repoRoot, pack.ksdAdaptation.wrapperPath);
    const relToSkills = relative(skillsDir, wrapperAbs);
    if (relToSkills === '..' || relToSkills.startsWith(`..${sep}`) || isAbsolute(relToSkills)) {
      issues.push({
        code: 'POLICY_BOUNDARY_VIOLATION',
        subject: packId,
        message: `${packId} wrapperPath ${pack.ksdAdaptation.wrapperPath} must live under skills/`,
      });
    } else if (!existsSync(wrapperAbs)) {
      issues.push({
        code: 'MISSING_WRAPPER',
        subject: packId,
        message: `${packId} local KSD wrapper ${pack.ksdAdaptation.wrapperPath} does not exist`,
      });
    } else if (pack.disableModelInvocation) {
      const text = await readFile(wrapperAbs, 'utf8');
      const fm = parseSkillFrontmatter(text);
      if (!fm?.disableModelInvocation) {
        issues.push({
          code: 'OPT_IN_VIOLATION',
          subject: packId,
          message: `${packId} wrapper ${pack.ksdAdaptation.wrapperPath} must declare disable-model-invocation: true`,
        });
      }
    }
  }

  return issues;
}
