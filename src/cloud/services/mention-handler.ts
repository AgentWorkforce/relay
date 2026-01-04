/**
 * Mention Handler Service
 *
 * Handles @mentions of agents in GitHub issues and PR comments.
 * Routes mentions to appropriate agents for response.
 *
 * Flow:
 * 1. App posts acknowledgment comment
 * 2. Finds a linked daemon for the repository
 * 3. Queues spawn command for the daemon
 * 4. Agent works and posts response comment
 */

import { db, CommentMention, IssueAssignment, Repository } from '../db/index.js';
import { nangoService } from './nango.js';

/**
 * Known agent types that can be mentioned
 */
export const KNOWN_AGENTS = {
  // Generic agents
  'agent-relay': 'General purpose agent for any task',
  'lead': 'Lead agent for coordination and delegation',
  'developer': 'Developer agent for coding tasks',
  'reviewer': 'Code review agent',

  // Specialized agents
  'ci-fix': 'CI failure fixing agent',
  'debugger': 'Bug investigation and fixing agent',
  'docs': 'Documentation agent',
  'test': 'Test writing agent',
  'refactor': 'Code refactoring agent',
} as const;

export type KnownAgentType = keyof typeof KNOWN_AGENTS;

/**
 * Check if a mention is for a known agent type
 */
export function isKnownAgent(mention: string): mention is KnownAgentType {
  return mention in KNOWN_AGENTS;
}

/**
 * Get the GitHub App name for comments
 */
function getAppName(): string {
  return process.env.GITHUB_APP_NAME || 'Agent Relay';
}

/**
 * Post an acknowledgment comment on GitHub
 */
async function postAcknowledgmentComment(
  repository: Repository,
  issueNumber: number,
  mentionedAgent: string,
  authorLogin: string
): Promise<{ id: number; url: string } | null> {
  if (!repository.nangoConnectionId) {
    console.warn(`[mention-handler] Repository ${repository.githubFullName} has no Nango connection`);
    return null;
  }

  const [owner, repo] = repository.githubFullName.split('/');
  const appName = getAppName();
  const agentDescription = isKnownAgent(mentionedAgent)
    ? KNOWN_AGENTS[mentionedAgent]
    : 'Custom agent';

  const body = `👋 @${authorLogin}, I've received your request and am routing it to **@${mentionedAgent}** (${agentDescription}).

The agent will respond shortly. You can track progress in this thread.

_— ${appName}_`;

  try {
    const result = await nangoService.addGithubIssueComment(
      repository.nangoConnectionId,
      owner,
      repo,
      issueNumber,
      body
    );
    console.log(`[mention-handler] Posted acknowledgment comment: ${result.html_url}`);
    return { id: result.id, url: result.html_url };
  } catch (error) {
    console.error(`[mention-handler] Failed to post acknowledgment comment:`, error);
    return null;
  }
}

/**
 * Find a linked daemon that can handle this repository
 */
async function findAvailableDaemon(repository: Repository): Promise<{ id: string; userId: string } | null> {
  // The daemon must belong to the repository owner
  if (!repository.userId) {
    console.warn(`[mention-handler] Repository ${repository.githubFullName} has no userId`);
    return null;
  }

  const daemons = await db.linkedDaemons.findByUserId(repository.userId);
  const onlineDaemon = daemons.find(d => d.status === 'online');

  if (!onlineDaemon) {
    console.warn(`[mention-handler] No online daemon found for user ${repository.userId}`);
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
    mentionId: string;
    repository: string;
    issueNumber: number;
    authorLogin: string;
  }
): Promise<void> {
  const command = {
    type: 'spawn_agent',
    agentName,
    cli: 'claude', // Default to Claude CLI
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

  console.log(`[mention-handler] Queued spawn command for daemon ${daemonId}`);
}

/**
 * Handle a mention record
 *
 * This function:
 * 1. Validates the mention is for a known agent
 * 2. Posts an acknowledgment comment
 * 3. Finds a linked daemon
 * 4. Queues a spawn command for the agent
 */
export async function handleMention(mention: CommentMention): Promise<void> {
  console.log(`[mention-handler] Processing mention: @${mention.mentionedAgent} in ${mention.repository}`);

  // Check if this is a known agent type
  if (!isKnownAgent(mention.mentionedAgent)) {
    console.log(`[mention-handler] Unknown agent: @${mention.mentionedAgent}, checking workspace config`);
    // TODO: Check workspace configuration for custom agent names
    // For now, mark as ignored
    await db.commentMentions.markIgnored(mention.id);
    return;
  }

  // Find the repository to get Nango connection
  const repository = await db.repositories.findByFullName(mention.repository);
  if (!repository) {
    console.error(`[mention-handler] Repository not found: ${mention.repository}`);
    await db.commentMentions.markIgnored(mention.id);
    return;
  }

  // Generate agent info
  const agentId = `mention-${mention.id}`;
  const agentName = `${mention.mentionedAgent}-${mention.issueOrPrNumber}`;

  // Update status to processing
  await db.commentMentions.markProcessing(mention.id, agentId, agentName);

  // Step 1: Post acknowledgment comment
  const ackResult = await postAcknowledgmentComment(
    repository,
    mention.issueOrPrNumber,
    mention.mentionedAgent,
    mention.authorLogin
  );

  if (!ackResult) {
    console.warn(`[mention-handler] Could not post acknowledgment, continuing anyway`);
  }

  // Step 2: Find a linked daemon
  const daemon = await findAvailableDaemon(repository);

  if (!daemon) {
    console.warn(`[mention-handler] No available daemon for ${mention.repository}`);
    // Post a comment explaining the situation
    if (repository.nangoConnectionId) {
      const [owner, repo] = repository.githubFullName.split('/');
      try {
        await nangoService.addGithubIssueComment(
          repository.nangoConnectionId,
          owner,
          repo,
          mention.issueOrPrNumber,
          `⚠️ @${mention.authorLogin}, I couldn't find an available agent to handle this request. Please ensure you have a linked Agent Relay daemon running.

You can set this up by running \`agent-relay cloud link\` on your development machine.

_— ${getAppName()}_`
        );
      } catch (error) {
        console.error(`[mention-handler] Failed to post error comment:`, error);
      }
    }
    return;
  }

  // Step 3: Build the prompt for the agent
  const prompt = buildMentionPrompt(mention, repository);

  // Step 4: Queue spawn command for the daemon
  await queueSpawnCommand(daemon.id, agentName, prompt, {
    mentionId: mention.id,
    repository: mention.repository,
    issueNumber: mention.issueOrPrNumber,
    authorLogin: mention.authorLogin,
  });

  console.log(`[mention-handler] Spawned agent @${mention.mentionedAgent} for mention ${mention.id}`);
}

/**
 * Build a prompt for handling a mention
 */
function buildMentionPrompt(mention: CommentMention, repository: Repository): string {
  const agentDescription = isKnownAgent(mention.mentionedAgent)
    ? KNOWN_AGENTS[mention.mentionedAgent]
    : 'Custom agent';

  const sourceTypeDescription = {
    issue_comment: 'GitHub issue comment',
    pr_comment: 'GitHub PR comment',
    pr_review: 'GitHub PR review comment',
  }[mention.sourceType] || 'GitHub comment';

  const responseInstructions = `
## Response Instructions

When you complete your work:
1. Post a comment on GitHub to notify @${mention.authorLogin}
2. Reference specific files and line numbers when relevant
3. If you made code changes, push them and reference the commit

Use the GitHub CLI (\`gh\`) to post your response:
\`\`\`bash
gh issue comment ${mention.issueOrPrNumber} --repo ${mention.repository} --body "Your response here @${mention.authorLogin}"
\`\`\`

Or for PR comments:
\`\`\`bash
gh pr comment ${mention.issueOrPrNumber} --repo ${mention.repository} --body "Your response here @${mention.authorLogin}"
\`\`\`
`;

  return `
# Agent Mention Task

You (@${mention.mentionedAgent}) have been mentioned in a ${sourceTypeDescription}.

## Your Role
${agentDescription}

## Context

**Repository:** ${mention.repository}
**Issue/PR:** #${mention.issueOrPrNumber}
**Comment by:** @${mention.authorLogin}
**Comment URL:** ${mention.commentUrl || 'N/A'}

## Comment

${mention.commentBody}

## Your Task

Analyze the comment and respond appropriately:

1. If a question was asked, provide a helpful answer
2. If a task was requested, either complete it or explain what's needed
3. If feedback was given, acknowledge it and act on it if needed

${responseInstructions}

## Important

- Be concise and helpful
- If you need to make code changes, create a commit and push
- If the request is unclear, ask for clarification in your response
- Always @mention ${mention.authorLogin} in your response so they get notified
`.trim();
}

/**
 * Handle an issue assignment
 *
 * Called when an issue should be assigned to an agent
 */
export async function handleIssueAssignment(assignment: IssueAssignment): Promise<void> {
  console.log(`[mention-handler] Processing issue assignment: #${assignment.issueNumber} in ${assignment.repository}`);

  // Find the repository
  const repository = await db.repositories.findByFullName(assignment.repository);
  if (!repository) {
    console.error(`[mention-handler] Repository not found: ${assignment.repository}`);
    return;
  }

  // Post acknowledgment comment
  if (repository.nangoConnectionId) {
    const [owner, repo] = repository.githubFullName.split('/');
    try {
      await nangoService.addGithubIssueComment(
        repository.nangoConnectionId,
        owner,
        repo,
        assignment.issueNumber,
        `🤖 I've been assigned to work on this issue. I'll analyze the problem and get started.

You can track my progress in this thread. I'll update you when I have a solution or need more information.

_— ${getAppName()}_`
      );
    } catch (error) {
      console.error(`[mention-handler] Failed to post assignment comment:`, error);
    }
  }

  // Find a linked daemon
  const daemon = await findAvailableDaemon(repository);

  if (!daemon) {
    console.warn(`[mention-handler] No available daemon for ${assignment.repository}`);
    if (repository.nangoConnectionId) {
      const [owner, repo] = repository.githubFullName.split('/');
      try {
        await nangoService.addGithubIssueComment(
          repository.nangoConnectionId,
          owner,
          repo,
          assignment.issueNumber,
          `⚠️ I couldn't start working on this issue because no Agent Relay daemon is available.

Please ensure you have a linked daemon running by executing \`agent-relay cloud link\` on your development machine.

_— ${getAppName()}_`
        );
      } catch (error) {
        console.error(`[mention-handler] Failed to post error comment:`, error);
      }
    }
    return;
  }

  // Build prompt for the issue
  const prompt = buildIssuePrompt(assignment, repository);

  // Queue spawn command
  const agentName = `issue-${assignment.issueNumber}`;
  await queueSpawnCommand(daemon.id, agentName, prompt, {
    mentionId: assignment.id,
    repository: assignment.repository,
    issueNumber: assignment.issueNumber,
    authorLogin: 'issue-author', // TODO: Get from issue
  });

  // Update assignment status and assign agent
  await db.issueAssignments.assignAgent(assignment.id, agentName, agentName);
  await db.issueAssignments.updateStatus(assignment.id, 'in_progress');

  console.log(`[mention-handler] Spawned agent for issue #${assignment.issueNumber}`);
}

/**
 * Build a prompt for an issue assignment
 */
function buildIssuePrompt(assignment: IssueAssignment, repository: Repository): string {
  const priorityNote = assignment.priority
    ? `\n**Priority:** ${assignment.priority.toUpperCase()}`
    : '';

  const labelsNote = assignment.labels && assignment.labels.length > 0
    ? `\n**Labels:** ${assignment.labels.join(', ')}`
    : '';

  return `
# Issue Assignment

You have been assigned to work on GitHub issue #${assignment.issueNumber}.

## Issue Details

**Repository:** ${assignment.repository}
**Title:** ${assignment.issueTitle}${priorityNote}${labelsNote}
**URL:** ${assignment.issueUrl || 'N/A'}

## Description

${assignment.issueBody || 'No description provided.'}

## Your Task

1. Analyze the issue and understand what needs to be done
2. Investigate the codebase to find relevant files
3. Implement a solution if possible
4. Create a PR with your changes
5. Link the PR to this issue

## Response Instructions

Keep the issue updated with your progress:
\`\`\`bash
gh issue comment ${assignment.issueNumber} --repo ${assignment.repository} --body "Your update here"
\`\`\`

When you create a PR:
\`\`\`bash
gh pr create --repo ${assignment.repository} --title "Fix #${assignment.issueNumber}: Brief description" --body "Fixes #${assignment.issueNumber}

Description of changes..."
\`\`\`

## Important

- Start with a comment on the issue acknowledging you're working on it
- If you need clarification, ask in the issue comments
- Create a draft PR early if the fix is complex
- Reference the issue number in your commit messages (e.g., "Fix #${assignment.issueNumber}")
`.trim();
}

/**
 * Get pending mentions for processing
 */
export async function getPendingMentions(limit = 50): Promise<CommentMention[]> {
  return db.commentMentions.findPending(limit);
}

/**
 * Get pending issue assignments for processing
 */
export async function getPendingIssueAssignments(limit = 50): Promise<IssueAssignment[]> {
  return db.issueAssignments.findPending(limit);
}

/**
 * Process all pending mentions (background job)
 */
export async function processPendingMentions(): Promise<number> {
  const pending = await getPendingMentions();
  let processed = 0;

  for (const mention of pending) {
    try {
      await handleMention(mention);
      processed++;
    } catch (error) {
      console.error(`[mention-handler] Failed to process mention ${mention.id}:`, error);
    }
  }

  return processed;
}

/**
 * Process all pending issue assignments (background job)
 */
export async function processPendingIssueAssignments(): Promise<number> {
  const pending = await getPendingIssueAssignments();
  let processed = 0;

  for (const assignment of pending) {
    try {
      await handleIssueAssignment(assignment);
      processed++;
    } catch (error) {
      console.error(`[mention-handler] Failed to process assignment ${assignment.id}:`, error);
    }
  }

  return processed;
}
