/**
 * Agent Spawner
 * Handles spawning and releasing worker agents via relay-pty.
 * Workers run headlessly with output capture for logs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './utils.js';
import { getProjectPaths } from '../utils/project-namespace.js';
import { resolveCommand } from '../utils/command-resolver.js';
import { RelayPtyOrchestrator, type RelayPtyOrchestratorConfig } from '../wrapper/relay-pty-orchestrator.js';
import type { SummaryEvent, SessionEndEvent } from '../wrapper/wrapper-types.js';
import { selectShadowCli } from './shadow-cli.js';

// Get the directory where this module is located (for binary path resolution)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { AgentPolicyService, type CloudPolicyFetcher } from '../policy/agent-policy.js';
import { buildClaudeArgs, findAgentConfig } from '../utils/agent-config.js';
import { composeForAgent, type AgentRole } from '../wrapper/prompt-composer.js';
import { getUserDirectoryService } from '../daemon/user-directory.js';
import type {
  SpawnRequest,
  SpawnResult,
  WorkerInfo,
  SpawnWithShadowRequest,
  SpawnWithShadowResult,
  SpeakOnTrigger,
} from './types.js';

/**
 * CLI command mapping for providers
 * Maps provider names to actual CLI command names
 */
const CLI_COMMAND_MAP: Record<string, string> = {
  cursor: 'agent',  // Cursor CLI installs as 'agent'
  google: 'gemini', // Google provider uses 'gemini' CLI
  // Other providers use their name as the command (claude, codex, etc.)
};

/**
 * Cloud persistence handler interface.
 * Implement this to persist agent session data to cloud storage.
 */
export interface CloudPersistenceHandler {
  onSummary: (agentName: string, event: SummaryEvent) => Promise<void>;
  onSessionEnd: (agentName: string, event: SessionEndEvent) => Promise<void>;
  /** Optional cleanup method for tests and graceful shutdown */
  destroy?: () => void;
}

/** Worker metadata stored in workers.json */
interface WorkerMeta {
  name: string;
  cli: string;
  task: string;
  /** Optional team name this agent belongs to */
  team?: string;
  /** Optional user ID for per-user credential scoping */
  userId?: string;
  spawnedAt: number;
  pid?: number;
  logFile?: string;
}

/** Stored listener references for cleanup */
interface ListenerBindings {
  output?: (data: string) => void;
  summary?: (event: SummaryEvent) => void;
  sessionEnd?: (event: SessionEndEvent) => void;
}

/** Type alias for the wrapper - uses RelayPtyOrchestrator (relay-pty Rust binary) */
type AgentWrapper = RelayPtyOrchestrator;

interface ActiveWorker extends WorkerInfo {
  pty: AgentWrapper;
  logFile?: string;
  listeners?: ListenerBindings;
  userId?: string;
}

/** Callback for agent death notifications */
export type OnAgentDeathCallback = (info: {
  name: string;
  exitCode: number | null;
  agentId?: string;
  resumeInstructions?: string;
}) => void;

/**
 * Get relay protocol instructions for a spawned agent.
 * This provides the agent with the communication protocol it needs to work with the relay.
 */
function getRelayInstructions(agentName: string): string {
  return [
    '# Agent Relay Protocol',
    '',
    `You are agent "${agentName}" connected to Agent Relay for multi-agent coordination.`,
    '',
    '## Sending Messages',
    '',
    'Write a file to your outbox, then output the trigger:',
    '',
    '```bash',
    `cat > /tmp/relay-outbox/${agentName}/msg << 'EOF'`,
    'TO: TargetAgent',
    '',
    'Your message here.',
    'EOF',
    '```',
    '',
    'Then output: `->relay-file:msg`',
    '',
    '## Communication Rules',
    '',
    '1. **ACK immediately** - When you receive a task:',
    '```bash',
    `cat > /tmp/relay-outbox/${agentName}/ack << 'EOF'`,
    'TO: Sender',
    '',
    'ACK: Brief description of task received',
    'EOF',
    '```',
    'Then: `->relay-file:ack`',
    '',
    '2. **Report completion** - When done:',
    '```bash',
    `cat > /tmp/relay-outbox/${agentName}/done << 'EOF'`,
    'TO: Sender',
    '',
    'DONE: Brief summary of what was completed',
    'EOF',
    '```',
    'Then: `->relay-file:done`',
    '',
    '## Message Format',
    '',
    '```',
    'TO: Target',
    'THREAD: optional-thread',
    '',
    'Message body (everything after blank line)',
    '```',
    '',
    '| TO Value | Behavior |',
    '|----------|----------|',
    '| `AgentName` | Direct message |',
    '| `*` | Broadcast to all |',
    '| `#channel` | Channel message |',
  ].join('\n');
}

/**
 * Check if the relay-pty binary is available.
 * Returns the path to the binary if found, null otherwise.
 *
 * Search order:
 * 1. bin/relay-pty in package root (installed by postinstall)
 * 2. relay-pty/target/release/relay-pty (local Rust build)
 * 3. /usr/local/bin/relay-pty (global install)
 */
function findRelayPtyBinary(): string | null {
  // Get the package root (three levels up from dist/bridge/)
  const packageRoot = path.join(__dirname, '..', '..');

  const candidates = [
    // Primary: installed by postinstall from platform-specific binary
    path.join(packageRoot, 'bin', 'relay-pty'),
    // Development: local Rust build
    path.join(packageRoot, 'relay-pty', 'target', 'release', 'relay-pty'),
    path.join(packageRoot, 'relay-pty', 'target', 'debug', 'relay-pty'),
    // Local build in cwd (for development)
    path.join(process.cwd(), 'relay-pty', 'target', 'release', 'relay-pty'),
    // Installed globally
    '/usr/local/bin/relay-pty',
    // In node_modules (when installed as dependency)
    path.join(process.cwd(), 'node_modules', 'agent-relay', 'bin', 'relay-pty'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/** Cached result of relay-pty binary check */
let relayPtyBinaryPath: string | null | undefined;
let relayPtyBinaryChecked = false;

/**
 * Check if relay-pty binary is available (cached).
 * Returns true if the binary exists, false otherwise.
 */
function hasRelayPtyBinary(): boolean {
  if (!relayPtyBinaryChecked) {
    relayPtyBinaryPath = findRelayPtyBinary();
    relayPtyBinaryChecked = true;
    if (relayPtyBinaryPath) {
      console.log(`[spawner] relay-pty binary found: ${relayPtyBinaryPath}`);
    } else {
      console.log('[spawner] relay-pty binary not found, will use PtyWrapper fallback');
    }
  }
  return relayPtyBinaryPath !== null;
}

/** Options for AgentSpawner constructor */
export interface AgentSpawnerOptions {
  projectRoot: string;
  tmuxSession?: string;
  dashboardPort?: number;
  /**
   * Callback to mark an agent as spawning (before HELLO completes).
   * Messages sent to this agent will be queued for delivery after registration.
   */
  onMarkSpawning?: (agentName: string) => void;
  /**
   * Callback to clear the spawning flag for an agent.
   * Called when spawn fails or is cancelled.
   */
  onClearSpawning?: (agentName: string) => void;
}

export class AgentSpawner {
  private activeWorkers: Map<string, ActiveWorker> = new Map();
  private agentsPath: string;
  private projectRoot: string;
  private socketPath?: string;
  private logsDir: string;
  private workersPath: string;
  private dashboardPort?: number;
  private onAgentDeath?: OnAgentDeathCallback;
  private cloudPersistence?: CloudPersistenceHandler;
  private policyService?: AgentPolicyService;
  private policyEnforcementEnabled = false;
  private onMarkSpawning?: (agentName: string) => void;
  private onClearSpawning?: (agentName: string) => void;

  constructor(projectRoot: string, _tmuxSession?: string, dashboardPort?: number);
  constructor(options: AgentSpawnerOptions);
  constructor(projectRootOrOptions: string | AgentSpawnerOptions, _tmuxSession?: string, dashboardPort?: number) {
    // Handle both old and new constructor signatures
    const options: AgentSpawnerOptions = typeof projectRootOrOptions === 'string'
      ? { projectRoot: projectRootOrOptions, tmuxSession: _tmuxSession, dashboardPort }
      : projectRootOrOptions;

    const paths = getProjectPaths(options.projectRoot);
    this.projectRoot = paths.projectRoot;
    // Use connected-agents.json (live socket connections) instead of agents.json (historical registry)
    // This ensures spawned agents have actual daemon connections for channel message delivery
    this.agentsPath = path.join(paths.teamDir, 'connected-agents.json');
    this.socketPath = paths.socketPath;
    this.logsDir = path.join(paths.teamDir, 'worker-logs');
    this.workersPath = path.join(paths.teamDir, 'workers.json');
    this.dashboardPort = options.dashboardPort;

    // Store spawn tracking callbacks
    this.onMarkSpawning = options.onMarkSpawning;
    this.onClearSpawning = options.onClearSpawning;

    // Ensure logs directory exists
    fs.mkdirSync(this.logsDir, { recursive: true });

    // Initialize policy service if enforcement is enabled
    if (process.env.AGENT_POLICY_ENFORCEMENT === '1') {
      this.policyEnforcementEnabled = true;
      this.policyService = new AgentPolicyService({
        projectRoot: this.projectRoot,
        workspaceId: process.env.WORKSPACE_ID,
        strictMode: process.env.AGENT_POLICY_STRICT === '1',
      });
      console.log('[spawner] Policy enforcement enabled');
    }
  }

  /**
   * Set cloud policy fetcher for workspace-level policies
   */
  setCloudPolicyFetcher(fetcher: CloudPolicyFetcher): void {
    if (this.policyService) {
      // Recreate policy service with cloud fetcher
      this.policyService = new AgentPolicyService({
        projectRoot: this.projectRoot,
        workspaceId: process.env.WORKSPACE_ID,
        cloudFetcher: fetcher,
        strictMode: process.env.AGENT_POLICY_STRICT === '1',
      });
    }
  }

  /**
   * Get the policy service (for external access to policy checks)
   */
  getPolicyService(): AgentPolicyService | undefined {
    return this.policyService;
  }

  private async fetchGhTokenFromCloud(): Promise<string | null> {
    const cloudApiUrl = process.env.CLOUD_API_URL || process.env.AGENT_RELAY_CLOUD_URL;
    const workspaceId = process.env.WORKSPACE_ID;
    const workspaceToken = process.env.WORKSPACE_TOKEN;

    if (!cloudApiUrl || !workspaceId || !workspaceToken) {
      return null;
    }

    const normalizedUrl = cloudApiUrl.replace(/\/$/, '');
    const url = `${normalizedUrl}/api/git/token?workspaceId=${encodeURIComponent(workspaceId)}`;

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${workspaceToken}`,
        },
      });

      if (!response.ok) {
        console.warn(`[spawner] Failed to fetch GH token from cloud: ${response.status} ${response.statusText}`);
        return null;
      }

      const data = await response.json() as { userToken?: string | null; token?: string | null };
      return data.userToken || data.token || null;
    } catch (err) {
      console.warn('[spawner] Failed to fetch GH token from cloud', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async resolveGhToken(): Promise<string | null> {
    const cloudToken = await this.fetchGhTokenFromCloud();
    if (cloudToken) {
      return cloudToken;
    }

    return process.env.GH_TOKEN || null;
  }

  /**
   * Set the dashboard port (for nested spawn API calls).
   * Called after the dashboard server starts and we know the actual port.
   */
  setDashboardPort(port: number): void {
    console.log(`[spawner] Dashboard port set to ${port} - nested spawns now enabled`);
    this.dashboardPort = port;
  }

  /**
   * Set callback for agent death notifications.
   * Called when an agent exits unexpectedly (non-zero exit code).
   */
  setOnAgentDeath(callback: OnAgentDeathCallback): void {
    this.onAgentDeath = callback;
  }

  /**
   * Set cloud persistence handler for forwarding RelayPtyOrchestrator events.
   * When set, 'summary' and 'session-end' events from spawned agents
   * are forwarded to the handler for cloud persistence (PostgreSQL/Redis).
   *
   * Note: Enable via RELAY_CLOUD_ENABLED=true environment variable.
   */
  setCloudPersistence(handler: CloudPersistenceHandler): void {
    this.cloudPersistence = handler;
    console.log('[spawner] Cloud persistence handler set');
  }

  /**
   * Bind cloud persistence event handlers to a RelayPtyOrchestrator.
   * Returns the listener references for cleanup.
   */
  private bindCloudPersistenceEvents(name: string, pty: AgentWrapper): Partial<ListenerBindings> {
    if (!this.cloudPersistence) return {};

    const summaryListener = async (event: SummaryEvent) => {
      try {
        await this.cloudPersistence!.onSummary(name, event);
      } catch (err) {
        console.error(`[spawner] Cloud persistence summary error for ${name}:`, err);
      }
    };

    const sessionEndListener = async (event: SessionEndEvent) => {
      try {
        await this.cloudPersistence!.onSessionEnd(name, event);
      } catch (err) {
        console.error(`[spawner] Cloud persistence session-end error for ${name}:`, err);
      }
    };

    pty.on('summary', summaryListener);
    pty.on('session-end', sessionEndListener);

    return { summary: summaryListener, sessionEnd: sessionEndListener };
  }

  /**
   * Unbind all tracked listeners from a RelayPtyOrchestrator.
   */
  private unbindListeners(pty: AgentWrapper, listeners?: ListenerBindings): void {
    if (!listeners) return;

    if (listeners.output) {
      pty.off('output', listeners.output);
    }
    if (listeners.summary) {
      pty.off('summary', listeners.summary);
    }
    if (listeners.sessionEnd) {
      pty.off('session-end', listeners.sessionEnd);
    }
  }

  /**
   * Spawn a new worker agent using relay-pty
   */
  async spawn(request: SpawnRequest): Promise<SpawnResult> {
    const { name, cli, task, team, spawnerName, userId } = request;
    const debug = process.env.DEBUG_SPAWN === '1';

    // Check if worker already exists
    if (this.activeWorkers.has(name)) {
      return {
        success: false,
        name,
        error: `Worker ${name} already exists`,
      };
    }

    // Enforce agent limit based on plan (MAX_AGENTS is set by provisioner based on plan)
    const maxAgents = parseInt(process.env.MAX_AGENTS || '10', 10);
    const currentAgentCount = this.activeWorkers.size;
    if (currentAgentCount >= maxAgents) {
      console.warn(`[spawner] Agent limit reached: ${currentAgentCount}/${maxAgents}`);
      return {
        success: false,
        name,
        error: `Agent limit reached (${currentAgentCount}/${maxAgents}). Upgrade your plan for more agents.`,
      };
    }

    // Policy enforcement: check if the spawner is authorized to spawn this agent
    if (this.policyEnforcementEnabled && this.policyService && spawnerName) {
      const decision = await this.policyService.canSpawn(spawnerName, name, cli);
      if (!decision.allowed) {
        console.warn(`[spawner] Policy blocked spawn: ${spawnerName} -> ${name}: ${decision.reason}`);
        return {
          success: false,
          name,
          error: `Policy denied: ${decision.reason}`,
          policyDecision: decision,
        };
      }
      if (debug) {
        console.log(`[spawner:debug] Policy allowed spawn: ${spawnerName} -> ${name} (source: ${decision.policySource})`);
      }
    }

    try {
      // Parse CLI command and apply mapping (e.g., cursor -> agent)
      const cliParts = cli.split(' ');
      const rawCommandName = cliParts[0];
      const commandName = CLI_COMMAND_MAP[rawCommandName] || rawCommandName;
      const args = cliParts.slice(1);

      if (commandName !== rawCommandName) {
        console.log(`[spawner] Mapped CLI '${rawCommandName}' -> '${commandName}'`);
      }

      // Resolve full path to avoid posix_spawnp failures
      const command = resolveCommand(commandName);
      console.log(`[spawner] Resolved '${commandName}' -> '${command}'`);
      if (command === commandName && !commandName.startsWith('/')) {
        // Command wasn't resolved - it might not exist
        console.warn(`[spawner] Warning: Could not resolve path for '${commandName}', spawn may fail`);
      }

      // Add --dangerously-skip-permissions for Claude agents
      const isClaudeCli = commandName.startsWith('claude');
      if (isClaudeCli && !args.includes('--dangerously-skip-permissions')) {
        args.push('--dangerously-skip-permissions');
      }

      // Add --force for Cursor agents (CLI is 'agent', may be passed as 'cursor')
      const isCursorCli = commandName === 'agent' || rawCommandName === 'cursor';
      if (isCursorCli && !args.includes('--force')) {
        args.push('--force');
      }

      // Apply agent config (model, --agent flag) from .claude/agents/ if available
      // This ensures spawned agents respect their profile settings
      if (isClaudeCli) {
        // Get agent config for model tracking
        const agentConfig = findAgentConfig(name, this.projectRoot);
        const model = agentConfig?.model || 'sonnet'; // Default to sonnet

        const configuredArgs = buildClaudeArgs(name, args, this.projectRoot);
        // Replace args with configured version (includes --model and --agent if found)
        args.length = 0;
        args.push(...configuredArgs);

        // Cost tracking: log which model is being used
        console.log(`[spawner] Agent ${name}: model=${model}, cli=${cli}`);
        if (debug) console.log(`[spawner:debug] Applied agent config for ${name}: ${args.join(' ')}`);
      }

      // Add --dangerously-bypass-approvals-and-sandbox for Codex agents
      const isCodexCli = commandName.startsWith('codex');
      if (isCodexCli && !args.includes('--dangerously-bypass-approvals-and-sandbox')) {
        args.push('--dangerously-bypass-approvals-and-sandbox');
      }

      // Add --yolo for Gemini agents (auto-accept all prompts)
      const isGeminiCli = commandName === 'gemini';
      if (isGeminiCli && !args.includes('--yolo')) {
        args.push('--yolo');
      }

      // Inject relay protocol instructions via CLI-specific system prompt
      let relayInstructions = getRelayInstructions(name);

      // Compose role-specific prompts if agent has a role defined in .claude/agents/
      const agentConfigForRole = isClaudeCli ? findAgentConfig(name, this.projectRoot) : null;
      if (agentConfigForRole?.role) {
        const validRoles: AgentRole[] = ['planner', 'worker', 'reviewer', 'lead', 'shadow'];
        const role = agentConfigForRole.role.toLowerCase() as AgentRole;
        if (validRoles.includes(role)) {
          try {
            const composed = await composeForAgent(
              { name, role },
              this.projectRoot,
              { taskDescription: task }
            );
            if (composed.content) {
              relayInstructions = `${composed.content}\n\n---\n\n${relayInstructions}`;
              if (debug) console.log(`[spawner:debug] Composed role prompt for ${name} (role: ${role})`);
            }
          } catch (err: any) {
            console.warn(`[spawner] Failed to compose role prompt for ${name}: ${err.message}`);
          }
        }
      }

      if (isClaudeCli && !args.includes('--append-system-prompt')) {
        args.push('--append-system-prompt', relayInstructions);
      } else if (isCodexCli && !args.some(a => a.includes('developer_instructions'))) {
        args.push('--config', `developer_instructions=${relayInstructions}`);
      }

      // Codex requires an initial prompt in TTY mode (unlike Claude which waits for input)
      // Pass the task as the initial prompt, or a generic "ready" message if no task
      if (isCodexCli) {
        const initialPrompt = task || 'You are ready. Wait for messages from the relay system.';
        args.push(initialPrompt);
      }

      if (debug) console.log(`[spawner:debug] Spawning ${name} with: ${command} ${args.join(' ')}`);

      // Create PtyWrapper config
      // Use dashboardPort for nested spawns (API-based, works in non-TTY contexts)
      // Fall back to callbacks only if no dashboardPort is not set
      // Note: Spawned agents CAN spawn sub-workers intentionally - the parser is strict enough
      // to avoid accidental spawns from documentation text (requires line start, PascalCase, known CLI)
      // Use request.cwd if specified, otherwise use projectRoot
      const agentCwd = request.cwd || this.projectRoot;

      // Log whether nested spawning will be enabled for this agent
      console.log(`[spawner] Spawning ${name}: dashboardPort=${this.dashboardPort || 'none'} (${this.dashboardPort ? 'nested spawns enabled' : 'nested spawns disabled'})`);

      let userEnv: Record<string, string> | undefined;
      if (userId) {
        try {
          const userDirService = getUserDirectoryService();
          userEnv = userDirService.getUserEnvironment(userId);
        } catch (err) {
          console.warn('[spawner] Failed to resolve user environment, using default', {
            userId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const mergedUserEnv = { ...(userEnv ?? {}) };
      if (!mergedUserEnv.GH_TOKEN) {
        const ghToken = await this.resolveGhToken();
        if (ghToken) {
          mergedUserEnv.GH_TOKEN = ghToken;
        }
      }
      if (Object.keys(mergedUserEnv).length > 0) {
        userEnv = mergedUserEnv;
      }

      if (debug) console.log(`[spawner:debug] Socket path for ${name}: ${this.socketPath ?? 'undefined'}`);

      // Require relay-pty binary
      if (!hasRelayPtyBinary()) {
        const error = 'relay-pty binary not found. Install with: npm run build:relay-pty';
        console.error(`[spawner] ${error}`);
        return {
          success: false,
          name,
          error,
        };
      }

      // Common exit handler for both wrapper types
      const onExitHandler = (code: number) => {
        if (debug) console.log(`[spawner:debug] Worker ${name} exited with code ${code}`);

        // Get the agentId and clean up listeners before removing from active workers
        const worker = this.activeWorkers.get(name);
        const agentId = worker?.pty?.getAgentId?.();
        if (worker?.listeners) {
          this.unbindListeners(worker.pty, worker.listeners);
        }

        this.activeWorkers.delete(name);
        try {
          this.saveWorkersMetadata();
        } catch (err) {
          console.error(`[spawner] Failed to save metadata on exit:`, err);
        }

        // Notify if agent died unexpectedly (non-zero exit)
        if (code !== 0 && code !== null && this.onAgentDeath) {
          this.onAgentDeath({
            name,
            exitCode: code,
            agentId,
            resumeInstructions: agentId
              ? `To resume this agent's work, use: --resume ${agentId}`
              : undefined,
          });
        }
      };

      // Common spawn/release handlers
      const onSpawnHandler = this.dashboardPort ? undefined : async (workerName: string, workerCli: string, workerTask: string) => {
        if (debug) console.log(`[spawner:debug] Nested spawn: ${workerName}`);
        await this.spawn({
          name: workerName,
          cli: workerCli,
          task: workerTask,
          userId,
        });
      };

      const onReleaseHandler = this.dashboardPort ? undefined : async (workerName: string) => {
        if (debug) console.log(`[spawner:debug] Release request: ${workerName}`);
        await this.release(workerName);
      };

      // Create RelayPtyOrchestrator (relay-pty Rust binary)
      const ptyConfig: RelayPtyOrchestratorConfig = {
        name,
        command,
        args,
        socketPath: this.socketPath,
        cwd: agentCwd,
        dashboardPort: this.dashboardPort,
        env: userEnv,
        streamLogs: true,
        shadowOf: request.shadowOf,
        shadowSpeakOn: request.shadowSpeakOn,
        skipContinuity: true,
        onSpawn: onSpawnHandler,
        onRelease: onReleaseHandler,
        onExit: onExitHandler,
      };
      const pty = new RelayPtyOrchestrator(ptyConfig);
      if (debug) console.log(`[spawner:debug] Using RelayPtyOrchestrator for ${name}`);

      // Track listener references for proper cleanup
      const listeners: ListenerBindings = {};

      // Hook up output events for live log streaming
      const outputListener = (data: string) => {
        // Broadcast to any connected WebSocket clients via global function
        const broadcast = (global as any).__broadcastLogOutput;
        if (broadcast) {
          broadcast(name, data);
        }
      };
      pty.on('output', outputListener);
      listeners.output = outputListener;

      // Bind cloud persistence events (if enabled) and store references
      const cloudListeners = this.bindCloudPersistenceEvents(name, pty);
      if (cloudListeners.summary) listeners.summary = cloudListeners.summary;
      if (cloudListeners.sessionEnd) listeners.sessionEnd = cloudListeners.sessionEnd;

      // Mark agent as spawning BEFORE starting PTY
      // This allows messages sent to this agent to be queued until HELLO completes
      if (this.onMarkSpawning) {
        this.onMarkSpawning(name);
        if (debug) console.log(`[spawner:debug] Marked ${name} as spawning`);
      }

      await pty.start();

      if (debug) console.log(`[spawner:debug] PTY started, pid: ${pty.pid}`);

      // Wait for the agent to register with the daemon
      const registered = await this.waitForAgentRegistration(name, 30_000, 500);
      if (!registered) {
        const error = `Worker ${name} failed to register within 30s`;
        console.error(`[spawner] ${error}`);
        // Clear spawning flag since spawn failed
        if (this.onClearSpawning) {
          this.onClearSpawning(name);
        }
        await pty.kill();
        return {
          success: false,
          name,
          error,
        };
      }

      // Send task to the newly spawned agent if provided
      // We do this AFTER registration AND after the CLI is ready to receive input
      if (task && task.trim() && this.dashboardPort) {
        try {
          // Wait for the CLI to be ready (has produced output AND is idle)
          // This is more reliable than a random sleep because it waits for actual signals
          if ('waitUntilCliReady' in pty) {
            const orchestrator = pty as RelayPtyOrchestrator;
            const ready = await orchestrator.waitUntilCliReady(15000, 100);
            if (!ready) {
              console.warn(`[spawner] CLI for ${name} did not become ready within timeout, sending task anyway`);
            } else if (debug) {
              console.log(`[spawner:debug] CLI for ${name} is ready to receive messages`);
            }
          } else {
            // PtyWrapper fallback - use short delay as it doesn't have waitUntilCliReady
            await sleep(500);
          }

          const sendResponse = await fetch(
            `http://localhost:${this.dashboardPort}/api/send`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                to: name,
                message: task,
                from: spawnerName, // Include spawner name so message appears from correct agent
              }),
            }
          );

          if (sendResponse.ok) {
            if (debug) console.log(`[spawner:debug] Task sent to ${name}`);
          } else {
            console.error(`[spawner] Failed to send task to ${name}: ${sendResponse.status}`);
          }
        } catch (err: any) {
          console.error(`[spawner] Error sending task to ${name}:`, err.message);
        }
      }

      // Track the worker
      const workerInfo: ActiveWorker = {
        name,
        cli,
        task,
        team,
        userId,
        spawnedAt: Date.now(),
        pid: pty.pid,
        pty,
        logFile: pty.logPath,
        listeners, // Store for cleanup
      };
      this.activeWorkers.set(name, workerInfo);
      this.saveWorkersMetadata();

      const teamInfo = team ? ` [team: ${team}]` : '';
      const shadowInfo = request.shadowOf ? ` [shadow of: ${request.shadowOf}]` : '';
      console.log(`[spawner] Spawned ${name} (${cli})${teamInfo}${shadowInfo} [pid: ${pty.pid}]`);

      return {
        success: true,
        name,
        pid: pty.pid,
      };
    } catch (err: any) {
      console.error(`[spawner] Failed to spawn ${name}:`, err.message);
      if (debug) console.error(`[spawner:debug] Full error:`, err);
      // Clear spawning flag since spawn failed
      if (this.onClearSpawning) {
        this.onClearSpawning(name);
      }
      return {
        success: false,
        name,
        error: err.message,
      };
    }
  }

  /** Role presets for shadow agents */
  private static readonly ROLE_PRESETS: Record<string, SpeakOnTrigger[]> = {
    reviewer: ['CODE_WRITTEN', 'REVIEW_REQUEST', 'EXPLICIT_ASK'],
    auditor: ['SESSION_END', 'EXPLICIT_ASK'],
    active: ['ALL_MESSAGES'],
  };

  /**
   * Spawn a primary agent with its shadow agent
   *
   * Example usage:
   * ```ts
   * const result = await spawner.spawnWithShadow({
   *   primary: { name: 'Lead', command: 'claude', task: 'Implement feature X' },
   *   shadow: { name: 'Auditor', role: 'reviewer', speakOn: ['CODE_WRITTEN'] }
   * });
   * ```
   */
  async spawnWithShadow(request: SpawnWithShadowRequest): Promise<SpawnWithShadowResult> {
    const { primary, shadow } = request;
    const debug = process.env.DEBUG_SPAWN === '1';

    // Resolve shadow speakOn triggers
    let speakOn: SpeakOnTrigger[] = ['EXPLICIT_ASK']; // Default

    // Check for role preset
    if (shadow.role && AgentSpawner.ROLE_PRESETS[shadow.role.toLowerCase()]) {
      speakOn = AgentSpawner.ROLE_PRESETS[shadow.role.toLowerCase()];
    }

    // Override with explicit speakOn if provided
    if (shadow.speakOn && shadow.speakOn.length > 0) {
      speakOn = shadow.speakOn;
    }

    // Build shadow task prompt
    const defaultPrompt = `You are a shadow agent monitoring "${primary.name}". You receive copies of their messages. Your role: ${shadow.role || 'observer'}. Stay passive unless your triggers activate: ${speakOn.join(', ')}.`;
    const shadowTask = shadow.prompt || defaultPrompt;

    // Decide how to run the shadow (subagent for Claude/OpenCode primaries, process fallback otherwise)
    let shadowSelection: Awaited<ReturnType<typeof selectShadowCli>> | null = null;
    try {
      shadowSelection = await selectShadowCli(primary.command || 'claude', {
        preferredShadowCli: shadow.command,
      });
    } catch (err: any) {
      console.warn(`[spawner] Shadow CLI selection failed for ${shadow.name}: ${err.message}`);
    }

    if (debug) {
      const mode = shadowSelection?.mode ?? 'unknown';
      const cli = shadowSelection?.command ?? shadow.command ?? primary.command ?? 'claude';
      console.log(
        `[spawner] spawnWithShadow: primary=${primary.name}, shadow=${shadow.name}, mode=${mode}, cli=${cli}, speakOn=${speakOn.join(',')}`
      );
    }

    // Step 1: Spawn primary agent
    const primaryResult = await this.spawn({
      name: primary.name,
      cli: primary.command || 'claude',
      task: primary.task || '',
      team: primary.team,
    });

    if (!primaryResult.success) {
      return {
        success: false,
        primary: primaryResult,
        error: `Failed to spawn primary agent: ${primaryResult.error}`,
      };
    }

    // Step 2: Wait for primary to register before spawning shadow
    // The spawn() method already waits, but we add a small delay for stability
    await sleep(1000);

    // Subagent mode: no separate process needed
    if (shadowSelection?.mode === 'subagent') {
      console.log(
        `[spawner] Shadow ${shadow.name} will run as ${shadowSelection.cli} subagent inside ${primary.name} (no separate process)`
      );
      return {
        success: true,
        primary: primaryResult,
        shadow: {
          success: true,
          name: shadow.name,
        },
      };
    }

    // No available shadow CLI - proceed without spawning a shadow process
    if (!shadowSelection) {
      console.warn(`[spawner] No authenticated shadow CLI available; ${primary.name} will run without a shadow`);
      return {
        success: true,
        primary: primaryResult,
        error: 'Shadow spawn skipped: no authenticated shadow CLI available',
      };
    }

    // Step 3: Spawn shadow agent with shadowOf and shadowSpeakOn
    const shadowResult = await this.spawn({
      name: shadow.name,
      // Use the selected/validated CLI for process-mode shadows
      cli: shadowSelection.command || shadow.command || primary.command || 'claude',
      task: shadowTask,
      shadowOf: primary.name,
      shadowSpeakOn: speakOn,
    });

    if (!shadowResult.success) {
      console.warn(`[spawner] Shadow agent ${shadow.name} failed to spawn, primary ${primary.name} continues without shadow`);
      return {
        success: true, // Primary succeeded, overall operation is partial success
        primary: primaryResult,
        shadow: shadowResult,
        error: `Shadow spawn failed: ${shadowResult.error}`,
      };
    }

    console.log(`[spawner] Spawned pair: ${primary.name} with shadow ${shadow.name} (speakOn: ${speakOn.join(',')})`);

    return {
      success: true,
      primary: primaryResult,
      shadow: shadowResult,
    };
  }

  /**
   * Release (terminate) a worker
   */
  async release(name: string): Promise<boolean> {
    const worker = this.activeWorkers.get(name);
    if (!worker) {
      console.log(`[spawner] Worker ${name} not found`);
      return false;
    }

    try {
      // Unbind all listeners first to prevent memory leaks
      this.unbindListeners(worker.pty, worker.listeners);

      // Stop the pty process gracefully (handles auto-save internally)
      await worker.pty.stop();

      // Force kill if still running
      if (worker.pty.isRunning) {
        await worker.pty.kill();
      }

      this.activeWorkers.delete(name);
      this.saveWorkersMetadata();
      console.log(`[spawner] Released ${name}`);

      return true;
    } catch (err: any) {
      console.error(`[spawner] Failed to release ${name}:`, err.message);
      // Still unbind and remove from tracking
      this.unbindListeners(worker.pty, worker.listeners);
      this.activeWorkers.delete(name);
      this.saveWorkersMetadata();
      return false;
    }
  }

  /**
   * Release all workers
   */
  async releaseAll(): Promise<void> {
    const workers = Array.from(this.activeWorkers.keys());
    for (const name of workers) {
      await this.release(name);
    }
  }

  /**
   * Get all active workers (returns WorkerInfo without pty reference)
   */
  getActiveWorkers(): WorkerInfo[] {
    return Array.from(this.activeWorkers.values()).map((w) => ({
      name: w.name,
      cli: w.cli,
      task: w.task,
      team: w.team,
      spawnedAt: w.spawnedAt,
      pid: w.pid,
    }));
  }

  /**
   * Check if a worker exists
   */
  hasWorker(name: string): boolean {
    return this.activeWorkers.has(name);
  }

  /**
   * Get worker info
   */
  getWorker(name: string): WorkerInfo | undefined {
    const worker = this.activeWorkers.get(name);
    if (!worker) return undefined;
    return {
      name: worker.name,
      cli: worker.cli,
      task: worker.task,
      team: worker.team,
      spawnedAt: worker.spawnedAt,
      pid: worker.pid,
    };
  }

  /**
   * Get output logs from a worker
   */
  getWorkerOutput(name: string, limit?: number): string[] | null {
    const worker = this.activeWorkers.get(name);
    if (!worker) return null;
    return worker.pty.getOutput(limit);
  }

  /**
   * Get raw output from a worker
   */
  getWorkerRawOutput(name: string): string | null {
    const worker = this.activeWorkers.get(name);
    if (!worker) return null;
    return worker.pty.getRawOutput();
  }

  /**
   * Send input to a worker's PTY (for interactive terminal support)
   * @param name - Worker name
   * @param data - Input data to send (keystrokes, text, etc.)
   * @returns true if input was sent, false if worker not found
   */
  sendWorkerInput(name: string, data: string): boolean {
    const worker = this.activeWorkers.get(name);
    if (!worker) return false;
    worker.pty.write(data);
    return true;
  }

  /**
   * Wait for an agent to appear in the registry (agents.json)
   */
  private async waitForAgentRegistration(
    name: string,
    timeoutMs = 30_000,
    pollIntervalMs = 500
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (this.isAgentRegistered(name)) {
        return true;
      }

      await sleep(pollIntervalMs);
    }

    return false;
  }

  private isAgentRegistered(name: string): boolean {
    if (!this.agentsPath) return false;
    if (!fs.existsSync(this.agentsPath)) return false;

    try {
      const raw = JSON.parse(fs.readFileSync(this.agentsPath, 'utf-8'));
      // connected-agents.json format: { agents: string[], users: string[], updatedAt: number }
      // agents is a string array of connected agent names (not objects)
      const agents: string[] = Array.isArray(raw?.agents) ? raw.agents : [];

      // Case-insensitive check to match router behavior
      const lowerName = name.toLowerCase();
      return agents.some((a) => typeof a === 'string' && a.toLowerCase() === lowerName);
    } catch (err: any) {
      console.error('[spawner] Failed to read connected-agents.json:', err.message);
      return false;
    }
  }

  /**
   * Save workers metadata to disk for CLI access
   */
  private saveWorkersMetadata(): void {
    try {
      const workers: WorkerMeta[] = Array.from(this.activeWorkers.values()).map((w) => ({
        name: w.name,
        cli: w.cli,
        task: w.task,
        team: w.team,
        userId: w.userId,
        spawnedAt: w.spawnedAt,
        pid: w.pid,
        logFile: w.logFile,
      }));

      fs.writeFileSync(this.workersPath, JSON.stringify({ workers }, null, 2));
    } catch (err: any) {
      console.error('[spawner] Failed to save workers metadata:', err.message);
    }
  }

  /**
   * Get path to logs directory
   */
  getLogsDir(): string {
    return this.logsDir;
  }

  /**
   * Get path to workers metadata file
   */
  getWorkersPath(): string {
    return this.workersPath;
  }
}

/**
 * Read workers metadata from disk (for CLI use)
 */
export function readWorkersMetadata(projectRoot: string): WorkerMeta[] {
  const paths = getProjectPaths(projectRoot);
  const workersPath = path.join(paths.teamDir, 'workers.json');

  if (!fs.existsSync(workersPath)) {
    return [];
  }

  try {
    const raw = JSON.parse(fs.readFileSync(workersPath, 'utf-8'));
    return Array.isArray(raw?.workers) ? raw.workers : [];
  } catch {
    return [];
  }
}

/**
 * Get the worker logs directory path
 */
export function getWorkerLogsDir(projectRoot: string): string {
  const paths = getProjectPaths(projectRoot);
  return path.join(paths.teamDir, 'worker-logs');
}
