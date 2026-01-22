# Multi-Server Architecture: Current State & Vision

**Status:** Living Document
**Last Updated:** 2025-01-07
**Related:** PR #8 (Federation Proposal)

## Executive Summary

This document provides a realistic assessment of agent-relay's multi-server capabilities today and a detailed roadmap for achieving the vision of **N servers per organization, each potentially on different repos, all communicating seamlessly**.

### The Vision

```
Organization: Acme Corp (Team Plan)
├── User Alice (Server 1) → Repo: acme/frontend
├── User Bob (Server 2) → Repo: acme/backend
├── User Carol (Server 3) → Repo: acme/shared-lib
├── User Dave (Server 4) → Repo: acme/frontend (same repo, different server)
└── User Eve (Server 5) → Repo: acme/mobile
    ↓
    All agents can communicate across servers
    ↓
    Per-user billing, org-level governance
```

---

## Table of Contents

1. [Current State: What's Built Today](#1-current-state-whats-built-today)
2. [Architecture Deep Dive](#2-architecture-deep-dive)
3. [Gap Analysis](#3-gap-analysis)
4. [Target Architecture](#4-target-architecture)
5. [Implementation Roadmap](#5-implementation-roadmap)
6. [Pricing Model](#6-pricing-model)
7. [Technical Specifications](#7-technical-specifications)
8. [Agent Implementation Guide](#8-agent-implementation-guide)
9. [Appendix A: Migration Path](#appendix-a-migration-path)
10. [Appendix B: Critical Insights from PR #8](#appendix-b-critical-insights-from-pr-8)
11. [Appendix C: Comparison Summary](#appendix-c-comparison-summary)

---

## 1. Current State: What's Built Today

### 1.1 What Works ✅

| Capability | Implementation | File Reference |
|------------|----------------|----------------|
| **Per-user workspaces** | Workspaces are user-scoped containers | `src/cloud/db/schema.ts:workspaces` |
| **Cross-machine agent discovery** | CloudSyncService heartbeats | `src/daemon/cloud-sync.ts` |
| **Cross-machine messaging** | Via cloud API relay | `src/daemon/router.ts:560-620` |
| **Multi-project bridge** | MultiProjectClient | `src/bridge/multi-project-client.ts` |
| **Agent policy governance** | Per-workspace policies | `src/policy/agent-policy.ts` |
| **Horizontal scaling** | ScalingOrchestrator | `src/cloud/services/scaling-orchestrator.ts` |
| **Project groups** | Coordinator agents across repos | `src/cloud/db/schema.ts:projectGroups` |

### 1.2 Cross-Project Messaging (Already Works)

Agents can already message across projects using the `project:agent` format:

```
->relay:frontend:Designer <<<
Please update the login UI for the new auth flow>>>

->relay:backend:Lead <<<
API question - should we use REST or GraphQL?>>>

->relay:*:* <<<
Broadcast to ALL agents in ALL projects>>>
```

### 1.3 Current Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CURRENT ARCHITECTURE                                 │
│                                                                              │
│  LOCAL MACHINE A              LOCAL MACHINE B              CLOUD             │
│  ┌─────────────────┐         ┌─────────────────┐         ┌────────────────┐ │
│  │ Daemon (proj-a) │         │ Daemon (proj-b) │         │ Control Plane  │ │
│  │                 │         │                 │         │                │ │
│  │ ┌─────┐ ┌─────┐│         │ ┌─────┐ ┌─────┐ │         │ ┌────────────┐ │ │
│  │ │Alice│ │Bob  ││         │ │Carol│ │Dave │ │         │ │ PostgreSQL │ │ │
│  │ └──┬──┘ └──┬──┘│         │ └──┬──┘ └──┬──┘ │         │ │   + Redis  │ │ │
│  │    │       │   │         │    │       │    │         │ └─────┬──────┘ │ │
│  │ ┌──┴───────┴──┐│         │ ┌──┴───────┴───┐│         │       │        │ │
│  │ │   Router    ││         │ │    Router    ││         │ ┌─────┴──────┐ │ │
│  │ └──────┬──────┘│         │ └──────┬───────┘│         │ │  REST API  │ │ │
│  │        │       │         │        │        │         │ │ /daemons/* │ │ │
│  │ ┌──────┴──────┐│         │ ┌──────┴───────┐│         │ │ /messages/*│ │ │
│  │ │CloudSyncSvc ││         │ │CloudSyncSvc  ││         │ └─────┬──────┘ │ │
│  │ └──────┬──────┘│         │ └──────┬───────┘│         │       │        │ │
│  └────────┼───────┘         └────────┼────────┘         └───────┼────────┘ │
│           │                          │                          │          │
│           └──────────────────────────┴──────────────────────────┘          │
│                              Heartbeat + Relay                              │
│                              (30s interval)                                 │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.4 Current Limitations ⚠️

| Limitation | Impact | Priority |
|------------|--------|----------|
| **Cloud-mediated routing** | ~100-300ms latency per cross-machine message | High |
| **No P2P connections** | All cross-machine traffic through cloud API | High |
| **User-centric billing** | No org-level plans or team billing | Medium |
| **Single repo per workspace** | Can't run multi-repo in one daemon | Medium |
| **No global agent registry** | Agent name collisions possible across machines | Medium |
| **Limited offline queuing** | Messages lost if cloud unavailable | Low |

### 1.5 Message Injection Architecture (relay-pty)

The system uses a Rust-based PTY wrapper (`relay-pty`) for reliable message injection:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       RELAY-PTY MESSAGE FLOW                                 │
│                                                                              │
│  Agent writes file          relay-pty parses         Orchestrator routes    │
│  to outbox                  and emits JSON           via daemon/cloud       │
│                                                                              │
│  ┌────────────────┐        ┌────────────────┐        ┌────────────────┐    │
│  │ Agent (claude) │        │   relay-pty    │        │  Orchestrator  │    │
│  │                │        │   (Rust PTY)   │        │  (TypeScript)  │    │
│  │ cat > outbox/  │        │                │        │                │    │
│  │   msg << EOF   │───────►│ Parse output   │───────►│ Route message  │    │
│  │ TO: Bob        │ stdout │ Detect ->relay │ stderr │ via daemon or  │    │
│  │ Hello!         │        │ -file:ID       │  JSON  │ cloud API      │    │
│  │ EOF            │        │                │        │                │    │
│  │                │        │ Read file,     │        │                │    │
│  │ ->relay-file:  │        │ emit JSON to   │        │                │    │
│  │   msg          │        │ stderr         │        │                │    │
│  └────────────────┘        └────────────────┘        └────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**File-based Format (Preferred):**
```
# Agent writes to ~/.agent-relay/outbox/$AGENT_RELAY_NAME/msg-001
TO: Bob
THREAD: optional

Message body here.
No escaping needed.
```

Then outputs: `->relay-file:msg-001`

**Why File-based?**
1. **Avoids terminal corruption** - Terminal line wrapping can corrupt inline messages
2. **No escaping required** - Heredoc syntax prevents bash interpretation issues
3. **Reliable parsing** - File content isn't affected by ANSI codes or TUI rendering
4. **Simpler for agents** - Header format is more natural than JSON

**Spawn/Release via Files:**
```
# Spawn
KIND: spawn
NAME: WorkerName
CLI: claude

Task description here.

# Release
KIND: release
NAME: WorkerName
```

---

## 2. Architecture Deep Dive

### 2.1 Database Schema (Current)

```typescript
// Users & Auth
users {
  id: UUID,
  githubId: TEXT UNIQUE,
  plan: 'free' | 'pro' | 'team',  // Per-user billing
  stripeCustomerId: VARCHAR
}

// Workspaces (Agent containers)
workspaces {
  id: UUID,
  userId: UUID FK,           // Each workspace owned by one user
  name: VARCHAR,
  status: 'provisioning' | 'running' | 'stopped' | 'failed',
  config: {
    repositories: string[],  // Currently just one
    maxAgents: number,
    resourceTier: 'small' | 'medium' | 'large' | 'xlarge'
  }
}

// Linked Daemons (Local machines connected to cloud)
linkedDaemons {
  id: UUID,
  userId: UUID FK,
  machineId: VARCHAR UNIQUE,
  apiKeyHash: VARCHAR,       // SHA256 of ar_live_xxx
  status: 'online' | 'offline',
  lastSeenAt: TIMESTAMP,
  messageQueue: JSONB        // Pending messages when offline
}

// Project Groups (Multi-repo coordination)
projectGroups {
  id: UUID,
  userId: UUID FK,
  name: VARCHAR,
  coordinatorAgent: {
    enabled: boolean,
    name: string,
    model: string,
    systemPrompt: string
  }
}
```

### 2.2 Message Routing Flow

```
Alice@MachineA wants to message Carol@MachineB:

1. Alice writes file and outputs: ->relay-file:msg-001
   (File contains: TO: Carol\n\nHello!)

2. relay-pty detects pattern, reads file, emits JSON to stderr

3. RelayPtyOrchestrator receives JSON, calls sendRelayCommand()

4. Router checks: Carol not local

5. Router calls CloudSyncService.sendCrossMachineMessage()

6. CloudSyncService POSTs to /api/messages/relay:
   {
     from: { daemonId: "daemon-a", agent: "Alice" },
     to: "Carol",
     content: "Hello!"
   }

7. Cloud API looks up Carol's daemon via linkedDaemons table

8. Cloud queues message in daemon-b's messageQueue

9. MachineB's CloudSyncService polls and receives message

10. MachineB's Router delivers to Carol via relay-pty socket injection

Total latency: 100-500ms (depends on poll interval)
```

**Local Message Flow (Same Machine):**
```
Alice -> Bob (both on MachineA):

1. Alice writes file, outputs ->relay-file:msg-001
2. relay-pty parses, emits JSON
3. Orchestrator calls router.send()
4. Router finds Bob is local
5. Router delivers via Bob's relay-pty socket
6. Bob's relay-pty injects message into PTY

Total latency: <50ms
```

### 2.3 Scaling Characteristics

| Metric | Current Capacity | Bottleneck |
|--------|------------------|------------|
| Agents per daemon | ~50 | Memory (each wrapper ~50MB) |
| Messages per second (local) | ~100/sec | SQLite writes |
| Messages per second (cross-machine) | ~10/sec | Cloud API rate limit |
| Linked daemons per user | Unlimited | No limit |
| Workspaces per user | Plan-dependent | Billing |

---

## 3. Gap Analysis

### 3.1 Missing for N-Server Vision

| Gap | Description | Effort |
|-----|-------------|--------|
| **Organizations table** | Group users under org billing | 2 days |
| **Org-level policies** | Governance across all org members | 2 days |
| **P2P daemon connections** | Direct WebSocket between daemons | 5 days |
| **Global agent registry** | Fleet-wide unique names | 3 days |
| **Multi-repo per daemon** | Multiple repos in one workspace | 3 days |
| **Org billing integration** | Stripe org subscriptions | 3 days |

### 3.2 What PR #8 Proposed vs Reality

| PR #8 Proposal | Current Reality | Gap |
|----------------|-----------------|-----|
| Ed25519 asymmetric keys | API key hash (SHA256) | Simpler works fine |
| Quorum-based registration | Cloud is source of truth | Not needed |
| NATS JetStream transport | HTTP polling works | Future optimization |
| P2P WebSocket mesh | Cloud-mediated | Real gap |
| Credit-based flow control | Rate limiting | Simpler works |

**Verdict:** PR #8 over-engineered some aspects. The cloud-mediated approach works well for current scale. P2P is the main gap for low-latency at scale.

---

## 4. Target Architecture

### 4.1 Organization-Centric Model

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TARGET ARCHITECTURE                                  │
│                                                                              │
│  ORGANIZATION: Acme Corp                                                     │
│  Plan: Team ($X/user/month)                                                  │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ User: Alice                    User: Bob                    User: Carol ││
│  │ Server 1                       Server 2                     Server 3    ││
│  │ Repo: frontend                 Repo: backend                Repo: libs  ││
│  │                                                                         ││
│  │ ┌─────┐ ┌─────┐               ┌─────┐ ┌─────┐              ┌─────┐     ││
│  │ │Lead │ │Dev-1│               │API  │ │DB   │              │Utils│     ││
│  │ └──┬──┘ └──┬──┘               └──┬──┘ └──┬──┘              └──┬──┘     ││
│  │    │       │                     │       │                    │        ││
│  │ ┌──┴───────┴──┐               ┌──┴───────┴──┐              ┌──┴──┐     ││
│  │ │   Daemon    │◄─────────────►│   Daemon    │◄────────────►│Daemon│    ││
│  │ └──────┬──────┘   P2P WSS     └──────┬──────┘   P2P WSS    └──┬──┘     ││
│  └────────┼─────────────────────────────┼────────────────────────┼────────┘│
│           │                             │                        │         │
│           └─────────────────────────────┼────────────────────────┘         │
│                                         │                                   │
│                              ┌──────────┴──────────┐                       │
│                              │    Cloud Control    │                       │
│                              │    Plane (Backup)   │                       │
│                              │                     │                       │
│                              │ • Org management    │                       │
│                              │ • Agent registry    │                       │
│                              │ • Policy sync       │                       │
│                              │ • Fallback routing  │                       │
│                              └─────────────────────┘                       │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 New Database Schema

```typescript
// NEW: Organizations
organizations {
  id: UUID,
  name: VARCHAR,
  slug: VARCHAR UNIQUE,        // acme-corp
  plan: 'team' | 'enterprise',
  stripeSubscriptionId: VARCHAR,
  settings: {
    maxUsersIncluded: number,
    maxAgentsPerUser: number,
    ssoEnabled: boolean
  }
}

// NEW: Organization Memberships
orgMemberships {
  id: UUID,
  orgId: UUID FK,
  userId: UUID FK,
  role: 'owner' | 'admin' | 'member',
  joinedAt: TIMESTAMP
}

// UPDATED: Users
users {
  // ... existing fields ...
  defaultOrgId: UUID FK,       // NEW: primary org
}

// NEW: Organization Policies
orgPolicies {
  id: UUID,
  orgId: UUID FK,
  name: VARCHAR,
  rules: AgentPolicyRule[],    // Applied to all org members
  priority: INTEGER            // Higher = override user policies
}

// NEW: Global Agent Registry
globalAgents {
  id: UUID,
  orgId: UUID FK,
  name: VARCHAR,               // Fleet-wide unique within org
  daemonId: UUID FK,
  userId: UUID FK,
  status: 'online' | 'offline',
  lastSeenAt: TIMESTAMP,
  UNIQUE(orgId, name)          // No collisions within org
}
```

### 4.3 P2P Connection Model

```
Daemon Discovery & Connection:

1. Daemon starts, registers with cloud:
   POST /api/daemons/register
   {
     machineId: "machine-123",
     publicEndpoint: "wss://alice-machine.local:3889",  // Optional
     orgId: "acme-corp"
   }

2. Cloud returns peer list:
   {
     peers: [
       { daemonId: "daemon-bob", endpoint: "wss://...", agents: ["API", "DB"] },
       { daemonId: "daemon-carol", endpoint: "wss://...", agents: ["Utils"] }
     ]
   }

3. Daemon establishes P2P WebSocket connections to peers

4. Messages route directly (P2P) with cloud as fallback:

   Alice -> Carol:
   ├── Try P2P: daemon-alice -> daemon-carol (10ms)
   └── Fallback: daemon-alice -> cloud -> daemon-carol (200ms)
```

---

## 5. Implementation Roadmap

### Phase 1: Organizations (2 weeks)

**Goal:** Enable team billing and org-level user management

```
Week 1:
├── Create organizations, orgMemberships tables
├── Add org CRUD API endpoints
├── Stripe integration for org subscriptions
└── Org invite flow (email + link)

Week 2:
├── Org settings UI in dashboard
├── Member management (add/remove/roles)
├── Migrate existing team users to orgs
└── Billing portal integration
```

**Deliverables:**
- `/api/orgs/*` endpoints
- Org dashboard page
- Per-seat billing working

### Phase 2: Global Agent Registry (1 week)

**Goal:** Fleet-wide unique agent names within org

```
├── Create globalAgents table
├── Agent registration on daemon connect
├── Heartbeat updates agent status
├── Name collision prevention (UNIQUE constraint)
└── Cross-daemon agent lookup API
```

**Deliverables:**
- `GET /api/orgs/:orgId/agents` - List all org agents
- Name collision errors with helpful messages
- Agent status visible in dashboard

### Phase 3: Org-Level Policies (1 week)

**Goal:** Governance rules that apply to all org members

```
├── Create orgPolicies table
├── Policy inheritance: org -> user -> workspace
├── Admin UI for policy management
├── Policy sync to linked daemons
└── Audit logging for policy violations
```

**Deliverables:**
- Org admins can set "allowed tools" for all agents
- Spawn limits enforced across org
- Policy violations logged

### Phase 4: P2P Daemon Connections (3 weeks)

**Goal:** Direct WebSocket connections between daemons for low-latency

```
Week 1:
├── PeerTransport interface
├── WebSocket peer connection logic
├── Peer discovery via cloud API
└── Connection health monitoring

Week 2:
├── Message routing: P2P primary, cloud fallback
├── Reconnection with exponential backoff
├── Peer authentication (challenge-response)
└── Message queuing during disconnect

Week 3:
├── NAT traversal hints (STUN-like)
├── Relay mode for firewalled peers
├── Performance testing
└── Dashboard peer status view
```

**Deliverables:**
- P2P messages: <50ms latency
- Automatic fallback to cloud
- Peer connection status in dashboard

### Phase 5: Multi-Repo Workspaces (2 weeks)

**Goal:** Single daemon serving multiple repos

```
Week 1:
├── Update workspace config for multiple repos
├── Agent-to-repo assignment
├── Per-repo policy scoping
└── Git context isolation

Week 2:
├── Coordinator agent spanning repos
├── Cross-repo file access controls
├── Dashboard multi-repo view
└── Migration for existing workspaces
```

**Deliverables:**
- One workspace can have N repos
- Agents assigned to specific repos
- Coordinator sees all repos

---

## 6. Pricing Model

### 6.1 Per-User Team Pricing

```
Free Tier (Individual):
├── 1 workspace
├── 3 agents max
├── 1 linked daemon
├── Community support
└── $0/month

Pro Tier (Individual):
├── 5 workspaces
├── 20 agents max
├── 5 linked daemons
├── Priority support
└── $29/user/month

Team Tier (Organization):
├── Unlimited workspaces per user
├── 50 agents per user
├── Unlimited linked daemons
├── Org-level policies
├── SSO (enterprise add-on)
├── Dedicated support
└── $49/user/month (min 3 users)

Enterprise Tier:
├── Everything in Team
├── Custom agent limits
├── SLA guarantees
├── Dedicated infrastructure
├── Custom integrations
└── Contact sales
```

### 6.2 Billing Implementation

```typescript
// Stripe subscription with per-seat billing
const subscription = await stripe.subscriptions.create({
  customer: org.stripeCustomerId,
  items: [{
    price: 'price_team_per_seat',  // $49/seat/month
    quantity: org.memberCount      // Updates automatically
  }],
  billing_cycle_anchor: 'now'
});

// Webhook handles seat changes
app.post('/webhooks/stripe', async (req, res) => {
  if (event.type === 'customer.subscription.updated') {
    // Sync seat count with org membership
    await syncOrgSeats(subscription.id);
  }
});
```

---

## 7. Technical Specifications

### 7.1 P2P Protocol Messages

```typescript
// Peer handshake
interface PeerHello {
  type: 'PEER_HELLO';
  daemonId: string;
  orgId: string;
  agents: string[];        // Local agent names
  challenge: string;       // Random bytes for auth
}

interface PeerWelcome {
  type: 'PEER_WELCOME';
  daemonId: string;
  agents: string[];
  challengeResponse: string;  // Signed challenge
}

// Peer routing
interface PeerRoute {
  type: 'PEER_ROUTE';
  id: string;              // Message ID
  from: string;            // Sender agent
  to: string;              // Recipient agent
  content: string;
  timestamp: number;
}

interface PeerAck {
  type: 'PEER_ACK';
  id: string;              // Message ID being acked
  delivered: boolean;      // Was agent reached?
}

// Peer health
interface PeerPing {
  type: 'PEER_PING';
  ts: number;
}

interface PeerPong {
  type: 'PEER_PONG';
  ts: number;
}
```

### 7.2 Agent Registry API

```typescript
// Register agent (called by daemon on agent connect)
POST /api/orgs/:orgId/agents
{
  name: "Alice",
  daemonId: "daemon-123",
  model: "claude",
  capabilities: ["code", "review"]
}
// Returns 409 if name already taken

// List org agents
GET /api/orgs/:orgId/agents
// Returns all agents across all daemons

// Find agent's daemon
GET /api/orgs/:orgId/agents/:name/location
// Returns { daemonId, endpoint, status }

// Deregister agent
DELETE /api/orgs/:orgId/agents/:name
```

### 7.3 Cross-Daemon Message Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       MESSAGE ROUTING DECISION TREE                          │
│                                                                              │
│  Message arrives at Router                                                   │
│       │                                                                      │
│       ▼                                                                      │
│  ┌─────────────────┐                                                        │
│  │ Is recipient    │──Yes──► Deliver locally via Unix socket                │
│  │ local agent?    │                                                        │
│  └────────┬────────┘                                                        │
│           │ No                                                               │
│           ▼                                                                  │
│  ┌─────────────────┐                                                        │
│  │ Is recipient in │──Yes──► Look up in global registry                     │
│  │ same org?       │              │                                         │
│  └────────┬────────┘              ▼                                         │
│           │ No              ┌───────────────┐                               │
│           │                 │ P2P connected │──Yes──► Send via P2P WebSocket│
│           ▼                 │ to daemon?    │                               │
│  ┌─────────────────┐        └───────┬───────┘                               │
│  │ Return error:   │                │ No                                    │
│  │ "Agent not in   │                ▼                                       │
│  │ your org"       │        ┌───────────────┐                               │
│  └─────────────────┘        │ Cloud fallback│──► POST /api/messages/relay   │
│                             └───────────────┘                               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Agent Implementation Guide

This section provides directly actionable specifications for agents implementing each phase.

### 8.1 Phase 1: Organizations - Implementation Details

**Files to Create:**
```
src/cloud/db/migrations/XXXX_add_organizations.ts
src/cloud/api/organizations.ts
src/cloud/api/org-memberships.ts
src/cloud/services/org-billing.ts
```

**Files to Modify:**
```
src/cloud/db/schema.ts          # Add organizations, orgMemberships tables
src/cloud/server.ts             # Mount /api/orgs/* routes
src/cloud/api/auth.ts           # Add org context to session
```

**Database Migration:**
```typescript
// src/cloud/db/migrations/XXXX_add_organizations.ts
import { pgTable, uuid, varchar, timestamp, jsonb } from 'drizzle-orm/pg-core';

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).unique().notNull(),
  plan: varchar('plan', { length: 50 }).default('team'),
  stripeCustomerId: varchar('stripe_customer_id', { length: 255 }),
  stripeSubscriptionId: varchar('stripe_subscription_id', { length: 255 }),
  settings: jsonb('settings').default({
    maxUsersIncluded: 10,
    maxAgentsPerUser: 50,
    ssoEnabled: false
  }),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow()
});

export const orgMemberships = pgTable('org_memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  role: varchar('role', { length: 50 }).default('member'), // owner, admin, member
  invitedBy: uuid('invited_by').references(() => users.id),
  joinedAt: timestamp('joined_at').defaultNow()
});
```

**API Endpoints:**
```typescript
// POST /api/orgs - Create organization
// Request:  { name: string, slug?: string }
// Response: { id, name, slug, plan, createdAt }
// Errors:   400 (invalid slug), 409 (slug taken)

// GET /api/orgs/:orgId - Get organization details
// Response: { id, name, slug, plan, settings, memberCount }
// Errors:   403 (not a member), 404 (not found)

// POST /api/orgs/:orgId/invites - Invite user
// Request:  { email: string, role: 'admin' | 'member' }
// Response: { inviteId, inviteUrl, expiresAt }
// Errors:   403 (not admin), 409 (already member)

// DELETE /api/orgs/:orgId/members/:userId - Remove member
// Errors:   403 (not admin), 400 (can't remove owner)
```

**Acceptance Criteria:**
- [ ] User can create org and becomes owner
- [ ] Owner can invite members via email
- [ ] Invited user can join org via link
- [ ] Admin can remove members (except owner)
- [ ] Org deletion cascades to memberships
- [ ] Stripe subscription created on org creation
- [ ] Seat count updates on member add/remove

**Edge Cases:**
```typescript
// User leaves org - what happens to their workspaces?
async function handleUserLeavesOrg(userId: string, orgId: string) {
  // Option 1: Workspaces become personal (if within personal limits)
  // Option 2: Workspaces are suspended until reassigned
  // Option 3: Workspaces are deleted after grace period

  // DECISION: Option 2 - suspend with 30-day grace period
  await db.update(workspaces)
    .set({ status: 'suspended', suspendedAt: new Date() })
    .where(and(
      eq(workspaces.userId, userId),
      eq(workspaces.orgId, orgId)
    ));
}

// Org owner tries to leave
async function handleOwnerLeaves(userId: string, orgId: string) {
  const admins = await getOrgAdmins(orgId);
  if (admins.length === 0) {
    throw new Error('Must promote another member to admin before leaving');
  }
  // Auto-promote first admin to owner
  await promoteToOwner(admins[0].userId, orgId);
}

// Org deleted - cascade handling
async function deleteOrganization(orgId: string) {
  // 1. Cancel Stripe subscription
  await cancelSubscription(org.stripeSubscriptionId);

  // 2. Deregister all agents from global registry
  await db.delete(globalAgents).where(eq(globalAgents.orgId, orgId));

  // 3. Suspend all workspaces (don't delete - allow recovery)
  await db.update(workspaces)
    .set({ status: 'suspended', deletedAt: new Date() })
    .where(eq(workspaces.orgId, orgId));

  // 4. Remove memberships
  await db.delete(orgMemberships).where(eq(orgMemberships.orgId, orgId));

  // 5. Soft delete org
  await db.update(organizations)
    .set({ deletedAt: new Date() })
    .where(eq(organizations.id, orgId));
}
```

### 8.2 Phase 2: Global Agent Registry - Implementation Details

**Files to Create:**
```
src/cloud/db/migrations/XXXX_add_global_agents.ts
src/cloud/api/global-agents.ts
src/cloud/services/agent-registry.ts
```

**Files to Modify:**
```
src/daemon/cloud-sync.ts        # Register agents on connect
src/daemon/router.ts            # Query registry for remote agents
src/cloud/api/daemons.ts        # Include agent list in heartbeat
```

**Registration Flow:**
```typescript
// src/cloud/services/agent-registry.ts
export class AgentRegistry {

  async register(agent: AgentRegistration): Promise<RegistrationResult> {
    const { name, orgId, daemonId, model, capabilities } = agent;

    // Validate name format (alphanumeric, hyphens, 1-50 chars)
    if (!isValidAgentName(name)) {
      return { success: false, error: 'INVALID_NAME', message: 'Agent names must be 1-50 alphanumeric characters or hyphens' };
    }

    try {
      // Atomic insert with conflict detection
      const result = await db.insert(globalAgents)
        .values({
          name,
          orgId,
          daemonId,
          model,
          capabilities,
          status: 'online',
          registeredAt: new Date(),
          lastSeenAt: new Date()
        })
        .onConflictDoNothing()
        .returning();

      if (result.length === 0) {
        // Name collision - find existing
        const existing = await db.query.globalAgents.findFirst({
          where: and(eq(globalAgents.orgId, orgId), eq(globalAgents.name, name))
        });

        return {
          success: false,
          error: 'NAME_TAKEN',
          message: `Agent "${name}" already registered on daemon ${existing.daemonId}`,
          suggestion: `${name}-${daemonId.slice(0, 4)}`
        };
      }

      return { success: true, agentId: result[0].id };
    } catch (error) {
      return { success: false, error: 'INTERNAL_ERROR', message: error.message };
    }
  }

  async deregister(name: string, orgId: string, daemonId: string): Promise<void> {
    // Only the owning daemon can deregister
    await db.delete(globalAgents)
      .where(and(
        eq(globalAgents.name, name),
        eq(globalAgents.orgId, orgId),
        eq(globalAgents.daemonId, daemonId)
      ));
  }

  async lookup(name: string, orgId: string): Promise<AgentLocation | null> {
    const agent = await db.query.globalAgents.findFirst({
      where: and(eq(globalAgents.orgId, orgId), eq(globalAgents.name, name)),
      with: { daemon: true }
    });

    if (!agent) return null;

    return {
      name: agent.name,
      daemonId: agent.daemonId,
      endpoint: agent.daemon.publicEndpoint,
      status: agent.status,
      lastSeenAt: agent.lastSeenAt
    };
  }

  async handleDaemonDisconnect(daemonId: string): Promise<void> {
    // Mark all agents on this daemon as offline
    await db.update(globalAgents)
      .set({ status: 'offline', lastSeenAt: new Date() })
      .where(eq(globalAgents.daemonId, daemonId));
  }

  async cleanupStaleAgents(maxAgeMs: number = 300_000): Promise<number> {
    // Remove agents not seen in 5 minutes
    const cutoff = new Date(Date.now() - maxAgeMs);
    const result = await db.delete(globalAgents)
      .where(lt(globalAgents.lastSeenAt, cutoff))
      .returning();
    return result.length;
  }
}
```

**Acceptance Criteria:**
- [ ] Agents auto-register on daemon connect
- [ ] Name collisions return helpful error with suggestion
- [ ] Agent status updates via heartbeat
- [ ] Stale agents cleaned up after 5 min
- [ ] Daemon disconnect marks all its agents offline
- [ ] Dashboard shows all org agents with status

### 8.3 Phase 4: P2P Connections - Implementation Details

**Files to Create:**
```
src/daemon/peer-transport.ts     # PeerTransport interface
src/daemon/peer-manager.ts       # Manages peer connections
src/daemon/peer-connection.ts    # Single peer WebSocket
src/protocol/peer-types.ts       # Peer message types
```

**Files to Modify:**
```
src/daemon/router.ts             # Route via P2P when available
src/daemon/cloud-sync.ts         # Fetch peer list from cloud
src/daemon/server.ts             # Accept incoming peer connections
```

**Peer Connection State Machine:**
```typescript
// src/daemon/peer-connection.ts
export class PeerConnection extends EventEmitter {
  private state: 'DISCONNECTED' | 'CONNECTING' | 'HANDSHAKING' | 'ACTIVE' | 'RECONNECTING' = 'DISCONNECTED';
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_DELAY = 30_000;
  private messageQueue: PeerEnvelope[] = [];
  private readonly MAX_QUEUE_SIZE = 1000;

  constructor(
    private readonly peerId: string,
    private readonly endpoint: string,
    private readonly localDaemonId: string,
    private readonly orgId: string,
    private readonly authToken: string
  ) {
    super();
  }

  async connect(): Promise<void> {
    if (this.state !== 'DISCONNECTED' && this.state !== 'RECONNECTING') {
      return;
    }

    this.state = 'CONNECTING';

    try {
      this.ws = new WebSocket(this.endpoint, {
        headers: { 'X-Daemon-Id': this.localDaemonId }
      });

      this.ws.on('open', () => this.handleOpen());
      this.ws.on('message', (data) => this.handleMessage(data));
      this.ws.on('close', (code) => this.handleClose(code));
      this.ws.on('error', (err) => this.handleError(err));

    } catch (error) {
      this.scheduleReconnect();
    }
  }

  private handleOpen(): void {
    this.state = 'HANDSHAKING';
    this.reconnectAttempts = 0;

    // Send PEER_HELLO
    const hello: PeerHello = {
      type: 'PEER_HELLO',
      daemonId: this.localDaemonId,
      orgId: this.orgId,
      agents: this.getLocalAgents(),
      challenge: crypto.randomBytes(32).toString('hex'),
      version: '1.0'
    };

    this.sendRaw(hello);
  }

  private handleMessage(data: Buffer): void {
    const envelope = JSON.parse(data.toString()) as PeerEnvelope;

    // Deduplication check
    if (this.deduplicator.isDuplicate(envelope.id)) {
      return;
    }

    switch (envelope.type) {
      case 'PEER_WELCOME':
        this.state = 'ACTIVE';
        this.flushQueue();
        this.emit('connected', envelope.payload);
        break;

      case 'PEER_ROUTE':
        this.emit('message', envelope.payload);
        this.sendAck(envelope.id, true);
        break;

      case 'PEER_BUSY':
        this.emit('backpressure', envelope.payload);
        break;

      case 'PEER_PING':
        this.send({ type: 'PEER_PONG', ts: Date.now() });
        break;

      case 'PEER_BYE':
        this.disconnect();
        break;
    }
  }

  private scheduleReconnect(): void {
    this.state = 'RECONNECTING';
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      this.MAX_RECONNECT_DELAY
    );
    this.reconnectAttempts++;

    setTimeout(() => this.connect(), delay);
  }

  send(message: PeerMessage): boolean {
    const envelope: PeerEnvelope = {
      v: 1,
      type: message.type,
      id: crypto.randomUUID(),
      ts: Date.now(),
      from_server: this.localDaemonId,
      ttl_ms: 300_000, // 5 minutes
      payload: message
    };

    if (this.state !== 'ACTIVE') {
      return this.enqueue(envelope);
    }

    return this.sendRaw(envelope);
  }

  private enqueue(envelope: PeerEnvelope): boolean {
    if (this.messageQueue.length >= this.MAX_QUEUE_SIZE) {
      // Drop oldest
      const dropped = this.messageQueue.shift();
      this.emit('dropped', dropped);
    }
    this.messageQueue.push(envelope);
    return true;
  }
}
```

**Edge Cases:**
```typescript
// Cloud unavailable during P2P discovery
async function discoverPeers(orgId: string): Promise<PeerInfo[]> {
  try {
    return await cloudApi.getPeers(orgId);
  } catch (error) {
    // Fall back to cached peer list
    const cached = await cache.get(`peers:${orgId}`);
    if (cached && Date.now() - cached.timestamp < 3600_000) {
      return cached.peers;
    }
    // No peers available - continue with cloud-only routing
    return [];
  }
}

// Message in flight when connection drops
async function handleMessageInFlight(message: PeerRoute, peerId: string): Promise<void> {
  // Re-queue for retry or cloud fallback
  if (this.peerManager.isConnected(peerId)) {
    // Retry via P2P
    await this.peerManager.send(peerId, message);
  } else {
    // Fall back to cloud
    await this.cloudSync.sendMessage(message);
  }
}

// Both peers try to connect simultaneously
function handleDuplicateConnection(existingConn: PeerConnection, newConn: PeerConnection): void {
  // Deterministic winner: lower daemon ID keeps initiator role
  if (this.localDaemonId < newConn.peerId) {
    // We initiated first, reject incoming
    newConn.close(4001, 'Duplicate connection - you are responder');
  } else {
    // They initiated first, close our outgoing
    existingConn.close(4001, 'Duplicate connection - switching to responder');
    this.connections.set(newConn.peerId, newConn);
  }
}
```

**Acceptance Criteria:**
- [ ] P2P connection established within 5s of peer discovery
- [ ] Messages route via P2P when connected (<50ms latency)
- [ ] Automatic fallback to cloud when P2P unavailable
- [ ] Reconnection with exponential backoff
- [ ] Message queue survives brief disconnections
- [ ] Backpressure signals prevent OOM
- [ ] Dashboard shows peer connection status

### 8.4 Testing Strategy

**Unit Tests:**
```typescript
// src/cloud/services/__tests__/agent-registry.test.ts
describe('AgentRegistry', () => {
  it('registers agent with unique name', async () => {
    const result = await registry.register({ name: 'Alice', orgId, daemonId, model: 'claude' });
    expect(result.success).toBe(true);
  });

  it('rejects duplicate name with suggestion', async () => {
    await registry.register({ name: 'Alice', orgId, daemonId: 'daemon-1' });
    const result = await registry.register({ name: 'Alice', orgId, daemonId: 'daemon-2' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('NAME_TAKEN');
    expect(result.suggestion).toMatch(/Alice-daemon/);
  });

  it('cleans up stale agents', async () => {
    await registry.register({ name: 'Stale', orgId, daemonId });
    await db.update(globalAgents).set({ lastSeenAt: new Date(Date.now() - 600_000) });
    const cleaned = await registry.cleanupStaleAgents();
    expect(cleaned).toBe(1);
  });
});
```

**Integration Tests:**
```typescript
// src/__tests__/integration/p2p-routing.test.ts
describe('P2P Message Routing', () => {
  let daemonA: TestDaemon;
  let daemonB: TestDaemon;

  beforeAll(async () => {
    daemonA = await TestDaemon.start({ orgId, daemonId: 'daemon-a' });
    daemonB = await TestDaemon.start({ orgId, daemonId: 'daemon-b' });
    await daemonA.connectPeer(daemonB.endpoint);
  });

  it('routes message via P2P when connected', async () => {
    const agentA = await daemonA.spawnAgent('Alice');
    const agentB = await daemonB.spawnAgent('Bob');

    const start = Date.now();
    await agentA.send('Bob', 'Hello');
    const message = await agentB.waitForMessage();

    expect(message.content).toBe('Hello');
    expect(Date.now() - start).toBeLessThan(100); // <100ms
  });

  it('falls back to cloud when P2P disconnected', async () => {
    await daemonA.disconnectPeer(daemonB.peerId);

    const agentA = await daemonA.spawnAgent('Alice');
    const agentB = await daemonB.spawnAgent('Bob');

    await agentA.send('Bob', 'Hello');
    const message = await agentB.waitForMessage({ timeout: 5000 });

    expect(message.content).toBe('Hello');
  });
});
```

---

## Appendix A: Migration Path

### Existing Users

1. **Individual users** → Remain on user-centric plans (Free/Pro)
2. **Team users** → Auto-create org, migrate to Team plan
3. **Linked daemons** → Continue working, gain P2P after Phase 4

### Breaking Changes

- **None planned.** All changes are additive.
- P2P is transparent to agents (same `->relay:` syntax)
- Org features are opt-in

---

## Appendix B: Critical Insights from PR #8

PR #8's federation proposal and its review identified critical distributed systems challenges that MUST be addressed. This section preserves those insights.

### B.1 End-to-End Delivery Confirmation (🔴 Critical)

**Problem identified in PR #8 review:**
```
Alice@A → Daemon A → Daemon B → ??? → Bob receives?
         ↑           ↑
         ACK         ACK
         (local)     (peer)

But does Bob's agent actually SEE the message?
```

Peer-level ACKs don't confirm:
- `tmux send-keys` succeeded
- Agent wasn't in a blocking state
- Agent didn't ignore the message (prompt too long)

**Solution adopted:**
```typescript
// End-to-end confirmation flow
interface DeliveryConfirmation {
  type: 'DELIVERY_CONFIRMED';
  messageId: string;
  agentName: string;
  injectedAt: number;        // When send-keys executed
  detectedAt: number;        // When "Relay message" appeared in output
}

// TmuxWrapper detects successful injection
async function confirmDelivery(messageId: string): Promise<boolean> {
  // After send-keys, poll capture-pane for "Relay message from..."
  const output = await capturePane();
  if (output.includes(`Relay message`) && output.includes(messageId.slice(0, 8))) {
    await sendDeliveryConfirmation(messageId);
    return true;
  }
  return false;
}
```

### B.2 Registry Consistency (🔴 Critical)

**Problem identified in PR #8 review:**
```
Time 0:  Server A has no "Bob", Server B has no "Bob"
Time 1:  Alice on A starts "Bob", Carol on B starts "Bob"
Time 2:  Both send PEER_SYNC: "Bob joined" (messages cross)
Time 3:  Split-brain: both think THEIR Bob is real
```

**Solution adopted:** Cloud as authoritative registry with Lamport timestamps for local ordering.

```typescript
// Registration with conflict detection
async function registerAgent(name: string, orgId: string): Promise<Result> {
  // Atomic check-and-set in PostgreSQL
  const result = await db.query(`
    INSERT INTO global_agents (org_id, name, daemon_id, registered_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (org_id, name) DO NOTHING
    RETURNING id
  `, [orgId, name, daemonId]);

  if (result.rowCount === 0) {
    const existing = await db.query(
      'SELECT daemon_id FROM global_agents WHERE org_id = $1 AND name = $2',
      [orgId, name]
    );
    return {
      success: false,
      error: `Name "${name}" already registered on daemon ${existing.rows[0].daemon_id}`,
      suggestion: `${name}-${daemonId.slice(0, 4)}`
    };
  }
  return { success: true };
}
```

### B.3 Message Deduplication (🔴 Critical)

**Problem identified:** No replay protection allows attackers to replay captured messages.

**Solution adopted:**
```typescript
// Dedup using message IDs with TTL
class MessageDeduplicator {
  private seen = new Map<string, number>();  // messageId -> timestamp
  private readonly TTL_MS = 300_000;  // 5 minutes

  isDuplicate(messageId: string): boolean {
    this.cleanup();
    if (this.seen.has(messageId)) {
      return true;
    }
    this.seen.set(messageId, Date.now());
    return false;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, ts] of this.seen) {
      if (now - ts > this.TTL_MS) {
        this.seen.delete(id);
      }
    }
  }
}
```

### B.4 Backpressure & Flow Control (🟡 High)

**Problem identified:** Slow peers can cause OOM via unbounded queues.

**Solution adopted:** Credit-based flow control with PEER_BUSY/PEER_READY signals.

```typescript
// Flow control protocol
interface PeerBusy {
  type: 'PEER_BUSY';
  queueDepth: number;        // Current queue size
  resumeAt?: number;         // Estimated resume time
}

interface PeerReady {
  type: 'PEER_READY';
  credits: number;           // Messages we can accept
}

// Bounded queue with drop policy
class BoundedMessageQueue {
  private queue: Message[] = [];
  private readonly MAX_SIZE = 1000;
  private readonly DROP_POLICY: 'oldest' | 'newest' = 'oldest';

  enqueue(msg: Message): boolean {
    if (this.queue.length >= this.MAX_SIZE) {
      if (this.DROP_POLICY === 'oldest') {
        const dropped = this.queue.shift();
        this.emitDropped(dropped);
      } else {
        this.emitDropped(msg);
        return false;
      }
    }
    this.queue.push(msg);
    return true;
  }
}
```

### B.5 Distributed Tracing (🟡 High)

**Problem identified:** "My message never arrived. Why?" is impossible to debug without tracing.

**Solution adopted:** Correlation IDs on all messages, queryable trace API.

```typescript
// All messages include correlation ID
interface TracedMessage {
  id: string;                // Unique message ID
  correlationId: string;     // Groups related messages
  parentId?: string;         // For request/response chains
  hops: TraceHop[];          // Servers traversed
}

interface TraceHop {
  serverId: string;
  action: 'received' | 'queued' | 'delivered' | 'dropped';
  timestamp: number;
  error?: string;
}

// CLI command for debugging
// $ agent-relay trace abc123
// → Shows full journey of message abc123 across servers
```

### B.6 NAT/Firewall Traversal (🟡 Medium)

**Problem identified:** Many servers are behind NATs or firewalls.

**Solution adopted:** Hybrid topology with relay fallback.

```
Topology Decision Tree:

1. Both peers have public IPs?
   → Direct P2P WebSocket

2. One peer behind NAT?
   → NAT peer initiates connection to public peer
   → Use connection reversal

3. Both peers behind NAT?
   → Use cloud as relay
   → Or: TURN-style relay server

4. Corporate firewall blocking WebSocket?
   → Fall back to cloud polling (current behavior)
```

### B.7 Clock Skew Handling (🟡 Medium)

**Problem identified:** TTL expiration fails with clock drift between servers.

**Solution adopted:** Relative TTLs applied at receipt time.

```typescript
// Message uses relative TTL, not absolute expiry
interface Message {
  // ...
  ttl_ms: number;           // e.g., 3600000 (1 hour)
  // NOT: expires_at: timestamp
}

// Receiving server applies TTL
function isExpired(msg: Message, receivedAt: number): boolean {
  return Date.now() > receivedAt + msg.ttl_ms;
}
```

### B.8 Detailed Protocol Specification

**From PR #8 - preserved for implementation:**

```typescript
// Complete peer protocol from PR #8
type PeerMessageType =
  | 'PEER_HELLO'      // Initial handshake
  | 'PEER_WELCOME'    // Handshake response
  | 'PEER_SYNC'       // Registry synchronization
  | 'PEER_ROUTE'      // Route message to agent
  | 'PEER_BROADCAST'  // Broadcast to all local agents
  | 'PEER_ACK'        // Acknowledge receipt
  | 'PEER_NACK'       // Negative acknowledgment
  | 'PEER_BUSY'       // Backpressure signal
  | 'PEER_READY'      // Resume signal
  | 'PEER_PING'       // Heartbeat
  | 'PEER_PONG'       // Heartbeat response
  | 'PEER_BYE';       // Graceful disconnect

interface PeerEnvelope<T = unknown> {
  v: 1;                      // Protocol version
  type: PeerMessageType;
  id: string;                // Message UUID
  correlationId?: string;    // For tracing
  ts: number;                // Timestamp
  from_server: string;       // Origin server ID
  ttl_ms: number;            // Time to live
  payload: T;
}

// Connection state machine
// DISCONNECTED → CONNECTING → HANDSHAKING → ACTIVE → RECONNECTING
// Reconnection: exponential backoff 1s → 2s → 4s → 8s → 16s → 30s (max)
```

### B.9 Network Topology Recommendation

**From PR #8 - hybrid approach:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     HYBRID TOPOLOGY (RECOMMENDED)                            │
│                                                                              │
│                         ┌─────────────┐                                     │
│              ┌─────────►│  Cloud Hub  │◄─────────┐                         │
│              │          │ (discovery) │          │                         │
│              │          └─────────────┘          │                         │
│              │                                   │                         │
│              ▼                                   ▼                         │
│          ServerA ◄────────────────────────► ServerB                        │
│              ▲              P2P                  ▲                         │
│              │                                   │                         │
│              └──────────► ServerC ◄──────────────┘                         │
│                                                                              │
│  • Hub provides discovery and registry sync                                 │
│  • Daemons establish direct P2P connections                                 │
│  • Messages route directly (low latency)                                    │
│  • Hub failure doesn't break existing P2P connections                       │
│  • Hub serves as fallback for NAT'd peers                                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Appendix C: Comparison Summary

| Aspect | PR #8 Proposal | This Document |
|--------|----------------|---------------|
| **Scope** | Pure federation (P2P only) | Full org model + federation |
| **Auth** | Ed25519 per-message signing | API keys + TLS (simpler for v1) |
| **Registry** | Quorum consensus | Cloud as source of truth |
| **Timeline** | 8-10 weeks federation only | 9 weeks for complete vision |
| **Billing** | Not addressed | Per-user team pricing |
| **E2E Delivery** | ✅ Identified as critical | ✅ Adopted |
| **Deduplication** | ✅ Identified as critical | ✅ Adopted |
| **Backpressure** | ✅ Credit-based | ✅ Adopted (PEER_BUSY/READY) |
| **Tracing** | ✅ Correlation IDs | ✅ Adopted |
| **NAT Traversal** | ✅ Identified as gap | ✅ Hybrid topology |

**This document incorporates PR #8's critical insights** while taking a more pragmatic, incremental approach that builds on what's already working.
