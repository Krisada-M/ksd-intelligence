import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultSkillsDir, discoverSkillsForPlatform, } from '../../workflow/packs.js';
// Inspects OMP's profile, RULES.md, config, and skill directories read-only without mutating user state.
export function detectOmpEnvironment(options = {}) {
    const env = options.env ?? process.env;
    const realHome = options.homeDir ?? env.SNAP_REAL_HOME ?? env.HOME ?? homedir();
    const profile = options.profile ?? env.OMP_PROFILE ?? 'default';
    const agentDir = resolve(options.agentDir ??
        env.PI_CODING_AGENT_DIR ??
        env.OMP_AGENT_DIR ??
        (profile !== 'default'
            ? join(realHome, '.omp', 'profiles', profile, 'agent')
            : join(realHome, '.omp', 'agent')));
    const projectDir = options.workspaceRoot ? resolve(options.workspaceRoot, '.omp') : null;
    const projectSkillsDir = projectDir ? join(projectDir, 'skills') : null;
    const userSkillsDir = join(agentDir, 'skills');
    const sharedSkillsDir = resolve(realHome, '.agents', 'skills');
    const pluginSkillsDir = resolve(options.skillsDir ?? defaultSkillsDir());
    const rulesFiles = [];
    if (projectDir) {
        const projectRules = join(projectDir, 'RULES.md');
        rulesFiles.push({ scope: 'project', path: projectRules, exists: existsSync(projectRules) });
    }
    const userRules = join(agentDir, 'RULES.md');
    rulesFiles.push({ scope: 'user', path: userRules, exists: existsSync(userRules) });
    const configFiles = [];
    if (projectDir) {
        const projectSettings = join(projectDir, 'settings.json');
        configFiles.push({
            kind: 'settings.json',
            scope: 'project',
            path: projectSettings,
            exists: existsSync(projectSettings),
        });
    }
    for (const kind of ['config.yml', 'settings.json', 'engineering-proxy.json']) {
        const file = join(agentDir, kind);
        configFiles.push({ kind, scope: 'user', path: file, exists: existsSync(file) });
    }
    return {
        realHome,
        profile,
        agentDir,
        rulesFiles,
        configFiles,
        projectSkillsDir,
        userSkillsDir,
        sharedSkillsDir,
        pluginSkillsDir,
    };
}
// Native OMP skill discovery mirroring `@oh-my-pi/pi-coding-agent` precedence:
// project `.omp/skills` > active profile/user `<agentDir>/skills` > shared `~/.agents/skills` > marketplace plugin `skills/`.
// Skills with `disable-model-invocation: true` (e.g. `poteto-mode`) remain in `explicitOnly`.
export async function discoverOmpSkills(options = {}) {
    const environment = detectOmpEnvironment({
        workspaceRoot: options.workspaceRoot,
        profile: options.profile,
        agentDir: options.agentDir,
        skillsDir: options.skillsDir,
        env: options.env,
        homeDir: options.homeDir,
    });
    const roots = [];
    const seenPaths = new Set();
    const addRoot = (root) => {
        const key = resolve(root.path);
        if (seenPaths.has(key))
            return;
        seenPaths.add(key);
        roots.push(root);
    };
    if (environment.projectSkillsDir) {
        addRoot({
            path: environment.projectSkillsDir,
            label: 'omp:project',
            optional: true,
        });
    }
    if (options.userSkillsDir) {
        addRoot({
            path: options.userSkillsDir,
            label: 'omp:user',
            optional: true,
            allowExternalSymlinks: true,
            auditContent: false,
        });
    }
    else if (options.detectHostPaths || options.profile || options.agentDir) {
        addRoot({
            path: environment.userSkillsDir,
            label: environment.profile === 'default' ? 'omp:user' : `omp:profile:${environment.profile}`,
            optional: true,
            allowExternalSymlinks: true,
            auditContent: false,
        });
    }
    if (options.sharedSkillsDir) {
        addRoot({
            path: options.sharedSkillsDir,
            label: 'omp:shared',
            optional: true,
            allowExternalSymlinks: true,
            auditContent: false,
        });
    }
    else if (options.detectHostPaths) {
        addRoot({
            path: environment.sharedSkillsDir,
            label: 'omp:shared',
            optional: true,
            allowExternalSymlinks: true,
            auditContent: false,
        });
    }
    addRoot({
        path: environment.pluginSkillsDir,
        label: 'omp:plugin:ksd-intelligence',
        optional: false,
        auditContent: true,
    });
    const discovery = await discoverSkillsForPlatform({
        platform: 'omp',
        roots,
        requireCatalog: options.requireCatalog ?? true,
    });
    return { ...discovery, environment };
}
