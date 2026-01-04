/**
 * CI Agent Spawner Service
 *
 * Spawns agents to fix CI failures automatically.
 * Called by the webhook handler when CI checks fail on PRs.
 *
 * Flow:
 * 1. App posts acknowledgment comment on the PR
 * 2. Finds a linked daemon for the repository
 * 3. Queues spawn command for the daemon
 * 4. Agent works and posts response comment
 */

import { db, CIFailureEvent, CIAnnotation, Repository } from '../db/index.js';
import { nangoService } from './nango.js';

/**
 * Get the GitHub App name for comments
 */
function getAppName(): string {
  return process.env.GITHUB_APP_NAME || 'Agent Relay';
}

/**
 * Post a CI failure acknowledgment comment on GitHub
 */
async function postCIAcknowledgmentComment(
  repository: Repository,
  prNumber: number,
  checkName: string,
  failureTitle: string | null
): Promise<{ id: number; url: string } | null> {
  if (!repository.nangoConnectionId) {
    console.warn(`[ci-spawner] Repository ${repository.githubFullName} has no Nango connection`);
    return null;
  }

  const [owner, repo] = repository.githubFullName.split('/');
  const appName = getAppName();

  const body = `🔴 **CI Failure Detected**

The \`${checkName}\` check has failed${failureTitle ? `: ${failureTitle}` : ''}.

I'm spawning an agent to investigate and fix this issue. The **@ci-fix** agent will analyze the failure and attempt to resolve it.

You'll be notified when the fix is ready or if manual intervention is needed.

_— ${appName}_`;

  try {
    const result = await nangoService.addGithubIssueComment(
      repository.nangoConnectionId,
      owner,
      repo,
      prNumber,
      body
    );
    console.log(`[ci-spawner] Posted CI acknowledgment comment: ${result.html_url}`);
    return { id: result.id, url: result.html_url };
  } catch (error) {
    console.error(`[ci-spawner] Failed to post CI acknowledgment comment:`, error);
    return null;
  }
}

/**
 * Post a completion comment on GitHub
 */
async function postCompletionComment(
  repository: Repository,
  prNumber: number,
  success: boolean,
  summary: string,
  commitSha?: string
): Promise<void> {
  if (!repository.nangoConnectionId) {
    return;
  }

  const [owner, repo] = repository.githubFullName.split('/');
  const appName = getAppName();

  let body: string;
  if (success) {
    body = `✅ **CI Fix Applied**

${summary}

${commitSha ? `**Commit:** ${commitSha.substring(0, 7)}` : ''}

Please review the changes and re-run the CI checks.

_— ${appName}_`;
  } else {
    body = `⚠️ **CI Fix Unsuccessful**

${summary}

Manual intervention may be required. Please check the failure details and fix the issue manually.

_— ${appName}_`;
  }

  try {
    await nangoService.addGithubIssueComment(
      repository.nangoConnectionId,
      owner,
      repo,
      prNumber,
      body
    );
    console.log(`[ci-spawner] Posted completion comment for PR #${prNumber}`);
  } catch (error) {
    console.error(`[ci-spawner] Failed to post completion comment:`, error);
  }
}

/**
 * Find a linked daemon that can handle this repository
 */
async function findAvailableDaemon(repository: Repository): Promise<{ id: string; userId: string } | null> {
  if (!repository.userId) {
    console.warn(`[ci-spawner] Repository ${repository.githubFullName} has no userId`);
    return null;
  }

  const daemons = await db.linkedDaemons.findByUserId(repository.userId);
  const onlineDaemon = daemons.find(d => d.status === 'online');

  if (!onlineDaemon) {
    console.warn(`[ci-spawner] No online daemon found for user ${repository.userId}`);
    return null;
  }

  return { id: onlineDaemon.id, userId: repository.userId };
}

/**
 * Queue a spawn command for a linked daemon
 */
async function queueSpawnCommand(
  daemonId: string,
  agentName: string,
  prompt: string,
  metadata: {
    failureEventId: string;
    fixAttemptId: string;
    repository: string;
    prNumber: number;
    checkName: string;
  }
): Promise<void> {
  const command = {
    type: 'spawn_agent',
    agentName,
    cli: 'claude',
    task: prompt,
    metadata,
    timestamp: new Date().toISOString(),
  };

  await db.linkedDaemons.queueMessage(daemonId, {
    from: { daemonId: 'cloud', daemonName: 'Agent Relay Cloud', agent: 'system' },
    to: '__spawner__',
    content: JSON.stringify(command),
    metadata: { type: 'spawn_command' },
    timestamp: new Date().toISOString(),
  });

  console.log(`[ci-spawner] Queued spawn command for daemon ${daemonId}`);
}

/**
 * Spawn an agent to fix CI failures
 *
 * This function:
 * 1. Finds the workspace for the repository
 * 2. Posts acknowledgment comment
 * 3. Creates a fix attempt record
 * 4. Queues spawn command for a linked daemon
 *
 * @param failureEvent - The CI failure event from the database
 */
export async function spawnCIFixAgent(failureEvent: CIFailureEvent): Promise<void> {
  console.log(`[ci-spawner] Spawning agent for failure: ${failureEvent.id}`);
  console.log(`[ci-spawner] Repository: ${failureEvent.repository}`);
  console.log(`[ci-spawner] Check: ${failureEvent.checkName}`);
  console.log(`[ci-spawner] PR: #${failureEvent.prNumber}`);

  // Only handle failures on PRs
  if (failureEvent.prNumber === null) {
    console.log(`[ci-spawner] Failure not on a PR, skipping`);
    return;
  }

  const prNumber = failureEvent.prNumber;

  // Find the repository
  const repository = await db.repositories.findByFullName(failureEvent.repository);
  if (!repository) {
    console.error(`[ci-spawner] Repository not found: ${failureEvent.repository}`);
    return;
  }

  // Generate agent name and ID
  const agentName = `ci-fix-${failureEvent.checkName.replace(/[^a-zA-Z0-9-]/g, '-')}-${prNumber}`;
  const agentId = `ci-${failureEvent.id}`;

  // Create fix attempt record
  const fixAttempt = await db.ciFixAttempts.create({
    failureEventId: failureEvent.id,
    agentId,
    agentName,
    status: 'pending',
  });

  console.log(`[ci-spawner] Created fix attempt: ${fixAttempt.id}`);

  try {
    // Step 1: Post acknowledgment comment
    await postCIAcknowledgmentComment(
      repository,
      prNumber,
      failureEvent.checkName,
      failureEvent.failureTitle
    );

    // Step 2: Find a linked daemon
    const daemon = await findAvailableDaemon(repository);

    if (!daemon) {
      console.warn(`[ci-spawner] No available daemon for ${failureEvent.repository}`);

      // Post a comment explaining the situation
      if (repository.nangoConnectionId) {
        const [owner, repo] = repository.githubFullName.split('/');
        try {
          await nangoService.addGithubIssueComment(
            repository.nangoConnectionId,
            owner,
            repo,
            prNumber,
            `⚠️ I couldn't spawn an agent to fix this CI failure because no Agent Relay daemon is available.

Please ensure you have a linked daemon running by executing \`agent-relay cloud link\` on your development machine.

You can also fix this issue manually by reviewing the failure output above.

_— ${getAppName()}_`
          );
        } catch (error) {
          console.error(`[ci-spawner] Failed to post error comment:`, error);
        }
      }

      await db.ciFixAttempts.complete(
        fixAttempt.id,
        'failed',
        undefined,
        'No available daemon to spawn agent'
      );
      return;
    }

    // Step 3: Build the agent prompt
    const prompt = buildAgentPrompt(failureEvent, repository);

    // Step 4: Update status to in_progress
    await db.ciFixAttempts.updateStatus(fixAttempt.id, 'in_progress');

    // Step 5: Queue spawn command for the daemon
    await queueSpawnCommand(daemon.id, agentName, prompt, {
      failureEventId: failureEvent.id,
      fixAttemptId: fixAttempt.id,
      repository: failureEvent.repository,
      prNumber,
      checkName: failureEvent.checkName,
    });

    console.log(`[ci-spawner] Successfully queued CI fix agent for ${failureEvent.repository}#${prNumber}`);

  } catch (error) {
    console.error(`[ci-spawner] Failed to spawn agent:`, error);
    await db.ciFixAttempts.complete(
      fixAttempt.id,
      'failed',
      undefined,
      error instanceof Error ? error.message : 'Unknown error'
    );
    throw error;
  }
}

/**
 * Build the prompt for the CI fix agent
 */
function buildAgentPrompt(failureEvent: CIFailureEvent, repository: Repository): string {
  const annotations = failureEvent.annotations as CIAnnotation[] | null;
  const annotationsList = annotations && annotations.length > 0
    ? annotations
        .slice(0, 20) // Limit to first 20 annotations
        .map(a => `- ${a.path}:${a.startLine} - ${a.message}`)
        .join('\n')
    : null;

  const responseInstructions = `
## Response Instructions

When you complete your work:
1. Commit and push your changes
2. Post a comment on the PR summarizing what you fixed

Use the GitHub CLI (\`gh\`) to post your response:
\`\`\`bash
gh pr comment ${failureEvent.prNumber} --repo ${failureEvent.repository} --body "## CI Fix Applied

Summary of changes...

**Files modified:**
- file1.ts
- file2.ts

Please re-run the CI checks to verify the fix."
\`\`\`
`;

  return `
# CI Failure Fix Task

A CI check has failed on PR #${failureEvent.prNumber} in ${failureEvent.repository}.

## Failure Details

**Check Name:** ${failureEvent.checkName}
**Branch:** ${failureEvent.branch || 'unknown'}
**Commit:** ${failureEvent.commitSha || 'unknown'}

${failureEvent.failureTitle ? `**Title:** ${failureEvent.failureTitle}` : ''}

${failureEvent.failureSummary ? `**Summary:**\n${failureEvent.failureSummary}` : ''}

${failureEvent.failureDetails ? `**Details:**\n${failureEvent.failureDetails}` : ''}

${annotationsList ? `## Annotations\n\n${annotationsList}` : ''}

## Your Task

1. Checkout the branch: \`${failureEvent.branch || 'unknown'}\`
2. Analyze the failure based on the annotations and error messages
3. Fix the issues in the affected files
4. Run the relevant checks locally to verify the fix
5. Commit and push your changes with a clear commit message
6. Report back with a summary of what was fixed

${responseInstructions}

## Important

- Only fix the specific issues causing the CI failure
- Do not refactor or improve unrelated code
- If you cannot fix the issue, explain why and what manual intervention is needed
- Keep your commit message descriptive and reference the CI check name
`.trim();
}

/**
 * Notify an existing agent about a CI failure
 *
 * Used when an agent is already working on a PR and a new failure occurs.
 *
 * @param agentId - The ID of the existing agent
 * @param failureEvent - The new CI failure event
 */
export async function notifyAgentOfCIFailure(
  agentId: string,
  failureEvent: CIFailureEvent
): Promise<void> {
  console.log(`[ci-spawner] Notifying agent ${agentId} of new failure`);

  // Find the repository
  const repository = await db.repositories.findByFullName(failureEvent.repository);
  if (!repository || !repository.userId) {
    console.warn(`[ci-spawner] Repository not found or has no userId: ${failureEvent.repository}`);
    return;
  }

  // Find the daemon that should have this agent
  const daemons = await db.linkedDaemons.findByUserId(repository.userId);
  const onlineDaemon = daemons.find(d => d.status === 'online');

  if (!onlineDaemon) {
    console.warn(`[ci-spawner] No online daemon to notify agent ${agentId}`);
    return;
  }

  // Build notification message
  const annotations = failureEvent.annotations as CIAnnotation[] | null;
  const annotationsList = annotations && annotations.length > 0
    ? annotations
        .slice(0, 10)
        .map(a => `  - ${a.path}:${a.startLine}: ${a.message}`)
        .join('\n')
    : null;

  const message = `
CI FAILURE: ${failureEvent.checkName}

${failureEvent.failureTitle || 'Check failed'}

${failureEvent.failureSummary || ''}

${annotationsList ? `Issues:\n${annotationsList}` : ''}

Please investigate and fix these issues, then push your changes.
`.trim();

  // Queue message for the agent via daemon
  await db.linkedDaemons.queueMessage(onlineDaemon.id, {
    from: { daemonId: 'cloud', daemonName: 'Agent Relay Cloud', agent: 'system' },
    to: agentId,
    content: message,
    metadata: { type: 'ci_failure_notification', failureEventId: failureEvent.id },
    timestamp: new Date().toISOString(),
  });

  console.log(`[ci-spawner] Queued CI failure notification for agent ${agentId}`);
}

/**
 * Mark a fix attempt as complete
 *
 * Called when an agent reports completion (success or failure)
 */
export async function completeFixAttempt(
  fixAttemptId: string,
  success: boolean,
  commitSha?: string,
  errorMessage?: string
): Promise<void> {
  console.log(`[ci-spawner] Completing fix attempt ${fixAttemptId}: ${success ? 'success' : 'failed'}`);

  // Update the fix attempt record
  await db.ciFixAttempts.complete(
    fixAttemptId,
    success ? 'success' : 'failed',
    commitSha,
    errorMessage
  );

  // Get the fix attempt to find the failure event
  const fixAttempt = await db.ciFixAttempts.findById(fixAttemptId);
  if (!fixAttempt) {
    console.warn(`[ci-spawner] Fix attempt not found: ${fixAttemptId}`);
    return;
  }

  // Get the failure event to find the repository and PR
  const failureEvent = await db.ciFailureEvents.findById(fixAttempt.failureEventId);
  if (!failureEvent) {
    console.warn(`[ci-spawner] Failure event not found: ${fixAttempt.failureEventId}`);
    return;
  }

  // Find the repository to post completion comment
  const repository = await db.repositories.findByFullName(failureEvent.repository);
  if (repository && failureEvent.prNumber !== null) {
    const summary = success
      ? `The @ci-fix agent has fixed the \`${failureEvent.checkName}\` check failure.`
      : errorMessage || 'The @ci-fix agent was unable to fix the issue.';

    await postCompletionComment(
      repository,
      failureEvent.prNumber,
      success,
      summary,
      commitSha
    );
  }
}

/**
 * Get failure history for a repository
 */
export async function getFailureHistory(
  repository: string,
  limit = 50
): Promise<CIFailureEvent[]> {
  return db.ciFailureEvents.findByRepository(repository, limit);
}

/**
 * Get failure history for a specific PR
 */
export async function getPRFailureHistory(
  repository: string,
  prNumber: number
): Promise<CIFailureEvent[]> {
  return db.ciFailureEvents.findByPR(repository, prNumber);
}
