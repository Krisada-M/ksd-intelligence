#!/usr/bin/env node
/**
 * GitLab CI helper for KSD unified AGY + OMP skill updates.
 *
 * Lifecycle: Check upstream -> Diff -> Validate dependencies -> Test AGY & OMP -> Report / Draft MR.
 * Hard boundaries:
 * - Never executes upstream scripts or git hooks.
 * - Never auto-merges or auto-deploys; any proposed MR is strictly a Draft with auto-merge disabled.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootsFromEnv } from '../../dist/workflow/catalog.js';
import { stageSkillUpdate } from '../../dist/workflow/updates.js';

export function formatUpdateMarkdown(staged) {
  const lines = [
    '# KSD Unified Skill Update Report (AGY + OMP)',
    '',
    `- **Stage ID:** \`${staged.stageId}\``,
    `- **Status:** \`${staged.status}\``,
    `- **Updates Detected:** ${staged.diff.hasUpdates ? 'yes' : 'no'}`,
    `- **AGY Discovery:** ${staged.validation.runtimes.agy.ok ? 'PASS' : 'FAIL'} (${staged.validation.runtimes.agy.discoveredCount} skills, ${staged.validation.runtimes.agy.optInCount} opt-in)`,
    `- **OMP Discovery:** ${staged.validation.runtimes.omp.ok ? 'PASS' : 'FAIL'} (${staged.validation.runtimes.omp.discoveredCount} skills, ${staged.validation.runtimes.omp.optInCount} opt-in)`,
    `- **Blocking Findings:** ${staged.diff.blockingFindings.length}`,
    '',
    '## Provider Diff',
    '',
    '| Provider | Previous Commit | Candidate Commit | Changed | Added | Removed | Renamed |',
    '|---|---|---|---|---|---|---|',
  ];

  for (const p of staged.diff.providers) {
    const prev = p.previousCommit ? `\`${p.previousCommit.slice(0, 12)}\`` : '-';
    const next = p.nextCommit ? `\`${p.nextCommit.slice(0, 12)}\`` : '-';
    lines.push(
      `| ${p.provider} | ${prev} | ${next} | ${p.changed.length} | ${p.added.length} | ${p.removed.length} | ${p.renamed.length} |`,
    );
  }

  if (staged.diff.findings.length > 0) {
    lines.push('', '## Compatibility & Security Findings', '');
    for (const f of staged.diff.findings) {
      lines.push(`- **[${f.severity.toUpperCase()}]** \`${f.code}\`: ${f.message}`);
    }
  }

  lines.push(
    '',
    '## Approval & Rollback',
    '',
    '- Auto-merge is **disabled** (`merge_when_pipeline_succeeds: false`).',
    '- Upstream scripts and hooks were **not executed**.',
    '- Review the upstream `SKILL.md` diffs, then approve locally with:',
    `  \`ei skills publish --stage-id ${staged.stageId} --approve\``,
    '- Roll back anytime with: `ei skills rollback`',
    '',
  );

  return lines.join('\n');
}

export function buildMrProposalPayload({
  staged,
  sourceBranch,
  targetBranch = 'main',
  reportMarkdown,
}) {
  const blocked = !staged.validation.ok;
  const titlePrefix = blocked ? 'Draft: [BLOCKED] ' : 'Draft: ';
  return {
    source_branch: sourceBranch,
    target_branch: targetBranch,
    title: `${titlePrefix}chore(skills): update pinned AGY + OMP skill registry (${staged.stageId})`,
    description: reportMarkdown ?? formatUpdateMarkdown(staged),
    remove_source_branch: true,
    squash: false,
    // Hard invariant: CI may propose a Draft MR, never enable auto-merge.
    merge_when_pipeline_succeeds: false,
    labels: blocked
      ? 'skills-update,blocked,needs-owner-review'
      : 'skills-update,needs-owner-review',
  };
}

export async function runSkillsUpdatePipeline({
  roots,
  stateDir,
  reportDir,
  lockPath,
  registryPath,
  skillsDir,
  workspaceRoot,
  proposeMr = false,
  gitlabApiUrl,
  projectId,
  gitlabToken,
  sourceBranch,
  targetBranch = 'main',
  fetchImpl = fetch,
}) {
  const { stagePath, staged } = await stageSkillUpdate({
    roots,
    stateDir,
    lockPath,
    registryPath,
    skillsDir,
    workspaceRoot,
  });

  const markdown = formatUpdateMarkdown(staged);
  let reportPath = null;
  let jsonPath = null;
  if (reportDir) {
    await mkdir(reportDir, { recursive: true });
    reportPath = resolve(reportDir, 'skills-update-report.md');
    jsonPath = resolve(reportDir, 'skills-update-staged.json');
    await writeFile(reportPath, markdown, 'utf8');
    await writeFile(jsonPath, `${JSON.stringify(staged, null, 2)}\n`, 'utf8');
  }

  let mrProposal = null;
  if (proposeMr && staged.diff.hasUpdates) {
    const branch = sourceBranch ?? `chore/skills-update-${staged.stageId}`;
    const payload = buildMrProposalPayload({
      staged,
      sourceBranch: branch,
      targetBranch,
      reportMarkdown: markdown,
    });
    if (gitlabApiUrl && projectId && gitlabToken) {
      const url = `${gitlabApiUrl.replace(/\/$/, '')}/projects/${encodeURIComponent(String(projectId))}/merge_requests`;
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'PRIVATE-TOKEN': gitlabToken,
        },
        body: JSON.stringify(payload),
      });
      mrProposal = {
        submitted: response.ok,
        status: response.status,
        payload,
      };
    } else {
      mrProposal = { submitted: false, reason: 'missing-gitlab-credentials', payload };
    }
  }

  return { stagePath, staged, markdown, reportPath, jsonPath, mrProposal };
}

async function main() {
  const reportDir =
    process.env.SKILLS_REPORT_DIR ?? resolve(process.cwd(), 'artifacts/skills-update');
  const stateDir = process.env.SKILLS_STATE_DIR ?? resolve(reportDir, 'state');
  const result = await runSkillsUpdatePipeline({
    roots: rootsFromEnv(process.env),
    stateDir,
    reportDir,
    workspaceRoot: process.cwd(),
    proposeMr: process.env.PROPOSE_MR === 'true',
    gitlabApiUrl: process.env.CI_API_V4_URL,
    projectId: process.env.CI_PROJECT_ID,
    gitlabToken: process.env.GITLAB_TOKEN,
    sourceBranch: process.env.SKILLS_UPDATE_BRANCH,
    targetBranch: process.env.CI_DEFAULT_BRANCH ?? 'main',
  });
  console.log(result.markdown);
  if (!result.staged.validation.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
