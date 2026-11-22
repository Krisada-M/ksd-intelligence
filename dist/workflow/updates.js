import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile, } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { discoverAgySkills } from '../adapters/agy/skills.js';
import { discoverOmpSkills } from '../adapters/omp/skills.js';
import { PROVIDERS, catalog, skillIdsOf } from './catalog.js';
import { MAX_SKILL_BYTES, readSkill, sha256Hex } from './loader.js';
import { defaultSkillsDir, parseSkillFrontmatter } from './packs.js';
import { defaultRegistryPath, parseRegistry, readRegistry, validateRegistryConsistency, } from './registry.js';
import { defaultLockPath, parseLock, readLock, } from './sources.js';
import { PROVIDER_IDS, WorkflowError } from './types.js';
const execFileAsync = promisify(execFile);
const COMMIT = /^[0-9a-f]{40}$/;
const SCRIPT_EXT = /\.(?:sh|bash|zsh|ps1|bat|cmd|py|rb|pl|js|mjs|cjs|ts)$/i;
export function defaultUpdateStateDir(env = process.env) {
    const base = env.XDG_CACHE_HOME ?? join(env.SNAP_REAL_HOME ?? env.HOME ?? homedir(), '.cache');
    return resolve(base, 'ksd-intelligence', 'skill-updates');
}
async function gitHead(root) {
    try {
        const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD']);
        const head = stdout.trim();
        return COMMIT.test(head) ? head : null;
    }
    catch {
        return null;
    }
}
async function atomicWriteFile(targetPath, content) {
    await mkdir(dirname(targetPath), { recursive: true });
    const tmp = `${targetPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, content, 'utf8');
    try {
        await rename(tmp, targetPath);
    }
    catch (error) {
        await unlink(tmp).catch(() => { });
        throw error;
    }
}
async function atomicActivatePair(lockPath, lock, registryPath, registry, previousLockText) {
    const nextLockText = `${JSON.stringify(lock, null, 2)}\n`;
    const nextRegistryText = `${JSON.stringify(registry, null, 2)}\n`;
    await atomicWriteFile(lockPath, nextLockText);
    try {
        await atomicWriteFile(registryPath, nextRegistryText);
    }
    catch (error) {
        // Roll back the first file if the second atomic rename fails.
        await atomicWriteFile(lockPath, previousLockText).catch(() => { });
        throw error;
    }
}
function isContained(base, target) {
    const rel = relative(base, target);
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
// Inventories immediate `<subpath>/<name>/SKILL.md` files and detects any scripts/hooks inside them
// purely by reading directory metadata (never executes anything).
async function scanUpstreamSubpath(root, rootSubpath) {
    const skills = new Map();
    const scripts = [];
    const base = await realpath(root);
    const subpathDir = resolve(base, rootSubpath);
    let realSubpath;
    try {
        realSubpath = await realpath(subpathDir);
        if (!isContained(base, realSubpath))
            return { skills, scripts };
        if (!(await stat(realSubpath)).isDirectory())
            return { skills, scripts };
    }
    catch {
        return { skills, scripts };
    }
    const entries = (await readdir(realSubpath, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const skillDir = join(realSubpath, entry.name);
        const skillFile = join(skillDir, 'SKILL.md');
        try {
            const realSkill = await realpath(skillFile);
            if (isContained(base, realSkill)) {
                const info = await stat(realSkill);
                if (info.isFile() && info.size <= MAX_SKILL_BYTES) {
                    const bytes = await readFile(realSkill);
                    skills.set(`${entry.name}/SKILL.md`, sha256Hex(bytes));
                }
            }
        }
        catch {
            // Not a skill directory.
        }
        // Detect executable/hook files without running them.
        for (const subdir of ['scripts', 'hooks']) {
            const nested = join(skillDir, subdir);
            try {
                const nestedEntries = await readdir(nested, { withFileTypes: true });
                for (const item of nestedEntries) {
                    if (item.isFile())
                        scripts.push(`${entry.name}/${subdir}/${item.name}`);
                }
            }
            catch {
                // No scripts/hooks directory.
            }
        }
        try {
            const topEntries = await readdir(skillDir, { withFileTypes: true });
            for (const item of topEntries) {
                if (item.isFile() && SCRIPT_EXT.test(item.name)) {
                    scripts.push(`${entry.name}/${item.name}`);
                }
            }
        }
        catch {
            // Ignore unreadable dir.
        }
    }
    return { skills, scripts: [...new Set(scripts)].sort() };
}
function knownReferencePathsForProvider(registry, provider) {
    const paths = new Set();
    for (const id of skillIdsOf(provider)) {
        const entry = catalog[id];
        if (entry)
            paths.add(entry.path);
    }
    for (const pack of Object.values(registry.packs)) {
        if (pack.provider !== provider)
            continue;
        for (const sourcePath of pack.upstream.sourcePaths)
            paths.add(sourcePath);
    }
    return paths;
}
// Step 1 & 2 of update lifecycle: Check upstream checkouts + diff added/removed/renamed/changed
// skills + detect breaking compatibility changes without mutating any live files.
export async function checkUpstreamUpdates(options) {
    const lock = options.lock ?? (await readLock(options.lockPath ?? defaultLockPath()));
    const registry = options.registry ?? (await readRegistry(options.registryPath ?? defaultRegistryPath()));
    const nextLockProviders = {
        matt: { ...lock.providers.matt, skills: { ...lock.providers.matt.skills } },
        poteto: { ...lock.providers.poteto, skills: { ...lock.providers.poteto.skills } },
        osmani: { ...lock.providers.osmani, skills: { ...lock.providers.osmani.skills } },
    };
    const nextRegistryProviders = {
        matt: { ...registry.providers.matt },
        poteto: { ...registry.providers.poteto },
        osmani: { ...registry.providers.osmani },
    };
    const providers = [];
    const allFindings = [];
    let hasUpdates = false;
    for (const provider of PROVIDER_IDS) {
        const info = PROVIDERS[provider];
        const root = options.roots[provider] ?? null;
        const lockProv = lock.providers[provider];
        const findings = [];
        const changed = [];
        const removed = [];
        const added = [];
        const renamed = [];
        let unchangedCount = 0;
        if (!root || !isAbsolute(root)) {
            findings.push({
                code: 'PROVIDER_UNAVAILABLE',
                severity: 'blocking',
                provider,
                message: `${info.envVar} is unset or not an absolute path`,
            });
            providers.push({
                provider,
                root,
                previousCommit: lockProv.commit,
                nextCommit: null,
                commitChanged: false,
                added,
                removed,
                renamed,
                changed,
                unchangedCount,
                upstreamScripts: [],
                findings,
            });
            allFindings.push(...findings);
            continue;
        }
        const head = await gitHead(root);
        if (head === null) {
            findings.push({
                code: 'PROVIDER_UNAVAILABLE',
                severity: 'blocking',
                provider,
                message: `${info.envVar}=${root} has no readable git HEAD`,
            });
        }
        let inventory = { skills: new Map(), scripts: [] };
        try {
            inventory = await scanUpstreamSubpath(root, info.rootSubpath);
        }
        catch {
            findings.push({
                code: 'PROVIDER_UNAVAILABLE',
                severity: 'blocking',
                provider,
                message: `${info.envVar}=${root} does not exist or cannot be scanned`,
            });
        }
        const knownPaths = knownReferencePathsForProvider(registry, provider);
        const removedWithPrevHash = [];
        const nextSkills = { ...lockProv.skills };
        for (const id of skillIdsOf(provider)) {
            const entry = catalog[id];
            const prevSha = lockProv.skills[id]?.sha256 ?? null;
            try {
                const loaded = await readSkill(id, options.roots);
                if (prevSha !== loaded.sha256) {
                    changed.push({
                        id,
                        path: entry.path,
                        previousSha256: prevSha,
                        nextSha256: loaded.sha256,
                    });
                    nextSkills[id] = { sha256: loaded.sha256 };
                    hasUpdates = true;
                }
                else {
                    unchangedCount += 1;
                }
            }
            catch (error) {
                if (error instanceof WorkflowError && error.code === 'SKILL_NOT_FOUND') {
                    removed.push(entry.path);
                    removedWithPrevHash.push({ path: entry.path, prevSha });
                    findings.push({
                        code: 'BREAKING_DEPENDENCY_REMOVED',
                        severity: 'blocking',
                        provider,
                        skill: id,
                        message: `pinned allowlisted skill ${id} (${entry.path}) was removed upstream`,
                    });
                }
                else {
                    const detail = error instanceof Error ? error.message : String(error);
                    findings.push({
                        code: 'INVALID_UPSTREAM_SKILL',
                        severity: 'blocking',
                        provider,
                        skill: id,
                        message: `${id}: ${detail}`,
                    });
                }
            }
        }
        // Check non-pinned referenced upstream source paths (including poteto-mode).
        for (const refPath of knownPaths) {
            const isPinned = skillIdsOf(provider).some((id) => catalog[id].path === refPath);
            if (isPinned)
                continue;
            if (!inventory.skills.has(refPath)) {
                if (!removed.includes(refPath))
                    removed.push(refPath);
                findings.push({
                    code: 'UPSTREAM_REFERENCE_REMOVED',
                    severity: 'warning',
                    provider,
                    skill: refPath,
                    message: `referenced upstream playbook ${provider}:${refPath} was not found`,
                });
            }
        }
        // Verify upstream poteto-mode still preserves opt-in guard if present.
        if (provider === 'poteto' && inventory.skills.has('poteto-mode/SKILL.md')) {
            try {
                const potetoPath = resolve(root, info.rootSubpath, 'poteto-mode/SKILL.md');
                const text = await readFile(potetoPath, 'utf8');
                const fm = parseSkillFrontmatter(text);
                if (!fm?.disableModelInvocation) {
                    findings.push({
                        code: 'AUTO_OPT_IN_VIOLATION',
                        severity: 'blocking',
                        provider,
                        skill: 'poteto-mode',
                        message: `upstream poteto-mode/SKILL.md dropped disable-model-invocation: true`,
                    });
                }
            }
            catch {
                // Already handled if missing.
            }
        }
        // Detect newly added skills & hash-matched renames.
        for (const [relPath, sha] of inventory.skills) {
            if (knownPaths.has(relPath))
                continue;
            const renamedFrom = removedWithPrevHash.find((item) => item.prevSha === sha);
            if (renamedFrom) {
                renamed.push({ fromPath: renamedFrom.path, toPath: relPath, sha256: sha });
            }
            else {
                added.push(relPath);
            }
        }
        // Surface upstream scripts/hooks for manual review without executing them.
        for (const scriptPath of inventory.scripts) {
            const relevant = [...knownPaths].some((known) => scriptPath.startsWith(`${known.split('/')[0] ?? ''}/`));
            if (relevant) {
                findings.push({
                    code: 'UPSTREAM_SCRIPT_DETECTED',
                    severity: 'warning',
                    provider,
                    skill: scriptPath,
                    message: `upstream script/hook present (${scriptPath}); review manually, never auto-execute`,
                });
            }
        }
        const commitChanged = head !== null && head !== lockProv.commit;
        if (commitChanged)
            hasUpdates = true;
        const providerBlocked = findings.some((f) => f.severity === 'blocking');
        if (!providerBlocked && head !== null) {
            nextLockProviders[provider] = { ...lockProv, commit: head, skills: nextSkills };
            nextRegistryProviders[provider] = { ...registry.providers[provider], commit: head };
        }
        providers.push({
            provider,
            root,
            previousCommit: lockProv.commit,
            nextCommit: head,
            commitChanged,
            added: added.sort(),
            removed: removed.sort(),
            renamed,
            changed,
            unchangedCount,
            upstreamScripts: inventory.scripts,
            findings,
        });
        allFindings.push(...findings);
    }
    return {
        checkedAt: new Date().toISOString(),
        hasUpdates,
        providers,
        findings: allFindings,
        blockingFindings: allFindings.filter((f) => f.severity === 'blocking'),
        nextLock: { version: 1, providers: nextLockProviders },
        nextRegistry: {
            ...registry,
            providers: nextRegistryProviders,
        },
    };
}
// Step 3 & 4: Validate dependencies + test AGY and OMP discovery + write a staged update bundle.
export async function stageSkillUpdate(options) {
    const lockPath = options.lockPath ?? defaultLockPath();
    const registryPath = options.registryPath ?? defaultRegistryPath();
    const skillsDir = options.skillsDir ?? defaultSkillsDir();
    const stateDir = options.stateDir ?? defaultUpdateStateDir();
    const previousLock = await readLock(lockPath);
    const previousRegistry = await readRegistry(registryPath);
    const check = await checkUpstreamUpdates({
        roots: options.roots,
        lock: previousLock,
        registry: previousRegistry,
    });
    const registryIssues = await validateRegistryConsistency(check.nextRegistry, check.nextLock, {
        skillsDir,
    });
    for (const issue of registryIssues) {
        check.findings.push({
            code: 'REGISTRY_VALIDATION_FAILED',
            severity: 'blocking',
            skill: issue.subject,
            message: `${issue.code}: ${issue.message}`,
        });
    }
    const [agyResult, ompResult] = await Promise.all([
        discoverAgySkills({ workspaceRoot: options.workspaceRoot, skillsDir, requireCatalog: true }),
        discoverOmpSkills({ workspaceRoot: options.workspaceRoot, skillsDir, requireCatalog: true }),
    ]);
    const agySummary = {
        platform: 'agy',
        ok: agyResult.issues.length === 0,
        discoveredCount: agyResult.skills.length,
        autoCount: agyResult.autoVisible.length,
        optInCount: agyResult.explicitOnly.length,
        issues: agyResult.issues.map((i) => `${i.code}: ${i.message}`),
    };
    const ompSummary = {
        platform: 'omp',
        ok: ompResult.issues.length === 0,
        discoveredCount: ompResult.skills.length,
        autoCount: ompResult.autoVisible.length,
        optInCount: ompResult.explicitOnly.length,
        issues: ompResult.issues.map((i) => `${i.code}: ${i.message}`),
    };
    for (const rt of [agySummary, ompSummary]) {
        if (!rt.ok) {
            check.findings.push({
                code: 'RUNTIME_DISCOVERY_FAILED',
                severity: 'blocking',
                message: `${rt.platform} discovery failed: ${rt.issues.join('; ')}`,
            });
        }
    }
    const blockingFindings = check.findings.filter((f) => f.severity === 'blocking');
    const ok = blockingFindings.length === 0;
    const stageId = `stage-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const staged = {
        version: 1,
        stageId,
        createdAt: new Date().toISOString(),
        status: ok ? 'staged' : 'blocked',
        approved: false,
        diff: {
            checkedAt: check.checkedAt,
            hasUpdates: check.hasUpdates,
            providers: check.providers,
            findings: check.findings,
            blockingFindings,
        },
        validation: {
            ok,
            registryIssues,
            runtimes: { agy: agySummary, omp: ompSummary },
        },
        previous: { lock: previousLock, registry: previousRegistry },
        next: { lock: check.nextLock, registry: check.nextRegistry },
    };
    const stagePath = join(stateDir, 'staged', `${stageId}.json`);
    await atomicWriteFile(stagePath, `${JSON.stringify(staged, null, 2)}\n`);
    return { stagePath, staged };
}
// Step 5 & 6: Approve and atomically activate a staged update, recording a rollback snapshot first.
export async function publishStagedUpdate(options) {
    if (!options.approve) {
        throw new WorkflowError('INVALID_INPUT', 'publishing a staged skill update requires explicit approval (--approve)');
    }
    const stateDir = options.stateDir ?? defaultUpdateStateDir();
    const lockPath = options.lockPath ?? defaultLockPath();
    const registryPath = options.registryPath ?? defaultRegistryPath();
    const skillsDir = options.skillsDir ?? defaultSkillsDir();
    const stagePath = join(stateDir, 'staged', `${options.stageId}.json`);
    let staged;
    try {
        staged = JSON.parse(await readFile(stagePath, 'utf8'));
    }
    catch (error) {
        throw new WorkflowError('LOCK_INVALID', `cannot read staged update ${options.stageId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (staged.status !== 'staged' || !staged.validation.ok) {
        throw new WorkflowError('LOCK_INVALID', `staged update ${options.stageId} is blocked and cannot be published`);
    }
    // Re-parse and re-validate before activation so tampered stage files cannot slip through.
    const nextLock = parseLock(JSON.stringify(staged.next.lock));
    const nextRegistry = parseRegistry(JSON.stringify(staged.next.registry));
    const regIssues = await validateRegistryConsistency(nextRegistry, nextLock, { skillsDir });
    if (regIssues.length > 0) {
        throw new WorkflowError('LOCK_INVALID', `staged update failed validation: ${regIssues.map((i) => i.message).join('; ')}`);
    }
    const currentLockText = await readFile(lockPath, 'utf8');
    const currentLock = parseLock(currentLockText);
    const currentRegistry = await readRegistry(registryPath);
    if (!options.force &&
        (JSON.stringify(currentLock) !== JSON.stringify(staged.previous.lock) ||
            JSON.stringify(currentRegistry) !== JSON.stringify(staged.previous.registry))) {
        throw new WorkflowError('LOCK_INVALID', 'live lockfile or registry changed since staging; re-stage before publishing');
    }
    const releaseId = `rel-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const snapshot = {
        version: 1,
        releaseId,
        stageId: staged.stageId,
        publishedAt: new Date().toISOString(),
        lockPath,
        registryPath,
        previous: { lock: currentLock, registry: currentRegistry },
        active: { lock: nextLock, registry: nextRegistry },
    };
    const snapshotPath = join(stateDir, 'history', `${releaseId}.json`);
    await atomicWriteFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    await atomicActivatePair(lockPath, nextLock, registryPath, nextRegistry, currentLockText);
    return { snapshotPath, snapshot };
}
// Atomically restores the previous approved skills.lock.json and skills.registry.json from snapshot history.
export async function rollbackSkillUpdate(options) {
    const stateDir = options.stateDir ?? defaultUpdateStateDir();
    const lockPath = options.lockPath ?? defaultLockPath();
    const registryPath = options.registryPath ?? defaultRegistryPath();
    const skillsDir = options.skillsDir ?? defaultSkillsDir();
    const historyDir = join(stateDir, 'history');
    let releaseId = options.releaseId;
    if (!releaseId) {
        let files;
        try {
            files = (await readdir(historyDir))
                .filter((name) => name.endsWith('.json'))
                .sort()
                .reverse();
        }
        catch {
            throw new WorkflowError('LOCK_INVALID', `no release history found in ${historyDir}`);
        }
        const latest = files[0];
        if (!latest)
            throw new WorkflowError('LOCK_INVALID', `no release snapshots in ${historyDir}`);
        releaseId = latest.replace(/\.json$/, '');
    }
    const snapshotPath = join(historyDir, `${releaseId}.json`);
    let snapshot;
    try {
        snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
    }
    catch (error) {
        throw new WorkflowError('LOCK_INVALID', `cannot read release snapshot ${releaseId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const prevLock = parseLock(JSON.stringify(snapshot.previous.lock));
    const prevRegistry = parseRegistry(JSON.stringify(snapshot.previous.registry));
    const issues = await validateRegistryConsistency(prevRegistry, prevLock, { skillsDir });
    if (issues.length > 0) {
        throw new WorkflowError('LOCK_INVALID', `rollback snapshot ${releaseId} failed validation: ${issues.map((i) => i.message).join('; ')}`);
    }
    const currentLockText = await readFile(lockPath, 'utf8');
    await atomicActivatePair(lockPath, prevLock, registryPath, prevRegistry, currentLockText);
    return { restoredFrom: releaseId, lock: prevLock, registry: prevRegistry };
}
