# CI Failure Webhooks - Agent Notification System

## Overview

This document describes the architecture for automatically notifying agents when GitHub CI checks fail on pull requests. This enables agents to autonomously investigate and fix CI failures without human intervention.

## Motivation

Currently, when CI fails on a PR:
1. Developer notices the failure (manual)
2. Developer investigates logs (manual)
3. Developer fixes the issue (manual)
4. Developer pushes and waits for CI again (manual)

With webhook-based agent notification:
1. CI fails → webhook fires
2. Agent receives failure context automatically
3. Agent investigates and pushes fix
4. CI re-runs automatically

This closes the loop for autonomous PR maintenance.

## Architecture

```
┌─────────────┐     webhook      ┌─────────────────┐
│   GitHub    │ ───────────────> │  Cloud API      │
│  (CI fails) │  check_run       │  /webhooks      │
└─────────────┘  completed       └────────┬────────┘
                                          │
                                          │ spawn or message
                                          ▼
                              ┌─────────────────────┐
                              │   Agent Relay       │
                              │   Daemon            │
                              └────────┬────────────┘
                                       │
                          ┌────────────┼────────────┐
                          ▼            ▼            ▼
                     ┌────────┐  ┌────────┐  ┌────────┐
                     │ Agent  │  │ Agent  │  │ Agent  │
                     │  (PR)  │  │ (Lint) │  │ (Test) │
                     └────────┘  └────────┘  └────────┘
```

## GitHub Webhook Events

### Relevant Events

| Event | Trigger | Use Case |
|-------|---------|----------|
| `check_run` | Individual check completes | Fine-grained failure handling |
| `check_suite` | All checks complete | Wait for full CI before acting |
| `workflow_run` | GitHub Action completes | Action-specific handling |
| `pull_request` | PR state changes | Track PR lifecycle |

### Recommended: `check_run` Event

The `check_run` event provides the most actionable data:

```json
{
  "action": "completed",
  "check_run": {
    "id": 123456789,
    "name": "lint",
    "status": "completed",
    "conclusion": "failure",
    "output": {
      "title": "ESLint found 3 errors",
      "summary": "Fix the following issues...",
      "text": "src/foo.ts:10:5 - error: ...",
      "annotations": [
        {
          "path": "src/foo.ts",
          "start_line": 10,
          "end_line": 10,
          "annotation_level": "failure",
          "message": "Unexpected console statement"
        }
      ]
    },
    "pull_requests": [
      {
        "number": 55,
        "head": {
          "ref": "feature-branch",
          "sha": "abc123"
        }
      }
    ]
  },
  "repository": {
    "full_name": "org/repo"
  }
}
```

## Implementation

### 1. Webhook Endpoint

```typescript
// src/cloud/api/webhooks.ts

import { Router } from 'express';
import crypto from 'crypto';

export const webhookRouter = Router();

/**
 * Verify GitHub webhook signature
 */
function verifyGitHubSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expected = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')}`;
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

/**
 * GitHub webhook handler for CI failures
 */
webhookRouter.post('/github/ci', async (req, res) => {
  const event = req.headers['x-github-event'] as string;
  const signature = req.headers['x-hub-signature-256'] as string;
  const payload = JSON.stringify(req.body);

  // Verify webhook authenticity
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (secret && !verifyGitHubSignature(payload, signature, secret)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Handle check_run events
  if (event === 'check_run') {
    await handleCheckRunEvent(req.body);
  }

  // Handle workflow_run events
  if (event === 'workflow_run') {
    await handleWorkflowRunEvent(req.body);
  }

  res.status(200).json({ received: true });
});
```

### 2. Check Run Handler

```typescript
// src/cloud/api/ci-handlers.ts

import { db } from '../db';
import { spawnAgent, messageAgent } from '../services/agent-spawner';

interface CheckRunPayload {
  action: string;
  check_run: {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    output: {
      title: string;
      summary: string;
      text?: string;
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
 * Handle check_run webhook events
 */
export async function handleCheckRunEvent(payload: CheckRunPayload) {
  const { action, check_run, repository } = payload;

  // Only handle completed, failed checks
  if (action !== 'completed') return;
  if (check_run.conclusion !== 'failure') return;

  // Only handle checks on PRs
  if (check_run.pull_requests.length === 0) return;

  const pr = check_run.pull_requests[0];
  const failureContext = buildFailureContext(payload);

  // Check if there's already an agent working on this PR
  const existingAgent = await findAgentForPR(repository.full_name, pr.number);

  if (existingAgent) {
    // Message the existing agent about the failure
    await messageAgent(existingAgent.id, {
      type: 'ci_failure',
      ...failureContext,
    });
  } else {
    // Spawn a new agent to handle the failure
    await spawnCIFixAgent(failureContext);
  }
}

/**
 * Build structured context from check run failure
 */
function buildFailureContext(payload: CheckRunPayload) {
  const { check_run, repository } = payload;
  const pr = check_run.pull_requests[0];

  return {
    repository: repository.full_name,
    cloneUrl: repository.clone_url,
    prNumber: pr.number,
    branch: pr.head.ref,
    commitSha: pr.head.sha,
    checkName: check_run.name,
    checkId: check_run.id,
    failureTitle: check_run.output.title,
    failureSummary: check_run.output.summary,
    failureDetails: check_run.output.text,
    annotations: check_run.output.annotations || [],
  };
}
```

### 3. Agent Spawner

```typescript
// src/cloud/services/agent-spawner.ts

import { WorkspaceProvisioner } from '../provisioner';

interface CIFailureContext {
  repository: string;
  cloneUrl: string;
  prNumber: number;
  branch: string;
  commitSha: string;
  checkName: string;
  checkId: number;
  failureTitle: string;
  failureSummary: string;
  failureDetails?: string;
  annotations: Array<{
    path: string;
    start_line: number;
    end_line: number;
    message: string;
  }>;
}

/**
 * Spawn an agent to fix CI failures
 */
export async function spawnCIFixAgent(context: CIFailureContext) {
  const prompt = buildAgentPrompt(context);

  // Find or create workspace for this repository
  const workspace = await findOrCreateWorkspace(context.repository);

  // Spawn agent in the workspace
  await workspace.spawnAgent({
    name: `ci-fix-${context.checkName}-${context.prNumber}`,
    prompt,
    branch: context.branch,
    workingDirectory: `/workspace/repos/${context.repository}`,
  });
}

/**
 * Build the prompt for the CI fix agent
 */
function buildAgentPrompt(context: CIFailureContext): string {
  const annotationsList = context.annotations
    .map(a => `- ${a.path}:${a.start_line} - ${a.message}`)
    .join('\n');

  return `
# CI Failure Fix Task

A CI check has failed on PR #${context.prNumber} in ${context.repository}.

## Failure Details

**Check Name:** ${context.checkName}
**Title:** ${context.failureTitle}
**Summary:** ${context.failureSummary}

${context.failureDetails ? `**Details:**\n${context.failureDetails}` : ''}

${annotationsList ? `## Annotations\n\n${annotationsList}` : ''}

## Your Task

1. Checkout the branch: \`${context.branch}\`
2. Analyze the failure based on the annotations and error messages
3. Fix the issues in the affected files
4. Run the relevant checks locally to verify the fix
5. Commit and push your changes with a clear commit message
6. Report back with a summary of what was fixed

## Important

- Only fix the specific issues causing the CI failure
- Do not refactor or improve unrelated code
- If you cannot fix the issue, explain why and what manual intervention is needed
`.trim();
}
```

### 4. Agent Notification via Relay

For agents already working on a PR, send failure notifications through the relay system:

```typescript
// src/cloud/services/agent-notifier.ts

import { RelayClient } from '../../relay/client';

interface CIFailureMessage {
  type: 'ci_failure';
  checkName: string;
  failureTitle: string;
  failureSummary: string;
  annotations: Array<{
    path: string;
    start_line: number;
    message: string;
  }>;
}

/**
 * Notify an agent about CI failure via relay message
 */
export async function notifyAgentOfCIFailure(
  agentId: string,
  failure: CIFailureMessage
) {
  const relay = new RelayClient();

  const message = formatCIFailureMessage(failure);

  await relay.sendMessage({
    to: agentId,
    content: message,
    priority: 'high',
    thread: `ci-failure-${failure.checkName}`,
  });
}

function formatCIFailureMessage(failure: CIFailureMessage): string {
  const annotations = failure.annotations
    .slice(0, 10) // Limit to first 10
    .map(a => `  - ${a.path}:${a.start_line}: ${a.message}`)
    .join('\n');

  return `
CI FAILURE: ${failure.checkName}

${failure.failureTitle}

${failure.failureSummary}

${annotations ? `Issues:\n${annotations}` : ''}

Please investigate and fix these issues, then push your changes.
`.trim();
}
```

## Configuration

### Workspace Settings

Repositories can configure CI webhook behavior in `.relay/config.json`:

```json
{
  "ciWebhooks": {
    "enabled": true,
    "autoFix": {
      "lint": true,
      "typecheck": true,
      "test": false
    },
    "notifyExistingAgent": true,
    "spawnNewAgent": true,
    "maxConcurrentAgents": 3,
    "cooldownMinutes": 5
  }
}
```

### Check Name Mapping

Map CI check names to fix strategies:

```json
{
  "ciWebhooks": {
    "checkStrategies": {
      "lint": {
        "autoFix": true,
        "command": "npm run lint:fix",
        "agentProfile": "linter"
      },
      "typecheck": {
        "autoFix": true,
        "command": "npm run typecheck",
        "agentProfile": "typescript-expert"
      },
      "test": {
        "autoFix": false,
        "notifyOnly": true,
        "agentProfile": "tester"
      }
    }
  }
}
```

## Agent Profiles for CI Fixes

### Lint Fix Agent

```yaml
# .claude/agents/lint-fixer.md
---
name: LintFixer
description: Fixes linting errors automatically
tools:
  - Read
  - Edit
  - Bash
model: haiku
---

You are a code quality specialist. Your job is to fix linting errors.

## Approach

1. Read the files with errors
2. Understand the linting rule being violated
3. Fix the code to comply with the rule
4. Run the linter to verify the fix
5. Commit with message: "fix: resolve lint errors"

## Rules

- Fix only the specific errors reported
- Do not change code style beyond what's needed
- Do not add or remove features
- If a rule seems wrong, fix it anyway (discuss rule changes separately)
```

### Test Fix Agent

```yaml
# .claude/agents/test-fixer.md
---
name: TestFixer
description: Investigates and fixes failing tests
tools:
  - Read
  - Edit
  - Bash
  - Grep
model: sonnet
---

You are a testing specialist. Your job is to fix failing tests.

## Approach

1. Run the failing test to see the actual error
2. Determine if the issue is:
   - Test is wrong (update the test)
   - Code is wrong (fix the code)
   - Environment issue (fix setup)
3. Apply the minimal fix
4. Run the test again to verify
5. Run the full test suite to check for regressions
6. Commit with descriptive message

## Rules

- Prefer fixing code over changing tests
- If changing tests, explain why in the commit message
- Never delete tests to make CI pass
- If stuck, report the issue instead of guessing
```

## Database Schema

Track CI failure events and agent responses:

```sql
-- CI failure events
CREATE TABLE ci_failure_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id),
  repository TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  check_name TEXT NOT NULL,
  check_id BIGINT NOT NULL,
  conclusion TEXT NOT NULL,
  failure_title TEXT,
  failure_summary TEXT,
  annotations JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Agent responses to CI failures
CREATE TABLE ci_fix_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  failure_event_id UUID REFERENCES ci_failure_events(id),
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  status TEXT NOT NULL, -- 'pending', 'in_progress', 'success', 'failed'
  commit_sha TEXT,
  error_message TEXT,
  started_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

-- Indexes
CREATE INDEX idx_ci_failures_repo_pr ON ci_failure_events(repository, pr_number);
CREATE INDEX idx_ci_failures_created ON ci_failure_events(created_at);
CREATE INDEX idx_ci_fix_attempts_status ON ci_fix_attempts(status);
```

## API Endpoints

### Webhook Registration

```
POST /api/webhooks/github/register
{
  "repository": "org/repo",
  "events": ["check_run", "workflow_run"],
  "secret": "webhook-secret"
}
```

### CI Failure History

```
GET /api/ci-failures?repository=org/repo&pr=55

Response:
{
  "failures": [
    {
      "id": "...",
      "checkName": "lint",
      "failureTitle": "ESLint found 3 errors",
      "createdAt": "2025-01-04T...",
      "fixAttempt": {
        "agentName": "ci-fix-lint-55",
        "status": "success",
        "commitSha": "def456"
      }
    }
  ]
}
```

### Manual Trigger

```
POST /api/ci-failures/retry
{
  "failureEventId": "...",
  "agentProfile": "lint-fixer"
}
```

## Security Considerations

### Webhook Verification

Always verify webhook signatures:

```typescript
const signature = req.headers['x-hub-signature-256'];
const payload = JSON.stringify(req.body);
const expected = `sha256=${crypto
  .createHmac('sha256', WEBHOOK_SECRET)
  .update(payload)
  .digest('hex')}`;

if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
  throw new Error('Invalid webhook signature');
}
```

### Rate Limiting

Prevent abuse with rate limits:

```typescript
const rateLimiter = new RateLimiter({
  // Max 10 agent spawns per repo per hour
  key: (req) => `ci-spawn:${req.body.repository.full_name}`,
  maxRequests: 10,
  windowMs: 60 * 60 * 1000,
});
```

### Agent Permissions

CI fix agents should have limited permissions:

```yaml
permissions:
  tools:
    - Read
    - Edit
    - Bash
  bash:
    allowedCommands:
      - npm
      - git
      - eslint
    blockedCommands:
      - rm -rf
      - curl
      - wget
  files:
    writable:
      - "src/**"
      - "test/**"
    readonly:
      - "package.json"
      - ".github/**"
```

## Monitoring & Observability

### Metrics to Track

- `ci_webhook_received_total` - Total webhooks received by event type
- `ci_failure_events_total` - Total CI failures by check name
- `ci_fix_attempts_total` - Fix attempts by status (success/failed)
- `ci_fix_duration_seconds` - Time from failure to fix commit
- `ci_agent_spawn_total` - Agents spawned for CI fixes

### Alerts

```yaml
alerts:
  - name: HighCIFailureRate
    condition: rate(ci_failure_events_total[1h]) > 10
    severity: warning
    message: "High CI failure rate detected"

  - name: AgentFixFailures
    condition: rate(ci_fix_attempts_total{status="failed"}[1h]) > 5
    severity: warning
    message: "Agents failing to fix CI issues"
```

## Issue and Comment Handling

In addition to CI failures, agents can respond to GitHub issues and @mentions in comments.

### Supported Events

| Event | Purpose |
|-------|---------|
| `issues` | Track new issues for agent assignment |
| `issue_comment` | Detect @mentions in issue/PR comments |
| `pull_request_review_comment` | Detect @mentions in PR review comments |

### @Mention Detection

When a comment contains `@agent-name`, the system:

1. Extracts all @mentions from the comment text
2. Checks if the mentioned name is a known agent type
3. Creates a mention record in the database
4. Routes to the appropriate agent for response

**Known Agent Types:**
- `@agent-relay` - General purpose agent
- `@lead` - Lead agent for coordination
- `@developer` - Developer agent for coding tasks
- `@reviewer` - Code review agent
- `@ci-fix` - CI failure fixing agent
- `@debugger` - Bug investigation agent
- `@docs` - Documentation agent
- `@test` - Test writing agent
- `@refactor` - Code refactoring agent

### Issue Assignment

When a new issue is opened:

1. Record the issue in `issue_assignments` table
2. Extract priority from labels (p0-p3, critical/high/medium/low)
3. Optionally auto-assign based on label mapping
4. Agent receives issue context and works on a fix

### Configuration

Configure agent triggers per repository:

```json
{
  "agentTriggers": {
    "mentionableAgents": ["lead", "ci-fix", "reviewer"],
    "defaultIssueAgent": "developer",
    "autoAssignLabels": {
      "bug": "debugger",
      "enhancement": "developer",
      "documentation": "docs"
    },
    "autoRespondToMentions": true,
    "maxResponsesPerHour": 20,
    "allowedTriggerUsers": []
  }
}
```

### Database Schema

```sql
-- Issue assignments
CREATE TABLE issue_assignments (
  id UUID PRIMARY KEY,
  repository TEXT NOT NULL,
  issue_number BIGINT NOT NULL,
  issue_title TEXT NOT NULL,
  issue_body TEXT,
  agent_id TEXT,
  agent_name TEXT,
  status TEXT DEFAULT 'pending',
  resolution TEXT,
  linked_pr_number BIGINT,
  labels TEXT[],
  priority TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(repository, issue_number)
);

-- Comment mentions
CREATE TABLE comment_mentions (
  id UUID PRIMARY KEY,
  repository TEXT NOT NULL,
  source_type TEXT NOT NULL, -- issue_comment, pr_comment, pr_review
  source_id BIGINT NOT NULL,
  issue_or_pr_number BIGINT NOT NULL,
  comment_body TEXT NOT NULL,
  author_login TEXT NOT NULL,
  mentioned_agent TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  response_comment_id BIGINT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Security

- Rate limit @mentions to prevent abuse
- Optionally restrict which users can trigger agents
- Agents cannot respond to their own comments (prevent loops)
- Bot accounts are ignored by default

## Future Enhancements

1. **Learning from Fixes**: Track successful fixes to build patterns for common errors

2. **Pre-emptive Checks**: Run checks locally before push to catch issues early

3. **Fix Suggestions**: Instead of auto-fixing, suggest fixes for human review

4. **Cross-repo Learning**: Apply fix patterns learned in one repo to others

5. **Escalation Paths**: Auto-escalate to humans if agent can't fix after N attempts

6. **Slack/Discord Integration**: Notify team channels about agent activity

7. **PR Review Automation**: Auto-request reviews from appropriate agents

## References

- [GitHub Webhooks Documentation](https://docs.github.com/en/webhooks)
- [GitHub Checks API](https://docs.github.com/en/rest/checks)
- [Agent Relay Protocol](./agent-relay-protocol.md)
