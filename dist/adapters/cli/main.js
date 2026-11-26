#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { auditFieldsForChanges, auditFieldsForImpact, auditFieldsForSearch, auditFieldsForWorkflow, clearAuditState, consumeAuditWarning, parseSince, recordAudit, renderAuditSummary, summarizeAudit, } from '../../core/audit/index.js';
import { buildIndex, doctorDeep } from '../../core/engine/build.js';
import { isHolderAlive, readLockHolder } from '../../core/engine/lock.js';
import { homeRelative, renderStatus, workspaceStatus } from '../../core/engine/status.js';
import { checkTypescriptRuntime, engineVersion, pinnedTypescriptVersion, setupTypescriptRuntime, } from '../../core/engine/typescript.js';
import { loadWorkspace, resolveWorkspaceCache } from '../../core/engine/workspace.js';
import { readBuildHistory } from '../../core/indexing/ui-progress.js';
import { isRecord } from '../../core/kernel/guards.js';
import { runChanges } from '../../core/changes/changes.js';
import { renderChangesOutcome } from '../../core/changes/render.js';
import { changesVerificationNote, renderVerifyOutcome } from '../../core/verify/render.js';
import { loadVerificationState, runVerification, validateVerifyInput, } from '../../core/verify/verify.js';
import { impactDetails, renderImpact } from '../../core/impact/render.js';
import { ImpactSession } from '../../core/impact/session.js';
import { runSearch, validateSearchInput } from '../../core/search/lexical.js';
import { renderSearchOutcome } from '../../core/search/render.js';
import { withAnchorIndex, snapshot } from '../../core/knowledge/knowledge.js';
import { learningLabel, quoteClaim, renderLearningList } from '../../core/knowledge/render.js';
import { approveProposal, rejectProposal, reviewLearning } from '../../core/knowledge/store.js';
import { initProject } from '../../core/workspace/init.js';
import { discoverAgySkills } from '../agy/skills.js';
import { discoverOmpSkills } from '../omp/skills.js';
import { rootsFromEnv } from '../../workflow/catalog.js';
import { prepareWorkflow } from '../../workflow/loader.js';
import { listSkillPacks } from '../../workflow/packs.js';
import { defaultRegistryPath, readRegistry, validateRegistryConsistency, } from '../../workflow/registry.js';
import { renderWorkflow } from '../../workflow/render.js';
import { routeTask } from '../../workflow/router.js';
import { checkUpstreamUpdates, publishStagedUpdate, rollbackSkillUpdate, stageSkillUpdate, } from '../../workflow/updates.js';
import { checkSources, defaultLockPath, formatReports, readLock, reportStatus, writeLock, } from '../../workflow/sources.js';
import { WorkflowError } from '../../workflow/types.js';
import { openHud, renderHudSummary } from '../ui/hud.js';
import { renderResultView, terminalViewOptions } from '../ui/tree.js';
function doctorPassed(report) {
    const differences = report.differences;
    const count = typeof differences === 'object' && differences !== null && 'count' in differences
        ? differences.count
        : 1;
    const differential = report.differential;
    const misses = typeof differential === 'object' &&
        differential !== null &&
        'misses' in differential &&
        Array.isArray(differential.misses)
        ? differential.misses.length
        : 0;
    return count === 0 && misses === 0;
}
function counterNote(report) {
    const counters = report.counterDifferences;
    const count = typeof counters === 'object' && counters !== null && 'count' in counters ? counters.count : 0;
    return typeof count === 'number' && count > 0
        ? `INFO ${count} files have use counters that differ from the cold rebuild (statistics only, not a failure: TypeScript infers lazily, so they depend on checking order)`
        : '';
}
function renderDoctor(report) {
    return [
        doctorPassed(report) ? 'DOCTOR ok' : 'DOCTOR differences found',
        counterNote(report),
        JSON.stringify({
            differences: report.differences,
            counterDifferences: report.counterDifferences,
            differential: report.differential,
        }, null, 2),
    ]
        .filter((line) => line !== '')
        .join('\n');
}
const USAGE = `usage:
  main.js init    [--root <path>] [--force] [--dry-run] [--json]
  main.js setup   [--check]                       (installs the pinned TypeScript runtime; --check only verifies)
  main.js index   [--root <path>] [--full] [--json] (update the index from the working tree; --full rebuilds cold)
  main.js impact  <target…> [--depth <n>] [--root <path>] [--json] (who depends on 1–5 targets)
  main.js changes [--base <ref>] [--depth <n>] [--planned <target>]... [--root <path>] [--json] (impact of uncommitted changes)
  main.js search  <query> [--limit <n>] [--root <path>] [--json] (find declarations by words or identifier)
  main.js learning list [--status <state>] | show <id> | approve <id> | review <id> | reject <id> [--root <path>] [--json] (owner commands for .ksd/learnings)
  main.js verify  <check> | --report <name> [--root <path>] [--json] (run an allowlisted check or read a result file; needs verification.enabled)
  main.js doctor  --deep [--root <path>] [--differential <n|all>] [--json]  (cold rebuild diffed against the index)
  main.js status  [--root <path>] [--json]        (index, coverage, runtime, TypeScript, store, lock)
  main.js audit   [--since <7d|24h|30m|ISO>] [--root <path>] [--json] (summarize audit.jsonl)
  main.js cache   clear [--root <path>] [--json]  (remove index and audit cache for this repository)
  main.js route   --task "..." [--stage plan|investigate|implement|verify|review|ship] [--risk normal|high] [--type bug|feature|refactor|security|performance|ui] [--poteto-mode]
  main.js load    --task "..." [same options]     (needs checkouts; fails closed)
  main.js skills  list|check [--platform agy|omp] [--root <path>] [--profile <name>] [--detect-host] [--json]
  main.js skills  diff [--lock <path>] [--registry <path>] [--json]
  main.js skills  sync [--stage] [--state-dir <path>] [--lock <path>] [--registry <path>] [--json]
  main.js skills  publish --stage-id <id> --approve [--state-dir <path>] [--lock <path>] [--registry <path>] [--json]
  main.js skills  rollback [--release <id>] [--state-dir <path>] [--lock <path>] [--registry <path>] [--json]
  main.js sources check [--write] [--lock <path>] (never clones or fetches)
  main.js mcp     --root <path> [--workflow]      (local stdio MCP server for Antigravity)`;
async function tryResolveCacheCli(root) {
    try {
        const info = await resolveWorkspaceCache(root ?? process.cwd());
        return { root: info.root, cacheDir: info.cacheDir };
    }
    catch {
        return null;
    }
}
async function duringHud(hud, run) {
    if (hud === undefined)
        return run();
    const interrupt = () => {
        hud.close();
        process.exit(130);
    };
    process.once('SIGINT', interrupt);
    try {
        return await run();
    }
    finally {
        process.removeListener('SIGINT', interrupt);
        hud.close();
    }
}
function phaseTimes(raw) {
    if (!isRecord(raw))
        return [];
    return Object.entries(raw).flatMap(([phase, durationMs]) => typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0
        ? [{ phase, durationMs }]
        : []);
}
const LEARNING_STATES = ['active', 'needs-review', 'orphaned', 'superseded'];
// Owner commands. approve and review are the only code paths that write `.ksd/learnings/`.
async function runLearningCommand(sub, id, root, status, json) {
    const workspace = await loadWorkspace(root ?? process.cwd());
    const session = new ImpactSession(workspace, {
        waitAfterExpiry: true,
        onProgress: (message) => console.error(`ei learning: ${message}`),
    });
    if (status !== undefined && !LEARNING_STATES.includes(status)) {
        console.error(`ei learning: --status must be one of ${LEARNING_STATES.join(', ')}`);
        return 2;
    }
    if (sub === 'list' || sub === 'show') {
        const snap = await withAnchorIndex(session, (index) => snapshot(workspace, index));
        const keep = (entry) => (status === undefined || entry.state === status) &&
            (sub === 'list' || entry.learning.id === id);
        const learnings = snap.learnings.filter(keep);
        const proposals = snap.proposals.filter(keep);
        if (sub === 'show' && learnings.length + proposals.length === 0) {
            console.error(`ei learning: no learning or proposal "${id ?? ''}"`);
            return 1;
        }
        console.log(json
            ? JSON.stringify({ learnings, proposals, problems: snap.problems }, null, 2)
            : renderLearningList({
                scope: sub === 'show' ? (id ?? '') : 'all',
                learnings,
                proposals,
                problems: snap.problems,
            }));
        return 0;
    }
    if (id === undefined) {
        console.error(USAGE);
        return 2;
    }
    try {
        if (sub === 'approve') {
            const learning = approveProposal(workspace.root, workspace.cacheDir, id);
            console.log(`APPROVED ${learning.id} → .ksd/learnings/${learning.id}.yaml (owner-confirmed)\n  > ${quoteClaim(learning.claim)}`);
            return 0;
        }
        if (sub === 'reject') {
            rejectProposal(workspace.cacheDir, id);
            console.log(`REJECTED ${id} (proposal removed)`);
            return 0;
        }
        if (sub === 'review') {
            const snap = await withAnchorIndex(session, (index) => snapshot(workspace, index));
            const entry = snap.learnings.find((candidate) => candidate.learning.id === id);
            if (entry === undefined)
                throw new Error(`no learning "${id}" in .ksd/learnings`);
            if (entry.currentHash === undefined) {
                throw new Error(`${id} cannot be re-anchored: ${learningLabel(entry)}`);
            }
            const learning = reviewLearning(workspace.root, id, entry.currentHash);
            console.log(`REVIEWED ${learning.id} — re-anchored to the current ${learning.anchor.key}`);
            return 0;
        }
    }
    catch (error) {
        console.error(`ei learning: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
    }
    console.error(USAGE);
    return 2;
}
async function run(argv) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            help: { type: 'boolean', short: 'h' },
            root: { type: 'string' },
            force: { type: 'boolean' },
            'dry-run': { type: 'boolean' },
            json: { type: 'boolean' },
            plain: { type: 'boolean' },
            all: { type: 'boolean' },
            task: { type: 'string' },
            stage: { type: 'string' },
            risk: { type: 'string' },
            type: { type: 'string' },
            'poteto-mode': { type: 'boolean' },
            platform: { type: 'string' },
            profile: { type: 'string' },
            'detect-host': { type: 'boolean' },
            registry: { type: 'string' },
            'state-dir': { type: 'string' },
            'stage-id': { type: 'string' },
            release: { type: 'string' },
            approve: { type: 'boolean' },
            write: { type: 'boolean' },
            lock: { type: 'string' },
            check: { type: 'boolean' },
            full: { type: 'boolean' },
            deep: { type: 'boolean' },
            differential: { type: 'string' },
            depth: { type: 'string' },
            limit: { type: 'string' },
            base: { type: 'string' },
            planned: { type: 'string', multiple: true },
            since: { type: 'string' },
            status: { type: 'string' },
            report: { type: 'string' },
            workflow: { type: 'boolean' },
        },
    });
    if (values.help) {
        console.log(USAGE.replaceAll('main.js ', 'ei '));
        return 0;
    }
    const [command, sub] = positionals;
    const lockPath = values.lock ?? defaultLockPath();
    const registryPath = values.registry ?? defaultRegistryPath();
    const view = terminalViewOptions({
        env: process.env,
        columns: process.stdout.columns || 80,
        isTTY: process.stdout.isTTY === true,
        plain: values.plain === true,
        json: values.json === true,
        all: values.all === true,
    });
    const show = (input, plain) => {
        console.log(view === undefined ? plain() : renderResultView(input, view).join('\n'));
    };
    const hudOptions = {
        stream: process.stderr,
        env: process.env,
        plain: values.plain === true,
        json: values.json === true,
    };
    if (command === 'setup') {
        const version = pinnedTypescriptVersion();
        const started = performance.now();
        const check = values.check === true;
        const hud = check
            ? undefined
            : openHud({ ...hudOptions, command: 'setup', repo: basename(process.cwd()) });
        const result = await duringHud(hud, () => check
            ? checkTypescriptRuntime({ version })
            : setupTypescriptRuntime({ version, onHudProgress: hud?.update }));
        if (hud !== undefined && view !== undefined) {
            console.log(renderHudSummary({
                ...view,
                command: 'setup',
                outcome: result.ok ? 'completed' : 'failed',
                durationMs: performance.now() - started,
                reason: result.ok
                    ? `typescript ${result.runtime.version} · ${result.runtime.path} · sha256 ${result.sha256}`
                    : result.reason,
                next: result.ok ? 'ready for ei index' : result.fix,
            }));
            return result.ok ? 0 : 1;
        }
        if (!result.ok) {
            console.log(`typescript ${version}: degraded (${result.reason}) · ${result.fix}`);
            return 1;
        }
        console.log(`typescript ${result.runtime.version}: ready · ${result.runtime.path} · sha256 ${result.sha256}`);
        return 0;
    }
    if (command === 'status') {
        if (process.env.EI_DISABLED === '1') {
            console.log('STATUS disabled (EI_DISABLED)');
            return 0;
        }
        const started = performance.now();
        const status = await workspaceStatus(values.root ?? process.cwd(), {
            presentation: view === undefined ? undefined : 'status',
        });
        recordAudit(status.cacheDir, {
            ts: new Date().toISOString(),
            tool: 'ei_status',
            adapter: 'cli',
            outcome: 'result',
            ms: performance.now() - started,
            engine: engineVersion(),
            ...(status.typescript.ok ? { ts_version: status.typescript.runtime.version } : {}),
            statusState: status.state,
        }, { root: status.root });
        const extraWarning = consumeAuditWarning(status.cacheDir);
        if (extraWarning !== null)
            status.auditWarning = extraWarning;
        if (values.json === true)
            console.log(JSON.stringify(status, null, 2));
        else
            show({ kind: 'status', value: status }, () => renderStatus(status));
        return status.state === 'ready' ? 0 : 1;
    }
    if (command === 'audit') {
        let sinceMs;
        if (values.since !== undefined) {
            const parsed = parseSince(values.since);
            if (parsed === null) {
                console.error(`INVALID_INPUT: invalid --since ${JSON.stringify(values.since)}; expected e.g. 7d, 24h, 30m, or ISO timestamp`);
                return 2;
            }
            sinceMs = parsed;
        }
        const { cacheDir } = await resolveWorkspaceCache(values.root ?? process.cwd());
        const summary = summarizeAudit(cacheDir, {
            ...(sinceMs !== undefined ? { sinceMs, sinceLabel: values.since } : {}),
        });
        if (values.json === true)
            console.log(JSON.stringify(summary, null, 2));
        else
            show({ kind: 'audit', value: summary }, () => renderAuditSummary(summary));
        return 0;
    }
    if (command === 'cache') {
        if (sub !== 'clear') {
            console.error(USAGE);
            return 2;
        }
        const { repoId, cacheDir } = await resolveWorkspaceCache(values.root ?? process.cwd());
        const holder = readLockHolder(cacheDir);
        if (holder !== null && isHolderAlive(holder)) {
            if (values.json === true) {
                console.log(JSON.stringify({ cleared: false, locked: true, repoId, pid: holder.pid }, null, 2));
            }
            else {
                console.error(`CACHE LOCKED ${repoId} · build lock held by pid ${holder.pid} since ${holder.startedAt}`);
            }
            return 1;
        }
        const existed = existsSync(cacheDir);
        await rm(cacheDir, { recursive: true, force: true });
        clearAuditState(cacheDir);
        if (values.json === true) {
            console.log(JSON.stringify({ cleared: true, existed, repoId, cacheDir }, null, 2));
        }
        else {
            console.log(existed
                ? `CACHE CLEARED ${repoId} · removed ${homeRelative(cacheDir)}`
                : `CACHE CLEARED ${repoId} · nothing to clear (${homeRelative(cacheDir)})`);
        }
        return 0;
    }
    if (command === 'index') {
        const workspace = await loadWorkspace(values.root ?? process.cwd());
        const started = performance.now();
        const previous = view !== undefined && process.stderr.isTTY
            ? readBuildHistory(workspace.cacheDir).at(-1)
            : undefined;
        const hud = openHud({
            ...hudOptions,
            command: 'index',
            repo: basename(workspace.root),
            previous,
        });
        let rebuildReason;
        const outcome = await duringHud(hud, () => buildIndex(workspace, {
            full: values.full === true,
            onProgress: hud === undefined ? (message) => console.error(`ei index: ${message}`) : undefined,
            onHudProgress: hud === undefined && view === undefined
                ? undefined
                : (event) => {
                    rebuildReason = event.reason ?? rebuildReason;
                    hud?.update(event);
                },
        }));
        if (!outcome.ok) {
            if (view !== undefined) {
                const status = await workspaceStatus(workspace.root);
                console.log(renderHudSummary({
                    ...view,
                    command: 'index',
                    outcome: 'failed',
                    durationMs: performance.now() - started,
                    reason: `${outcome.code}: ${outcome.message}`,
                    activeIndex: status.index === null ? 'none' : homeRelative(status.index.path),
                    next: outcome.fix,
                }));
                return 1;
            }
            console.log(`INDEX ${outcome.code}: ${outcome.message} · ${outcome.fix}`);
            return 1;
        }
        if (values.json === true) {
            console.log(JSON.stringify(outcome.value, null, 2));
            return outcome.value.action === 'failed' ? 1 : 0;
        }
        const durationMs = performance.now() - started;
        const seconds = (durationMs / 1000).toFixed(2);
        const { action, reason } = outcome.value;
        if (view !== undefined &&
            (action === 'cold' || action === 'update' || action === 'unchanged' || action === 'failed')) {
            const { index, presentation, includeWarnings } = await workspaceStatus(workspace.root, {
                presentation: action === 'failed' ? undefined : 'index',
            });
            let shownReason = rebuildReason ?? String(reason);
            if (action === 'failed') {
                shownReason = String(reason);
                const problems = Array.isArray(outcome.value.problems)
                    ? outcome.value.problems.filter((value) => typeof value === 'string')
                    : [];
                if (problems.length > 0)
                    shownReason += `: ${problems.join('; ')}`;
            }
            const actionLabel = action === 'cold' ? 'built' : 'updated';
            const activeIndex = index === null ? 'none' : homeRelative(index.path);
            const drift = isRecord(outcome.value.drift) ? outcome.value.drift : {};
            console.log(renderHudSummary({
                ...view,
                command: 'index',
                outcome: action === 'failed' || action === 'unchanged' ? action : actionLabel,
                kind: action === 'cold' || action === 'update' ? action : undefined,
                durationMs,
                previous,
                reason: shownReason,
                phases: phaseTimes(outcome.value.phases),
                coverage: index === null || presentation === undefined
                    ? undefined
                    : { scanned: index.coverage.scanned, ...presentation },
                includeWarnings,
                drift: action === 'update'
                    ? `+${String(drift.added)} · ~${String(drift.changed)} · −${String(drift.deleted)}`
                    : undefined,
                activeIndex: action === 'failed' ? activeIndex : undefined,
                throughput: hud?.throughput,
                next: action === 'failed' ? 'check ei status before retrying' : 'ready for ei impact',
            }));
            return action === 'failed' ? 1 : 0;
        }
        console.log(`INDEX ${String(action)} in ${seconds} s (${String(reason)})`);
        console.log(renderStatus(await workspaceStatus(workspace.root)));
        return action === 'failed' ? 1 : 0;
    }
    if (command === 'impact') {
        const started = performance.now();
        const targets = positionals.slice(1);
        const rawDepth = values.depth;
        const depth = rawDepth === undefined ? undefined : Number.parseInt(rawDepth, 10);
        if (targets.length < 1 ||
            targets.length > 5 ||
            (rawDepth !== undefined &&
                (depth === undefined ||
                    !Number.isInteger(depth) ||
                    String(depth) !== rawDepth.trim() ||
                    depth < 1 ||
                    depth > 10))) {
            const cache = await tryResolveCacheCli(values.root);
            if (cache !== null) {
                recordAudit(cache.cacheDir, {
                    ts: new Date().toISOString(),
                    tool: 'ei_impact',
                    adapter: 'cli',
                    outcome: 'failure',
                    ms: performance.now() - started,
                    engine: engineVersion(),
                    code: 'INVALID_INPUT',
                    codes: ['INVALID_INPUT'],
                    ...(targets.length > 0 ? { targets } : {}),
                }, { root: cache.root });
            }
            const batch = {
                answers: [
                    {
                        input: targets[0] ?? '',
                        kind: 'failure',
                        code: 'INVALID_INPUT',
                        message: 'provide 1–5 targets and depth 1–10',
                    },
                ],
                index: { state: 'fresh', updatedFiles: 0, driftedFiles: [] },
            };
            if (values.json === true)
                console.log(JSON.stringify(batch.answers[0], null, 2));
            else
                show({ kind: 'impact', value: batch }, () => renderImpact(batch));
            return 2;
        }
        const workspace = await loadWorkspace(values.root ?? process.cwd());
        const session = new ImpactSession(workspace, {
            waitAfterExpiry: true,
            onProgress: (message) => console.error(`ei impact: ${message}`),
        });
        const batch = await session.query(targets, depth);
        recordAudit(workspace.cacheDir, {
            ts: new Date().toISOString(),
            tool: 'ei_impact',
            adapter: 'cli',
            outcome: 'result',
            ms: performance.now() - started,
            engine: engineVersion(),
            ...auditFieldsForImpact(batch, engineVersion()),
        }, { root: workspace.root });
        const details = values.json === true ? impactDetails(batch) : undefined;
        if (details !== undefined) {
            console.log(JSON.stringify(details.length === 1 ? details[0] : details, null, 2));
        }
        else {
            show({ kind: 'impact', value: batch }, () => renderImpact(batch));
        }
        return batch.answers.some((answer) => answer.kind === 'failure') ? 1 : 0;
    }
    if (command === 'changes') {
        if (process.env.EI_DISABLED === '1') {
            console.log('CHANGES disabled (EI_DISABLED)');
            return 0;
        }
        const started = performance.now();
        const rawDepth = values.depth;
        const depth = rawDepth === undefined ? undefined : Number.parseInt(rawDepth, 10);
        if (rawDepth !== undefined &&
            (depth === undefined ||
                !Number.isInteger(depth) ||
                String(depth) !== rawDepth.trim() ||
                depth < 1 ||
                depth > 10)) {
            const cache = await tryResolveCacheCli(values.root);
            if (cache !== null) {
                recordAudit(cache.cacheDir, {
                    ts: new Date().toISOString(),
                    tool: 'ei_changes',
                    adapter: 'cli',
                    outcome: 'failure',
                    ms: performance.now() - started,
                    engine: engineVersion(),
                    code: 'INVALID_INPUT',
                    codes: ['INVALID_INPUT'],
                }, { root: cache.root });
            }
            const outcome = {
                kind: 'failure',
                code: 'INVALID_INPUT',
                message: 'depth must be an integer 1–10',
            };
            if (values.json === true)
                console.log(JSON.stringify(outcome, null, 2));
            else
                show({ kind: 'changes', value: outcome }, () => renderChangesOutcome(outcome));
            return 2;
        }
        const workspace = await loadWorkspace(values.root ?? process.cwd());
        const session = new ImpactSession(workspace, {
            waitAfterExpiry: true,
            onProgress: (message) => console.error(`ei changes: ${message}`),
        });
        const outcome = await runChanges(session, {
            base: values.base,
            depth,
            planned: values.planned,
        });
        recordAudit(workspace.cacheDir, {
            ts: new Date().toISOString(),
            tool: 'ei_changes',
            adapter: 'cli',
            outcome: outcome.kind,
            ms: performance.now() - started,
            engine: engineVersion(),
            ...auditFieldsForChanges(outcome, engineVersion()),
        }, { root: workspace.root });
        if (values.json === true) {
            console.log(JSON.stringify(outcome.kind === 'result' ? outcome.value : outcome, null, 2));
        }
        else {
            const verification = await loadVerificationState(workspace);
            const verificationNote = verification &&
                changesVerificationNote(verification.reports, verification.revision, verification.checkNames);
            show({ kind: 'changes', value: outcome, verificationNote }, () => renderChangesOutcome(outcome, undefined, verificationNote));
        }
        return outcome.kind === 'failure' ? 1 : 0;
    }
    if (command === 'learning') {
        return runLearningCommand(sub, positionals[2], values.root, values.status, values.json === true);
    }
    if (command === 'verify') {
        if (process.env.EI_DISABLED === '1') {
            console.log('VERIFY disabled (EI_DISABLED)');
            return 0;
        }
        const name = positionals[1];
        const raw = values.report === undefined ? { check: name } : { check: name, report: values.report };
        const valid = validateVerifyInput(raw);
        if (!valid.ok) {
            const failure = {
                kind: 'failure',
                code: 'INVALID_INPUT',
                message: valid.message,
            };
            console.log(values.json === true
                ? JSON.stringify(failure, null, 2)
                : renderVerifyOutcome(failure, engineVersion()));
            return 2;
        }
        const workspace = await loadWorkspace(values.root ?? process.cwd());
        const outcome = await runVerification(workspace, valid.request);
        console.log(values.json === true
            ? JSON.stringify(outcome.kind === 'result' ? outcome.value : outcome, null, 2)
            : renderVerifyOutcome(outcome, engineVersion()));
        if (outcome.kind === 'failure')
            return 2;
        return outcome.value.status === 'PASS' ? 0 : 1;
    }
    if (command === 'search') {
        if (process.env.EI_DISABLED === '1') {
            console.log('SEARCH disabled (EI_DISABLED)');
            return 0;
        }
        const started = performance.now();
        const rawLimit = values.limit;
        const parsedLimit = rawLimit === undefined
            ? undefined
            : /^\d+$/.test(rawLimit.trim())
                ? Number.parseInt(rawLimit.trim(), 10)
                : Number.NaN;
        const query = positionals.slice(1).join(' ');
        const valid = validateSearchInput(query, parsedLimit);
        if (!valid.ok) {
            const cache = await tryResolveCacheCli(values.root);
            if (cache !== null) {
                recordAudit(cache.cacheDir, {
                    ts: new Date().toISOString(),
                    tool: 'ei_search',
                    adapter: 'cli',
                    outcome: 'failure',
                    ms: performance.now() - started,
                    engine: engineVersion(),
                    code: 'INVALID_INPUT',
                    codes: ['INVALID_INPUT'],
                    ...(query !== '' ? { query } : {}),
                    ...(parsedLimit !== undefined && Number.isInteger(parsedLimit)
                        ? { limit: parsedLimit }
                        : {}),
                }, { root: cache.root });
            }
            const outcome = {
                kind: 'failure',
                code: 'INVALID_INPUT',
                message: valid.message,
            };
            if (values.json === true)
                console.log(JSON.stringify(outcome, null, 2));
            else
                show({ kind: 'search', value: outcome }, () => renderSearchOutcome(outcome));
            return 2;
        }
        const workspace = await loadWorkspace(values.root ?? process.cwd());
        const session = new ImpactSession(workspace, {
            waitAfterExpiry: true,
            onProgress: (message) => console.error(`ei search: ${message}`),
        });
        const outcome = await runSearch(session, {
            query: valid.query,
            limit: valid.limit,
        });
        recordAudit(workspace.cacheDir, {
            ts: new Date().toISOString(),
            tool: 'ei_search',
            adapter: 'cli',
            outcome: outcome.kind,
            ms: performance.now() - started,
            engine: engineVersion(),
            ...auditFieldsForSearch(outcome, engineVersion(), valid.query, valid.limit),
        }, { root: workspace.root });
        if (values.json === true) {
            console.log(JSON.stringify(outcome.kind === 'result' ? outcome.value : outcome, null, 2));
        }
        else {
            show({ kind: 'search', value: outcome }, () => renderSearchOutcome(outcome));
        }
        return outcome.kind === 'failure' ? 1 : 0;
    }
    if (command === 'doctor') {
        if (values.deep !== true) {
            console.error(USAGE);
            return 2;
        }
        const workspace = await loadWorkspace(values.root ?? process.cwd());
        const raw = values.differential ?? '0';
        const differential = raw === 'all' ? -1 : Number.parseInt(raw, 10);
        if (!Number.isInteger(differential)) {
            console.error(`--differential must be a number or "all", got ${raw}`);
            return 2;
        }
        const started = performance.now();
        const previous = view !== undefined && process.stderr.isTTY
            ? readBuildHistory(workspace.cacheDir).at(-1)
            : undefined;
        const hud = openHud({
            ...hudOptions,
            command: 'doctor',
            repo: basename(workspace.root),
            previous,
        });
        const outcome = await duringHud(hud, () => doctorDeep(workspace, {
            differential,
            onProgress: hud === undefined ? (message) => console.error(`ei doctor: ${message}`) : undefined,
            onHudProgress: hud?.update,
        }));
        if (!outcome.ok) {
            if (hud !== undefined && view !== undefined) {
                console.log(renderHudSummary({
                    ...view,
                    command: 'doctor',
                    outcome: 'failed',
                    durationMs: performance.now() - started,
                    reason: `${outcome.code}: ${outcome.message}`,
                    next: outcome.fix,
                }));
                return 1;
            }
            console.log(`DOCTOR ${outcome.code}: ${outcome.message} · ${outcome.fix}`);
            return 1;
        }
        if (values.json === true) {
            console.log(JSON.stringify(outcome.value, null, 2));
        }
        else if (hud !== undefined && view !== undefined) {
            const ok = doctorPassed(outcome.value);
            const cold = isRecord(outcome.value.cold) ? outcome.value.cold : {};
            const compared = differential === 0
                ? 'canonical differences'
                : 'canonical differences or differential misses';
            console.log(renderHudSummary({
                ...view,
                command: 'doctor',
                outcome: ok ? 'completed' : 'failed',
                durationMs: performance.now() - started,
                reason: ok ? `no ${compared}` : 'differences found',
                phases: phaseTimes(cold.phases),
                throughput: hud.throughput,
                next: ok
                    ? 'ready for ei impact'
                    : 'check the reported differences before using this index',
            }));
            const note = counterNote(outcome.value);
            if (!ok)
                console.log(renderDoctor(outcome.value));
            else if (note !== '')
                console.log(note);
        }
        else {
            console.log(renderDoctor(outcome.value));
        }
        return doctorPassed(outcome.value) ? 0 : 1;
    }
    if (command === 'init') {
        const result = await initProject({
            root: values.root,
            force: values.force === true,
            dryRun: values['dry-run'] === true,
        });
        if (values.json === true) {
            console.log(JSON.stringify(result, null, 2));
            return 0;
        }
        const dry = values['dry-run'] === true;
        const status = result.configOverwritten
            ? dry
                ? 'would overwrite'
                : 'overwritten'
            : result.configCreated
                ? dry
                    ? 'would create'
                    : 'created'
                : 'already exists, skipped';
        console.log('Project initialized:');
        console.log(`  Repo ID:    ${result.repoId}`);
        console.log(`  Root:       ${result.root}`);
        console.log(`  Cache dir:  ${result.cacheDir}`);
        console.log(`  Config:     ${result.configPath} (${status})`);
        console.log(`  Git:        ${result.git.isRepo ? `yes (${result.git.gitRoot ?? 'root'})` : 'not a git repository'}`);
        console.log(`  Include:    ${result.config.impact.include.join(', ')}`);
        console.log(`  TS configs: ${result.tsconfigs.length > 0 ? result.tsconfigs.join(', ') : 'none found'}`);
        console.log(`  Omitted tsconfig dirs: ${result.omittedTsconfigDirs.length > 0 ? result.omittedTsconfigDirs.join(', ') : 'none'}`);
        if (result.warnings.length > 0) {
            console.log('\nWarnings:');
            for (const warning of result.warnings) {
                console.log(`  - ${warning}`);
            }
        }
        return 0;
    }
    if (command === 'route' || command === 'load') {
        const query = {
            task: values.task ?? '',
            stage: values.stage,
            risk: values.risk,
            type: values.type,
            potetoMode: values['poteto-mode'] === true,
        };
        if (command === 'route') {
            console.log(JSON.stringify(routeTask(query), null, 2));
            return 0;
        }
        const started = performance.now();
        try {
            const workflow = await prepareWorkflow({
                ...query,
                strict: true,
                roots: rootsFromEnv(process.env),
                lock: await readLock(lockPath),
            });
            const cache = await tryResolveCacheCli(values.root);
            if (cache !== null) {
                recordAudit(cache.cacheDir, {
                    ts: new Date().toISOString(),
                    tool: 'ei_workflow',
                    adapter: 'cli',
                    outcome: 'result',
                    ms: performance.now() - started,
                    engine: engineVersion(),
                    ...auditFieldsForWorkflow(workflow),
                }, { root: cache.root });
            }
            console.log(renderWorkflow(workflow));
            return 0;
        }
        catch (error) {
            const cache = await tryResolveCacheCli(values.root);
            if (cache !== null) {
                recordAudit(cache.cacheDir, {
                    ts: new Date().toISOString(),
                    tool: 'ei_workflow',
                    adapter: 'cli',
                    outcome: 'error',
                    ms: performance.now() - started,
                    engine: engineVersion(),
                    code: error instanceof WorkflowError ? error.code : 'WORKFLOW_ERROR',
                    ...(query.task !== '' ? { task: query.task } : {}),
                    ...(query.stage !== undefined ? { stage: query.stage } : {}),
                }, { root: cache.root });
            }
            throw error;
        }
    }
    if (command === 'skills' && (sub === 'list' || sub === 'check')) {
        const rawPlatform = values.platform ?? 'omp';
        if (rawPlatform !== 'agy' && rawPlatform !== 'omp') {
            console.error(`invalid --platform ${JSON.stringify(rawPlatform)}; expected agy or omp`);
            return 2;
        }
        const platform = rawPlatform;
        const result = platform === 'agy'
            ? await discoverAgySkills({
                workspaceRoot: values.root,
                detectHostPaths: values['detect-host'] === true,
                requireCatalog: true,
            })
            : await discoverOmpSkills({
                workspaceRoot: values.root,
                profile: values.profile,
                detectHostPaths: values['detect-host'] === true,
                requireCatalog: true,
            });
        const registryIssues = sub === 'check'
            ? await validateRegistryConsistency(await readRegistry(registryPath), await readLock(lockPath))
            : [];
        const totalIssues = result.issues.length + registryIssues.length;
        if (values.json === true) {
            console.log(JSON.stringify(sub === 'list'
                ? { platform, packs: listSkillPacks(), discovery: result }
                : { ...result, registryIssues }, null, 2));
            return sub === 'check' && totalIssues > 0 ? 1 : 0;
        }
        if (view !== undefined) {
            console.log(renderResultView({ kind: 'skills', platform, discovery: result, registryIssues }, view).join('\n'));
            return sub === 'check' && totalIssues > 0 ? 1 : 0;
        }
        console.log(`SKILLS ${platform} · ${result.skills.length} discovered (${result.autoVisible.length} auto, ${result.explicitOnly.length} opt-in) · ${totalIssues} issues`);
        for (const skill of result.skills) {
            const mode = skill.explicitOnly ? 'opt-in' : 'auto';
            console.log(`  ${skill.name.padEnd(28)} ${mode.padEnd(8)} ${skill.sourceLabel}`);
        }
        for (const issue of result.issues) {
            console.log(`  ISSUE ${issue.code}: ${issue.message}`);
        }
        for (const issue of registryIssues) {
            console.log(`  REGISTRY ${issue.code}: ${issue.message}`);
        }
        return sub === 'check' && totalIssues > 0 ? 1 : 0;
    }
    if (command === 'skills' && sub === 'diff') {
        const check = await checkUpstreamUpdates({
            roots: rootsFromEnv(process.env),
            lockPath,
            registryPath,
        });
        if (values.json === true) {
            console.log(JSON.stringify(check, null, 2));
            return check.blockingFindings.length > 0 ? 1 : 0;
        }
        console.log(`SKILLS DIFF · updates=${check.hasUpdates ? 'yes' : 'no'} · blocking=${check.blockingFindings.length} · warnings=${check.findings.length - check.blockingFindings.length}`);
        for (const p of check.providers) {
            console.log(`  ${p.provider.padEnd(8)} commit ${(p.previousCommit ?? '-').slice(0, 12)} -> ${(p.nextCommit ?? '-').slice(0, 12)} · changed=${p.changed.length} added=${p.added.length} removed=${p.removed.length} renamed=${p.renamed.length}`);
        }
        for (const finding of check.findings) {
            console.log(`  [${finding.severity.toUpperCase()}] ${finding.code}: ${finding.message}`);
        }
        return check.blockingFindings.length > 0 ? 1 : 0;
    }
    if (command === 'skills' && sub === 'sync') {
        const { stagePath, staged } = await stageSkillUpdate({
            roots: rootsFromEnv(process.env),
            lockPath,
            registryPath,
            stateDir: values['state-dir'],
            workspaceRoot: values.root,
        });
        if (values.json === true) {
            console.log(JSON.stringify({ stagePath, staged }, null, 2));
            return staged.validation.ok ? 0 : 1;
        }
        console.log(`SKILLS SYNC ${staged.status.toUpperCase()} · stageId=${staged.stageId} · agy=${staged.validation.runtimes.agy.ok ? 'OK' : 'FAIL'} · omp=${staged.validation.runtimes.omp.ok ? 'OK' : 'FAIL'} · file=${stagePath}`);
        for (const finding of staged.diff.findings) {
            console.log(`  [${finding.severity.toUpperCase()}] ${finding.code}: ${finding.message}`);
        }
        if (staged.validation.ok) {
            console.log(`Next: review diff, then run: ei skills publish --stage-id ${staged.stageId} --approve`);
        }
        return staged.validation.ok ? 0 : 1;
    }
    if (command === 'skills' && sub === 'publish') {
        const stageId = values['stage-id'];
        if (!stageId) {
            console.error('usage: main.js skills publish --stage-id <id> --approve [--state-dir <path>]');
            return 2;
        }
        const { snapshotPath, snapshot } = await publishStagedUpdate({
            stageId,
            approve: values.approve === true,
            lockPath,
            registryPath,
            stateDir: values['state-dir'],
            force: values.force === true,
        });
        if (values.json === true) {
            console.log(JSON.stringify({ snapshotPath, snapshot }, null, 2));
            return 0;
        }
        console.log(`SKILLS PUBLISHED releaseId=${snapshot.releaseId} from ${snapshot.stageId} · rollback snapshot=${snapshotPath}`);
        return 0;
    }
    if (command === 'skills' && sub === 'rollback') {
        const restored = await rollbackSkillUpdate({
            releaseId: values.release,
            lockPath,
            registryPath,
            stateDir: values['state-dir'],
        });
        if (values.json === true) {
            console.log(JSON.stringify(restored, null, 2));
            return 0;
        }
        console.log(`SKILLS ROLLED BACK to previous state of release ${restored.restoredFrom}`);
        return 0;
    }
    if (command === 'sources' && sub === 'check') {
        const lock = await readLock(lockPath);
        const result = await checkSources(lock, rootsFromEnv(process.env), {
            write: values.write === true,
        });
        console.log(formatReports(result.reports));
        if (result.reports.some((report) => report.written))
            await writeLock(lockPath, result.lock);
        return result.reports.some((report) => reportStatus(report) === 'ERROR') ? 1 : 0;
    }
    if (command === 'mcp') {
        if (sub !== undefined) {
            console.error('usage: main.js mcp --root /absolute/path/to/repository [--workflow]');
            return 2;
        }
        const stdioUrl = new URL('../../../scripts/mcp/stdio.mjs', import.meta.url).href;
        const { createStdioServer, resolveMcpRoot } = (await import(stdioUrl));
        const resolved = await resolveMcpRoot(values.root, process.env);
        if (!resolved.ok) {
            console.error(resolved.message);
            return 2;
        }
        const env = values.workflow === true ? { ...process.env, KSD_MCP_WORKFLOW: '1' } : process.env;
        const server = createStdioServer({ root: resolved.root, env });
        await server.done;
        return 0;
    }
    console.error(USAGE);
    return 2;
}
try {
    process.exitCode = await run(process.argv.slice(2));
}
catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
