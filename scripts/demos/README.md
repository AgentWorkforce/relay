# Multi-Agent Negotiation Demos

Two demos showcasing agents with competing priorities negotiating limited resources using the full agent-relay system.

## Prerequisites

```bash
# Build agent-relay and link globally
cd /path/to/relay
npm run build
npm link

# Verify
agent-relay --version

# Ensure claude CLI is authenticated
claude --version
```

## The Demos

### 1. Server Capacity (Emergency)

**Scenario**: Black Friday traffic spike. 3 services compete for 10 emergency server slots.

```bash
./scripts/demos/server-capacity.sh
```

---

### 2. Sprint Planning

**Scenario**: 50 story points available, 85 requested. Product Lead facilitates.

```bash
./scripts/demos/sprint-planning.sh
```

---

## Running a Demo

### Step 1: Start Relay Daemon

```bash
agent-relay up --dashboard
```

Open http://localhost:3888 to watch the conversation.

### Step 2: Run Setup Script

```bash
./scripts/demos/server-capacity.sh
```

This creates a prompt file in `/tmp/agent-relay-demos/`.

### Step 3: Start Agents

```bash
# Terminal 2
agent-relay -n WebAPI claude
# Say: Read /tmp/agent-relay-demos/server-capacity.md - you are WebAPI. Join #incident channel.

# Terminal 3
agent-relay -n BatchJobs claude
# Say: Read /tmp/agent-relay-demos/server-capacity.md - you are BatchJobs. Join #incident channel.

# Terminal 4
agent-relay -n Analytics claude
# Say: Read /tmp/agent-relay-demos/server-capacity.md - you are Analytics. Join #incident channel.
```

## What You'll See

- **Dashboard**: Agents connect, messages flow in real-time
- **Terminals**: Agents negotiate, propose allocations, vote on outcomes
