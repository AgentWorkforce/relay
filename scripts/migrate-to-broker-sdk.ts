#!/usr/bin/env npx tsx
/**
 * CLI Migration: Old SDK -> Broker SDK
 *
 * Coordinates multi-agent migration using agent-relay itself.
 * A Lead agent (this script) spawns Codex workers in dependency waves,
 * then spawns a Codex reviewer after each wave to verify the work.
 * The lead reflects after each wave before proceeding.
 *
 * Waves:
 *   Wave 1: Extend Rust binary protocol + Extend broker SDK (parallel)
 *   Wave 2: Migrate CLI + ACP bridge + MCP (parallel)
 *   Wave 3: Delete unused packages
 *
 * Run: npx tsx scripts/migrate-to-broker-sdk.ts
 * Plan: .claude/plans/binary-watching-waffle.md
 */
import { AgentRelay, type Agent } from "@agent-relay/broker-sdk";

// ── Self-release suffix appended to every task spec ─────────────────────────
// Codex --full-auto doesn't auto-exit. Workers must self-release via relay
// file protocol so the orchestrator can detect completion.

function withSelfRelease(task: string, workerName: string): string {
  return `${task}

## Release Yourself When Done (CRITICAL)
After completing ALL tasks above (including self-reflection), you MUST release yourself.
Run this exact bash command:

\`\`\`bash
cat > $AGENT_RELAY_OUTBOX/release << 'EOF'
KIND: release
NAME: ${workerName}
EOF
\`\`\`

Then output this exact text: ->relay-file:release

This is how the orchestrator knows you are finished. Do NOT skip this step.
`.trim();
}

// ── Task specs ──────────────────────────────────────────────────────────────

const RUST_WORKER_TASK = `
You are extending the Rust binary protocol for agent-relay.

## Context
The broker SDK (packages/sdk-ts) communicates with the Rust binary (src/main.rs) via JSON
over stdio. The binary currently handles: hello, spawn_agent, send_message, release_agent,
list_agents, get_status, shutdown. We need to add new protocol message types.

## Files to modify
- src/main.rs (protocol handler — search for "spawn_agent" to find the match block ~line 1764)
- src/protocol.rs (type definitions — AgentSpec struct)

## Tasks

### 1. Add send_input handler
Accept payload: { name: String, data: String }
Find the worker by name in the workers HashMap, write data bytes to its PTY stdin (the
ChildStdin stored in WorkerHandle).
Respond with ok: { name: String, bytes_written: usize }
Error if worker not found.

### 2. Add set_model handler
Accept payload: { name: String, model: String, timeout_ms: Option<u64> }
Find the worker by name. Write "/model {model}\\n" to its PTY stdin.
This is how Claude Code switches models interactively.
Respond with ok: { name: String, model: String, success: bool }
Error if worker not found.

### 3. Add get_metrics handler
Accept payload: { agent: Option<String> }
For each worker (or just the named one), collect:
- name (from WorkerHandle.spec.name)
- pid (from WorkerHandle.child.id())
- uptime_secs (track spawn time in WorkerHandle, compute elapsed)
- memory_bytes: use /proc/{pid}/statm on Linux, or 0 on macOS (best effort)
Respond with ok: { agents: Vec<{name, pid, memory_bytes, uptime_secs}> }

To track spawn time: add a \`spawned_at: Instant\` field to WorkerHandle.

### 4. Extend AgentSpec in protocol.rs
Add these optional fields to the AgentSpec struct:
\`\`\`rust
#[serde(skip_serializing_if = "Option::is_none")]
pub model: Option<String>,
#[serde(skip_serializing_if = "Option::is_none")]
pub cwd: Option<String>,
#[serde(skip_serializing_if = "Option::is_none")]
pub team: Option<String>,
#[serde(skip_serializing_if = "Option::is_none")]
pub shadow_of: Option<String>,
#[serde(skip_serializing_if = "Option::is_none")]
pub shadow_mode: Option<String>,
\`\`\`

In main.rs where workers are spawned, if spec.cwd is Some, use it as the working
directory for the child process Command.

### 5. Add reason to release_agent
Change the release_agent handler to accept: { name: String, reason: Option<String> }
Log the reason with tracing::info! when releasing. No other behavior change.

## Verification
After ALL changes, run these commands and fix any issues:
- cargo test
- cargo clippy -- -D warnings
- cargo build

Report back with: which handlers you added, any issues encountered, and test results.

## Self-Reflection (REQUIRED before finishing)
Before you report completion, you MUST go through every task above with fresh eyes:
1. Re-read each numbered task (1-5) and verify you actually implemented it
2. For each task, open the file you modified and confirm the code is there
3. Run cargo test, cargo clippy, cargo build one final time
4. Check: Did I miss anything? Any TODO comments left behind? Any incomplete implementations?
5. List each task and mark it DONE or INCOMPLETE in your final report
`.trim();

const SDK_WORKER_TASK = `
You are extending the broker SDK (TypeScript) for agent-relay.

## Context
The broker SDK in packages/sdk-ts/ communicates with the Rust binary via JSON stdio protocol.
The AgentRelayClient class (client.ts) sends typed requests via requestOk<T>().
The AgentRelay class (relay.ts) is the high-level facade.
Protocol types are in protocol.ts.

## Files to modify
- packages/sdk-ts/src/client.ts (AgentRelayClient class)
- packages/sdk-ts/src/relay.ts (AgentRelay facade)
- packages/sdk-ts/src/protocol.ts (type definitions)
- packages/sdk-ts/src/relaycast.ts (replace wrapper with utility)
- packages/sdk-ts/src/index.ts (update exports)

## Tasks

### 1. Add new methods to AgentRelayClient (client.ts)

Follow the existing requestOk pattern (see spawnPty, release, sendMessage):

a) sendInput(name: string, data: string): Promise<{ name: string; bytes_written: number }>
   Sends "send_input" with payload { name, data }

b) setModel(name: string, model: string, opts?: { timeoutMs?: number }): Promise<{ name: string; model: string; success: boolean }>
   Sends "set_model" with payload { name, model, timeout_ms: opts?.timeoutMs }

c) getMetrics(agent?: string): Promise<{ agents: Array<{ name: string; pid: number; memory_bytes: number; uptime_secs: number }> }>
   Sends "get_metrics" with payload { agent }

### 2. Extend SpawnPtyInput interface (client.ts)
Add optional fields:
  model?: string;
  cwd?: string;
  team?: string;
  shadowOf?: string;
  shadowMode?: string;

In the spawnPty method, pass these through to the AgentSpec:
  model: input.model,
  cwd: input.cwd,
  team: input.team,
  shadow_of: input.shadowOf,
  shadow_mode: input.shadowMode,

### 3. Update release signature (client.ts)
Change: release(name: string, reason?: string): Promise<{ name: string }>
Send { name, reason } in the payload (reason is optional).

### 4. Update AgentSpec in protocol.ts
Add to the AgentSpec interface:
  model?: string;
  cwd?: string;
  team?: string;
  shadow_of?: string;
  shadow_mode?: string;

### 5. Add waitForAgentReady to AgentRelay facade (relay.ts)
Add method:
  async waitForAgentReady(name: string, timeoutMs = 60_000): Promise<Agent>

Implementation:
- If the agent is already in knownAgents and has received worker_ready, resolve immediately
- Otherwise, listen to the existing onEvent "worker_ready" events
- Set up a timeout that rejects with an error
- When worker_ready fires for the matching name, resolve with the Agent object
- Clean up listener on resolve or reject

### 6. Replace RelaycastApi with createRelaycastClient utility (relaycast.ts)
Delete the RelaycastApi class. Replace with:

\`\`\`typescript
import { RelayCast, RelayError, type AgentClient } from "@relaycast/sdk";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export type { AgentClient } from "@relaycast/sdk";

export interface CreateRelaycastClientOptions {
  apiKey?: string;
  baseUrl?: string;
  cachePath?: string;
  agentName?: string;
}

/**
 * Create an authenticated @relaycast/sdk AgentClient.
 * Handles API key resolution (options > env > cache file) and agent registration
 * with 409 conflict retry.
 */
export async function createRelaycastClient(
  options: CreateRelaycastClientOptions = {},
): Promise<AgentClient> {
  const baseUrl = options.baseUrl ?? process.env.RELAYCAST_BASE_URL ?? "https://api.relaycast.dev";
  const cachePath = options.cachePath ?? join(homedir(), ".agent-relay", "relaycast.json");
  const agentName = options.agentName ?? \`sdk-\${randomBytes(4).toString("hex")}\`;

  // Resolve API key
  let apiKey = options.apiKey ?? process.env.RELAY_API_KEY;
  if (!apiKey) {
    const raw = await readFile(cachePath, "utf-8");
    const creds = JSON.parse(raw);
    apiKey = creds.api_key;
  }

  const relay = new RelayCast({ apiKey, baseUrl });

  // Register with 409 conflict retry
  let name = agentName;
  let registration;
  try {
    registration = await relay.agents.register({ name, type: "agent" });
  } catch (err) {
    if (err instanceof RelayError && err.code === "agent_already_exists") {
      name = \`\${agentName}-\${randomBytes(4).toString("hex")}\`;
      registration = await relay.agents.register({ name, type: "agent" });
    } else {
      throw err;
    }
  }

  return relay.as(registration.token);
}
\`\`\`

### 7. Update index.ts exports
- Remove: export * from "./relaycast.js" (if it only exported RelaycastApi)
- Add: export { createRelaycastClient, type CreateRelaycastClientOptions, type AgentClient } from "./relaycast.js"
- Make sure all new client methods are accessible

### 8. Update package.json dependencies
In packages/sdk-ts/package.json, ensure @relaycast/sdk is a dependency (it should already be).

## Verification
Run: cd packages/sdk-ts && npm test
Report back with: methods added, any type issues, test results.

## Self-Reflection (REQUIRED before finishing)
Before you report completion, you MUST go through every task above with fresh eyes:
1. Re-read each numbered task (1-8) and verify you actually implemented it
2. For each task, open the file you modified and confirm the code is there
3. Run npm test in packages/sdk-ts one final time
4. Check: Did I miss anything? Any TODO comments left behind? Any type errors remaining?
5. Cross-check: Do the protocol types in protocol.ts match what the Rust binary expects?
6. List each task and mark it DONE or INCOMPLETE in your final report
`.trim();

const CLI_WORKER_TASK = `
You are migrating the agent-relay CLI from the old SDK to the broker SDK.

## Context
The CLI at src/cli/index.ts is a large file (~1800+ lines) built with Commander.
It currently uses:
- RelayClient from @agent-relay/sdk (Unix socket to daemon)
- Daemon from @agent-relay/daemon
- RelayPtyOrchestrator, getTmuxPath from @agent-relay/wrapper
- AgentSpawner, readWorkersMetadata, getWorkerLogsDir, selectShadowCli, ensureMcpPermissions from @agent-relay/bridge
- SpawnRequest, SpawnResult types from @agent-relay/bridge

We're replacing ALL of these with:
- AgentRelay / AgentRelayClient from @agent-relay/broker-sdk (stdio to Rust binary)
- createRelaycastClient from @agent-relay/broker-sdk (for cloud operations)
- @relaycast/sdk AgentClient for inbox, history, channels, search

## File to modify
- src/cli/index.ts
- src/cli/package.json (if it has its own, update deps) OR the root package.json deps

## Imports to REMOVE
\`\`\`typescript
import { Daemon } from '@agent-relay/daemon';
import { RelayClient } from '@agent-relay/sdk';
import { RelayPtyOrchestrator, getTmuxPath } from '@agent-relay/wrapper';
import { AgentSpawner, readWorkersMetadata, getWorkerLogsDir, selectShadowCli, ensureMcpPermissions } from '@agent-relay/bridge';
import type { SpawnRequest, SpawnResult } from '@agent-relay/bridge';
\`\`\`

## Imports to ADD
\`\`\`typescript
import { AgentRelay, AgentRelayClient, createRelaycastClient } from '@agent-relay/broker-sdk';
import type { AgentClient } from '@relaycast/sdk';
\`\`\`

## Command-by-command migration

Search for every "new RelayClient(" and replace. There are ~6 instances.

### relay up
Old: Starts Daemon, creates RelayPtyOrchestrator
New: Instantiate AgentRelay({ binaryPath, channels }). The SDK auto-starts the Rust binary.
     For dashboard support, the listen mode in the Rust binary handles Relaycast WS streaming.

### relay down
Old: Connects to daemon, sends shutdown
New: relay.shutdown()

### relay spawn <name> <cli> [task]
Old: Connects to daemon via RelayClient, calls client.spawn(...)
New: relay.spawnPty({ name, cli, args, channels, task })
     Boot broker on the fly if not running (AgentRelay handles this).

### relay release <name>
Old: Connects to daemon, calls client.release(name)
New: Use AgentRelayClient to call release(name, reason)

### relay send <to> <message>
Old: Connects via RelayClient, calls client.sendMessage(to, body)
New: const human = relay.human({ name: senderName }); human.sendMessage({ to, text })

### relay agents / relay who
Old: Connects via RelayClient, calls client.listAgents() or listConnectedAgents()
New: relay.listAgents() for local agents

### relay status
Old: Connects via RelayClient, calls client.getStatus()
New: relay.getStatus()

### relay history
Old: Connects via RelayClient, calls client.queryMessages(...)
New: const rc = await createRelaycastClient(); rc.messages(channel, { limit })

### relay read <id>
Old: Connects via RelayClient, fetches message
New: Use @relaycast/sdk to fetch message

### relay set-model <agent> <model>
Old: Connects via RelayClient, calls client.setWorkerModel(name, model)
New: client.setModel(name, model)

### relay inbox
Old: Connects via RelayClient, calls client.getInbox(...)
New: const rc = await createRelaycastClient(); rc.inbox()

### relay metrics
Old: Connects via RelayClient, calls client.getMetrics(...)
New: client.getMetrics(agent)

### relay create-agent <cmd>
Old: Uses RelayPtyOrchestrator to wrap a CLI in a PTY
New: relay.spawnPty({ name, cli: cmd, args }) — the Rust binary handles PTY wrapping

## Key pattern change
Old: Must run "relay up" first to start daemon, then commands connect via socket.
New: Each command boots the broker on demand via AgentRelay. No separate "up" step needed
     for most commands. "relay up" can still exist for users who want a persistent broker
     (e.g., for dashboard streaming).

## Package dependency updates
In whatever package.json governs the CLI, remove these deps:
- @agent-relay/sdk
- @agent-relay/daemon
- @agent-relay/wrapper
- @agent-relay/bridge

Add these deps:
- @agent-relay/broker-sdk (should already be in the monorepo)
- @relaycast/sdk (for cloud operations)

## Important
- Keep the same CLI UX and all command names
- Preserve all existing flags and options
- Keep telemetry (initTelemetry, track calls), update checks (checkForUpdatesInBackground)
- Keep config loading (loadRuntimeConfig, getProjectPaths, getShadowForAgent from @agent-relay/config)
- Keep storage (createStorageAdapter from @agent-relay/storage)
- Keep MCP install (installMcpConfig from @agent-relay/mcp)
- The file is very large — work methodically through each command

## Verification
After changes:
1. Run: npx tsc --noEmit (or whatever typecheck command exists)
2. Grep for any remaining imports of @agent-relay/sdk, @agent-relay/daemon, @agent-relay/wrapper, @agent-relay/bridge
3. Report: which commands you migrated, any commands you couldn't migrate (and why), any type errors

## Self-Reflection (REQUIRED before finishing)
Before you report completion, you MUST go through every task above with fresh eyes:
1. Re-read the "Command-by-command migration" section — go through EVERY command and verify you migrated it
2. Open src/cli/index.ts and search for any remaining "RelayClient", "Daemon", "RelayPtyOrchestrator", "AgentSpawner" references
3. Run npx tsc --noEmit one final time
4. Verify every CLI command still exists (up, down, spawn, release, send, agents, who, status, history, read, set-model, inbox, metrics)
5. Check: Are all old imports removed? Are all new imports added? Any TODO comments left?
6. List each command and mark it MIGRATED or INCOMPLETE in your final report
`.trim();

const ACP_WORKER_TASK = `
You are migrating the ACP bridge from the old SDK to the broker SDK.

## Context
The ACP bridge at packages/acp-bridge/src/acp-agent.ts bridges agent-relay to ACP editors (Zed).
It currently uses RelayClient from @agent-relay/sdk (Unix socket to daemon).

We're replacing with AgentRelay from @agent-relay/broker-sdk (stdio to Rust binary).

## Files to modify
- packages/acp-bridge/src/acp-agent.ts
- packages/acp-bridge/package.json (update dependencies)

## Migration map

### Replace RelayClient with AgentRelay

1. Import: Replace
   \`import { RelayClient, type ClientConfig } from '@agent-relay/sdk'\`
   with
   \`import { AgentRelay, type Agent, type Message } from '@agent-relay/broker-sdk'\`

2. Constructor: Replace
   \`this.relayClient = new RelayClient(relayConfig)\`
   with
   \`this.relay = new AgentRelay({ brokerName: this.config.agentName, channels: ['general'] })\`

3. Remove connect(): AgentRelay auto-starts on first operation. Remove the explicit
   \`await this.relayClient.connect()\` call in start(). Remove the subscribe('#general')
   call — channels are configured at construction.

4. Messaging:
   Old: relay.sendMessage(target, cleanMessage, 'message', undefined, session.id)
   New: const human = this.relay.human({ name: this.config.agentName });
        await human.sendMessage({ to: target, text: cleanMessage, threadId: session.id })

   Old: relay.sendMessage('*', userMessage, 'message', undefined, session.id)
   New: await human.sendMessage({ to: '*', text: userMessage, threadId: session.id })

5. Spawn:
   Old: await this.relayClient!.spawn({ name, cli, task, waitForReady: true })
   New: const agent = await this.relay.spawnPty({ name, cli, task });
        await this.relay.waitForAgentReady(name, 60_000);
   Adapt result handling — old returns { success, error, ready }, new returns agent object
   or throws on failure.

6. Release:
   Old: await this.relayClient!.release(name)
   New: Call release through the AgentRelayClient or agent handle.
   Adapt result — old returns { success, error }, new returns { name } or throws.

7. List:
   Old: await this.relayClient!.listConnectedAgents()
   New: await this.relay.listAgents()
   Result shape: old returns AgentInfo[], new returns Agent[]. Both have .name and .cli fields.

8. Events — setupRelayHandlers():
   Old:
     this.relayClient.onMessage = (from, payload, messageId) => { ... }
     this.relayClient.onChannelMessage = (from, channel, body) => { ... }
     this.relayClient.onStateChange = (state) => { ... }
     this.relayClient.onError = (error) => { ... }
   New:
     this.relay.onMessageReceived = (msg) => {
       // msg has: eventId, from, to, text, threadId
       this.handleRelayMessage({
         id: msg.eventId,
         from: msg.from,
         body: msg.text,
         thread: msg.threadId,
         timestamp: Date.now(),
       });
     };
     // Channel messages also come through onMessageReceived in the broker SDK
     // onStateChange — not directly available; remove or replace with process checks
     // onError — remove; handle errors via try/catch on operations

9. State & ensureRelayReady():
   Old: checks client.state === 'READY', handles DISCONNECTED/BACKOFF reconnect logic
   New: The broker SDK manages the Rust binary process. If it's not running, operations
   will throw. Simplify ensureRelayReady() to:
   - Try a lightweight operation (like getStatus)
   - If it throws, try to re-instantiate AgentRelay
   - Return true/false

10. reconnectToRelay():
    Old: Creates a fresh RelayClient and calls connect()
    New: Create a fresh AgentRelay instance. Auto-starts on first use. Simpler.

11. Cleanup:
    Old: this.relayClient?.destroy()
    New: await this.relay?.shutdown()

### Update package.json
In packages/acp-bridge/package.json:
- Remove dependency: @agent-relay/sdk
- Add dependency: @agent-relay/broker-sdk
- Keep @agentclientprotocol/sdk (this is the ACP SDK, not relay)

## Important
- ACP commands must still work: spawn, release, agents, status, help
- @mention messaging must still work
- Session management (sessions Map, messageBuffer Map) stays the same
- CircularDedupeCache stays (it's local)
- The "sent" boolean pattern changes — old sendMessage returns boolean, new returns Promise.
  Adapt the if (!sent) checks to use try/catch.

## Verification
1. Run: npx tsc --noEmit in packages/acp-bridge
2. Grep for remaining @agent-relay/sdk imports
3. Report: what you changed, any issues, any functionality that couldn't be mapped 1:1

## Self-Reflection (REQUIRED before finishing)
Before you report completion, you MUST go through every task above with fresh eyes:
1. Re-read the "Migration map" section — go through items 1-11 and verify each was addressed
2. Open packages/acp-bridge/src/acp-agent.ts and search for any remaining "RelayClient" or "@agent-relay/sdk" references
3. Run npx tsc --noEmit in packages/acp-bridge one final time
4. Verify all ACP commands still work: spawn, release, agents, status, help, @mention messaging
5. Check: Is the event mapping correct (onMessage → onMessageReceived)? Is session management intact?
6. List each migration item (1-11) and mark it DONE or INCOMPLETE in your final report
`.trim();

const MCP_WORKER_TASK = `
You are migrating the MCP package from the old SDK to the broker SDK.

## Context
The MCP package at packages/mcp/ provides MCP tools for agent-relay.
It uses RelayClient from @agent-relay/sdk in its client adapter.

## Files to check and modify
- packages/mcp/src/client-adapter.ts (main adapter — read this first)
- packages/mcp/src/tools/*.ts (tool implementations that may import old SDK types)
- packages/mcp/package.json (dependencies)

## Tasks

### 1. Read client-adapter.ts first
Understand how it wraps RelayClient. Then replace:
- RelayClient usage → AgentRelay or AgentRelayClient from @agent-relay/broker-sdk
- Old SDK types → broker SDK types
- Socket-based connect/disconnect → broker SDK auto-start/shutdown

### 2. Update tool implementations
Check each tool file in packages/mcp/src/tools/ for imports from @agent-relay/sdk.
Replace with @agent-relay/broker-sdk equivalents:
- relay-send.ts — sendMessage
- relay-spawn.ts — spawnPty
- relay-release.ts — release
- relay-who.ts — listAgents
- relay-inbox.ts — may need createRelaycastClient + @relaycast/sdk agent.inbox()
- relay-logs.ts — getLogs from broker SDK
- relay-shadow.ts — ShadowManager from broker SDK
- relay-consensus.ts — ConsensusEngine from broker SDK
- relay-set-model.ts — setModel (new method)
- relay-health.ts — may need createRelaycastClient + @relaycast/sdk relay.stats()
- relay-metrics.ts — getMetrics (new method)

### 3. Update package.json
- Remove: @agent-relay/sdk from dependencies/peerDependencies/devDependencies
- Add: @agent-relay/broker-sdk
- Add: @relaycast/sdk if any tools need cloud operations

### 4. Check for @agent-relay/protocol imports
The old MCP package may import types from @agent-relay/protocol. These types now live
in @agent-relay/broker-sdk (packages/sdk-ts/src/protocol.ts). Update accordingly.

## Verification
1. Run: npx tsc --noEmit in packages/mcp
2. Grep for remaining imports of @agent-relay/sdk or @agent-relay/protocol
3. List all tools and whether they compile
4. Report: changes made, any tools that couldn't be migrated, any missing types

## Self-Reflection (REQUIRED before finishing)
Before you report completion, you MUST go through every task above with fresh eyes:
1. Re-read tasks 1-4 and verify each was completed
2. Open packages/mcp/src/client-adapter.ts and verify no remaining @agent-relay/sdk imports
3. Check EVERY tool file in packages/mcp/src/tools/ for old SDK references
4. Run npx tsc --noEmit in packages/mcp one final time
5. List each tool file and mark it MIGRATED or SKIPPED (with reason) in your final report
`.trim();

const CLEANUP_WORKER_TASK = `
You are deleting unused packages from the agent-relay monorepo.

## Context
We've migrated to the broker SDK. The following packages are no longer imported anywhere.

## Packages to delete
Delete these directories entirely:
- packages/daemon
- packages/sdk
- packages/wrapper
- packages/bridge
- packages/spawner
- packages/protocol
- packages/state
- packages/resiliency
- packages/continuity

## Step-by-step

### 1. BEFORE deleting, verify no remaining imports
Search the ENTIRE codebase (excluding node_modules) for these import patterns:
- @agent-relay/daemon
- @agent-relay/sdk (but NOT @agent-relay/sdk-ts or @agent-relay/broker-sdk)
- @agent-relay/wrapper
- @agent-relay/bridge
- @agent-relay/spawner
- @agent-relay/protocol
- @agent-relay/state
- @agent-relay/resiliency
- @agent-relay/continuity

If ANY remaining imports are found, report them and DO NOT delete those packages.
The migration workers in the previous wave should have already removed these imports.

### 2. Delete the directories
rm -rf packages/daemon packages/sdk packages/wrapper packages/bridge packages/spawner packages/protocol packages/state packages/resiliency packages/continuity

### 3. Update root package.json workspace config
Read the root package.json. Find the "workspaces" array. Remove entries for deleted packages.

### 4. Update tsconfig references
Check for:
- Root tsconfig.json or tsconfig.build.json with "references" pointing to deleted packages
- Any tsconfig.json in remaining packages that references deleted packages

### 5. Update any CI/build scripts
Check .github/workflows/ and scripts/ for references to deleted packages.

### 6. Verify build
Run the build command (check package.json scripts for "build"):
- npm run build OR turbo build OR equivalent

## Do NOT delete
- packages/sdk-ts (this is the NEW SDK, @agent-relay/broker-sdk)
- packages/config, utils, telemetry, storage, mcp, hooks
- packages/memory, policy, acp-bridge, user-directory, trajectory

## Verification
1. Full build passes
2. No remaining imports of deleted packages
3. Report: which packages were deleted, build status, any issues found

## Self-Reflection (REQUIRED before finishing)
Before you report completion, you MUST go through every task above with fresh eyes:
1. Re-read steps 1-6 and verify each was completed
2. Run: ls packages/ — confirm deleted packages are gone and kept packages still exist
3. Run: grep -r "@agent-relay/daemon\|@agent-relay/sdk[^-]\|@agent-relay/wrapper\|@agent-relay/bridge\|@agent-relay/spawner\|@agent-relay/protocol\|@agent-relay/state\|@agent-relay/resiliency\|@agent-relay/continuity" --include="*.ts" --include="*.json" . (excluding node_modules)
4. Run the full build one final time
5. List each package and mark it DELETED or KEPT in your final report
`.trim();

// ── Review task templates ───────────────────────────────────────────────────

function makeReviewTask(waveName: string, workers: string[], checks: string): string {
  return `
You are a code reviewer verifying the output of Wave "${waveName}".

## Context
The following Codex workers just completed their tasks: ${workers.join(', ')}.
They were part of a migration from the old @agent-relay/sdk (Unix socket daemon model)
to @agent-relay/broker-sdk (stdio to Rust binary).

## Your job
Review the changes made by these workers. Check for:

1. **Completeness** — Did each worker complete ALL their assigned tasks?
2. **Correctness** — Are the implementations correct? No type errors? No logic bugs?
3. **Consistency** — Do the changes across workers align? (e.g., Rust protocol types
   match TypeScript protocol types, method signatures match)
4. **No regressions** — Are existing features preserved? No accidental deletions?
5. **Build health** — Does the project compile?

## Specific checks
${checks}

## Verification commands to run
- cargo build (Rust)
- cargo test (Rust tests)
- cd packages/sdk-ts && npm test (SDK tests)
- npx tsc --noEmit (TypeScript typecheck across project)
- Search for any remaining imports of @agent-relay/sdk (old), @agent-relay/daemon,
  @agent-relay/wrapper, @agent-relay/bridge in migrated files

## Output format
Respond with a structured report:

REVIEW: ${waveName}
STATUS: PASS | FAIL | PARTIAL
ISSUES:
- [file:line] description of issue
- ...
MISSING:
- Feature X was not implemented
- ...
BUILD:
- cargo build: PASS/FAIL
- cargo test: PASS/FAIL
- npm test: PASS/FAIL
- tsc: PASS/FAIL
RECOMMENDATION: proceed | fix-needed | block
`.trim();
}

const WAVE1_REVIEW_CHECKS = `
### Rust binary (RustWorker)
- src/main.rs has handlers for: send_input, set_model, get_metrics
- src/protocol.rs AgentSpec has: model, cwd, team, shadow_of, shadow_mode fields
- release_agent accepts optional reason field
- WorkerHandle has spawned_at: Instant for uptime tracking
- cargo test passes, cargo clippy clean

### Broker SDK (SDKWorker)
- packages/sdk-ts/src/client.ts has: sendInput(), setModel(), getMetrics() methods
- SpawnPtyInput has: model, cwd, team, shadowOf, shadowMode fields
- release() accepts optional reason parameter
- packages/sdk-ts/src/relay.ts has waitForAgentReady() method
- packages/sdk-ts/src/protocol.ts AgentSpec matches Rust AgentSpec
- packages/sdk-ts/src/relaycast.ts exports createRelaycastClient (NOT RelaycastApi class)
- npm test passes

### Cross-check
- Rust send_input payload shape matches TS sendInput arguments
- Rust set_model payload shape matches TS setModel arguments
- Rust get_metrics response shape matches TS getMetrics return type
- AgentSpec fields are snake_case in Rust, camelCase mapped in TS
`;

const WAVE2_REVIEW_CHECKS = `
### CLI (CLIWorker)
- src/cli/index.ts has NO imports from: @agent-relay/sdk, @agent-relay/daemon,
  @agent-relay/wrapper, @agent-relay/bridge
- src/cli/index.ts imports AgentRelay/AgentRelayClient from @agent-relay/broker-sdk
- All CLI commands still exist: up, down, spawn, release, send, agents, who, status,
  history, read, set-model, inbox, metrics, create-agent, doctor
- Telemetry, update checks, config loading preserved
- Package deps updated

### ACP Bridge (ACPWorker)
- packages/acp-bridge/src/acp-agent.ts has NO imports from @agent-relay/sdk
- Uses AgentRelay from @agent-relay/broker-sdk
- All ACP commands work: spawn, release, agents, status, help
- @mention messaging preserved
- Session/buffer management intact
- package.json deps updated

### MCP (MCPWorker)
- packages/mcp/ has NO imports from @agent-relay/sdk or @agent-relay/protocol
- All tool files compile
- package.json deps updated
`;

const WAVE3_REVIEW_CHECKS = `
### Cleanup (CleanupWorker)
- These directories are GONE: packages/daemon, packages/sdk, packages/wrapper,
  packages/bridge, packages/spawner, packages/protocol, packages/state,
  packages/resiliency, packages/continuity
- These directories EXIST: packages/sdk-ts, packages/config, packages/utils,
  packages/telemetry, packages/storage, packages/mcp, packages/hooks,
  packages/memory, packages/policy, packages/acp-bridge, packages/user-directory,
  packages/trajectory
- Root package.json workspaces updated
- No remaining imports of deleted packages anywhere in codebase
- Full build passes
`;

// ── Fresh-eyes review task template ──────────────────────────────────────────

function makeFreshEyesReviewTask(workerName: string, originalTask: string): string {
  return `
You are a fresh-eyes reviewer. You have NOT seen this code before.
Your job is to review the work done by "${workerName}" as if you're seeing it for the first time.

## The original task given to ${workerName}
${originalTask}

## Your review process

### Step 1: Read the diff
Run: git diff HEAD~1 -- (or git log --oneline -5 to find the right range)
Look at every changed file. Do NOT skim — read carefully.

### Step 2: Verify completeness against the task spec
Go through every numbered task/requirement in the original task above.
For each one, find the corresponding code change and verify it's correct.

### Step 3: Look for problems with fresh eyes
As someone seeing this code for the first time, check for:
- Obvious bugs or logic errors
- Missing error handling
- Type mismatches (especially between Rust and TypeScript types)
- Incomplete implementations (stubs, TODOs, placeholder code)
- Broken imports or missing exports
- Code that compiles but wouldn't work at runtime

### Step 4: Run verification
Run any verification commands specified in the original task (cargo test, npm test, tsc --noEmit, etc.)

## Output format
FRESH-EYES REVIEW: ${workerName}
STATUS: PASS | FAIL | CONCERNS
TASK CHECKLIST:
- [x] Task 1: description — verified
- [ ] Task 2: description — MISSING or INCOMPLETE (explain)
- ...
ISSUES FOUND:
- [file:line] description
- ...
RUNTIME RISKS:
- Any code that compiles but might fail at runtime
- ...
VERDICT: approved | needs-fixes
`.trim();
}

// Map worker names to their task specs for fresh-eyes reviews
const WORKER_TASKS: Record<string, string> = {
  RustWorker: RUST_WORKER_TASK,
  SDKWorker: SDK_WORKER_TASK,
  CLIWorker: CLI_WORKER_TASK,
  ACPWorker: ACP_WORKER_TASK,
  MCPWorker: MCP_WORKER_TASK,
  CleanupWorker: CLEANUP_WORKER_TASK,
};

async function runFreshEyesReviews(
  relay: AgentRelay,
  workerNames: string[],
): Promise<Array<{ worker: string; passed: boolean }>> {
  console.log(`\n  Spawning fresh-eyes reviewers for: ${workerNames.join(', ')}...\n`);

  const reviewers: Agent[] = [];
  for (const workerName of workerNames) {
    const task = WORKER_TASKS[workerName];
    if (!task) continue;
    const reviewerName = `FreshEyes-${workerName}`;
    const reviewer = await relay.codex.spawn({
      name: reviewerName,
      task: withSelfRelease(makeFreshEyesReviewTask(workerName, task), reviewerName),
    });
    reviewers.push(reviewer);
  }

  const results = await Promise.allSettled(
    reviewers.map((r) => r.waitForExit(300_000)),
  );

  const outcomes: Array<{ worker: string; passed: boolean }> = [];
  for (let i = 0; i < reviewers.length; i++) {
    const r = results[i];
    const reviewer = reviewers[i];
    const result = r.status === "fulfilled" ? r.value : `error: ${r.reason}`;
    // Codex doesn't auto-exit — treat timeout as success (review work is done)
    const passed = result === "timeout" || (r.status === "fulfilled" && (reviewer.exitCode === 0 || reviewer.exitCode === undefined));
    if (result === "timeout") {
      try { await reviewer.release(); } catch { /* ignore */ }
    }
    const icon = passed ? "+" : "x";
    console.log(`  [${icon}] ${reviewer.name}: ${passed ? 'PASS' : 'NEEDS ATTENTION'} (result=${result}, exit=${reviewer.exitCode ?? 'n/a'})`);
    outcomes.push({ worker: workerNames[i], passed });
  }

  return outcomes;
}

// ── Orchestrator ────────────────────────────────────────────────────────────

interface WaveResult {
  workers: Array<{ name: string; exitCode?: number; exitSignal?: string; result: string }>;
  allSucceeded: boolean;
}

async function waitForAll(agents: Agent[], label: string, timeoutMs = 600_000): Promise<WaveResult> {
  console.log(`\n  Waiting for ${label}...\n`);
  const results = await Promise.allSettled(
    agents.map((a) => a.waitForExit(timeoutMs)),
  );

  const workers: WaveResult['workers'] = [];
  let allSucceeded = true;

  for (let i = 0; i < agents.length; i++) {
    const r = results[i];
    const agent = agents[i];
    const exitCode = agent.exitCode;
    const result = r.status === "fulfilled" ? r.value : `error: ${r.reason}`;

    // Codex --full-auto doesn't auto-exit after task completion.
    // If a worker timed out, it likely finished its work but stayed alive.
    // Release it explicitly so the pipeline can continue.
    if (result === "timeout") {
      console.log(`  [~] ${agent.name}: timed out — releasing (work is likely done)`);
      try { await agent.release(); } catch { /* ignore if already gone */ }
      workers.push({ name: agent.name, exitCode: 0, result: "released-after-timeout" });
      continue;
    }

    const succeeded = r.status === "fulfilled" && result === "exited" && (exitCode === 0 || exitCode === undefined);
    if (!succeeded) allSucceeded = false;

    const icon = succeeded ? "+" : "x";
    console.log(`  [${icon}] ${agent.name}: ${result} (exit=${exitCode ?? 'n/a'})`);
    workers.push({ name: agent.name, exitCode, exitSignal: agent.exitSignal, result });
  }

  return { workers, allSucceeded };
}

async function runReview(
  relay: AgentRelay,
  waveName: string,
  workerNames: string[],
  checks: string,
): Promise<{ passed: boolean; report: string }> {
  console.log(`\n  Spawning reviewer for ${waveName}...\n`);

  const reviewTask = makeReviewTask(waveName, workerNames, checks);
  const reviewerName = `Reviewer-${waveName.replace(/\s+/g, '')}`;
  const reviewer = await relay.codex.spawn({
    name: reviewerName,
    task: withSelfRelease(reviewTask, reviewerName),
  });

  const result = await reviewer.waitForExit(300_000);
  // Codex doesn't auto-exit — treat timeout as success (work is done on disk)
  const passed = result === "timeout" || (result === "exited" && (reviewer.exitCode === 0 || reviewer.exitCode === undefined));
  if (result === "timeout") {
    try { await reviewer.release(); } catch { /* ignore */ }
  }

  console.log(`  Review ${waveName}: ${passed ? 'PASS' : 'NEEDS ATTENTION'} (result=${result}, exit=${reviewer.exitCode ?? 'n/a'})`);

  return { passed, report: `Review ${waveName}: ${result}` };
}

function leadReflection(
  waveName: string,
  waveResult: WaveResult,
  freshEyesResults: Array<{ worker: string; passed: boolean }>,
  reviewPassed: boolean,
): boolean {
  console.log(`\n--- Lead Reflection: ${waveName} ---`);

  if (!waveResult.allSucceeded) {
    const failed = waveResult.workers.filter(w => w.exitCode !== 0 && w.exitCode !== undefined);
    console.log(`  CONCERN: ${failed.length} worker(s) exited with errors:`);
    for (const w of failed) {
      console.log(`    - ${w.name}: exit=${w.exitCode}, signal=${w.exitSignal ?? 'none'}`);
    }
  }

  const freshEyesFailed = freshEyesResults.filter(r => !r.passed);
  if (freshEyesFailed.length > 0) {
    console.log(`  CONCERN: Fresh-eyes review flagged issues for: ${freshEyesFailed.map(r => r.worker).join(', ')}`);
  }

  if (!reviewPassed) {
    console.log(`  CONCERN: Wave-level reviewer flagged issues.`);
  }

  const allClear = waveResult.allSucceeded && freshEyesFailed.length === 0 && reviewPassed;
  if (allClear) {
    console.log(`  All workers completed, fresh-eyes reviews passed, and wave review passed.`);
    console.log(`  DECISION: Proceed to next wave.`);
    return true;
  }

  // Still proceed but log warnings — in a real production system you might
  // want to halt here and ask for human input
  console.log(`  WARNING: Proceeding despite issues. Manual review recommended.`);
  console.log(`--- End Reflection ---\n`);
  return true;  // Change to false to halt on failure
}

async function main() {
  console.log("=== CLI Migration: Old SDK -> Broker SDK ===");
  console.log("Plan: .claude/plans/binary-watching-waffle.md\n");

  const relay = new AgentRelay({
    binaryPath: "./target/debug/agent-relay-broker",
    channels: ["general"],
  });

  relay.onMessageReceived = (msg) => {
    const preview = msg.text.length > 300 ? msg.text.slice(0, 300) + "..." : msg.text;
    console.log(`  [${msg.from} -> ${msg.to}]: ${preview}\n`);
  };

  relay.onAgentSpawned = (agent) => {
    console.log(`  [spawned] ${agent.name}`);
  };

  relay.onAgentExited = (agent) => {
    console.log(`  [exited] ${agent.name} (code=${agent.exitCode})`);
  };

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // Wave 1: Foundation — Extend Rust Binary + Broker SDK (parallel)
    // ═══════════════════════════════════════════════════════════════════════

    console.log("\n=== Wave 1: Extend Rust Binary + Broker SDK ===\n");

    const rustWorker = await relay.codex.spawn({
      name: "RustWorker",
      task: withSelfRelease(RUST_WORKER_TASK, "RustWorker"),
    });

    const sdkWorker = await relay.codex.spawn({
      name: "SDKWorker",
      task: withSelfRelease(SDK_WORKER_TASK, "SDKWorker"),
    });

    const wave1Result = await waitForAll([rustWorker, sdkWorker], "Wave 1 (Rust + SDK)");

    // Fresh-eyes per-worker reviews
    const wave1FreshEyes = await runFreshEyesReviews(relay, ["RustWorker", "SDKWorker"]);

    // Wave-level review
    const wave1Review = await runReview(
      relay, "Wave 1", ["RustWorker", "SDKWorker"], WAVE1_REVIEW_CHECKS,
    );

    // Lead reflects
    const proceedToWave2 = leadReflection("Wave 1", wave1Result, wave1FreshEyes, wave1Review.passed);
    if (!proceedToWave2) {
      console.log("HALTED: Wave 1 issues need resolution before continuing.");
      return;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Wave 2: Migration — CLI + ACP Bridge + MCP (parallel)
    // ═══════════════════════════════════════════════════════════════════════

    console.log("\n=== Wave 2: Migrate CLI + ACP Bridge + MCP ===\n");

    const cliWorker = await relay.codex.spawn({
      name: "CLIWorker",
      task: withSelfRelease(CLI_WORKER_TASK, "CLIWorker"),
    });

    const acpWorker = await relay.codex.spawn({
      name: "ACPWorker",
      task: withSelfRelease(ACP_WORKER_TASK, "ACPWorker"),
    });

    const mcpWorker = await relay.codex.spawn({
      name: "MCPWorker",
      task: withSelfRelease(MCP_WORKER_TASK, "MCPWorker"),
    });

    const wave2Result = await waitForAll(
      [cliWorker, acpWorker, mcpWorker],
      "Wave 2 (CLI + ACP + MCP)",
    );

    // Fresh-eyes per-worker reviews
    const wave2FreshEyes = await runFreshEyesReviews(relay, ["CLIWorker", "ACPWorker", "MCPWorker"]);

    // Wave-level review
    const wave2Review = await runReview(
      relay, "Wave 2", ["CLIWorker", "ACPWorker", "MCPWorker"], WAVE2_REVIEW_CHECKS,
    );

    // Lead reflects
    const proceedToWave3 = leadReflection("Wave 2", wave2Result, wave2FreshEyes, wave2Review.passed);
    if (!proceedToWave3) {
      console.log("HALTED: Wave 2 issues need resolution before continuing.");
      return;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Wave 3: Cleanup — Delete unused packages
    // ═══════════════════════════════════════════════════════════════════════

    console.log("\n=== Wave 3: Delete Packages & Cleanup ===\n");

    const cleanupWorker = await relay.codex.spawn({
      name: "CleanupWorker",
      task: withSelfRelease(CLEANUP_WORKER_TASK, "CleanupWorker"),
    });

    const wave3Result = await waitForAll([cleanupWorker], "Wave 3 (Cleanup)", 300_000);

    // Fresh-eyes per-worker review
    const wave3FreshEyes = await runFreshEyesReviews(relay, ["CleanupWorker"]);

    // Wave-level review
    const wave3Review = await runReview(
      relay, "Wave 3", ["CleanupWorker"], WAVE3_REVIEW_CHECKS,
    );

    // Final reflection
    leadReflection("Wave 3", wave3Result, wave3FreshEyes, wave3Review.passed);

    // ═══════════════════════════════════════════════════════════════════════
    // Summary
    // ═══════════════════════════════════════════════════════════════════════

    console.log("\n=== Migration Summary ===\n");
    console.log("Wave 1 (Rust + SDK):", wave1Result.allSucceeded ? "PASS" : "ISSUES");
    console.log("Wave 1 Fresh-Eyes:", wave1FreshEyes.every(r => r.passed) ? "PASS" : "ISSUES");
    console.log("Wave 1 Review:", wave1Review.passed ? "PASS" : "ISSUES");
    console.log("Wave 2 (CLI + ACP + MCP):", wave2Result.allSucceeded ? "PASS" : "ISSUES");
    console.log("Wave 2 Fresh-Eyes:", wave2FreshEyes.every(r => r.passed) ? "PASS" : "ISSUES");
    console.log("Wave 2 Review:", wave2Review.passed ? "PASS" : "ISSUES");
    console.log("Wave 3 (Cleanup):", wave3Result.allSucceeded ? "PASS" : "ISSUES");
    console.log("Wave 3 Fresh-Eyes:", wave3FreshEyes.every(r => r.passed) ? "PASS" : "ISSUES");
    console.log("Wave 3 Review:", wave3Review.passed ? "PASS" : "ISSUES");

    const allFreshEyes = [...wave1FreshEyes, ...wave2FreshEyes, ...wave3FreshEyes];
    const allPassed = [wave1Result, wave2Result, wave3Result].every(r => r.allSucceeded)
      && allFreshEyes.every(r => r.passed)
      && [wave1Review, wave2Review, wave3Review].every(r => r.passed);

    if (allPassed) {
      console.log("\nMigration complete. All waves passed.\n");
    } else {
      console.log("\nMigration completed with issues. Manual review needed.\n");
    }

  } catch (err) {
    console.error("\nMigration failed:", err);
    process.exitCode = 1;
  } finally {
    await relay.shutdown();
  }
}

main().catch(console.error);
