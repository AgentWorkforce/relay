# Bridge & Staffing: Multi-Project Agent Orchestration

## Overview

This document describes the **Bridge** feature - a multi-project orchestration layer that allows a single agent (the **Architect** or **Principal**) to coordinate work across multiple projects, each managed by a **Lead** who can dynamically **staff** worker agents.

This builds on the existing agent-relay infrastructure while adding:
1. Cross-project communication via socket bridging
2. SE role hierarchy (Architect → Lead → Engineer)
3. Dynamic agent spawning by Leads
4. Multi-project dashboard visibility

---

## Terminology

| Term | Description |
|------|-------------|
| **Bridge** | CLI command and mode for multi-project orchestration |
| **Architect** / **Principal** | SE role for the bridging agent (cross-project coordinator) |
| **Lead** | Project leader (Tech Lead) - one per project, can spawn workers |
| **Engineer** / **Worker** | Agents spawned by Leads to execute specific tasks |
| **Spawn** | Action of creating a new worker agent |
| **Standup** | Morning coordination where Architect assigns work to Leads |

---

## Architecture

```
                        ┌─────────────────────────────────────┐
                        │        ARCHITECT (bridge agent)     │
                        │   agent-relay bridge --as architect │
                        │                                     │
                        │   ┌─────────────────────────────┐   │
                        │   │   MultiProjectClient        │   │
                        │   │   - projectSockets: Map     │   │
                        │   │   - projectLeads: Map       │   │
                        │   └─────────────────────────────┘   │
                        └──────────────┬──────────────────────┘
                                       │
               ┌───────────────────────┼───────────────────────┐
               │                       │                       │
               ▼                       ▼                       ▼
      ┌────────────────┐      ┌────────────────┐      ┌────────────────┐
      │ auth-service   │      │ frontend       │      │ api-service    │
      │ Project Daemon │      │ Project Daemon │      │ Project Daemon │
      │                │      │                │      │                │
      │ Socket:        │      │ Socket:        │      │ Socket:        │
      │ /tmp/.../auth/ │      │ /tmp/.../fe/   │      │ /tmp/.../api/  │
      └───────┬────────┘      └───────┬────────┘      └───────┬────────┘
              │                       │                       │
              ▼                       ▼                       ▼
      ┌────────────────┐      ┌────────────────┐      ┌────────────────┐
      │ Lead: Alice    │      │ Lead: Bob      │      │ Lead: Carol    │
      │ (can spawn)    │      │ (can spawn)    │      │ (can spawn)    │
      └───────┬────────┘      └───────┬────────┘      └───────┬────────┘
              │                       │                       │
        ┌─────┴─────┐           ┌─────┴─────┐                 │
        ▼           ▼           ▼           ▼                 ▼
    ┌───────┐   ┌───────┐   ┌───────┐   ┌───────┐       ┌───────┐
    │ Dev1  │   │ QA1   │   │ Dev1  │   │ Rev1  │       │ SRE1  │
    └───────┘   └───────┘   └───────┘   └───────┘       └───────┘
```

### Key Design Decisions

1. **Keep Daemons Project-Local**: Each project maintains its own daemon and socket. The Architect connects to multiple daemons simultaneously. This preserves security isolation.

2. **Coordination at Client Layer**: The `MultiProjectClient` handles cross-project routing, not the daemons. Daemons remain simple and unchanged.

3. **Leads Own Staffing**: Leads decide how many workers and what types to spawn based on work assigned by the Architect.

---

## CLI Commands

### Design Principle

> **Tight surface area. Simple interfaces hiding complexity.**

### Start Bridge (Architect)

```bash
# Bridge multiple projects - just list the paths
agent-relay bridge ~/auth ~/frontend ~/api
```

That's it. The system handles:
- Socket discovery for each project
- Multi-socket connections
- Lead auto-detection (first registered agent per project)
- Cross-project message routing

### Start Lead

```bash
# Be a lead - just your name
agent-relay lead Alice
```

That's it. The system handles:
- Project detection from current directory
- Spawn capability (automatic for leads)
- Daemon registration
- Worker management

### Workers (spawned by Leads)

Workers are created via relay messages - not CLI commands:

```bash
@relay:spawn Dev1 claude "Build the login page"
@relay:release Dev1
```

### What's Hidden

| User types | System handles |
|------------|----------------|
| `bridge ~/auth ~/frontend` | Socket discovery, multi-connection, lead detection |
| `lead Alice` | Spawn capability, project detection, daemon registration |
| `@relay:spawn Dev1 claude "task"` | Tmux window, agent launch, task injection |

---

## Message Patterns

### Cross-Project Addressing

```bash
# Architect → specific project lead
@relay:auth-service:lead Implement OAuth flow by EOD

# Architect → all leads
@relay:*:lead Standup time - report status and blockers

# Architect → specific agent in a project
@relay:frontend:Dev1 Focus on the login form first

# Architect → broadcast to entire project
@relay:api-service:* Code freeze starts in 1 hour
```

### Intra-Project (existing patterns still work)

```bash
# Lead → worker (same project)
@relay:Dev1 Start on the user endpoint

# Worker → Lead
@relay:lead Task complete, ready for next assignment

# Worker → Worker
@relay:QA1 My PR is ready for testing
```

### Spawn Messages

```bash
# Lead spawns a worker
@relay:spawn Dev1 claude "Implement login endpoint"

# Lead spawns with specific model
@relay:spawn SeniorDev claude:opus "Design the auth architecture"
@relay:spawn QuickFix claude:haiku "Fix typos in error messages"

# Lead releases a worker
@relay:release Dev1

# Lead releases all workers
@relay:release *
```

---

## Spawn Protocol

### Spawn Message Format

```
@relay:spawn <name> <cli>[:<model>] "<initial_task>"
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Worker agent name (unique within project) |
| `cli` | Yes | Agent CLI: `claude`, `codex`, `gemini` |
| `model` | No | Model variant: `opus`, `sonnet`, `haiku` |
| `initial_task` | Yes | Task injected into worker on startup |

### Spawn Sequence

```
┌─────────┐         ┌─────────┐         ┌─────────┐
│  Lead   │         │ Daemon  │         │ Spawner │
└────┬────┘         └────┬────┘         └────┬────┘
     │                   │                   │
     │ @relay:spawn Dev1 │                   │
     │ claude "task"     │                   │
     │──────────────────>│                   │
     │                   │                   │
     │                   │ SPAWN request     │
     │                   │──────────────────>│
     │                   │                   │
     │                   │    Create tmux    │
     │                   │    window "Dev1"  │
     │                   │                   │
     │                   │    Launch:        │
     │                   │    agent-relay    │
     │                   │    -n Dev1 claude │
     │                   │                   │
     │                   │    Inject task    │
     │                   │                   │
     │                   │ SPAWN_ACK         │
     │                   │<──────────────────│
     │                   │                   │
     │  SPAWN_COMPLETE   │                   │
     │   Dev1 ready      │                   │
     │<──────────────────│                   │
     │                   │                   │
```

### Spawn Implementation

```typescript
// src/daemon/spawner.ts

interface SpawnRequest {
  name: string;
  cli: string;
  model?: string;
  task: string;
  requestedBy: string;  // Lead's name
}

export class AgentSpawner {
  constructor(private projectRoot: string) {}

  async spawn(request: SpawnRequest): Promise<SpawnResult> {
    const { name, cli, model, task, requestedBy } = request;

    // 1. Create tmux window
    const sessionName = `relay-${name}`;
    await exec(`tmux new-window -t relay -n ${name}`);

    // 2. Build command
    let cmd = `agent-relay -n ${name}`;
    if (model) {
      cmd += ` ${cli}:${model}`;
    } else {
      cmd += ` ${cli}`;
    }

    // 3. Launch agent
    await exec(`tmux send-keys -t relay:${name} '${cmd}' Enter`);

    // 4. Wait for agent to register
    await this.waitForAgent(name, 30_000);

    // 5. Inject initial task
    await exec(`tmux send-keys -t relay:${name} '${escapeTask(task)}' Enter`);

    return {
      success: true,
      name,
      window: `relay:${name}`,
      spawnedBy: requestedBy,
    };
  }

  async release(name: string): Promise<void> {
    // Send graceful shutdown
    await exec(`tmux send-keys -t relay:${name} '/exit' Enter`);
    // Kill window after delay
    setTimeout(() => {
      exec(`tmux kill-window -t relay:${name}`).catch(() => {});
    }, 5000);
  }
}
```

---

## Daily Workflow: Standup Protocol

### Morning Standup Sequence

```
┌────────────────────────────────────────────────────────────────────────┐
│                         MORNING STANDUP                                 │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  1. ARCHITECT INITIATES                                                │
│     @relay:*:lead Standup - report status, blockers, and staffing needs│
│                                                                        │
│  2. LEADS REPORT                                                       │
│     Alice (auth):    STATUS: OAuth 60% complete                        │
│                      BLOCKED: Need API spec from api-service           │
│                      STAFF: Need 2 devs + 1 QA once unblocked          │
│                                                                        │
│     Bob (frontend):  STATUS: Dashboard ready for review                │
│                      BLOCKED: None                                     │
│                      STAFF: Need 1 reviewer                            │
│                                                                        │
│     Carol (api):     STATUS: Spec complete                             │
│                      BLOCKED: None                                     │
│                      STAFF: Ready for 3 parallel endpoint devs         │
│                                                                        │
│  3. ARCHITECT COORDINATES CROSS-PROJECT                                │
│     @relay:api-service:lead Alice needs your API spec - priority       │
│     @relay:auth-service:lead Unblocked - Carol sending spec now        │
│                                                                        │
│  4. ARCHITECT ASSIGNS WORK                                             │
│     @relay:auth-service:lead APPROVED: Staff 2 devs + 1 QA. Pri: HIGH  │
│     @relay:frontend:lead APPROVED: Staff 1 reviewer for dashboard      │
│     @relay:api-service:lead APPROVED: Staff 3 devs for endpoints       │
│                                                                        │
│  5. LEADS STAFF THEIR TEAMS                                            │
│     Alice: @relay:spawn Dev1 claude "Implement OAuth token flow"       │
│            @relay:spawn Dev2 claude "Implement OAuth callback"         │
│            @relay:spawn QA1 claude "Write OAuth integration tests"     │
│                                                                        │
│     Bob:   @relay:spawn Reviewer claude "Review dashboard PR #42"      │
│                                                                        │
│     Carol: @relay:spawn Dev1 claude "POST /users endpoint"             │
│            @relay:spawn Dev2 claude "GET /users/:id endpoint"          │
│            @relay:spawn Dev3 claude "DELETE /users/:id endpoint"       │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

### Staffing Strategy by Work Type

| Work Type | Recommended Agent | Rationale |
|-----------|-------------------|-----------|
| Architecture/Design | `claude:opus` | Complex reasoning needed |
| Feature Implementation | `claude:sonnet` | Balance speed/quality |
| Code Review | `claude:sonnet` | Good judgment required |
| Testing/QA | `claude:sonnet` | Thoroughness matters |
| Bug Fixes | `claude:haiku` | Fast, focused |
| Documentation | `claude:haiku` | Straightforward |
| Refactoring | `claude:sonnet` | Context-aware changes |

### End of Day Protocol

```bash
# Architect requests EOD status
@relay:*:lead EOD status report

# Leads report and release workers
@relay:architect STATUS: OAuth complete, PR #123 ready
                 RELEASING: Dev1, Dev2, QA1
@relay:release Dev1
@relay:release Dev2
@relay:release QA1

# Architect summarizes for dashboard/records
@relay:*:lead Good work today. Tomorrow: auth integration testing
```

---

## Multi-Project Dashboard

### Dashboard URL

```
http://localhost:3888/bridge?projects=auth-service,frontend,api-service
```

### Dashboard Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    AGENT RELAY - BRIDGE DASHBOARD                       │
├─────────────────────────────────────────────────────────────────────────┤
│  Orchestrator: Architect (Principal)                      [Refresh]     │
├───────────────┬──────────────┬──────────────┬──────────────────────────┤
│ PROJECT       │ LEAD         │ TEAM         │ STATUS                   │
├───────────────┼──────────────┼──────────────┼──────────────────────────┤
│ auth-service  │ Alice ●      │ 3 workers    │ ✓ OAuth implementation   │
│               │              │ Dev1 ●       │                          │
│               │              │ Dev2 ●       │                          │
│               │              │ QA1 ○        │                          │
├───────────────┼──────────────┼──────────────┼──────────────────────────┤
│ frontend      │ Bob ●        │ 1 worker     │ ⚠ Blocked on API spec    │
│               │              │ Reviewer ●   │                          │
├───────────────┼──────────────┼──────────────┼──────────────────────────┤
│ api-service   │ Carol ●      │ 3 workers    │ ✓ Parallel endpoints     │
│               │              │ Dev1 ●       │                          │
│               │              │ Dev2 ●       │                          │
│               │              │ Dev3 ●       │                          │
└───────────────┴──────────────┴──────────────┴──────────────────────────┘

│  Cross-Project Message Flow                              [Filter: All]  │
├─────────────────────────────────────────────────────────────────────────┤
│ 09:00 Architect → *:lead: Standup time                                  │
│ 09:01 auth:Alice → Architect: STATUS: OAuth 60%...                      │
│ 09:01 frontend:Bob → Architect: STATUS: Dashboard ready...              │
│ 09:02 api:Carol → Architect: STATUS: Spec complete...                   │
│ 09:05 Architect → api:lead: Send spec to Alice                          │
│ 09:06 api:Carol → auth:Alice: Here's the spec...                        │
│ 09:10 auth:Alice: @relay:spawn Dev1 claude "OAuth token..."             │
└─────────────────────────────────────────────────────────────────────────┘

│  [Click project to drill down]  [Click agent to attach]                 │
└─────────────────────────────────────────────────────────────────────────┘
```

### Drill-Down View (Single Project)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  auth-service                                    [← Back to Overview]   │
├─────────────────────────────────────────────────────────────────────────┤
│  Lead: Alice                                                            │
│  Status: Active - OAuth implementation                                  │
│  Workers: 3/3 active                                                    │
├─────────────────────────────────────────────────────────────────────────┤
│  AGENT       │ STATUS   │ TASK                        │ MESSAGES        │
├──────────────┼──────────┼─────────────────────────────┼─────────────────┤
│ Alice (Lead) │ ● active │ Coordinating OAuth impl     │ 12↑ 8↓          │
│ Dev1         │ ● active │ OAuth token flow            │ 5↑ 14↓          │
│ Dev2         │ ● typing │ OAuth callback handler      │ 3↑ 6↓           │
│ QA1          │ ○ idle   │ Waiting for impl complete   │ 1↑ 2↓           │
├─────────────────────────────────────────────────────────────────────────┤
│  Project Messages                                                       │
├─────────────────────────────────────────────────────────────────────────┤
│ 09:15 Alice → Dev1: Start on token flow                                 │
│ 09:16 Alice → Dev2: Handle the callback endpoint                        │
│ 09:30 Dev1 → Alice: Token generation done, testing...                   │
│ 09:45 Dev1 → QA1: Ready for your test suite                             │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1: Multi-Socket Client

**File: `src/wrapper/multi-project-client.ts`**

```typescript
export class MultiProjectClient {
  private sockets: Map<string, net.Socket> = new Map();
  private projectLeads: Map<string, string> = new Map();

  constructor(private projects: ProjectConfig[]) {}

  async connect(): Promise<void> {
    for (const project of this.projects) {
      const socket = await this.connectToProject(project);
      this.sockets.set(project.id, socket);
      if (project.lead) {
        this.projectLeads.set(project.id, project.lead);
      }
    }
  }

  async send(target: string, message: string): Promise<void> {
    // Parse target: "project:agent" or "project:*" or "*:lead"
    const { projectId, agentName } = this.parseTarget(target);

    if (projectId === '*') {
      // Broadcast to all projects
      for (const [pid, socket] of this.sockets) {
        await this.sendToSocket(socket, agentName, message);
      }
    } else {
      const socket = this.sockets.get(projectId);
      if (socket) {
        await this.sendToSocket(socket, agentName, message);
      }
    }
  }

  private parseTarget(target: string): { projectId: string; agentName: string } {
    const [projectId, agentName] = target.split(':');
    return {
      projectId: projectId || '*',
      agentName: agentName === 'lead'
        ? this.projectLeads.get(projectId) || 'lead'
        : agentName,
    };
  }
}
```

### Phase 2: Extended Parser

**File: `src/wrapper/parser.ts`** (modifications)

```typescript
// Extended pattern for cross-project messaging
const CROSS_PROJECT_PATTERN = /^@relay:([a-zA-Z0-9_-]+):([a-zA-Z0-9_*]+)\s+(.+)$/;
const SPAWN_PATTERN = /^@relay:spawn\s+(\S+)\s+(\S+)\s+"([^"]+)"$/;
const RELEASE_PATTERN = /^@relay:release\s+(\S+)$/;

export function parseRelayCommand(line: string): RelayCommand | null {
  // Check for spawn command
  const spawnMatch = line.match(SPAWN_PATTERN);
  if (spawnMatch) {
    return {
      type: 'spawn',
      name: spawnMatch[1],
      cli: spawnMatch[2],
      task: spawnMatch[3],
    };
  }

  // Check for release command
  const releaseMatch = line.match(RELEASE_PATTERN);
  if (releaseMatch) {
    return {
      type: 'release',
      name: releaseMatch[1],
    };
  }

  // Check for cross-project message
  const crossMatch = line.match(CROSS_PROJECT_PATTERN);
  if (crossMatch) {
    return {
      type: 'message',
      project: crossMatch[1],
      target: crossMatch[2],
      body: crossMatch[3],
    };
  }

  // Fall back to existing single-project pattern
  // ...existing code...
}
```

### Phase 3: Bridge CLI Command

**File: `src/cli/bridge.ts`**

```typescript
import { Command } from 'commander';
import { MultiProjectClient } from '../wrapper/multi-project-client.js';

export function bridgeCommand(program: Command): void {
  program
    .command('bridge')
    .description('Bridge multiple projects as orchestrator')
    .argument('<projects...>', 'Project paths to bridge')
    .action(async (projectPaths: string[]) => {
      // Resolve and validate paths
      const projects = await resolveProjects(projectPaths);

      // Connect to all project sockets
      const client = new MultiProjectClient(projects);
      await client.connect();

      // Auto-detect leads (first registered agent per project)
      await client.discoverLeads();

      // Start wrapper with multi-project client
      const wrapper = new TmuxWrapper({
        agentName: 'Architect',
        client,
        isOrchestrator: true,
      });

      await wrapper.start();
    });
}
```

**File: `src/cli/lead.ts`**

```typescript
export function leadCommand(program: Command): void {
  program
    .command('lead')
    .description('Start as project lead with spawn capability')
    .argument('<name>', 'Your name')
    .action(async (name: string) => {
      // Detect project from cwd
      const project = await detectProject(process.cwd());

      // Start as lead with spawn capability
      const wrapper = new TmuxWrapper({
        agentName: name,
        projectRoot: project.root,
        isLead: true,
        canSpawn: true,
      });

      await wrapper.start();
    });
}
```

### Phase 4: Spawner Service

**File: `src/daemon/spawner.ts`**

```typescript
export class AgentSpawner {
  private activeWorkers: Map<string, WorkerInfo> = new Map();

  constructor(
    private projectRoot: string,
    private tmuxSession: string,
  ) {}

  async spawn(request: SpawnRequest): Promise<SpawnResult> {
    const { name, cli, model, task, requestedBy } = request;

    // Validate
    if (this.activeWorkers.has(name)) {
      throw new Error(`Worker ${name} already exists`);
    }

    // Create tmux window
    const windowName = `${name}`;
    await execAsync(`tmux new-window -t ${this.tmuxSession} -n ${windowName}`);

    // Build and launch command
    const cliCmd = model ? `${cli}:${model}` : cli;
    const cmd = `agent-relay -n ${name} ${cliCmd}`;
    await execAsync(`tmux send-keys -t ${this.tmuxSession}:${windowName} '${cmd}' Enter`);

    // Wait for registration
    const registered = await this.waitForAgent(name, 30_000);
    if (!registered) {
      await this.cleanup(windowName);
      throw new Error(`Worker ${name} failed to register`);
    }

    // Inject initial task
    await sleep(2000); // Wait for agent to be ready
    await execAsync(
      `tmux send-keys -t ${this.tmuxSession}:${windowName} ${escapeForTmux(task)} Enter`
    );

    // Track worker
    this.activeWorkers.set(name, {
      name,
      cli: cliCmd,
      task,
      spawnedBy: requestedBy,
      spawnedAt: Date.now(),
      window: `${this.tmuxSession}:${windowName}`,
    });

    return { success: true, name, window: windowName };
  }

  async release(name: string): Promise<void> {
    const worker = this.activeWorkers.get(name);
    if (!worker) return;

    // Send exit command
    try {
      await execAsync(`tmux send-keys -t ${worker.window} '/exit' Enter`);
      await sleep(3000);
    } catch {
      // Window may already be gone
    }

    // Kill window
    try {
      await execAsync(`tmux kill-window -t ${worker.window}`);
    } catch {
      // Ignore
    }

    this.activeWorkers.delete(name);
  }

  async releaseAll(): Promise<void> {
    for (const name of this.activeWorkers.keys()) {
      await this.release(name);
    }
  }

  getActiveWorkers(): WorkerInfo[] {
    return Array.from(this.activeWorkers.values());
  }
}
```

### Phase 5: Dashboard Enhancement

**File: `src/dashboard/bridge-view.ts`**

```typescript
export function createBridgeRouter(projects: ProjectConnection[]): Router {
  const router = Router();

  router.get('/bridge', async (req, res) => {
    const projectData = await Promise.all(
      projects.map(async (project) => ({
        id: project.id,
        name: project.name,
        lead: await project.getLead(),
        agents: await project.getAgents(),
        status: await project.getStatus(),
        recentMessages: await project.getRecentMessages(10),
      }))
    );

    res.render('bridge', {
      projects: projectData,
      orchestrator: req.query.as || 'Architect',
    });
  });

  router.get('/bridge/:projectId', async (req, res) => {
    const project = projects.find(p => p.id === req.params.projectId);
    if (!project) {
      return res.status(404).send('Project not found');
    }

    const data = {
      ...project,
      agents: await project.getAgents(),
      messages: await project.getMessages(50),
      workers: await project.getWorkers(),
    };

    res.render('bridge-project', data);
  });

  return router;
}
```

---

## Protocol Extensions

### New Message Types

```typescript
// src/protocol/types.ts additions

export interface SpawnPayload {
  name: string;
  cli: string;
  model?: string;
  task: string;
}

export interface ReleasePayload {
  name: string;
}

export interface SpawnResultPayload {
  success: boolean;
  name: string;
  window?: string;
  error?: string;
}

// Extended envelope for cross-project
export interface CrossProjectEnvelope<T> extends Envelope<T> {
  sourceProject?: string;
  targetProject?: string;
}
```

### Wire Format Examples

```json
// Spawn request
{
  "v": 1,
  "type": "SPAWN",
  "id": "spawn-123",
  "payload": {
    "name": "Dev1",
    "cli": "claude",
    "model": "sonnet",
    "task": "Implement the login endpoint"
  }
}

// Cross-project message
{
  "v": 1,
  "type": "SEND",
  "id": "msg-456",
  "to": "Alice",
  "sourceProject": "api-service",
  "targetProject": "auth-service",
  "payload": {
    "kind": "message",
    "body": "Here's the API spec you requested"
  }
}
```

---

## Security Considerations

1. **Socket Permissions**: Each project daemon maintains 0o600 permissions. The Architect must have filesystem access to all project socket paths.

2. **Spawn Validation**: Only agents with `--can-spawn` flag can spawn workers. Daemon validates the request source.

3. **Cross-Project Isolation**: Messages are routed through the Architect's client, not directly between daemons. This provides an audit point.

4. **Worker Limits**: Consider adding `--max-workers` flag to prevent runaway spawning.

---

## Configuration

### Project Config File (optional)

```json
// ~/auth-service/.agent-relay/config.json
{
  "projectName": "auth-service",
  "defaultLead": "Alice",
  "maxWorkers": 5,
  "allowedClis": ["claude", "codex"],
  "spawnDefaults": {
    "model": "sonnet",
    "timeout": 3600
  }
}
```

### Bridge Config File (optional)

```json
// ~/.config/agent-relay/bridge.json
{
  "defaultRole": "architect",
  "projects": {
    "auth-service": {
      "path": "~/auth-service",
      "lead": "Alice"
    },
    "frontend": {
      "path": "~/frontend",
      "lead": "Bob"
    }
  },
  "standup": {
    "autoStart": true,
    "time": "09:00"
  }
}
```

---

## Future Enhancements

1. **Scheduled Standups**: Auto-trigger standup at configured time
2. **Worker Health Checks**: Monitor spawned workers for crashes
3. **Load Balancing**: Auto-distribute work across projects
4. **Metrics/Analytics**: Track productivity across projects
5. **Notification Integration**: Slack/Discord alerts for blockers
6. **Replay Mode**: Re-run standups from message history

---

## Summary

The Bridge & Staffing feature enables:

- **Architect/Principal** as cross-project orchestrator via `agent-relay bridge`
- **Leads** who can dynamically spawn worker agents via `@relay:spawn`
- **Standup protocol** for daily work coordination
- **Multi-project dashboard** for visibility across all projects
- **SE vernacular** with familiar role hierarchy

This maintains the simplicity of `@relay:` patterns while enabling sophisticated multi-project orchestration.
