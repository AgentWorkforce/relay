# Agent Relay Cloud - Onboarding Design

## Overview

Agent Relay Cloud provides a hosted version of agent-relay with:
- Automatic server provisioning with supervisor
- GitHub repository integration
- Multi-provider agent authentication
- Team management and collaboration

## Provider Authentication Architecture

### The Challenge

Each agent provider has different authentication mechanisms:

| Provider | Auth Method | Credentials |
|----------|-------------|-------------|
| Claude (Anthropic) | API Key | `ANTHROPIC_API_KEY` |
| Claude Code | OAuth | Browser-based login |
| OpenAI Codex | API Key | `OPENAI_API_KEY` |
| Gemini | API Key | `GOOGLE_API_KEY` |
| GitHub Copilot | OAuth | GitHub account |
| Local Ollama | None | Self-hosted |

### Proposed Solution: Provider Credentials Vault

```
┌─────────────────────────────────────────────────────────────────┐
│                    Agent Relay Cloud                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │   GitHub     │    │  Provider    │    │   Secrets    │       │
│  │   OAuth      │    │  Connector   │    │   Vault      │       │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘       │
│         │                   │                   │                │
│         ▼                   ▼                   ▼                │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                  Onboarding Flow                         │    │
│  │  1. Sign up (GitHub OAuth)                              │    │
│  │  2. Connect repositories                                │    │
│  │  3. Add agent providers                                 │    │
│  │  4. Configure teams                                     │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Onboarding Flow Design

### Step 1: Sign Up via GitHub OAuth

```
┌─────────────────────────────────────────────┐
│         Welcome to Agent Relay Cloud         │
│                                             │
│  Orchestrate AI agents across your repos    │
│                                             │
│  ┌─────────────────────────────────────┐   │
│  │  🔗 Continue with GitHub            │   │
│  └─────────────────────────────────────┘   │
│                                             │
│  By signing up, you agree to our Terms     │
└─────────────────────────────────────────────┘
```

**Why GitHub first?**
- Natural auth for developers
- Immediate access to repo list
- Repository permissions already defined
- GitHub Apps for webhook integration

### Step 2: Connect Repositories

```
┌─────────────────────────────────────────────────────────────┐
│  Select Repositories                                         │
│                                                              │
│  Which repositories should Agent Relay manage?              │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ 🔍 Search repositories...                              │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ☑️  acme/frontend          ⭐ 234   Updated 2 hours ago    │
│  ☑️  acme/backend-api       ⭐ 156   Updated 1 day ago      │
│  ☐  acme/docs              ⭐ 45    Updated 3 days ago      │
│  ☐  acme/mobile-app        ⭐ 89    Updated 1 week ago      │
│                                                              │
│  ┌──────────────┐  ┌──────────────────────────────────────┐ │
│  │    Back      │  │  Continue with 2 repositories  →    │ │
│  └──────────────┘  └──────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**What happens behind the scenes:**
- Install GitHub App on selected repos
- Clone repos to cloud workspace
- Detect existing `.claude/agents/` or `teams.json` configs
- Set up webhooks for PR/issue events

### Step 3: Add Agent Providers (The Key Step)

```
┌─────────────────────────────────────────────────────────────────┐
│  Connect Your AI Providers                                       │
│                                                                  │
│  Agent Relay works with multiple AI providers. Connect the      │
│  ones you want to use:                                          │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  ANTHROPIC                                    ┌───────────┐ ││
│  │  Claude Code, Claude API                      │  Connect  │ ││
│  │  ⚡ Recommended for code tasks                └───────────┘ ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  OPENAI                                       ┌───────────┐ ││
│  │  Codex, GPT-4                                 │  Connect  │ ││
│  │  Good for diverse tasks                       └───────────┘ ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  GOOGLE                                       ┌───────────┐ ││
│  │  Gemini                                       │  Connect  │ ││
│  │  Multi-modal capabilities                     └───────────┘ ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  + Add Custom Provider                                      ││
│  │  Ollama, LM Studio, or other CLI tools                      ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  You can always add more providers later in Settings            │
│                                                                  │
│  ┌──────────────┐  ┌──────────────────────────────────────────┐ │
│  │    Skip      │  │  Continue  →                            │ │
│  └──────────────┘  └──────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

#### Provider Connection Flows

**Option A: API Key Entry (Simple)**

```
┌─────────────────────────────────────────────────────────────┐
│  Connect Anthropic                                           │
│                                                              │
│  Enter your Anthropic API key:                              │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ sk-ant-api03-••••••••••••••••••••••••••••••••••••••••  │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  🔒 Your key is encrypted and stored securely               │
│                                                              │
│  Don't have a key? Get one at console.anthropic.com →       │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  ☐ Also connect Claude Code (requires OAuth)           │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌──────────────┐  ┌──────────────────────────────────────┐ │
│  │   Cancel     │  │  Connect Anthropic  →               │ │
│  └──────────────┘  └──────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**Option B: OAuth Flow (for Claude Code, Copilot, etc.)**

```
┌─────────────────────────────────────────────────────────────┐
│  Connect Claude Code                                         │
│                                                              │
│  Claude Code uses OAuth for authentication.                 │
│  You'll be redirected to Anthropic to authorize.            │
│                                                              │
│       ┌─────────────────────────────────────────┐           │
│       │                                         │           │
│       │     🔐 Authorize with Anthropic         │           │
│       │                                         │           │
│       │  Agent Relay Cloud wants to:            │           │
│       │  • Run Claude Code on your behalf       │           │
│       │  • Access your Claude usage quota       │           │
│       │                                         │           │
│       │  ┌─────────────┐  ┌─────────────────┐  │           │
│       │  │   Deny      │  │   Authorize     │  │           │
│       │  └─────────────┘  └─────────────────┘  │           │
│       │                                         │           │
│       └─────────────────────────────────────────┘           │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Step 4: Configure Your First Team (Optional)

```
┌─────────────────────────────────────────────────────────────────┐
│  Create Your First Agent Team                                    │
│                                                                  │
│  Teams are groups of AI agents that work together on tasks.     │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  🚀 Quick Start Templates                                │   │
│  ├──────────────────────────────────────────────────────────┤   │
│  │                                                          │   │
│  │  ┌────────────────────────────────────────────────────┐ │   │
│  │  │ 👥 Code Review Team                                │ │   │
│  │  │ Architect + Reviewer + Security Auditor            │ │   │
│  │  │ Auto-reviews PRs and suggests improvements         │ │   │
│  │  └────────────────────────────────────────────────────┘ │   │
│  │                                                          │   │
│  │  ┌────────────────────────────────────────────────────┐ │   │
│  │  │ 🛠️  Feature Development Team                       │ │   │
│  │  │ Lead + Frontend + Backend + Tester                 │ │   │
│  │  │ Coordinates multi-agent feature builds             │ │   │
│  │  └────────────────────────────────────────────────────┘ │   │
│  │                                                          │   │
│  │  ┌────────────────────────────────────────────────────┐ │   │
│  │  │ 📝 Custom Team                                     │ │   │
│  │  │ Configure your own agent composition               │ │   │
│  │  └────────────────────────────────────────────────────┘ │   │
│  │                                                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────┐  ┌──────────────────────────────────────────┐ │
│  │ Skip for now │  │  Select template  →                     │ │
│  └──────────────┘  └──────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Step 5: Ready to Go!

```
┌─────────────────────────────────────────────────────────────────┐
│  🎉 You're all set!                                              │
│                                                                  │
│  Your Agent Relay Cloud workspace is ready:                     │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  📂 Repositories          2 connected                    │   │
│  │  🤖 Agent Providers       Claude, Codex                  │   │
│  │  👥 Teams                 Code Review Team               │   │
│  │  🌐 Dashboard             relay.yourdomain.cloud         │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  What's next?                                                   │
│                                                                  │
│  • Open a PR to trigger automatic code review                   │
│  • Use @agent-relay in PR comments to chat with agents          │
│  • Visit your dashboard to monitor agent activity               │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Open Dashboard  →                                       │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Technical Implementation

### Provider Credentials Storage

```typescript
// src/cloud/providers/types.ts

interface ProviderCredential {
  id: string;
  userId: string;
  provider: ProviderType;
  authType: 'api_key' | 'oauth' | 'none';

  // For API key auth
  encryptedApiKey?: string;

  // For OAuth
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: Date;
  scopes?: string[];

  // Metadata
  displayName?: string;  // "Claude (Work Account)"
  createdAt: Date;
  lastUsedAt?: Date;
  isValid: boolean;
}

type ProviderType =
  | 'anthropic'      // Claude API
  | 'claude-code'    // Claude Code CLI (OAuth)
  | 'openai'         // Codex, GPT
  | 'google'         // Gemini
  | 'github'         // Copilot
  | 'custom';        // Ollama, local, etc.
```

### Provider Registry

```typescript
// src/cloud/providers/registry.ts

interface ProviderConfig {
  id: ProviderType;
  name: string;
  description: string;
  authMethods: AuthMethod[];
  cliCommand: string;
  cliArgs?: string[];
  envVars: Record<string, string>;  // Maps to credential fields
  oauthConfig?: OAuthConfig;
  setupUrl?: string;
  icon: string;
}

const PROVIDER_REGISTRY: ProviderConfig[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude API for programmatic access',
    authMethods: ['api_key'],
    cliCommand: 'claude',
    cliArgs: ['--dangerously-skip-permissions'],
    envVars: { 'ANTHROPIC_API_KEY': 'apiKey' },
    setupUrl: 'https://console.anthropic.com/settings/keys',
    icon: '🟠'
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Claude Code CLI with full capabilities',
    authMethods: ['oauth'],
    cliCommand: 'claude',
    cliArgs: ['--dangerously-skip-permissions'],
    oauthConfig: {
      authorizationUrl: 'https://console.anthropic.com/oauth/authorize',
      tokenUrl: 'https://api.anthropic.com/oauth/token',
      scopes: ['claude-code:execute']
    },
    icon: '🟠'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'Codex and GPT models',
    authMethods: ['api_key'],
    cliCommand: 'codex',
    cliArgs: ['--dangerously-bypass-approvals-and-sandbox'],
    envVars: { 'OPENAI_API_KEY': 'apiKey' },
    setupUrl: 'https://platform.openai.com/api-keys',
    icon: '🟢'
  },
  {
    id: 'google',
    name: 'Google AI',
    description: 'Gemini models',
    authMethods: ['api_key', 'oauth'],
    cliCommand: 'gemini',
    envVars: { 'GOOGLE_API_KEY': 'apiKey' },
    setupUrl: 'https://aistudio.google.com/app/apikey',
    icon: '🔵'
  },
  {
    id: 'custom',
    name: 'Custom Provider',
    description: 'Ollama, LM Studio, or other tools',
    authMethods: ['none', 'api_key'],
    cliCommand: '', // User specifies
    icon: '⚙️'
  }
];
```

### Spawner Integration

```typescript
// src/cloud/spawner-cloud.ts

class CloudAgentSpawner extends AgentSpawner {
  private credentialVault: CredentialVault;

  async spawn(request: CloudSpawnRequest): Promise<SpawnedAgent> {
    const { userId, provider, agentName, task } = request;

    // Get credentials for this provider
    const credential = await this.credentialVault.get(userId, provider);
    if (!credential) {
      throw new Error(`No ${provider} credentials configured`);
    }

    // Validate credentials are still valid
    if (credential.authType === 'oauth') {
      await this.refreshTokenIfNeeded(credential);
    }

    // Build environment with credentials
    const env = this.buildProviderEnv(credential);

    // Get provider config
    const providerConfig = PROVIDER_REGISTRY.find(p => p.id === provider);

    // Spawn agent with credentials injected
    return super.spawn({
      name: agentName,
      cli: providerConfig.cliCommand,
      args: providerConfig.cliArgs,
      env,
      task
    });
  }

  private buildProviderEnv(credential: ProviderCredential): Record<string, string> {
    const config = PROVIDER_REGISTRY.find(p => p.id === credential.provider);
    const env: Record<string, string> = {};

    if (credential.authType === 'api_key' && credential.encryptedApiKey) {
      const apiKey = this.credentialVault.decrypt(credential.encryptedApiKey);
      for (const [envVar, _] of Object.entries(config.envVars)) {
        env[envVar] = apiKey;
      }
    } else if (credential.authType === 'oauth' && credential.accessToken) {
      // OAuth tokens might need different handling per provider
      env['PROVIDER_ACCESS_TOKEN'] = credential.accessToken;
    }

    return env;
  }
}
```

### Onboarding API

```typescript
// src/cloud/api/onboarding.ts

const onboardingRouter = Router();

// Step 1: GitHub OAuth callback
onboardingRouter.get('/auth/github/callback', async (req, res) => {
  const { code } = req.query;
  const tokens = await exchangeGitHubCode(code);
  const user = await createOrUpdateUser(tokens);

  // Set session and redirect to repo selection
  req.session.userId = user.id;
  res.redirect('/onboarding/repositories');
});

// Step 2: Get user's repositories
onboardingRouter.get('/repositories', async (req, res) => {
  const repos = await github.listUserRepos(req.session.accessToken);
  res.json({ repos });
});

// Step 2: Connect selected repositories
onboardingRouter.post('/repositories', async (req, res) => {
  const { repoIds } = req.body;
  await Promise.all(repoIds.map(id =>
    connectRepository(req.session.userId, id)
  ));
  res.json({ success: true });
});

// Step 3: List available providers
onboardingRouter.get('/providers', async (req, res) => {
  const connected = await getConnectedProviders(req.session.userId);
  res.json({
    available: PROVIDER_REGISTRY,
    connected
  });
});

// Step 3: Connect provider (API Key)
onboardingRouter.post('/providers/:provider/api-key', async (req, res) => {
  const { provider } = req.params;
  const { apiKey, displayName } = req.body;

  // Validate API key works
  const isValid = await validateProviderKey(provider, apiKey);
  if (!isValid) {
    return res.status(400).json({ error: 'Invalid API key' });
  }

  // Encrypt and store
  await credentialVault.store({
    userId: req.session.userId,
    provider,
    authType: 'api_key',
    encryptedApiKey: encrypt(apiKey),
    displayName,
    isValid: true
  });

  res.json({ success: true });
});

// Step 3: Connect provider (OAuth - initiate)
onboardingRouter.get('/providers/:provider/oauth', async (req, res) => {
  const { provider } = req.params;
  const config = PROVIDER_REGISTRY.find(p => p.id === provider);

  const state = generateOAuthState(req.session.userId, provider);
  const authUrl = buildOAuthUrl(config.oauthConfig, state);

  res.redirect(authUrl);
});

// Step 3: OAuth callback
onboardingRouter.get('/providers/:provider/oauth/callback', async (req, res) => {
  const { code, state } = req.query;
  const { userId, provider } = verifyOAuthState(state);

  const tokens = await exchangeOAuthCode(provider, code);

  await credentialVault.store({
    userId,
    provider,
    authType: 'oauth',
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenExpiresAt: tokens.expiresAt,
    scopes: tokens.scopes,
    isValid: true
  });

  res.redirect('/onboarding/providers?connected=' + provider);
});

// Step 4: Create team from template
onboardingRouter.post('/teams/from-template', async (req, res) => {
  const { templateId, repoIds } = req.body;
  const template = TEAM_TEMPLATES[templateId];

  const team = await createTeam({
    userId: req.session.userId,
    name: template.name,
    agents: template.agents.map(a => ({
      ...a,
      provider: req.body.defaultProvider || 'anthropic'
    })),
    repoIds
  });

  res.json({ team });
});

// Complete onboarding
onboardingRouter.post('/complete', async (req, res) => {
  await markOnboardingComplete(req.session.userId);

  // Provision workspace
  const workspace = await provisionWorkspace(req.session.userId);

  res.json({
    dashboardUrl: workspace.dashboardUrl,
    webhookUrl: workspace.webhookUrl
  });
});
```

---

## Security Considerations

### API Key Storage

1. **Encryption at rest**: All API keys encrypted with AES-256-GCM
2. **Key derivation**: Per-user encryption keys derived from master key + user ID
3. **No plaintext logging**: API keys never logged, even in debug mode
4. **Rotation support**: Users can rotate keys without losing config

### OAuth Token Management

1. **Automatic refresh**: Tokens refreshed before expiry
2. **Secure storage**: Tokens stored encrypted, same as API keys
3. **Scope limiting**: Request minimum required scopes
4. **Revocation handling**: Detect revoked tokens, prompt re-auth

### Access Control

1. **User isolation**: Credentials tied to user ID, not shared
2. **Team permissions**: Team admins can share provider access with team
3. **Audit logging**: All credential access logged
4. **Rate limiting**: Provider usage rate-limited per user

---

## Future Enhancements

### 1. Credential Sharing for Teams

Allow team admins to share provider credentials with team members:

```typescript
interface SharedCredential {
  credentialId: string;
  teamId: string;
  sharedBy: string;
  permissions: 'read' | 'use';  // 'use' allows spawning agents
}
```

### 2. Usage Tracking & Billing

Track provider usage per user/team for billing:

```typescript
interface UsageRecord {
  userId: string;
  teamId?: string;
  provider: ProviderType;
  agentName: string;
  tokensUsed: number;
  duration: number;
  timestamp: Date;
}
```

### 3. Provider Health Monitoring

Monitor provider availability and quota:

```typescript
interface ProviderHealth {
  provider: ProviderType;
  status: 'healthy' | 'degraded' | 'down';
  quotaRemaining?: number;
  lastChecked: Date;
}
```

### 4. Bring Your Own Cloud

Let users connect their own cloud accounts for compute:

- AWS credentials for EC2 instances
- GCP credentials for Cloud Run
- Azure credentials for Container Instances

---

## Summary

The onboarding flow prioritizes:

1. **Low friction**: GitHub OAuth gets users started immediately
2. **Flexibility**: Support multiple auth methods per provider
3. **Security**: Encrypted credential storage with proper isolation
4. **Discoverability**: Show available providers with easy setup links
5. **Progressive disclosure**: Optional team setup, can skip and add later

Users can authenticate with all their providers upfront during onboarding, or add them incrementally as needed from settings.
