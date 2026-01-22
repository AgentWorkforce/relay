# @agent-relay/spawner API Surface

## Overview

The spawner package handles agent lifecycle management - spawning new agents, releasing them, and coordinating shadow agents.

## Core Types

### SpawnRequest

Request to spawn a new agent.

```typescript
interface SpawnRequest {
  /** Worker agent name (must be unique) */
  name: string;
  /** CLI tool (e.g., 'claude', 'claude:opus', 'codex', 'gemini') */
  cli: string;
  /** Initial task to inject after spawn */
  task: string;
  /** Optional team name for organization */
  team?: string;
  /** Working directory (defaults to project root) */
  cwd?: string;
  /** Name of requesting agent (for policy enforcement) */
  spawnerName?: string;
  /** Interactive mode - disables auto-accept */
  interactive?: boolean;
  /** Shadow mode: 'subagent' (no process) or 'process' */
  shadowMode?: 'subagent' | 'process';
  /** Primary agent to shadow */
  shadowOf?: string;
  /** Shadow agent profile */
  shadowAgent?: string;
  /** Shadow trigger conditions */
  shadowTriggers?: SpeakOnTrigger[];
  /** When shadow should speak */
  shadowSpeakOn?: SpeakOnTrigger[];
  /** User ID for credential scoping */
  userId?: string;
}
```

### SpawnResult

Result of a spawn operation.

```typescript
interface SpawnResult {
  success: boolean;
  name: string;
  /** PID of spawned process */
  pid?: number;
  error?: string;
  /** Policy decision if blocked */
  policyDecision?: PolicyDecision;
}
```

### WorkerInfo

Information about an active worker.

```typescript
interface WorkerInfo {
  name: string;
  cli: string;
  task: string;
  team?: string;
  spawnedAt: number;
  pid?: number;
}
```

### SpeakOnTrigger

When shadow agents should activate.

```typescript
type SpeakOnTrigger =
  | 'SESSION_END'      // When primary session ends
  | 'CODE_WRITTEN'     // When code is written
  | 'REVIEW_REQUEST'   // When review requested
  | 'EXPLICIT_ASK'     // When explicitly asked
  | 'ALL_MESSAGES';    // On every message
```

### PolicyDecision

Result of policy check.

```typescript
interface PolicyDecision {
  allowed: boolean;
  reason: string;
  policySource: 'repo' | 'local' | 'workspace' | 'default';
}
```

## AgentSpawner Class

Main class for agent lifecycle management.

### Constructor

```typescript
constructor(options: AgentSpawnerOptions)

interface AgentSpawnerOptions {
  projectRoot: string;
  tmuxSession?: string;
  dashboardPort?: number;
  onMarkSpawning?: (agentName: string) => void;
  onClearSpawning?: (agentName: string) => void;
}
```

### Core Methods

#### spawn(request: SpawnRequest): Promise<SpawnResult>

Spawn a new worker agent.

- Validates agent doesn't already exist
- Enforces agent limits (MAX_AGENTS)
- Checks policy (if enabled)
- Resolves CLI command path
- Configures agent based on CLI type
- Waits for registration with daemon
- Sends initial task

#### release(name: string): Promise<boolean>

Release (terminate) a worker.

- Unbinds event listeners
- Stops PTY process gracefully
- Force kills if needed
- Removes from tracking

#### releaseAll(): Promise<void>

Release all active workers.

#### spawnWithShadow(request: SpawnWithShadowRequest): Promise<SpawnWithShadowResult>

Spawn a primary agent with its shadow.

- Spawns primary first
- Determines shadow mode (subagent vs process)
- Spawns shadow with shadowOf binding
- Handles partial success (primary succeeds, shadow fails)

### Query Methods

#### getActiveWorkers(): WorkerInfo[]

Get all active workers (without PTY reference).

#### hasWorker(name: string): boolean

Check if a worker exists.

#### getWorker(name: string): WorkerInfo | undefined

Get worker info by name.

#### getWorkerOutput(name: string, limit?: number): string[] | null

Get output logs from a worker.

#### getWorkerRawOutput(name: string): string | null

Get raw output from a worker.

### Configuration Methods

#### setDashboardPort(port: number): void

Set dashboard port for nested spawn API calls.

#### setOnAgentDeath(callback: OnAgentDeathCallback): void

Set callback for agent death notifications.

#### setCloudPersistence(handler: CloudPersistenceHandler): void

Set cloud persistence handler for session events.

#### setCloudPolicyFetcher(fetcher: CloudPolicyFetcher): void

Set cloud policy fetcher for workspace policies.

## Shadow Agent Flow

1. **Primary Spawn**: Primary agent spawns normally
2. **Shadow Selection**: Determine shadow CLI and mode
3. **Subagent Mode**: Claude/Codex primaries run shadows as Task tool subagents (no extra process)
4. **Process Mode**: Other primaries spawn shadow as separate process with `shadowOf` binding
5. **Event Binding**: Shadow receives copies of primary's messages based on `speakOn` triggers

### Role Presets

```typescript
const ROLE_PRESETS = {
  reviewer: ['CODE_WRITTEN', 'REVIEW_REQUEST', 'EXPLICIT_ASK'],
  auditor: ['SESSION_END', 'EXPLICIT_ASK'],
  active: ['ALL_MESSAGES'],
};
```

## Policy Integration

When `AGENT_POLICY_ENFORCEMENT=1`:

1. Policy service initialized on construction
2. `canSpawn(spawnerName, targetName, cli)` called before spawn
3. Checks repo, local, workspace, and default policies
4. Returns `PolicyDecision` with reason if blocked

## CLI Command Mapping

```typescript
const CLI_COMMAND_MAP = {
  cursor: 'agent',   // Cursor CLI installs as 'agent'
  google: 'gemini',  // Google provider uses 'gemini' CLI
};
```

## Events

### Cloud Persistence Events

- `summary`: Agent outputs `[[SUMMARY]]` block
- `session-end`: Agent outputs `[[SESSION_END]]` block

### Death Notification

```typescript
type OnAgentDeathCallback = (info: {
  name: string;
  exitCode: number | null;
  agentId?: string;
  resumeInstructions?: string;
}) => void;
```

## Package Dependencies

### Required
- `@agent-relay/wrapper` - RelayPtyOrchestrator for PTY management

### Optional
- Policy service (when enforcement enabled)
- Cloud persistence handler
- User directory service
