# Agent Relay Plugin Registry

Design document for the AR extension ecosystem.

---

## Vision

Create a discoverable, installable ecosystem of extensions that lets developers:
- Find and install pre-built integrations
- Share their own extensions with the community
- Extend AR without modifying core code

Think: npm for agent infrastructure, or Supabase's integrations marketplace.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Plugin Registry                              │
│                   (registry.agentrelay.dev)                         │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌────────────┐ │
│  │   Bridges   │  │   Storage   │  │   Memory    │  │   Policy   │ │
│  │  (Slack,    │  │  (Postgres, │  │  (Pinecone, │  │  (RBAC,    │ │
│  │   Discord)  │  │   Redis)    │  │   Qdrant)   │  │   Audit)   │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └────────────┘ │
├─────────────────────────────────────────────────────────────────────┤
│  Discovery API  │  Package Hosting  │  Verification  │  Analytics  │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          ar plugin CLI                              │
│  ar plugin search slack                                             │
│  ar plugin install @ar/slack-bridge                                 │
│  ar plugin publish ./my-plugin                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Plugin Types

### 1. Bridges

Connect AR to external systems.

```yaml
type: bridge
name: "@ar/slack-bridge"
description: "Connect Slack to Agent Relay"
category: communication
tags: [slack, chat, team]

# Configuration schema
config:
  required:
    - SLACK_BOT_TOKEN
    - SLACK_APP_TOKEN
  optional:
    - DEFAULT_CHANNEL

# What it provides
provides:
  - bidirectional: true
    external: slack
    internal: relay

# Dependencies
dependencies:
  "@slack/bolt": "^3.17.0"
```

### 2. Storage Adapters

Custom persistence backends.

```yaml
type: storage
name: "@ar/postgres-storage"
description: "PostgreSQL storage adapter"
category: database
tags: [postgres, sql, production]

config:
  required:
    - DATABASE_URL
  optional:
    - POOL_MIN
    - POOL_MAX

implements:
  - StorageAdapter

features:
  - messages: true
  - sessions: true
  - summaries: true
  - dlq: true

dependencies:
  "pg": "^8.11.0"
```

### 3. Memory Adapters

Vector/semantic memory systems.

```yaml
type: memory
name: "@ar/pinecone-memory"
description: "Pinecone vector memory adapter"
category: ai
tags: [vector, rag, pinecone]

config:
  required:
    - PINECONE_API_KEY
    - PINECONE_INDEX
  optional:
    - OPENAI_API_KEY  # For embeddings

implements:
  - MemoryAdapter

features:
  - semantic_search: true
  - metadata_filter: true
  - namespaces: true
```

### 4. Policy Engines

Access control and governance.

```yaml
type: policy
name: "@ar/rbac-policy"
description: "Role-based access control"
category: security
tags: [rbac, security, access-control]

implements:
  - PolicyEngine

features:
  - roles: true
  - permissions: true
  - rate_limiting: true
  - audit_log: true
```

### 5. Hooks

Event handlers and middleware.

```yaml
type: hook
name: "@ar/audit-logger"
description: "Log all messages to audit trail"
category: compliance
tags: [audit, logging, compliance]

hooks:
  - onMessage: true
  - onConnect: true
  - onDisconnect: true

outputs:
  - format: json
    destination: file | s3 | datadog
```

### 6. Dashboard Widgets

Custom UI components for the dashboard.

```yaml
type: widget
name: "@ar/message-analytics"
description: "Message volume and latency charts"
category: observability
tags: [analytics, charts, monitoring]

displays:
  - type: chart
    data: message_volume
  - type: metric
    data: p99_latency
```

---

## Plugin Manifest

Every plugin has an `ar-plugin.yaml` manifest:

```yaml
# Required
name: "@myorg/slack-bridge"
version: "1.0.0"
type: bridge
description: "Connect Slack to Agent Relay"

# Author/Publisher
author:
  name: "Your Name"
  email: "you@example.com"
  url: "https://github.com/yourorg"

# Repository
repository:
  type: git
  url: "https://github.com/yourorg/ar-slack-bridge"

# License
license: MIT

# Entry points
main: "./dist/index.js"
types: "./dist/index.d.ts"

# Configuration
config:
  schema: "./config-schema.json"
  required:
    - SLACK_BOT_TOKEN
  optional:
    - DEFAULT_CHANNEL

# Dependencies
dependencies:
  "@slack/bolt": "^3.17.0"
peerDependencies:
  "agent-relay": "^1.3.0"

# Tags for discovery
tags:
  - slack
  - chat
  - bridge

# Category
category: communication

# Minimum AR version
minVersion: "1.3.0"

# Verification status (set by registry)
verified: false
official: false
```

---

## CLI Interface

### Discovery

```bash
# Search plugins
ar plugin search slack
ar plugin search --type bridge
ar plugin search --category database
ar plugin search --tag production

# Browse categories
ar plugin list --type storage
ar plugin list --official

# Get plugin info
ar plugin info @ar/slack-bridge

# Show README
ar plugin readme @ar/postgres-storage
```

### Installation

```bash
# Install from registry
ar plugin install @ar/slack-bridge

# Install specific version
ar plugin install @ar/slack-bridge@1.2.0

# Install from git
ar plugin install github:yourorg/my-plugin

# Install from local path
ar plugin install ./my-local-plugin

# List installed
ar plugin list

# Update all
ar plugin update

# Remove
ar plugin remove @ar/slack-bridge
```

### Usage

```bash
# Configure plugin
ar plugin config @ar/slack-bridge

# Enable/disable
ar plugin enable @ar/slack-bridge
ar plugin disable @ar/slack-bridge

# View logs
ar plugin logs @ar/slack-bridge

# Check health
ar plugin health
```

### Publishing

```bash
# Login to registry
ar plugin login

# Validate before publishing
ar plugin validate ./my-plugin

# Publish
ar plugin publish ./my-plugin

# Publish with tag
ar plugin publish ./my-plugin --tag beta

# Deprecate version
ar plugin deprecate @myorg/my-plugin@1.0.0 --message "Use 2.0 instead"
```

---

## Registry API

### Public Endpoints

```
# Search plugins
GET /api/v1/plugins?q=slack&type=bridge&limit=20

# Get plugin details
GET /api/v1/plugins/@ar/slack-bridge

# Get specific version
GET /api/v1/plugins/@ar/slack-bridge/1.2.0

# Download package
GET /api/v1/plugins/@ar/slack-bridge/1.2.0/download

# Get README
GET /api/v1/plugins/@ar/slack-bridge/readme

# List categories
GET /api/v1/categories

# List tags
GET /api/v1/tags

# Featured/popular
GET /api/v1/plugins/featured
GET /api/v1/plugins/popular
```

### Authenticated Endpoints

```
# Publish new version
POST /api/v1/plugins
Authorization: Bearer <token>
Content-Type: multipart/form-data

# Update metadata
PATCH /api/v1/plugins/@myorg/my-plugin
Authorization: Bearer <token>

# Deprecate version
POST /api/v1/plugins/@myorg/my-plugin/1.0.0/deprecate
Authorization: Bearer <token>

# Transfer ownership
POST /api/v1/plugins/@myorg/my-plugin/transfer
Authorization: Bearer <token>
```

### Webhook Notifications

```json
{
  "event": "plugin.published",
  "plugin": "@myorg/my-plugin",
  "version": "1.2.0",
  "timestamp": "2024-01-15T10:30:00Z"
}
```

---

## Plugin Loader

The AR daemon loads plugins at startup:

```typescript
// ar.config.ts
export default {
  plugins: [
    // From registry
    '@ar/slack-bridge',
    '@ar/postgres-storage',

    // Specific version
    '@ar/pinecone-memory@2.0.0',

    // With config
    {
      name: '@ar/slack-bridge',
      config: {
        defaultChannel: '#agents',
      },
    },

    // Local plugin
    './my-local-plugin',
  ],
};
```

### Loader Implementation

```typescript
interface PluginLoader {
  // Load all configured plugins
  loadAll(config: PluginConfig[]): Promise<LoadedPlugin[]>;

  // Load single plugin
  load(name: string, version?: string): Promise<LoadedPlugin>;

  // Get loaded plugins
  getLoaded(): LoadedPlugin[];

  // Unload plugin
  unload(name: string): Promise<void>;

  // Reload plugin (for development)
  reload(name: string): Promise<LoadedPlugin>;
}

interface LoadedPlugin {
  name: string;
  version: string;
  type: PluginType;
  instance: unknown;
  manifest: PluginManifest;
  status: 'active' | 'error' | 'disabled';
  error?: Error;
}
```

### Plugin Lifecycle

```typescript
interface Plugin {
  // Called when plugin is loaded
  onLoad?(context: PluginContext): Promise<void>;

  // Called when plugin is unloaded
  onUnload?(): Promise<void>;

  // Health check
  health?(): Promise<HealthStatus>;
}

interface PluginContext {
  // Access to daemon
  daemon: Daemon;

  // Access to relay client
  client: RelayClient;

  // Plugin config (from ar.config.ts)
  config: Record<string, unknown>;

  // Logger
  logger: Logger;

  // Metrics
  metrics: MetricsCollector;
}
```

---

## Verification & Trust

### Trust Levels

```
┌─────────────────────────────────────────────────────────────────┐
│  OFFICIAL (@ar/*)                                               │
│  • Maintained by AR team                                        │
│  • Full security review                                         │
│  • Guaranteed compatibility                                     │
│  • Priority support                                             │
├─────────────────────────────────────────────────────────────────┤
│  VERIFIED                                                       │
│  • Security scan passed                                         │
│  • Code review completed                                        │
│  • Author identity verified                                     │
│  • Compatibility tested                                         │
├─────────────────────────────────────────────────────────────────┤
│  COMMUNITY                                                      │
│  • Published by community                                       │
│  • Basic automated checks                                       │
│  • Use at your own risk                                         │
└─────────────────────────────────────────────────────────────────┘
```

### Verification Process

1. **Automated Checks**
   - Package builds successfully
   - No known vulnerabilities in deps
   - TypeScript types valid
   - Tests pass
   - Size limits respected

2. **Security Scan**
   - Static analysis for common issues
   - Dependency audit
   - No suspicious network calls
   - No eval/dynamic code execution

3. **Manual Review** (for verified status)
   - Code review by AR team
   - Functionality testing
   - Documentation review

### Security Policies

```yaml
# Plugins cannot:
security:
  blocklist:
    - eval
    - Function constructor
    - child_process.exec (without approval)
    - fs.write outside data directory
    - network calls to unapproved domains

# Plugins must:
requirements:
  - declare all permissions
  - use sandboxed file access
  - respect rate limits
  - handle errors gracefully
```

---

## Discovery UI

### Registry Website

```
registry.agentrelay.dev
├── /                    # Featured & popular plugins
├── /search              # Search interface
├── /categories          # Browse by category
├── /plugins/@ar/slack   # Plugin detail page
├── /publish             # Publishing guide
└── /docs                # Plugin development docs
```

### Plugin Detail Page

```
┌─────────────────────────────────────────────────────────────────┐
│  @ar/slack-bridge                           [OFFICIAL] [v1.2.0]│
│  Connect Slack to Agent Relay                                   │
│                                                                 │
│  ⭐ 4.8 (127 ratings)  📦 2.3k weekly downloads  🔗 MIT        │
├─────────────────────────────────────────────────────────────────┤
│  [README] [Versions] [Dependencies] [Dependents] [Stats]       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ## Installation                                                │
│  ```                                                            │
│  ar plugin install @ar/slack-bridge                             │
│  ```                                                            │
│                                                                 │
│  ## Configuration                                               │
│  ...                                                            │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  Maintainer: Agent Relay Team                                   │
│  Repository: github.com/agentrelay/slack-bridge                 │
│  Last updated: 2 days ago                                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Analytics & Insights

### For Plugin Authors

```
┌─────────────────────────────────────────────────────────────────┐
│  @myorg/my-plugin Dashboard                                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Downloads (Last 30 days)                                       │
│  ████████████████████████████░░░░░  2,847                      │
│                                                                 │
│  Active Installations: 1,203                                    │
│  Error Rate: 0.02%                                              │
│  Avg Load Time: 45ms                                            │
│                                                                 │
│  Version Distribution:                                          │
│  1.2.0  ████████████████████  68%                              │
│  1.1.0  ██████                21%                               │
│  1.0.0  ███                   11%                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### For AR Team

- Total plugins published
- Downloads by category
- Error rates by plugin
- Popular search terms
- Unmet needs (searched but not found)

---

## Monetization (Future)

### For Plugin Authors

1. **Free Tier**
   - Unlimited public plugins
   - Basic analytics
   - Community support

2. **Pro Tier** ($9/mo)
   - Private plugins
   - Advanced analytics
   - Priority review
   - Custom domains

3. **Enterprise**
   - On-prem registry
   - SSO integration
   - Audit logs
   - SLA

### Marketplace Model (Optional)

- Premium plugins with revenue share
- Sponsored plugins (promoted placement)
- Support contracts

---

## Implementation Phases

### Phase 1: Foundation (MVP)

- [ ] Plugin manifest schema
- [ ] CLI: install, list, remove
- [ ] Local plugin loading
- [ ] Basic registry API (read-only)
- [ ] 5 official plugins (@ar/slack, @ar/discord, @ar/postgres, @ar/webhook, @ar/audit)

### Phase 2: Publishing

- [ ] CLI: publish, validate
- [ ] Registry authentication
- [ ] Package hosting
- [ ] Automated security scan
- [ ] Registry website (basic)

### Phase 3: Discovery

- [ ] Search with filters
- [ ] Categories and tags
- [ ] Plugin ratings/reviews
- [ ] Download statistics
- [ ] Registry website (full)

### Phase 4: Trust & Safety

- [ ] Verification program
- [ ] Security sandboxing
- [ ] Dependency vulnerability alerts
- [ ] Abuse reporting

### Phase 5: Ecosystem

- [ ] Plugin analytics dashboard
- [ ] Monetization options
- [ ] Enterprise features
- [ ] SDK for plugin development

---

## Open Questions

1. **Naming Convention**
   - `@ar/official-plugin` vs `@org/community-plugin`?
   - Allow scoped names like npm?

2. **Hosting**
   - Host packages ourselves or use npm?
   - Mirror to npm for discoverability?

3. **Versioning**
   - Strict semver enforcement?
   - Auto-update policies?

4. **Sandboxing**
   - How much to sandbox plugins?
   - Performance vs security tradeoff?

5. **Revenue**
   - Build marketplace into registry?
   - Or keep it pure/free forever?

---

## References

- [npm Registry](https://docs.npmjs.com/cli/v9/using-npm/registry)
- [VS Code Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [Supabase Integrations](https://supabase.com/docs/guides/integrations)
- [Terraform Registry](https://registry.terraform.io/)
- [Homebrew Taps](https://docs.brew.sh/Taps)
