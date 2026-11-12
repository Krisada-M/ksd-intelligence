'use strict';
// B1: file/line census of the visible set (git ls-files -co --exclude-standard) + tsconfig facts.
// usage: node spikes/m1b/b1-census.cjs
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const C = require('./b-common.cjs');
const { ts } = C;

const TS_JS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DTS = /\.d\.(ts|mts|cts)$/;

const t0 = C.now();
const listed = cp.execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: C.OMP_SRC, maxBuffer: 1 << 28 }).toString('utf8').split('\0').filter(Boolean);
const listMs = C.now() - t0;

function countLines(file) {
  let buf;
  try {
    buf = fs.readFileSync(path.join(C.OMP_SRC, file));
  } catch {
    return null;
  }
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  return buf[buf.length - 1] === 10 ? n : n + 1;
}

const byExt = {};
const byPkg = {};
const tsconfigs = [];
let missing = 0;
const visibleTsJsNonDts = new Set();
for (const f of listed) {
  const base = path.basename(f);
  const isCode = TS_JS.test(f);
  const isDts = DTS.test(f);
  if (/^tsconfig.*\.json$/.test(base)) tsconfigs.push(f);
  if (!isCode) continue;
  const lines = countLines(f);
  if (lines === null) {
    missing++;
    continue;
  }
  const ext = isDts ? 'd.' + f.slice(f.lastIndexOf('.') + 1) : f.slice(f.lastIndexOf('.') + 1);
  const e = (byExt[ext] ||= { files: 0, lines: 0 });
  e.files++;
  e.lines += lines;
  const parts = f.split('/');
  const pk = parts[0] === 'packages' ? parts.slice(0, 2).join('/') : parts[0] === 'python' ? parts.slice(0, 3).join('/') : parts.length > 1 ? parts[0] : '(root files)';
  const p = (byPkg[pk] ||= { files: 0, lines: 0, dts: 0 });
  p.files++;
  p.lines += lines;
  if (isDts) p.dts++;
  if (!isDts) visibleTsJsNonDts.add(f);
}

const sum = (pred) => Object.entries(byExt).filter(([k]) => pred(k)).reduce((a, [, v]) => ({ files: a.files + v.files, lines: a.lines + v.lines }), { files: 0, lines: 0 });
const tsjsNonDts = sum((k) => !k.startsWith('d.'));
const dts = sum((k) => k.startsWith('d.'));
const tsOnly = sum((k) => ['ts', 'tsx', 'mts', 'cts'].includes(k));
const jsOnly = sum((k) => ['js', 'jsx', 'mjs', 'cjs'].includes(k));

// tsconfig facts (raw files, comments allowed)
const tsconfigFacts = [];
let referencesUsedIn = [];
let pathsUsedIn = [];
let compositeIn = [];
for (const f of tsconfigs) {
  const abs = path.join(C.OMP_SRC, f);
  const r = ts.readConfigFile(abs, ts.sys.readFile);
  const j = r.config || {};
  const co = j.compilerOptions || {};
  const fact = { file: f, extends: j.extends, references: (j.references || []).map((x) => x.path), composite: !!co.composite, paths: co.paths ? Object.keys(co.paths) : undefined, baseUrl: co.baseUrl, include: j.include, files: j.files, allowJs: co.allowJs };
  tsconfigFacts.push(fact);
  if (fact.references.length) referencesUsedIn.push(f);
  if (co.paths) pathsUsedIn.push(f);
  if (co.composite) compositeIn.push(f);
}

// reachable projects (post-order) and their coverage
const { root, projects } = C.reachableProjects(path.join(C.OMP_SRC, 'tsconfig.json'));
const projInfo = projects.map((p) => ({
  config: path.relative(C.OMP_SRC, p.configPath),
  rootNames: p.parsed.fileNames.length,
  dts: p.parsed.fileNames.filter((f) => DTS.test(f)).length,
  parseMs: C.round1(p.parseMs),
  configErrors: p.parsed.errors.map(C.flattenDiag),
  effective: {
    moduleResolution: ts.ModuleResolutionKind[p.parsed.options.moduleResolution],
    types: p.parsed.options.types,
    typeRoots: (p.parsed.options.typeRoots || []).map((x) => path.relative(C.OMP_SRC, x)),
    paths: p.parsed.options.paths,
    baseUrl: p.parsed.options.baseUrl,
    composite: !!p.parsed.options.composite,
    allowJs: !!p.parsed.options.allowJs,
    jsx: p.parsed.options.jsx,
    noEmit: !!p.parsed.options.noEmit,
  },
}));
const reachableCover = new Set();
for (const p of projects) for (const f of p.parsed.fileNames) reachableCover.add(path.relative(C.OMP_SRC, f));
const uncovered = [...visibleTsJsNonDts].filter((f) => !reachableCover.has(f));
const visibleAll = new Set(listed);
const reachableNotVisible = [...reachableCover].filter((f) => !visibleAll.has(f));
const uncoveredByExt = {};
for (const f of uncovered) {
  const e = f.slice(f.lastIndexOf('.') + 1);
  uncoveredByExt[e] = (uncoveredByExt[e] || 0) + 1;
}
const uncoveredTsOnly = uncovered.filter((f) => /\.(ts|tsx|mts|cts)$/.test(f));
const uncoveredTsDirs = {};
for (const f of uncoveredTsOnly) {
  const parts = f.split('/');
  const k = parts.slice(0, Math.min(3, parts.length - 1)).join('/') || '(root)';
  uncoveredTsDirs[k] = (uncoveredTsDirs[k] || 0) + 1;
}

// packages/*/tsconfig.json alternative layout: union coverage and overlap
const pkgSets = C.packageConfigs().map((c) => C.parseConfig(c));
const pkgUnion = new Set();
let pkgSum = 0;
for (const p of pkgSets) {
  pkgSum += p.parsed.fileNames.length;
  for (const f of p.parsed.fileNames) pkgUnion.add(f);
}

const result = {
  runtime: C.RUNTIME,
  ompSrc: C.OMP_SRC,
  commit: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: C.OMP_SRC }).toString().trim(),
  visibleFiles: listed.length,
  listMs: C.round1(listMs),
  missingOnDisk: missing,
  tsJsNonDts: tsjsNonDts,
  dts,
  tsOnly,
  jsOnly,
  byExt,
  topPackagesByLines: Object.entries(byPkg)
    .sort((a, b) => b[1].lines - a[1].lines)
    .slice(0, 25)
    .map(([k, v]) => ({ dir: k, ...v })),
  tsconfigFiles: tsconfigs.length,
  tsconfigList: tsconfigs,
  tsconfigsWithReferences: referencesUsedIn,
  tsconfigsWithPaths: pathsUsedIn,
  tsconfigsComposite: compositeIn,
  rootConfig: { file: 'tsconfig.json', references: (root.parsed.projectReferences || []).map((r) => path.relative(C.OMP_SRC, r.path)), parsedFileNamesIfTreatedAsProject: root.parsed.fileNames.length, errors: root.parsed.errors.map(C.flattenDiag) },
  reachableProjects: projInfo,
  effectivePathsAnywhere: projInfo.some((p) => p.effective.paths),
  referencesUsed: referencesUsedIn.length > 0,
  coverageByReachable: { rootNamesUnion: reachableCover.size, rootNamesNotInVisibleSet: reachableNotVisible.length, visibleTsJsNonDtsNotCovered: uncovered.length, byExt: uncoveredByExt, tsNotCovered: uncoveredTsOnly.length, tsNotCoveredByDir: uncoveredTsDirs },
  perPackageAlternative: { tsconfigs: pkgSets.length, rootNamesSum: pkgSum, rootNamesUnion: pkgUnion.size, overlapFactor: C.round1(pkgSum / pkgUnion.size), files: pkgSets.map((p) => ({ config: path.relative(C.OMP_SRC, p.configPath), rootNames: p.parsed.fileNames.length, errors: p.parsed.errors.map(C.flattenDiag) })) },
  tsconfigFacts,
};

C.writeOut(`b1-census-${C.RUNTIME}.json`, result);
console.log(
  JSON.stringify(
    {
      visibleFiles: result.visibleFiles,
      listMs: result.listMs,
      tsJsNonDts: tsjsNonDts,
      dts,
      tsOnly,
      jsOnly,
      tsconfigFiles: tsconfigs.length,
      reachable: projInfo.map((p) => `${p.config}:${p.rootNames}`),
      rootParsedFileNames: result.rootConfig.parsedFileNamesIfTreatedAsProject,
      referencesUsedIn,
      pathsUsedIn,
      effectivePathsAnywhere: result.effectivePathsAnywhere,
      coverage: result.coverageByReachable,
      perPackage: { n: pkgSets.length, sum: pkgSum, union: pkgUnion.size },
    },
    null,
    1,
  ),
);
