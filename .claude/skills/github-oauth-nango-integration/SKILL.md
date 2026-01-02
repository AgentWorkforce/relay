---
name: github-oauth-nango-integration
description: Use when implementing GitHub OAuth + GitHub App authentication with Nango - provides two-connection pattern for user login and repo access with webhook handling
---

# GitHub OAuth + Nango Integration

## Overview

Implements dual-connection OAuth pattern: one for user identity (`github` integration), another for repository access (`github-app-oauth` integration). This separation enables secure login while maintaining granular repo permissions through GitHub App installations.

## When to Use

- Setting up GitHub OAuth login via Nango
- Implementing GitHub App installation webhooks
- Reconciling OAuth users with GitHub App installations
- Building apps that need both user auth and repo access
- Handling Nango sync webhooks for GitHub data

## Why Two Connections?

GitHub has **two different authentication mechanisms** that serve different purposes:

### GitHub OAuth App (`github` integration)
- **What it is**: Traditional OAuth for user identity
- **What it gives you**: User profile (name, email, avatar, GitHub ID)
- **What it DOESN'T give you**: Access to repositories
- **Use for**: Login, "Sign in with GitHub"

### GitHub App (`github-app-oauth` integration)
- **What it is**: Installable app with granular repo permissions
- **What it gives you**: Access to specific repos the user installed it on
- **What it DOESN'T give you**: User identity (it knows the installation, not who's using it)
- **Use for**: Reading PRs, commits, files; posting comments; webhooks

### The Reconciliation Problem

```
OAuth App alone:  "User john@example.com logged in" → but which repos can they access?
GitHub App alone: "Installation #12345 has access to repo X" → but who is the user?
```

**Solution**: Two separate OAuth flows linked by user ID:

1. **Login flow** → User authenticates → Store user identity + `nangoConnectionId`
2. **Repo flow** → Same user authorizes app → Store repos + link via `ownerId`

This lets you answer: "User john@example.com can access repos X, Y, Z"

## Quick Reference

| Connection Type | Nango Integration | Purpose | Stored In |
|----------------|-------------------|---------|-----------|
| User Login | `github` | Authentication, identity | `users.nangoConnectionId` |
| Repo Access | `github-app-oauth` | PR operations, file access | `repos.nangoConnectionId` |

| Flow | Endpoint | Webhook Type |
|------|----------|--------------|
| Login | `GET /auth/nango-session` | `auth` + `github` |
| Repo Connect | `GET /auth/github-app-session` | `auth` + `github-app-oauth` |
| Data Sync | N/A (scheduled) | `sync` |

## Implementation

### 1. Database Schema

```typescript
// users table - stores login connection
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  githubId: text('github_id').unique().notNull(),
  githubUsername: text('github_username').notNull(),
  email: text('email'),
  avatarUrl: text('avatar_url'),
  nangoConnectionId: text('nango_connection_id'),      // Permanent login connection
  incomingConnectionId: text('incoming_connection_id'), // Temp polling connection
  pendingInstallationRequest: timestamp('pending_installation_request'), // Org approval wait
});

// repos table - stores per-repo app connection
export const repos = pgTable('repos', {
  id: uuid('id').primaryKey().defaultRandom(),
  githubRepoId: text('github_repo_id').unique().notNull(),
  fullName: text('full_name').notNull(),
  installationId: uuid('installation_id').references(() => githubInstallations.id),
  ownerId: uuid('owner_id').references(() => users.id),
  nangoConnectionId: text('nango_connection_id'),  // App connection for this repo
});

// github_installations - tracks app installations
export const githubInstallations = pgTable('github_installations', {
  id: uuid('id').primaryKey().defaultRandom(),
  installationId: text('installation_id').unique().notNull(),
  accountType: text('account_type'),   // 'user' | 'organization'
  accountLogin: text('account_login'),
  installedById: uuid('installed_by_id').references(() => users.id),
});
```

### 2. Constants

```typescript
// constants.ts
export const NANGO_INTEGRATION = {
  GITHUB_USER: 'github',              // Login only
  GITHUB_APP_OAUTH: 'github-app-oauth' // Repo access
} as const;
```

### 3. Login Flow Routes

```typescript
// GET /auth/nango-session - Create login OAuth session
app.get('/auth/nango-session', async (c) => {
  const tempUserId = randomUUID();

  const { sessionToken } = await nangoClient.createConnectSession({
    end_user: { id: tempUserId },
    allowed_integrations: [NANGO_INTEGRATION.GITHUB_USER],
  });

  return c.json({ sessionToken, tempUserId });
});

// GET /auth/nango/status/:connectionId - Poll login completion
app.get('/auth/nango/status/:connectionId', async (c) => {
  const { connectionId } = c.req.param();

  // Check if user exists with this incoming connection
  const user = await userRepo.findByIncomingConnectionId(connectionId);
  if (!user) {
    return c.json({ ready: false });
  }

  // Issue JWT and return
  const token = authService.issueToken(user);
  await userRepo.clearIncomingConnectionId(user.id);

  return c.json({ ready: true, token, user });
});
```

### 4. App OAuth Flow Routes

```typescript
// GET /auth/github-app-session - Create app OAuth session (authenticated)
app.get('/auth/github-app-session', authMiddleware, async (c) => {
  const user = c.get('user');

  const { sessionToken } = await nangoClient.createConnectSession({
    end_user: { id: user.id, email: user.email },
    allowed_integrations: [NANGO_INTEGRATION.GITHUB_APP_OAUTH],
  });

  return c.json({ sessionToken });
});

// GET /auth/github-app/status/:connectionId - Poll repo sync
app.get('/auth/github-app/status/:connectionId', authMiddleware, async (c) => {
  const user = c.get('user');

  // Check for pending org approval
  if (user.pendingInstallationRequest) {
    return c.json({ ready: false, pendingApproval: true });
  }

  // Check if repos synced
  const repos = await repoRepo.findByOwnerId(user.id);
  return c.json({ ready: repos.length > 0, repos });
});
```

### 5. Auth Webhook Handler

```typescript
// auth-webhook-service.ts
export async function handleAuthWebhook(payload: NangoAuthWebhook): Promise<boolean> {
  const { connectionId, providerConfigKey, endUser } = payload;

  if (providerConfigKey === NANGO_INTEGRATION.GITHUB_USER) {
    return handleLoginWebhook(connectionId, endUser);
  }

  if (providerConfigKey === NANGO_INTEGRATION.GITHUB_APP_OAUTH) {
    return handleAppOAuthWebhook(connectionId, endUser);
  }

  return false;
}

async function handleLoginWebhook(connectionId: string, endUser?: EndUser) {
  // Fetch GitHub user info via Nango
  const githubUser = await nangoService.getGitHubUser(connectionId);

  // Check if user exists
  const existingUser = await userRepo.findByGitHubId(String(githubUser.id));

  if (existingUser) {
    // Returning user - store temp connection for polling
    await userRepo.update(existingUser.id, {
      incomingConnectionId: connectionId,
    });
    // Delete duplicate connection later
    await nangoService.deleteConnection(connectionId);
  } else {
    // New user - create record
    const user = await userRepo.create({
      githubId: String(githubUser.id),
      githubUsername: githubUser.login,
      email: githubUser.email,
      avatarUrl: githubUser.avatar_url,
      nangoConnectionId: connectionId,
      incomingConnectionId: connectionId,
    });

    // Update connection with real user ID
    await nangoService.patchConnection(connectionId, {
      end_user: { id: user.id, email: user.email },
    });
  }

  return true;
}

async function handleAppOAuthWebhook(connectionId: string, endUser?: EndUser) {
  const userId = endUser?.id;
  if (!userId) throw new Error('No user ID in app OAuth webhook');

  const user = await userRepo.findById(userId);
  if (!user) throw new Error('User not found');

  try {
    // Fetch repos user has access to
    const repos = await githubService.getInstallationReposRaw(connectionId);

    // Sync repos to database
    for (const repo of repos) {
      await repoRepo.upsert({
        githubRepoId: String(repo.id),
        fullName: repo.full_name,
        ownerId: user.id,
        nangoConnectionId: connectionId,
      });
    }

    // Trigger Nango syncs
    await nangoService.triggerSync(connectionId, ['pull-requests', 'commits']);

  } catch (error) {
    if (error.status === 403) {
      // Org approval pending
      await userRepo.update(user.id, {
        pendingInstallationRequest: new Date(),
      });
      return true; // Graceful degradation
    }
    throw error;
  }

  return true;
}
```

### 6. Webhook Route with Signature Verification

```typescript
// webhooks.ts
app.post('/api/webhooks/nango', async (c) => {
  const signature = c.req.header('X-Nango-Signature');
  const body = await c.req.text();

  // Verify signature
  const expectedSignature = createHmac('sha256', NANGO_SECRET_KEY)
    .update(body)
    .digest('hex');

  if (signature !== expectedSignature) {
    return c.json({ error: 'Invalid signature' }, 401);
  }

  const payload = JSON.parse(body);

  if (payload.type === 'auth') {
    const success = await handleAuthWebhook(payload);
    return c.json({ success });
  }

  if (payload.type === 'sync') {
    await processSyncWebhook(payload);
    return c.json({ success: true });
  }

  return c.json({ success: false });
});
```

### 7. Frontend Integration

```typescript
// Login flow
async function handleLogin() {
  const res = await fetch('/api/auth/nango-session');
  const { sessionToken } = await res.json();

  const nango = new Nango({ connectSessionToken: sessionToken });

  nango.openConnectUI({
    onEvent: async (event) => {
      if (event.type === 'connect') {
        // Poll for completion
        const result = await pollForAuth(event.payload.connectionId);
        if (result.ready) {
          localStorage.setItem('token', result.token);
          navigate('/dashboard');
        }
      }
    },
  });
}

// Repo connection flow (after login)
async function handleConnectRepos() {
  const res = await fetch('/api/auth/github-app-session', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { sessionToken } = await res.json();

  const nango = new Nango({ connectSessionToken: sessionToken });

  nango.openConnectUI({
    onEvent: async (event) => {
      if (event.type === 'connect') {
        const result = await pollForRepos(event.payload.connectionId);
        if (result.pendingApproval) {
          showMessage('Waiting for org admin approval...');
        } else if (result.ready) {
          setRepos(result.repos);
        }
      }
    },
  });
}
```

## Complete Flow Diagram

```
USER LOGIN:
  Frontend → GET /auth/nango-session
           → Nango.openConnectUI(sessionToken)
           → User authorizes GitHub
           → Nango webhook (type: auth, providerConfigKey: github)
           → Backend creates/updates user
           → Frontend polls /auth/nango/status/:connectionId
           → Returns JWT token

REPO CONNECTION (authenticated):
  Frontend → GET /auth/github-app-session (with JWT)
           → Nango.openConnectUI(sessionToken)
           → User authorizes GitHub App
           → Nango webhook (type: auth, providerConfigKey: github-app-oauth)
           → Backend fetches repos, syncs to DB
           → Frontend polls /auth/github-app/status/:connectionId
           → Returns repos list

DATA SYNCS (background):
  Nango → Scheduled sync every 4 hours
        → Webhook (type: sync, model: GithubPullRequest)
        → Backend processes incremental updates
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Using same connection for login and repo access | Use two integrations: `github` for login, `github-app-oauth` for repos |
| Not handling org approval pending | Check for 403 error, set `pendingInstallationRequest` flag |
| Missing `endUser.id` in connection | Always set in `createConnectSession`, update after user creation |
| Polling wrong connection ID | Store `incomingConnectionId` separately for returning users |
| Not verifying webhook signature | Always verify `X-Nango-Signature` with HMAC-SHA256 |
| Keeping duplicate connections | Delete temp connection after returning user authenticates |

## Environment Variables

```bash
# Required
NANGO_SECRET_KEY=your-nango-secret-key
JWT_SECRET=your-jwt-secret-min-32-chars
DATABASE_URL=postgres://...

# Configure in Nango Dashboard
# - github integration: OAuth App credentials
# - github-app-oauth integration: GitHub App credentials
```

## Nango Dashboard Setup

1. **Create `github` integration** (for login):
   - Type: OAuth2
   - Client ID/Secret: From GitHub OAuth App
   - Scopes: `read:user`, `user:email`

2. **Create `github-app-oauth` integration** (for repos):
   - Type: GitHub App
   - App ID, Private Key, Client ID/Secret: From GitHub App
   - Scopes: `repo`, `pull_request`, etc.

3. **Configure webhook URL**: `https://your-domain/api/webhooks/nango`

4. **Enable syncs**: `pull-requests`, `commits`, `issues`, etc.
