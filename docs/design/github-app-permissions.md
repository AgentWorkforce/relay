# GitHub App Permissions

This document describes the GitHub App permissions required for Agent Relay's features, particularly the CI failure webhook integration.

## Overview

Agent Relay uses a GitHub App to:
1. Receive webhook events (installations, PRs, CI failures)
2. Access repository code for cloning/syncing
3. Create commits and push fixes
4. Interact with PRs (comments, reviews)

## Required Permissions

### Repository Permissions

| Permission | Access Level | Purpose |
|------------|--------------|---------|
| **Contents** | Read & Write | Clone repos, push commits, read files |
| **Pull requests** | Read & Write | Read PR details, create/update PRs, comment |
| **Checks** | Read | Receive check_run webhooks, read failure details |
| **Actions** | Read | Receive workflow_run webhooks, read logs |
| **Commit statuses** | Read | Read status checks, understand CI state |
| **Metadata** | Read | Basic repo info (required for all apps) |

### Organization Permissions

| Permission | Access Level | Purpose |
|------------|--------------|---------|
| **Members** | Read | Identify organization members for access control |

### Account Permissions

| Permission | Access Level | Purpose |
|------------|--------------|---------|
| **Email addresses** | Read | User identification, notifications |

## Webhook Events

The following webhook events should be enabled:

### Required Events

| Event | Purpose |
|-------|---------|
| `installation` | Track app installations/uninstallations |
| `installation_repositories` | Track repo access changes |
| `check_run` | **CI failure detection** - triggers agent spawn |
| `workflow_run` | Workflow-level failure tracking |
| `push` | Detect new commits for sync |
| `pull_request` | Track PR lifecycle |

### Optional Events

| Event | Purpose |
|-------|---------|
| `issues` | Future: issue-to-agent assignment |
| `issue_comment` | Future: agent @mentions |
| `pull_request_review` | Future: review request handling |
| `check_suite` | Aggregate check status |

## Configuration Steps

### 1. Create GitHub App

1. Go to GitHub Settings > Developer settings > GitHub Apps
2. Click "New GitHub App"
3. Fill in basic info:
   - **Name**: Agent Relay (or your instance name)
   - **Homepage URL**: Your dashboard URL
   - **Webhook URL**: `https://your-domain.com/api/webhooks/github`

### 2. Set Permissions

Under "Permissions & events":

**Repository permissions:**
- Contents: Read and write
- Pull requests: Read and write
- Checks: Read-only
- Actions: Read-only
- Commit statuses: Read-only
- Metadata: Read-only (default)

**Organization permissions:**
- Members: Read-only

**Account permissions:**
- Email addresses: Read-only

### 3. Subscribe to Events

Check the following events:
- [x] Check run
- [x] Workflow run
- [x] Installation
- [x] Installation and repositories
- [x] Push
- [x] Pull request

### 4. Generate Keys

1. Generate a private key (downloads .pem file)
2. Note the App ID
3. Generate a client secret for OAuth

### 5. Configure Agent Relay

Set environment variables:

```bash
# GitHub App credentials
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
GITHUB_CLIENT_ID=Iv1.abc123
GITHUB_CLIENT_SECRET=secret123

# Webhook secret (generate a random string)
GITHUB_WEBHOOK_SECRET=whsec_random_string_here
```

## Permission Rationale

### Why Contents: Write?

Agents need to push fixes to branches. This includes:
- Creating new commits
- Pushing to existing branches
- Creating new branches for fixes

### Why Checks: Read (not Write)?

We only receive check failure events and read results. We don't:
- Create our own checks
- Update check status

CI runs in GitHub Actions and creates its own checks.

### Why Pull Requests: Write?

Agents may need to:
- Comment on PRs with fix summaries
- Request reviews after fixes
- Update PR descriptions

### Why Actions: Read?

For workflow_run events that provide:
- Workflow-level failure context
- Access to workflow logs (future)

## Security Considerations

### Webhook Secret

Always configure a webhook secret:

```typescript
function verifyGitHubSignature(payload: string, signature: string, secret: string): boolean {
  const expected = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')}`;
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}
```

### Private Key Storage

- Never commit the private key to version control
- Use secure secret management (Vault, AWS Secrets Manager, etc.)
- Rotate keys periodically

### Installation Scope

When users install the app:
- Recommend "Only select repositories" over "All repositories"
- Document which repos will be monitored
- Allow easy un-installation

### Token Expiry

GitHub App installation tokens expire after 1 hour:
- Cache tokens with expiry tracking
- Refresh before expiration
- Handle 401 errors with token refresh

## Minimal Permissions Option

For users who want minimal permissions:

| Permission | Access | Notes |
|------------|--------|-------|
| Contents | Read | Can clone, cannot push |
| Pull requests | Read | Can read PRs, cannot comment |
| Checks | Read | Receive failures |

With minimal permissions:
- Agents can analyze failures but cannot push fixes
- Manual intervention required for commits
- Good for "notify only" mode

## Events Flow

```
┌──────────────┐      webhook       ┌─────────────────┐
│  GitHub CI   │ ──────────────────>│  Agent Relay    │
│  (check_run  │                    │  /webhooks      │
│   failed)    │                    └────────┬────────┘
└──────────────┘                             │
                                             │ verify signature
                                             │ parse payload
                                             ▼
                                    ┌─────────────────┐
                                    │  Record failure │
                                    │  in database    │
                                    └────────┬────────┘
                                             │
                                             │ spawn agent
                                             ▼
                                    ┌─────────────────┐
                                    │  Agent fixes    │
                                    │  and pushes     │
                                    └────────┬────────┘
                                             │
                                             │ uses Contents:write
                                             ▼
                                    ┌─────────────────┐
                                    │  GitHub CI      │
                                    │  re-runs        │
                                    └─────────────────┘
```

## Troubleshooting

### Webhook Not Received

1. Check webhook URL is correct and accessible
2. Verify webhook secret matches configuration
3. Check GitHub App webhook delivery logs
4. Ensure firewall allows GitHub IPs

### Permission Denied Errors

1. Verify app is installed on the repository
2. Check installation hasn't been suspended
3. Confirm required permissions are granted
4. Regenerate installation token

### CI Events Not Triggering

1. Verify `check_run` event is subscribed
2. Check check is from a GitHub Action (not external CI)
3. Ensure webhook URL is receiving events (check delivery logs)

## References

- [GitHub Apps documentation](https://docs.github.com/en/apps)
- [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
- [GitHub App permissions](https://docs.github.com/en/rest/overview/permissions-required-for-github-apps)
- [Check runs API](https://docs.github.com/en/rest/checks/runs)
