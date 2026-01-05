/**
 * Webhook API Routes
 *
 * Handles GitHub App webhooks for installation events.
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getConfig } from '../config.js';
import { db } from '../db/index.js';

export const webhooksRouter = Router();

// GitHub webhook signature verification
function verifyGitHubSignature(payload: string, signature: string | undefined): boolean {
  if (!signature) return false;

  const config = getConfig();
  const secret = config.github.webhookSecret || config.github.clientSecret;

  const expectedSignature = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')}`;

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

/**
 * POST /api/webhooks/github
 * Handle GitHub App webhook events
 */
webhooksRouter.post('/github', async (req: Request, res: Response) => {
  const signature = req.get('x-hub-signature-256');
  const event = req.get('x-github-event');
  const deliveryId = req.get('x-github-delivery');

  // Get raw body for signature verification
  // Note: This requires raw body middleware to be set up
  const rawBody = JSON.stringify(req.body);

  // Verify signature
  if (!verifyGitHubSignature(rawBody, signature)) {
    console.error(`[webhook] Invalid signature for delivery ${deliveryId}`);
    return res.status(401).json({ error: 'Invalid signature' });
  }

  console.log(`[webhook] Received ${event} event (delivery: ${deliveryId})`);

  try {
    switch (event) {
      case 'installation':
        await handleInstallationEvent(req.body);
        break;

      case 'installation_repositories':
        await handleInstallationRepositoriesEvent(req.body);
        break;

      case 'push':
        // Future: trigger sync for push events
        console.log(`[webhook] Push to ${req.body.repository?.full_name}`);
        break;

      case 'pull_request':
        // Future: handle PR events
        console.log(`[webhook] PR ${req.body.action} on ${req.body.repository?.full_name}`);
        break;

      case 'issues':
        await handleIssueEvent(req.body);
        break;

      case 'issue_comment':
        await handleIssueCommentEvent(req.body);
        break;

      case 'pull_request_review_comment':
        await handlePRReviewCommentEvent(req.body);
        break;

      case 'check_run':
        await handleCheckRunEvent(req.body);
        break;

      case 'workflow_run':
        await handleWorkflowRunEvent(req.body);
        break;

      default:
        console.log(`[webhook] Unhandled event: ${event}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error(`[webhook] Error processing ${event}:`, error);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});

/**
 * Handle installation events (created, deleted, suspended, etc.)
 */
async function handleInstallationEvent(payload: {
  action: string;
  installation: {
    id: number;
    account: {
      login: string;
      id: number;
      type: string;
    };
    permissions: Record<string, string>;
    events: string[];
    suspended_at: string | null;
    suspended_by?: { login: string };
  };
  sender: {
    id: number;
    login: string;
  };
  repositories?: Array<{
    id: number;
    full_name: string;
    private: boolean;
  }>;
}): Promise<void> {
  const { action, installation, sender, repositories } = payload;
  const installationId = String(installation.id);

  console.log(
    `[webhook] Installation ${action}: ${installation.account.login} (${installationId})`
  );

  switch (action) {
    case 'created': {
      // Find the user by their GitHub ID (the sender who installed the app)
      const user = await db.users.findByGithubId(String(sender.id));

      // Create/update the installation record
      await db.githubInstallations.upsert({
        installationId,
        accountType: installation.account.type.toLowerCase(),
        accountLogin: installation.account.login,
        accountId: String(installation.account.id),
        installedById: user?.id ?? null,
        permissions: installation.permissions,
        events: installation.events,
      });

      // If repositories were included, sync them
      if (repositories && user) {
        for (const repo of repositories) {
          const dbInstallation = await db.githubInstallations.findByInstallationId(installationId);
          if (dbInstallation) {
            await db.repositories.upsert({
              userId: user.id,
              githubFullName: repo.full_name,
              githubId: repo.id,
              isPrivate: repo.private,
              installationId: dbInstallation.id,
              syncStatus: 'synced',
              lastSyncedAt: new Date(),
            });
          }
        }
      }

      console.log(`[webhook] Created installation for ${installation.account.login}`);
      break;
    }

    case 'deleted': {
      // Remove the installation
      await db.githubInstallations.delete(installationId);
      console.log(`[webhook] Deleted installation for ${installation.account.login}`);
      break;
    }

    case 'suspend': {
      await db.githubInstallations.suspend(
        installationId,
        installation.suspended_by?.login || 'unknown'
      );
      console.log(`[webhook] Suspended installation for ${installation.account.login}`);
      break;
    }

    case 'unsuspend': {
      await db.githubInstallations.unsuspend(installationId);
      console.log(`[webhook] Unsuspended installation for ${installation.account.login}`);
      break;
    }

    case 'new_permissions_accepted': {
      // Update permissions
      await db.githubInstallations.updatePermissions(
        installationId,
        installation.permissions,
        installation.events
      );
      console.log(`[webhook] Updated permissions for ${installation.account.login}`);
      break;
    }

    default:
      console.log(`[webhook] Unhandled installation action: ${action}`);
  }
}

/**
 * Handle installation_repositories events (added/removed repos)
 */
async function handleInstallationRepositoriesEvent(payload: {
  action: 'added' | 'removed';
  installation: {
    id: number;
    account: { login: string };
  };
  repositories_added?: Array<{
    id: number;
    full_name: string;
    private: boolean;
  }>;
  repositories_removed?: Array<{
    id: number;
    full_name: string;
  }>;
  sender: {
    id: number;
    login: string;
  };
}): Promise<void> {
  const { action, installation, repositories_added, repositories_removed, sender } = payload;
  const installationId = String(installation.id);

  console.log(
    `[webhook] Repositories ${action} for ${installation.account.login}`
  );

  // Find the installation in our database
  const dbInstallation = await db.githubInstallations.findByInstallationId(installationId);
  if (!dbInstallation) {
    console.error(`[webhook] Installation ${installationId} not found in database`);
    return;
  }

  // Get the user who triggered this (should be the installedBy user)
  const user = await db.users.findByGithubId(String(sender.id));
  if (!user) {
    console.error(`[webhook] User ${sender.login} not found in database`);
    return;
  }

  if (action === 'added' && repositories_added) {
    for (const repo of repositories_added) {
      await db.repositories.upsert({
        userId: user.id,
        githubFullName: repo.full_name,
        githubId: repo.id,
        isPrivate: repo.private,
        installationId: dbInstallation.id,
        syncStatus: 'synced',
        lastSyncedAt: new Date(),
      });
    }
    console.log(`[webhook] Added ${repositories_added.length} repositories`);
  }

  if (action === 'removed' && repositories_removed) {
    // We don't delete repos, just remove the installation link
    // This preserves any user config while showing the repo is no longer accessible
    for (const repo of repositories_removed) {
      // Find the repo and clear its installation reference
      const repos = await db.repositories.findByUserId(user.id);
      const existingRepo = repos.find(r => r.githubFullName === repo.full_name);
      if (existingRepo) {
        // Update sync status to indicate repo access was removed
        await db.repositories.updateSyncStatus(existingRepo.id, 'access_removed');
      }
    }
    console.log(`[webhook] Removed access to ${repositories_removed.length} repositories`);
  }
}

// ============================================================================
// CI Failure Webhook Handlers
// ============================================================================

/**
 * Check run payload from GitHub webhook
 */
interface CheckRunPayload {
  action: string;
  check_run: {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    output: {
      title: string | null;
      summary: string | null;
      text?: string | null;
      annotations?: Array<{
        path: string;
        start_line: number;
        end_line: number;
        annotation_level: string;
        message: string;
      }>;
    };
    pull_requests: Array<{
      number: number;
      head: { ref: string; sha: string };
    }>;
  };
  repository: {
    full_name: string;
    clone_url: string;
  };
}

/**
 * Workflow run payload from GitHub webhook
 */
interface WorkflowRunPayload {
  action: string;
  workflow_run: {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    head_branch: string;
    head_sha: string;
    pull_requests: Array<{
      number: number;
    }>;
  };
  repository: {
    full_name: string;
  };
}

/**
 * Handle check_run webhook events
 *
 * When a CI check fails on a PR, we:
 * 1. Record the failure in our database
 * 2. Check if an agent is already working on the PR
 * 3. Either message the existing agent or spawn a new one
 */
async function handleCheckRunEvent(payload: CheckRunPayload): Promise<void> {
  const { action, check_run, repository } = payload;

  // Only handle completed checks
  if (action !== 'completed') {
    console.log(`[webhook] Ignoring check_run action: ${action}`);
    return;
  }

  // Only handle failures
  if (check_run.conclusion !== 'failure') {
    console.log(`[webhook] Check ${check_run.name} conclusion: ${check_run.conclusion} (not a failure)`);
    return;
  }

  // Only handle checks on PRs
  if (check_run.pull_requests.length === 0) {
    console.log(`[webhook] Check ${check_run.name} failed but not on a PR, skipping`);
    return;
  }

  const pr = check_run.pull_requests[0];

  console.log(
    `[webhook] CI failure: ${check_run.name} on ${repository.full_name}#${pr.number}`
  );

  // Build failure context
  const failureContext = {
    repository: repository.full_name,
    prNumber: pr.number,
    branch: pr.head.ref,
    commitSha: pr.head.sha,
    checkName: check_run.name,
    checkId: check_run.id,
    conclusion: check_run.conclusion,
    failureTitle: check_run.output.title,
    failureSummary: check_run.output.summary,
    failureDetails: check_run.output.text,
    annotations: (check_run.output.annotations || []).map(a => ({
      path: a.path,
      startLine: a.start_line,
      endLine: a.end_line,
      annotationLevel: a.annotation_level,
      message: a.message,
    })),
  };

  // Record the failure in the database
  try {
    const failureEvent = await db.ciFailureEvents.create({
      repository: failureContext.repository,
      prNumber: failureContext.prNumber,
      branch: failureContext.branch,
      commitSha: failureContext.commitSha,
      checkName: failureContext.checkName,
      checkId: failureContext.checkId,
      conclusion: failureContext.conclusion,
      failureTitle: failureContext.failureTitle,
      failureSummary: failureContext.failureSummary,
      failureDetails: failureContext.failureDetails,
      annotations: failureContext.annotations,
    });

    console.log(`[webhook] Recorded CI failure event: ${failureEvent.id}`);

    // Check for existing active fix attempts on this repo
    const activeAttempts = await db.ciFixAttempts.findActiveByRepository(repository.full_name);

    if (activeAttempts.length > 0) {
      console.log(`[webhook] ${activeAttempts.length} active fix attempt(s) already exist, skipping spawn`);
      await db.ciFailureEvents.markProcessed(failureEvent.id, false);
      return;
    }

    // Import and call the CI agent spawner (lazy import to avoid circular deps)
    const { spawnCIFixAgent } = await import('../services/ci-agent-spawner.js');
    await spawnCIFixAgent(failureEvent);

    // Mark as processed with agent spawned
    await db.ciFailureEvents.markProcessed(failureEvent.id, true);
    console.log(`[webhook] Agent spawned for CI failure: ${failureEvent.id}`);
  } catch (error) {
    console.error(`[webhook] Failed to handle CI failure:`, error);
    // Don't re-throw - we still want to return 200 to GitHub
  }
}

/**
 * Handle workflow_run webhook events
 *
 * This handles the entire workflow completion. Useful for:
 * - Waiting for all checks to complete before acting
 * - Getting workflow-level context
 */
async function handleWorkflowRunEvent(payload: WorkflowRunPayload): Promise<void> {
  const { action, workflow_run, repository } = payload;

  // Only handle completed workflows
  if (action !== 'completed') {
    console.log(`[webhook] Ignoring workflow_run action: ${action}`);
    return;
  }

  // Only handle failures
  if (workflow_run.conclusion !== 'failure') {
    console.log(`[webhook] Workflow ${workflow_run.name} conclusion: ${workflow_run.conclusion}`);
    return;
  }

  // Log for now - we primarily handle individual check_runs
  // but workflow_run events can be used for aggregate failure handling
  console.log(
    `[webhook] Workflow failed: ${workflow_run.name} on ${repository.full_name} ` +
    `(branch: ${workflow_run.head_branch}, PRs: ${workflow_run.pull_requests.map(p => p.number).join(', ')})`
  );

  // Future: Could use this to trigger workflow-level actions
  // For now, individual check_run events handle the actual failure processing
}

// ============================================================================
// Issue and Comment Webhook Handlers
// ============================================================================

/**
 * Issue payload from GitHub webhook
 */
interface IssuePayload {
  action: string; // opened, edited, closed, reopened, assigned, unassigned, labeled, unlabeled
  issue: {
    id: number;
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state: string;
    labels: Array<{ name: string }>;
    user: { login: string; id: number };
    assignees: Array<{ login: string; id: number }>;
  };
  repository: {
    full_name: string;
  };
  sender: {
    login: string;
    id: number;
  };
}

/**
 * Issue comment payload from GitHub webhook
 */
interface IssueCommentPayload {
  action: string; // created, edited, deleted
  issue: {
    number: number;
    title: string;
    pull_request?: { url: string }; // Present if this is a PR comment
  };
  comment: {
    id: number;
    body: string;
    html_url: string;
    user: { login: string; id: number };
  };
  repository: {
    full_name: string;
  };
  sender: {
    login: string;
    id: number;
  };
}

/**
 * PR review comment payload from GitHub webhook
 */
interface PRReviewCommentPayload {
  action: string; // created, edited, deleted
  pull_request: {
    number: number;
    title: string;
  };
  comment: {
    id: number;
    body: string;
    html_url: string;
    path: string;
    line: number | null;
    user: { login: string; id: number };
  };
  repository: {
    full_name: string;
  };
  sender: {
    login: string;
    id: number;
  };
}

/**
 * Extract @mentions from comment text
 * Returns list of mentioned agent names (without @ prefix)
 */
function extractMentions(text: string): string[] {
  // Match @agent-name patterns (alphanumeric, hyphens, underscores)
  const mentionPattern = /@([a-zA-Z][a-zA-Z0-9_-]*)/g;
  const mentions: string[] = [];
  let match;

  while ((match = mentionPattern.exec(text)) !== null) {
    mentions.push(match[1].toLowerCase());
  }

  return [...new Set(mentions)]; // Remove duplicates
}

/**
 * Get context around a mention (for prompt building)
 */
function getMentionContext(text: string, mention: string, contextLength = 200): string {
  const mentionIndex = text.toLowerCase().indexOf(`@${mention.toLowerCase()}`);
  if (mentionIndex === -1) return text.slice(0, contextLength);

  const start = Math.max(0, mentionIndex - contextLength / 2);
  const end = Math.min(text.length, mentionIndex + mention.length + 1 + contextLength / 2);

  let context = text.slice(start, end);
  if (start > 0) context = '...' + context;
  if (end < text.length) context = context + '...';

  return context;
}

/**
 * Handle issues webhook events
 *
 * When a new issue is opened or labeled, we can:
 * 1. Auto-assign an agent based on labels
 * 2. Record the issue for later assignment
 */
async function handleIssueEvent(payload: IssuePayload): Promise<void> {
  const { action, issue, repository } = payload;

  console.log(`[webhook] Issue ${action}: #${issue.number} on ${repository.full_name}`);

  // Only handle opened issues for now
  if (action !== 'opened' && action !== 'labeled') {
    return;
  }

  try {
    // Check if we already have an assignment for this issue
    const existing = await db.issueAssignments.findByIssue(repository.full_name, issue.number);
    if (existing) {
      console.log(`[webhook] Issue #${issue.number} already has an assignment`);
      return;
    }

    // Determine priority based on labels
    const labels = issue.labels.map(l => l.name.toLowerCase());
    let priority: string | undefined;
    if (labels.includes('critical') || labels.includes('p0')) priority = 'critical';
    else if (labels.includes('high') || labels.includes('p1')) priority = 'high';
    else if (labels.includes('medium') || labels.includes('p2')) priority = 'medium';
    else if (labels.includes('low') || labels.includes('p3')) priority = 'low';

    // Create issue assignment record
    const assignment = await db.issueAssignments.create({
      repository: repository.full_name,
      issueNumber: issue.number,
      issueTitle: issue.title,
      issueBody: issue.body,
      issueUrl: issue.html_url,
      status: 'pending',
      labels: issue.labels.map(l => l.name),
      priority,
    });

    console.log(`[webhook] Created issue assignment: ${assignment.id}`);

    // Check if we should auto-assign an agent
    // TODO: Load repo configuration for auto-assign settings
    // For now, issues remain in 'pending' status for manual assignment

  } catch (error) {
    console.error(`[webhook] Failed to handle issue event:`, error);
  }
}

/**
 * Handle issue_comment webhook events
 *
 * When someone @mentions an agent in a comment:
 * 1. Detect the mention
 * 2. Record it for agent processing
 * 3. Route to appropriate agent
 */
async function handleIssueCommentEvent(payload: IssueCommentPayload): Promise<void> {
  const { action, issue, comment, repository, sender } = payload;

  // Only handle new comments
  if (action !== 'created') {
    return;
  }

  const isPR = !!issue.pull_request;
  const sourceType = isPR ? 'pr_comment' : 'issue_comment';

  console.log(
    `[webhook] ${sourceType} on ${repository.full_name}#${issue.number} by @${sender.login}`
  );

  // Extract @mentions from comment
  const mentions = extractMentions(comment.body);
  if (mentions.length === 0) {
    return; // No mentions to process
  }

  console.log(`[webhook] Found mentions: ${mentions.join(', ')}`);

  try {
    for (const mention of mentions) {
      // Check if this is a known agent mention
      // TODO: Load configured agents from repo/workspace settings
      // For now, we accept any mention that looks like an agent name

      const context = getMentionContext(comment.body, mention);

      // Create mention record
      const mentionRecord = await db.commentMentions.create({
        repository: repository.full_name,
        sourceType,
        sourceId: comment.id,
        issueOrPrNumber: issue.number,
        commentBody: comment.body,
        commentUrl: comment.html_url,
        authorLogin: sender.login,
        authorId: sender.id,
        mentionedAgent: mention,
        mentionContext: context,
        status: 'pending',
      });

      console.log(`[webhook] Created mention record for @${mention}: ${mentionRecord.id}`);

      // Import and call the mention handler (lazy import)
      try {
        const { handleMention } = await import('../services/mention-handler.js');
        await handleMention(mentionRecord);
      } catch (_importError) {
        // Handler not implemented yet - mentions will be processed later
        console.log(`[webhook] Mention handler not available, mention queued for later processing`);
      }
    }
  } catch (error) {
    console.error(`[webhook] Failed to handle comment mentions:`, error);
  }
}

/**
 * Handle pull_request_review_comment webhook events
 *
 * Similar to issue_comment, but for PR review comments (inline code comments)
 */
async function handlePRReviewCommentEvent(payload: PRReviewCommentPayload): Promise<void> {
  const { action, pull_request, comment, repository, sender } = payload;

  // Only handle new comments
  if (action !== 'created') {
    return;
  }

  console.log(
    `[webhook] PR review comment on ${repository.full_name}#${pull_request.number} ` +
    `(${comment.path}:${comment.line}) by @${sender.login}`
  );

  // Extract @mentions from comment
  const mentions = extractMentions(comment.body);
  if (mentions.length === 0) {
    return; // No mentions to process
  }

  console.log(`[webhook] Found mentions in review comment: ${mentions.join(', ')}`);

  try {
    for (const mention of mentions) {
      const context = getMentionContext(comment.body, mention);

      // Create mention record
      const mentionRecord = await db.commentMentions.create({
        repository: repository.full_name,
        sourceType: 'pr_review',
        sourceId: comment.id,
        issueOrPrNumber: pull_request.number,
        commentBody: comment.body,
        commentUrl: comment.html_url,
        authorLogin: sender.login,
        authorId: sender.id,
        mentionedAgent: mention,
        mentionContext: `${comment.path}:${comment.line || '?'}\n\n${context}`,
        status: 'pending',
      });

      console.log(`[webhook] Created review mention for @${mention}: ${mentionRecord.id}`);

      // Try to handle mention immediately
      try {
        const { handleMention } = await import('../services/mention-handler.js');
        await handleMention(mentionRecord);
      } catch {
        console.log(`[webhook] Mention handler not available, mention queued for later processing`);
      }
    }
  } catch (error) {
    console.error(`[webhook] Failed to handle PR review comment mentions:`, error);
  }
}
