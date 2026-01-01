# Agent Relay Cloud - Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              AGENT RELAY CLOUD                                   │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                         CONTROL PLANE                                    │    │
│  │                                                                          │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │    │
│  │  │   API    │  │  Auth    │  │Credential│  │Workspace │  │ Dashboard│  │    │
│  │  │  Server  │  │ Service  │  │  Vault   │  │Provisioner│  │  (React) │  │    │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  │    │
│  │       │             │             │             │             │         │    │
│  │       └─────────────┴─────────────┴─────────────┴─────────────┘         │    │
│  │                                   │                                      │    │
│  │                            ┌──────┴──────┐                              │    │
│  │                            │  PostgreSQL │                              │    │
│  │                            │   + Redis   │                              │    │
│  │                            └─────────────┘                              │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                      │                                           │
│                                      │ Provision & Manage                        │
│                                      ▼                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                         COMPUTE PLANE                                    │    │
│  │                                                                          │    │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐         │    │
│  │  │   Workspace A   │  │   Workspace B   │  │   Workspace C   │  ...    │    │
│  │  │  (user-123)     │  │  (user-456)     │  │  (team-789)     │         │    │
│  │  │                 │  │                 │  │                 │         │    │
│  │  │  ┌───────────┐  │  │  ┌───────────┐  │  │  ┌───────────┐  │         │    │
│  │  │  │agent-relay│  │  │  │agent-relay│  │  │  │agent-relay│  │         │    │
│  │  │  │  daemon   │  │  │  │  daemon   │  │  │  │  daemon   │  │         │    │
│  │  │  └─────┬─────┘  │  │  └─────┬─────┘  │  │  └─────┬─────┘  │         │    │
│  │  │        │        │  │        │        │  │        │        │         │    │
│  │  │  ┌─────┴─────┐  │  │  ┌─────┴─────┐  │  │  ┌─────┴─────┐  │         │    │
│  │  │  │  Agents   │  │  │  │  Agents   │  │  │  │  Agents   │  │         │    │
│  │  │  │(claude,   │  │  │  │(codex)    │  │  │  │(claude,   │  │         │    │
│  │  │  │ codex)    │  │  │  │           │  │  │  │ gemini)   │  │         │    │
│  │  │  └───────────┘  │  │  └───────────┘  │  │  └───────────┘  │         │    │
│  │  │                 │  │                 │  │                 │         │    │
│  │  │  /repos/        │  │  /repos/        │  │  /repos/        │         │    │
│  │  │   ├─ project-a  │  │   └─ my-app    │  │   ├─ backend    │         │    │
│  │  │   └─ project-b  │  │                 │  │   └─ frontend  │         │    │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘         │    │
│  │                                                                          │    │
│  │  Compute Options: Fly.io | Railway | AWS ECS | GCP Cloud Run            │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## One-Click Provisioning Flow

```
User signs up
     │
     ▼
┌─────────────────────────────────────────────────────────────────┐
│  1. AUTHENTICATE                                                 │
│     • GitHub OAuth login                                        │
│     • Create user record                                        │
│     • Store GitHub token                                        │
└─────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. CONNECT PROVIDERS                                            │
│     • Device flow for Claude/Codex                              │
│     • Store tokens in credential vault                          │
│     • (Can be done during or after onboarding)                  │
└─────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. SELECT REPOSITORIES                                          │
│     • List repos from GitHub                                    │
│     • User selects which to connect                             │
│     • Install GitHub App on selected repos                      │
└─────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. PROVISION WORKSPACE (automatic, ~30 seconds)                 │
│     • Allocate compute resources                                │
│     • Deploy agent-relay container                              │
│     • Clone selected repositories                               │
│     • Inject credentials from vault                             │
│     • Start daemon with supervisor                              │
│     • Configure webhooks                                        │
└─────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────────┐
│  5. READY                                                        │
│     • Dashboard URL live                                        │
│     • Agents ready to spawn                                     │
│     • GitHub webhooks configured                                │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Control Plane Services

#### API Server (`/src/cloud/api/`)
- Express.js REST API
- Handles all cloud operations
- Routes:
  - `/auth/*` - GitHub OAuth, session management
  - `/providers/*` - Device flow auth for AI providers
  - `/workspaces/*` - Workspace CRUD, provisioning
  - `/repos/*` - Repository management
  - `/teams/*` - Team management

#### Auth Service (`/src/cloud/auth/`)
- GitHub OAuth for user login
- Device flow for AI providers
- Session management (Redis)
- JWT tokens for API auth

#### Credential Vault (`/src/cloud/vault/`)
- Encrypted storage for OAuth tokens
- Per-user encryption keys
- Automatic token refresh
- Sync to workspaces

#### Workspace Provisioner (`/src/cloud/provisioner/`)
- Provisions compute resources
- Deploys agent-relay containers
- Manages workspace lifecycle
- Supports multiple backends:
  - Fly.io (default)
  - Railway
  - AWS ECS
  - Docker (local dev)

### 2. Compute Plane

#### Workspace Container
```dockerfile
FROM node:20-slim

# Install agent CLIs
RUN npm install -g agent-relay
RUN npm install -g @anthropic/claude-code
# Codex installed via their installer

# Workspace directory
WORKDIR /workspace

# Entry point
COPY entrypoint.sh /entrypoint.sh
CMD ["/entrypoint.sh"]
```

#### Entrypoint Script
```bash
#!/bin/bash

# Fetch credentials from vault
agent-relay cloud sync-credentials

# Clone repositories
for repo in $REPOS; do
  git clone "https://x-access-token:${GITHUB_TOKEN}@github.com/${repo}.git"
done

# Start agent-relay daemon with supervisor
agent-relay up --watch
```

## Database Schema

```sql
-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id TEXT UNIQUE NOT NULL,
  github_username TEXT NOT NULL,
  email TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  onboarding_completed_at TIMESTAMP
);

-- Provider Credentials (encrypted)
CREATE TABLE credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  provider TEXT NOT NULL, -- 'anthropic', 'openai', 'google', etc.
  encrypted_access_token TEXT NOT NULL,
  encrypted_refresh_token TEXT,
  token_expires_at TIMESTAMP,
  scopes TEXT[],
  provider_account_id TEXT,
  provider_account_email TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  last_refreshed_at TIMESTAMP,
  UNIQUE(user_id, provider)
);

-- Workspaces
CREATE TABLE workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  name TEXT NOT NULL,
  status TEXT DEFAULT 'provisioning', -- provisioning, running, stopped, failed
  compute_provider TEXT NOT NULL, -- 'fly', 'railway', 'ecs'
  compute_id TEXT, -- Provider-specific instance ID
  public_url TEXT, -- Dashboard URL
  internal_url TEXT, -- For API calls
  created_at TIMESTAMP DEFAULT NOW(),
  started_at TIMESTAMP,
  stopped_at TIMESTAMP
);

-- Connected Repositories
CREATE TABLE repositories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id),
  github_repo_id TEXT NOT NULL,
  github_full_name TEXT NOT NULL, -- 'owner/repo'
  default_branch TEXT DEFAULT 'main',
  webhook_id TEXT,
  last_synced_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Teams (for collaboration)
CREATE TABLE teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_id UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE team_members (
  team_id UUID REFERENCES teams(id),
  user_id UUID REFERENCES users(id),
  role TEXT DEFAULT 'member', -- 'owner', 'admin', 'member'
  PRIMARY KEY (team_id, user_id)
);
```

## API Endpoints

### Auth
```
POST /api/auth/github          # Start GitHub OAuth
GET  /api/auth/github/callback # OAuth callback
POST /api/auth/logout          # Logout
GET  /api/auth/me              # Get current user
```

### Providers
```
GET  /api/providers                    # List providers + connection status
POST /api/providers/:provider/connect  # Start device flow
GET  /api/providers/:provider/status   # Check device flow status
DELETE /api/providers/:provider        # Disconnect provider
```

### Workspaces
```
GET  /api/workspaces              # List user's workspaces
POST /api/workspaces              # Create (provisions automatically)
GET  /api/workspaces/:id          # Get workspace details
DELETE /api/workspaces/:id        # Delete workspace
POST /api/workspaces/:id/start    # Start stopped workspace
POST /api/workspaces/:id/stop     # Stop workspace
POST /api/workspaces/:id/restart  # Restart workspace
GET  /api/workspaces/:id/logs     # Get logs (SSE stream)
```

### Repositories
```
GET  /api/repos/available         # List GitHub repos user can add
POST /api/workspaces/:id/repos    # Add repo to workspace
DELETE /api/workspaces/:id/repos/:repoId  # Remove repo
POST /api/workspaces/:id/repos/:repoId/sync  # Force sync
```

### Agents
```
GET  /api/workspaces/:id/agents   # List agents in workspace
POST /api/workspaces/:id/agents   # Spawn new agent
DELETE /api/workspaces/:id/agents/:name  # Kill agent
POST /api/workspaces/:id/agents/:name/message  # Send message to agent
```

## Workspace Provisioner Implementation

### Interface
```typescript
interface WorkspaceProvisioner {
  provision(config: ProvisionConfig): Promise<Workspace>;
  start(workspaceId: string): Promise<void>;
  stop(workspaceId: string): Promise<void>;
  destroy(workspaceId: string): Promise<void>;
  getLogs(workspaceId: string): AsyncIterable<string>;
  getStatus(workspaceId: string): Promise<WorkspaceStatus>;
}

interface ProvisionConfig {
  userId: string;
  name: string;
  repos: string[];  // ['owner/repo', ...]
  providers: string[];  // ['anthropic', 'openai', ...]
  resources?: {
    cpu?: string;    // '1' = 1 core
    memory?: string; // '512Mi', '1Gi'
  };
}
```

### Fly.io Implementation
```typescript
class FlyProvisioner implements WorkspaceProvisioner {
  async provision(config: ProvisionConfig): Promise<Workspace> {
    // 1. Create Fly app
    const app = await this.fly.createApp({
      name: `relay-${config.userId.slice(0, 8)}`,
      org: 'agent-relay-cloud'
    });

    // 2. Set secrets (credentials)
    const credentials = await vault.getCredentials(config.userId, config.providers);
    await this.fly.setSecrets(app.name, {
      ANTHROPIC_AUTH_TOKEN: credentials.anthropic?.accessToken,
      OPENAI_AUTH_TOKEN: credentials.openai?.accessToken,
      GITHUB_TOKEN: await this.getGitHubToken(config.userId),
      REPOS: config.repos.join(','),
      CLOUD_API_URL: process.env.CLOUD_API_URL,
      WORKSPACE_ID: app.name
    });

    // 3. Deploy container
    await this.fly.deploy(app.name, {
      image: 'ghcr.io/agent-relay/workspace:latest',
      region: 'iad',  // or user's preferred region
      vm: {
        cpus: 1,
        memory: 512
      }
    });

    // 4. Wait for healthy
    await this.waitForHealthy(app.name);

    return {
      id: app.name,
      publicUrl: `https://${app.name}.fly.dev`,
      status: 'running'
    };
  }
}
```

## Directory Structure

```
src/cloud/
├── index.ts                 # Cloud service entry point
├── server.ts               # Express server setup
├── config.ts               # Configuration
│
├── api/                    # API routes
│   ├── index.ts
│   ├── auth.ts             # Auth routes
│   ├── providers.ts        # Provider connection routes
│   ├── workspaces.ts       # Workspace management
│   ├── repos.ts            # Repository management
│   └── agents.ts           # Agent management
│
├── auth/                   # Auth services
│   ├── github.ts           # GitHub OAuth
│   ├── device-flow.ts      # Device flow for providers
│   └── session.ts          # Session management
│
├── vault/                  # Credential vault
│   ├── index.ts
│   ├── encryption.ts       # AES-256-GCM encryption
│   └── refresh.ts          # Token refresh service
│
├── provisioner/            # Workspace provisioning
│   ├── index.ts            # Provisioner interface
│   ├── fly.ts              # Fly.io implementation
│   ├── railway.ts          # Railway implementation
│   ├── docker.ts           # Local Docker (dev)
│   └── workspace-image/    # Container image
│       ├── Dockerfile
│       └── entrypoint.sh
│
├── db/                     # Database
│   ├── index.ts            # Connection
│   ├── schema.sql          # Schema
│   └── migrations/         # Migrations
│
└── services/               # Business logic
    ├── users.ts
    ├── workspaces.ts
    ├── credentials.ts
    └── github.ts
```

## Environment Variables

```bash
# Database
DATABASE_URL=postgres://user:pass@host:5432/agent_relay_cloud
REDIS_URL=redis://host:6379

# GitHub OAuth
GITHUB_CLIENT_ID=xxx
GITHUB_CLIENT_SECRET=xxx
GITHUB_APP_ID=xxx
GITHUB_APP_PRIVATE_KEY=xxx

# Provider OAuth (for device flow)
ANTHROPIC_CLIENT_ID=xxx
OPENAI_CLIENT_ID=xxx
GOOGLE_CLIENT_ID=xxx

# Encryption
VAULT_MASTER_KEY=xxx  # 32 bytes, base64

# Compute provider
COMPUTE_PROVIDER=fly  # fly, railway, docker
FLY_API_TOKEN=xxx
FLY_ORG=agent-relay-cloud

# Server
PORT=3000
PUBLIC_URL=https://relay.cloud
SESSION_SECRET=xxx
```

## Security

### Credential Vault Encryption
- AES-256-GCM for token encryption
- Per-user keys derived from master key + user ID
- Tokens never stored in plaintext
- Encryption keys never leave control plane

### Workspace Isolation
- Each workspace runs in isolated container
- No shared filesystem between workspaces
- Network isolation (workspaces can't talk to each other)
- Credentials injected as environment variables (encrypted in transit)

### API Security
- All API calls require authentication
- CSRF protection on mutations
- Rate limiting per user
- Audit logging for sensitive operations

## Scaling

### Control Plane
- Stateless API servers behind load balancer
- PostgreSQL with read replicas
- Redis cluster for sessions/caching

### Compute Plane
- Workspaces scale independently
- Auto-sleep inactive workspaces (cost optimization)
- Wake on webhook or API call
- Regional deployment for latency

---

## Cloud Coordinators (Project Groups)

Coordinators are high-level AI agents that oversee multiple projects (repositories). They enable cross-workspace communication and coordination at scale.

### Workspace vs Project Group

**Workspace** = A single compute instance (Fly.io VM) that can hold multiple repos:
```
┌─────────────────────────────────────────────┐
│           Workspace (1 Fly.io VM)           │
│  /repos/                                    │
│   ├── frontend-app/     ← Repo 1           │
│   ├── backend-api/      ← Repo 2           │
│   └── shared-libs/      ← Repo 3           │
│                                             │
│  agent-relay daemon (1 per workspace)      │
│  Agents communicate via local Unix socket  │
└─────────────────────────────────────────────┘
```

**Project Group** = A logical grouping of repos that may span multiple workspaces:
- Repos in the **same workspace** → agents talk via local daemon (fast)
- Repos in **different workspaces** → need Redis pub/sub (cross-VM messaging)
- The **Coordinator** oversees all repos regardless of which workspace they're in

### Architecture Overview

```
┌─────────────────────────────────────────────────┐
│               Cloud Dashboard                    │
│  (User creates Project Group, selects repos)    │
└──────────────────┬──────────────────────────────┘
                   │ Creates Project Group
                   ▼
┌─────────────────────────────────────────────────┐
│            Project Group                         │
│  ├─ Repo 1 (connected via Cloud Worker)         │
│  ├─ Repo 2 (connected via Cloud Worker)         │
│  └─ Coordinator Agent (cloud-hosted)            │
└──────────────────┬──────────────────────────────┘
                   │ Redis Pub/Sub
                   ▼
┌─────────────────────────────────────────────────┐
│    Per-Workspace Workers (Fly.io Machines)      │
│  Each maintains connection to local project     │
│  daemon and relays messages to/from cloud       │
└─────────────────────────────────────────────────┘
```

### Local vs Cloud Comparison

| Feature | Local Bridge (`relay bridge`) | Cloud Coordinator |
|---------|-------------------------------|-------------------|
| Spawning | tmux sessions on local machine | Cloud-hosted process (Fly.io) |
| Messaging | Direct Unix socket connections | Redis pub/sub across workspaces |
| State | `bridge-state.json` file | PostgreSQL (project_groups table) |
| Scaling | Single machine | Multi-tenant, horizontal scaling |
| Dashboard | Local dashboard server | Cloud dashboard with auth |

### Database Schema

```sql
-- Project Groups (collection of repos with optional coordinator)
CREATE TABLE project_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  name TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Repos in a Project Group
CREATE TABLE project_group_repos (
  project_group_id UUID REFERENCES project_groups(id),
  repository_id UUID REFERENCES repositories(id),
  PRIMARY KEY (project_group_id, repository_id)
);

-- Coordinator Agents (one per project group)
CREATE TABLE coordinators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_group_id UUID REFERENCES project_groups(id) UNIQUE,
  name TEXT DEFAULT 'Architect',
  model TEXT DEFAULT 'claude-sonnet',
  status TEXT DEFAULT 'stopped', -- stopped, starting, running, error
  compute_id TEXT, -- Fly.io machine ID
  started_at TIMESTAMP,
  stopped_at TIMESTAMP
);
```

### API Endpoints

```
# Project Groups
GET  /api/project-groups              # List user's project groups
POST /api/project-groups              # Create project group
GET  /api/project-groups/:id          # Get project group details
DELETE /api/project-groups/:id        # Delete project group

# Coordinators
POST /api/project-groups/:id/coordinator/enable   # Start coordinator
POST /api/project-groups/:id/coordinator/disable  # Stop coordinator
GET  /api/project-groups/:id/coordinator/status   # Get coordinator status
POST /api/project-groups/:id/coordinator/message  # Send message to coordinator
```

### Cross-Workspace Messaging

Coordinators use Redis pub/sub for cross-workspace communication:

```typescript
// Publish to a workspace
redis.publish(`workspace:${workspaceId}:messages`, JSON.stringify({
  from: 'Architect',
  to: 'Lead',
  content: 'Please prioritize the auth module',
  timestamp: Date.now()
}));

// Subscribe to messages for a workspace
redis.subscribe(`workspace:${workspaceId}:messages`, (message) => {
  // Route to local agent via daemon
});
```

### Message Routing

```
Coordinator → Redis → Workspace Worker → Local Daemon → Agent
     ↑                                                    │
     └────────────────────────────────────────────────────┘
                        (response path)
```

### Coordinator Prompt Template

When a coordinator is started, it receives context about its project group:

```
You are the Architect, a cross-project coordinator overseeing multiple codebases.

## Connected Projects
- project-1: /repos/frontend (Lead: FrontendLead)
- project-2: /repos/backend (Lead: BackendLead)

## Your Role
- Coordinate high-level work across all projects
- Assign tasks to project leads
- Ensure consistency and resolve cross-project dependencies
- Review overall architecture decisions

## Cross-Project Messaging

Use this syntax to message agents in specific projects:
->relay:project-id:AgentName <<<
Your message>>>

->relay:project-id:* <<<
Broadcast to all agents in a project>>>

->relay:*:* <<<
Broadcast to ALL agents in ALL projects>>>
```

### Dashboard UI (CoordinatorPanel)

The dashboard provides a UI for managing coordinators:

1. **Create Project Group** - Select repositories to group together
2. **Enable Coordinator** - Start the coordinator agent
3. **Disable Coordinator** - Stop the coordinator agent
4. **Delete Project Group** - Remove the group and stop coordinator

For local bridge mode, the panel shows:
- "Spawn Architect" button (when in bridge mode with multiple projects)
- CLI selector (Claude, Claude Opus, Sonnet, Codex)
- Instructions for using `relay bridge --architect` flag
