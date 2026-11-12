import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { PROVIDERS, lookupSkill } from './catalog.js';
import { routeTask } from './router.js';
import { WorkflowError } from './types.js';
export const MAX_SKILL_BYTES = 64 * 1024;
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
export function sha256Hex(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
function isMissingPath(error) {
    return (error instanceof Error &&
        'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR'));
}
async function realpathOrThrow(path, onMissing) {
    try {
        return await realpath(path);
    }
    catch (error) {
        if (isMissingPath(error))
            throw onMissing();
        throw error;
    }
}
// Reads one allowlisted SKILL.md and enforces every check except the lock-file hash.
// `sources check` reuses this so it measures exactly what the loader would load.
export async function readSkill(id, roots) {
    const entry = lookupSkill(id);
    if (!entry)
        throw new WorkflowError('NOT_ALLOWLISTED', `${id} is not in the skill catalog`);
    const provider = PROVIDERS[entry.provider];
    const root = roots[entry.provider];
    if (!root || !isAbsolute(root)) {
        throw new WorkflowError('PROVIDER_ROOT_MISSING', `${provider.envVar} is unset or not an absolute path (needed for ${id})`);
    }
    const base = await realpathOrThrow(root, () => new WorkflowError('PROVIDER_ROOT_NOT_FOUND', `${provider.envVar}=${root} does not exist (needed for ${id})`));
    const candidate = resolve(base, provider.rootSubpath, entry.path);
    const file = await realpathOrThrow(candidate, () => new WorkflowError('SKILL_NOT_FOUND', `${id}: root exists but ${candidate} does not`));
    const rel = relative(base, file);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new WorkflowError('PATH_ESCAPE', `${id} resolves to ${file}, outside provider root ${base}`);
    }
    const info = await stat(file);
    if (!info.isFile())
        throw new WorkflowError('INVALID_SKILL', `${id}: ${file} is not a regular file`);
    if (info.size > MAX_SKILL_BYTES)
        throw new WorkflowError('INVALID_SKILL', `${id}: ${file} is ${info.size} bytes, over the ${MAX_SKILL_BYTES} byte cap`);
    const bytes = await readFile(file);
    if (bytes.length > MAX_SKILL_BYTES)
        throw new WorkflowError('INVALID_SKILL', `${id}: ${file} grew past the ${MAX_SKILL_BYTES} byte cap while reading`);
    const text = bytes.toString('utf8');
    if (!FRONTMATTER.test(text))
        throw new WorkflowError('INVALID_SKILL', `${id}: ${file} has no frontmatter`);
    return { id, file, baseDir: dirname(file), text, sha256: sha256Hex(bytes) };
}
export async function loadSkill(id, roots, lock) {
    const skill = await readSkill(id, roots);
    const entry = lookupSkill(id);
    const pinned = entry ? (lock?.providers[entry.provider].skills[id]?.sha256 ?? null) : null;
    if (pinned === null)
        return { ...skill, hash: 'unpinned' };
    if (pinned !== skill.sha256) {
        throw new WorkflowError('HASH_MISMATCH', `${id}: ${skill.file} has sha256 ${skill.sha256}, lock pins ${pinned}`);
    }
    return { ...skill, hash: 'verified' };
}
export async function prepareWorkflow(options) {
    const route = routeTask(options);
    const loaded = [];
    const missing = [];
    for (const id of route.skillIds) {
        try {
            loaded.push(await loadSkill(id, options.roots, options.lock));
        }
        catch (error) {
            if (!(error instanceof WorkflowError))
                throw error;
            missing.push({ id, code: error.code, reason: error.message });
        }
    }
    if (options.strict && missing.length > 0) {
        const detail = missing.map((entry) => `${entry.id} (${entry.code})`).join(', ');
        throw new WorkflowError('SKILLS_UNAVAILABLE', `required skills unavailable: ${detail}`);
    }
    return { ...route, loaded, missing, ready: missing.length === 0 };
}
