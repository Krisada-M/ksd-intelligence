import { join } from 'node:path';
import type * as TS from 'typescript';
import type { Ts } from './declarations.js';

/**
 * Options that only shape emit or diagnostics. They never change which declaration a name
 * resolves to, so projects differing only in these share one program.
 */
const RESOLUTION_NEUTRAL = new Set([
  'allowImportingTsExtensions',
  'allowUnreachableCode',
  'allowUnusedLabels',
  'alwaysStrict',
  'checkJs',
  'composite',
  'configFile',
  'configFilePath',
  'declaration',
  'declarationDir',
  'declarationMap',
  'diagnostics',
  'emitBOM',
  'emitDeclarationOnly',
  'erasableSyntaxOnly',
  'extendedDiagnostics',
  'forceConsistentCasingInFileNames',
  'generateCpuProfile',
  'importHelpers',
  'incremental',
  'inlineSourceMap',
  'inlineSources',
  'isolatedDeclarations',
  'isolatedModules',
  'listEmittedFiles',
  'listFiles',
  'mapRoot',
  'newLine',
  'noCheck',
  'noEmit',
  'noEmitHelpers',
  'noEmitOnError',
  'noErrorTruncation',
  'noFallthroughCasesInSwitch',
  'noImplicitOverride',
  'noImplicitReturns',
  'noPropertyAccessFromIndexSignature',
  'noUncheckedSideEffectImports',
  'noUnusedLocals',
  'noUnusedParameters',
  'outDir',
  'outFile',
  'preserveConstEnums',
  'pretty',
  'removeComments',
  'rewriteRelativeImportExtensions',
  'rootDir',
  'skipDefaultLibCheck',
  'skipLibCheck',
  'sourceMap',
  'sourceRoot',
  'stripInternal',
  'traceResolution',
  'tsBuildInfoFile',
  'verbatimModuleSyntax',
]);

export interface ProgramGroup {
  /** Owning tsconfigs whose files this program analyses, repo-relative. */
  configs: string[];
  options: TS.CompilerOptions;
  /** Absolute paths of the indexable files the group owns. */
  rootNames: string[];
}

export interface GroupingResult {
  groups: ProgramGroup[];
  /** Configs whose options could not be read; their files are analysed with no group. */
  errors: string[];
}

function relevantOptions(options: TS.CompilerOptions): Record<string, unknown> {
  const relevant: Record<string, unknown> = {};
  for (const key of Object.keys(options).sort()) {
    if (!RESOLUTION_NEUTRAL.has(key)) relevant[key] = options[key];
  }
  return relevant;
}

function fingerprint(options: TS.CompilerOptions): string {
  return JSON.stringify(relevantOptions(options));
}

/** The resolution-relevant options whose values differ between groups: why there are several. */
export function splitBy(groups: readonly ProgramGroup[]): string[] {
  const values = new Map<string, Set<string>>();
  const all = groups.map((group) => relevantOptions(group.options));
  for (const options of all) {
    for (const key of Object.keys(options)) values.set(key, new Set());
  }
  for (const [key, seen] of values) {
    for (const options of all) seen.add(JSON.stringify(options[key]) ?? 'unset');
  }
  return [...values]
    .filter(([, seen]) => seen.size > 1)
    .map(([key]) => key)
    .sort();
}

/** D43: the compiler options of the analysis program. */
export function analysisOptions(options: TS.CompilerOptions): TS.CompilerOptions {
  const result: TS.CompilerOptions = { ...options };
  result.noEmit = true;
  result.verbatimModuleSyntax = false;
  result.isolatedModules = false;
  return result;
}

/**
 * One program for the whole index scope when every owning tsconfig resolves names the same way;
 * otherwise one program per set of compatible tsconfigs (recorded in the summary).
 */
export function groupPrograms(
  ts: Ts,
  root: string,
  owners: ReadonlyMap<string, readonly string[]>,
): GroupingResult {
  const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined };
  const cache = new Map<string, TS.ExtendedConfigCacheEntry>();
  const byFingerprint = new Map<string, ProgramGroup>();
  const errors: string[] = [];
  for (const config of [...owners.keys()].sort()) {
    const parsed = ts.getParsedCommandLineOfConfigFile(join(root, config), {}, host, cache);
    if (parsed === undefined) {
      errors.push(`${config}: cannot be read or parsed`);
      continue;
    }
    const options = analysisOptions(parsed.options);
    const key = fingerprint(options);
    let group = byFingerprint.get(key);
    if (group === undefined) {
      group = { configs: [], options, rootNames: [] };
      byFingerprint.set(key, group);
    }
    group.configs.push(config);
    for (const file of owners.get(config) ?? []) group.rootNames.push(join(root, file));
  }
  const groups = [...byFingerprint.values()];
  for (const group of groups) group.rootNames.sort();
  return { groups, errors };
}

// Default library files never change for one TypeScript install; programs share them.
const libraryFiles = new Map<string, TS.SourceFile>();

/**
 * A compiler host that returns the previous program's source file for every file it holds, so a
 * new program over the same files parses nothing again and has no checker yet. Library files are
 * shared across programs: a dependency change is a lockfile change, which forces a cold build.
 */
export function createAnalysisHost(
  ts: Ts,
  options: TS.CompilerOptions,
  previous: TS.Program | undefined,
): TS.CompilerHost {
  const host = ts.createCompilerHost(options, true);
  const read = host.getSourceFile.bind(host);
  const libraryDir = host.getDefaultLibLocation?.() ?? '';
  // A program keeps its host, so the host must not keep `previous`: that would keep the old
  // program, and its checker, alive for as long as the new one.
  const caseKey = (fileName: string): string =>
    ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase();
  const reusable = new Map<string, TS.SourceFile>();
  for (const sf of previous?.getSourceFiles() ?? []) reusable.set(caseKey(sf.fileName), sf);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const old = reusable.get(caseKey(fileName));
    if (old !== undefined) return old;
    const isLibrary = libraryDir !== '' && fileName.startsWith(libraryDir);
    const target =
      typeof languageVersion === 'object' ? languageVersion.languageVersion : languageVersion;
    const cacheKey = `${fileName}\u0000${target}`;
    if (isLibrary) {
      const cached = libraryFiles.get(cacheKey);
      if (cached !== undefined) return cached;
    }
    const sf = read(fileName, languageVersion, onError, shouldCreate);
    if (sf !== undefined && isLibrary) libraryFiles.set(cacheKey, sf);
    return sf;
  };
  return host;
}
