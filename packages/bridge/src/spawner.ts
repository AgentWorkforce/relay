/**
 * Agent Spawner
 * Handles spawning and releasing worker agents via relay-pty.
 * Workers run headlessly with output capture for logs.
 */

import fs from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './utils.js';
import { getProjectPaths, getAgentOutboxTemplate } from '@agent-relay/config';
import { resolveCommand } from '@agent-relay/utils/command-resolver';
import { createTraceableError } from '@agent-relay/utils/error-tracking';
import { createLogger } from '@agent-relay/utils/logger';
import { mapModelToCli } from '@agent-relay/utils/model-mapping';
import { findRelayPtyBinary as findRelayPtyBinaryUtil } from '@agent-relay/utils/relay-pty-path';
import { RelayPtyOrchestrator, type RelayPtyOrchestratorConfig } from '@agent-relay/wrapper';
import type { SummaryEvent, SessionEndEvent } from '@agent-relay/wrapper';
import { selectShadowCli } from './shadow-cli.js';

// Get the directory where this module is located (for binary path resolution)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { AgentPolicyService, type CloudPolicyFetcher } from '@agent-relay/policy';
import { buildClaudeArgs, findAgentConfig } from '@agent-relay/config/agent-config';
import { composeForAgent, type AgentRole } from '@agent-relay/wrapper';
import { getUserDirectoryService } from '@agent-relay/user-directory';
import { installMcpConfig } from '@agent-relay/mcp';
import type {
  SpawnRequest,
  SpawnResult,
  WorkerInfo,
  SpawnWithShadowRequest,
  SpawnWithShadowResult,
  SpeakOnTrigger,
} from './types.js';

// Logger instance for spawner (uses daemon log system instead of console)
const log = createLogger('spawner');

/**
 * CLI command mapping for providers
 * Maps provider names to actual CLI command names
 */
const CLI_COMMAND_MAP: Record<string, string> = {
  cursor: 'agent',  // Cursor CLI installs as 'agent'
  google: 'gemini', // Google provider uses 'gemini' CLI
  // Other providers use their name as the command (claude, codex, etc.)
};

function extractGhTokenFromHosts(content: string): string | null {
  const lines = content.split(/\r?\n/);
  let inGithubSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      const host = trimmed.replace(/:$/, '');
      inGithubSection = host === 'github.com';
      continue;
    }
    if (!inGithubSection) {
      continue;
    }
    const match = line.match(/^\s*(oauth_token|token):\s*(.+)$/);
    if (!match) {
      continue;
    }
    let token = match[2].split('#')[0].trim();
    token = token.replace(/^['"]|['"]$/g, '');
    if (token) {
      return token;
    }
  }
  return null;
}

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
  /** Traceable error ID for support lookup */
  errorId?: string;
}) => void;

/**
 * Ensure MCP permissions are pre-configured for the given CLI type.
 * This prevents MCP approval prompts from blocking agent initialization.
 *
 * For Claude Code: Creates/updates .claude/settings.local.json with:
 * - enableAllProjectMcpServers: true (auto-approve project MCP servers)
 * - permissions.allow: ["mcp__agent-relay__*"] (pre-approve all agent-relay MCP tools)
 *
 * For Cursor: Creates/updates .cursor/settings.json with MCP permissions
 * For Gemini: Creates/updates .gemini/settings.json with MCP permissions
 * For Windsurf: Creates/updates .windsurf/settings.json with MCP permissions
 * Other CLIs: May use CLI flags instead of config-based permissions
 *
 * @param projectRoot - The project root directory
 * @param cliType - The CLI type (claude, codex, gemini, cursor, etc.)
 * @param debug - Whether to log debug information
 */
export function ensureMcpPermissions(projectRoot: string, cliType: string, debug = false): void {
  // Determine settings path based on CLI type
  interface McpPermissionConfig {
    settingsDir: string;
    settingsFile: string;
    permissionKey?: string; // If different from 'permissions.allow'
    enableAllKey?: string; // If supports enableAllProjectMcpServers
    globalSettingsDir?: string; // For global settings that enable project MCP
  }

  const home = process.env.HOME || '';
  const configMap: Record<string, McpPermissionConfig> = {
    claude: {
      // Use global settings for Claude
      // enableAllProjectMcpServers enables project-local .mcp.json files
      settingsDir: path.join(home, '.claude'),
      settingsFile: 'settings.local.json',
      permissionKey: 'permissions.allow',
      enableAllKey: 'enableAllProjectMcpServers',
    },
    cursor: {
      settingsDir: path.join(projectRoot, '.cursor'),
      settingsFile: 'settings.json',
      permissionKey: 'permissions.allow',
    },
    gemini: {
      settingsDir: path.join(projectRoot, '.gemini'),
      settingsFile: 'settings.json',
      permissionKey: 'permissions.allow',
    },
    windsurf: {
      settingsDir: path.join(projectRoot, '.windsurf'),
      settingsFile: 'settings.json',
      permissionKey: 'permissions.allow',
    },
    // Codex uses TOML config and --dangerously-bypass-approvals-and-sandbox flag
    // OpenCode and Droid may not need config-based permissions
  };

  // Normalize CLI type
  const normalizedCli = cliType.toLowerCase().replace(/^(claude|codex|gemini|cursor|agent|windsurf).*/, '$1');

  // Map 'agent' (Cursor CLI) to 'cursor'
  const effectiveCli = normalizedCli === 'agent' ? 'cursor' : normalizedCli;

  const config = configMap[effectiveCli];
  if (!config) {
    // CLI doesn't use config-based MCP permissions (uses CLI flags instead)
    if (debug) log.debug(`CLI ${cliType} uses flag-based permissions, skipping config setup`);
    return;
  }

  const settingsPath = path.join(config.settingsDir, config.settingsFile);

  try {
    // Ensure settings directory exists
    if (!fs.existsSync(config.settingsDir)) {
      fs.mkdirSync(config.settingsDir, { recursive: true });
    }

    // Read existing settings or start fresh
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
      try {
        const content = fs.readFileSync(settingsPath, 'utf-8');
        settings = JSON.parse(content);
      } catch {
        // Invalid JSON, start fresh
        settings = {};
      }
    }

    // Set enableAllProjectMcpServers if supported (Claude-specific)
    if (config.enableAllKey && settings[config.enableAllKey] !== true) {
      settings[config.enableAllKey] = true;
      if (debug) log.debug(`Setting ${config.enableAllKey}: true`);
    }

    // Ensure permissions.allow includes agent-relay MCP
    if (config.permissionKey) {
      // Parse nested key (e.g., 'permissions.allow')
      const keyParts = config.permissionKey.split('.');
      let current: Record<string, unknown> = settings;

      // Navigate/create nested structure
      for (let i = 0; i < keyParts.length - 1; i++) {
        const key = keyParts[i];
        if (!current[key] || typeof current[key] !== 'object') {
          current[key] = {};
        }
        current = current[key] as Record<string, unknown>;
      }

      // Ensure allow list exists
      const finalKey = keyParts[keyParts.length - 1];
      if (!Array.isArray(current[finalKey])) {
        current[finalKey] = [];
      }
      const allowList = current[finalKey] as string[];

      // Add agent-relay MCP permission if not already present
      // Format: mcp__<serverName>__* approves all tools from that server
      const agentRelayPermission = 'mcp__agent-relay__*';
      if (!allowList.includes(agentRelayPermission)) {
        allowList.push(agentRelayPermission);
        if (debug) log.debug(`Added MCP permission: ${agentRelayPermission}`);
      }
    }

    // Write updated settings
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    if (debug) log.debug(`MCP permissions configured at ${settingsPath}`);
  } catch (err) {
    // Log but don't fail - this is a best-effort optimization
    log.warn('Failed to pre-configure MCP permissions', {
      cli: cliType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Get MCP tools reference for spawned agents.
 * Only included when MCP is configured for the project.
 */
function getMcpToolsReference(): string {
  return [
    '## MCP Tools Available',
    '',
    'You have access to MCP tools for agent communication (recommended over file protocol):',
    '- `relay_send(to, message)` - Send message to agent/channel',
    '- `relay_spawn(name, cli, task)` - Create worker agent',
    '- `relay_inbox()` - Check your messages',
    '- `relay_who()` - List online agents',
    '- `relay_release(name)` - Stop a worker agent',
    '- `relay_status()` - Check connection status',
    '',
  ].join('\n');
}

/**
 * Get relay protocol instructions for a spawned agent.
 * This provides the agent with the communication protocol it needs to work with the relay.
 *
 * Uses the legacy outbox path (/tmp/relay-outbox/) which is symlinked to workspace paths.
 * This keeps agent instructions simple while supporting workspace isolation.
 *
 * @param agentName - Name of the agent
 * @param options - Configuration options
 * @param options.hasMcp - Whether MCP tools are available (based on .mcp.json existence)
 * @param options.includeWorkflowConventions - Include ACK/DONE workflow conventions (default: false)
 */
function getRelayInstructions(agentName: string, options: { hasMcp?: boolean; includeWorkflowConventions?: boolean } = {}): string {
  const { hasMcp = false, includeWorkflowConventions = false } = options;
  // Get the outbox path template and replace variable with actual agent name
  const outboxBase = getAgentOutboxTemplate(agentName);

  const parts: string[] = [
    '# Agent Relay Protocol',
    '',
    `You are agent "${agentName}" connected to Agent Relay for multi-agent coordination.`,
    '',
  ];

  // Add MCP tools reference if available
  if (hasMcp) {
    parts.push(getMcpToolsReference());
  }

  parts.push(
    '## Sending Messages',
    '',
    'Write a file to your outbox, then output the trigger:',
    '',
    '```bash',
    `cat > ${outboxBase}/msg << 'EOF'`,
    'TO: TargetAgent',
    '',
    'Your message here.',
    'EOF',
    '```',
    '',
    'Then output: `->relay-file:msg`',
  );

  // Only include ACK/DONE workflow conventions if explicitly requested
  if (includeWorkflowConventions) {
    parts.push(
      '',
      '## Communication Rules',
      '',
      '1. **ACK immediately** - When you receive a task:',
      '```bash',
      `cat > ${outboxBase}/ack << 'EOF'`,
      'TO: Sender',
      '',
      'ACK: Brief description of task received',
      'EOF',
      '```',
      'Then: `->relay-file:ack`',
      '',
      '2. **Report completion** - When done:',
      '```bash',
      `cat > ${outboxBase}/done << 'EOF'`,
      'TO: Sender',
      '',
      'DONE: Brief summary of what was completed',
      'EOF',
      '```',
      'Then: `->relay-file:done`',
    );
  }

  parts.push(
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
  );

  return parts.join('\n');
}

/**
 * Check if the relay-pty binary is available.
 * Returns the path to the binary if found, null otherwise.
 * Uses shared utility from @agent-relay/utils.
 */
function findRelayPtyBinary(): string | null {
  return findRelayPtyBinaryUtil(__dirname);
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
    if (process.env.DEBUG_SPAWN === '1') {
      if (relayPtyBinaryPath) {
        log.debug(`relay-pty binary found: ${relayPtyBinaryPath}`);
      } else {
        log.debug('relay-pty binary not found, will use PtyWrapper fallback');
      }
    }
  }
  return relayPtyBinaryPath !== null;
}

/** Options for AgentSpawner constructor */
export interface AgentSpawnerOptions {
  projectRoot: string;
  /** Explicit socket path for daemon connection (if not provided, derived from projectRoot) */
  socketPath?: string;
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
  private static readonly ONLINE_THRESHOLD_MS = 30_000;
  private activeWorkers: Map<string, ActiveWorker> = new Map();
  private agentsPath: string;
  private registryPath: string;
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
    this.registryPath = path.join(paths.teamDir, 'agents.json');
    // Use explicit socketPath if provided (ensures spawned agents connect to same daemon)
    // Otherwise derive from project paths
    this.socketPath = options.socketPath ?? paths.socketPath;
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
      log.info('Policy enforcement enabled');
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
      // Use AbortController for timeout (5 seconds - don't block spawning)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${workspaceToken}`,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        log.warn(`Failed to fetch GH token from cloud: ${response.status} ${response.statusText}`);
        return null;
      }

      const data = await response.json() as { userToken?: string | null; token?: string | null };
      return data.userToken || data.token || null;
    } catch (err) {
      // Don't log timeout errors loudly - this is expected when cloud is unreachable
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('abort')) {
        log.info('Cloud API timeout (5s) - using local auth');
      } else {
        log.warn('Failed to fetch GH token from cloud', { error: message });
      }
      return null;
    }
  }

  private resolveGhTokenFromHostsFile(homeDir?: string): string | null {
    const resolvedHome = homeDir || process.env.HOME;
    const configHome = process.env.XDG_CONFIG_HOME || (resolvedHome ? path.join(resolvedHome, '.config') : undefined);
    const candidates = new Set<string>();
    if (configHome) {
      candidates.add(path.join(configHome, 'gh', 'hosts.yml'));
    }
    if (resolvedHome) {
      candidates.add(path.join(resolvedHome, '.config', 'gh', 'hosts.yml'));
    }

    for (const hostPath of candidates) {
      if (!hostPath || !fs.existsSync(hostPath)) {
        continue;
      }
      try {
        const content = fs.readFileSync(hostPath, 'utf8');
        const token = extractGhTokenFromHosts(content);
        if (token) {
          return token;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  private async resolveGhTokenFromGhCli(): Promise<string | null> {
    // Check common gh CLI installation paths across platforms
    const ghPathCandidates = [
      '/usr/bin/gh',                    // Linux package managers
      '/usr/local/bin/gh',              // Homebrew (Intel Mac), manual install
      '/opt/homebrew/bin/gh',           // Homebrew (Apple Silicon Mac)
      '/home/linuxbrew/.linuxbrew/bin/gh', // Linuxbrew
    ];

    const ghPath = ghPathCandidates.find((p) => fs.existsSync(p));
    if (!ghPath) {
      return null;
    }

    return await new Promise((resolve) => {
      execFile(ghPath, ['auth', 'token', '--hostname', 'github.com'], { timeout: 5000 }, (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const token = stdout.trim();
        resolve(token || null);
      });
    });
  }

  /**
   * Resolve GitHub token using multiple fallback sources.
   *
   * Fallback order (same as git-credential-relay for consistency):
   * 1. Environment - GH_TOKEN or GITHUB_TOKEN (fastest, set by entrypoint)
   * 2. hosts.yml - gh CLI config file (~/.config/gh/hosts.yml)
   * 3. gh CLI - execute `gh auth token` command
   * 4. Cloud API - workspace-scoped token from Nango (requires network)
   *
   * Environment is checked first because:
   * - It's the fastest (no I/O or network)
   * - The entrypoint pre-fetches and caches GH_TOKEN at startup
   * - This avoids delays when cloud API is slow/unreachable
   */
  private async resolveGhToken(homeDir?: string): Promise<string | null> {
    // 1. Check environment variables first (fastest - set by entrypoint at startup)
    const envToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (envToken) {
      return envToken;
    }

    // 2. Parse gh CLI hosts.yml config file
    const hostsToken = this.resolveGhTokenFromHostsFile(homeDir);
    if (hostsToken) {
      return hostsToken;
    }

    // 3. Execute gh CLI if available
    const cliToken = await this.resolveGhTokenFromGhCli();
    if (cliToken) {
      return cliToken;
    }

    // 4. Try cloud API as last resort (may be slow or unreachable)
    return await this.fetchGhTokenFromCloud();
  }

  /**
   * Set the dashboard port (for nested spawn API calls).
   * Called after the dashboard server starts and we know the actual port.
   */
  setDashboardPort(port: number): void {
    log.info(`Dashboard port set to ${port} - nested spawns now enabled`);
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
    log.info('Cloud persistence handler set');
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
        log.error(`Cloud persistence summary error for ${name}`, { error: err instanceof Error ? err.message : String(err) });
      }
    };

    const sessionEndListener = async (event: SessionEndEvent) => {
      try {
        await this.cloudPersistence!.onSessionEnd(name, event);
      } catch (err) {
        log.error(`Cloud persistence session-end error for ${name}`, { error: err instanceof Error ? err.message : String(err) });
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
    const { name, cli, task, team, spawnerName, userId, includeWorkflowConventions } = request;
    const debug = process.env.DEBUG_SPAWN === '1';

    // Validate agent name to prevent path traversal attacks
    if (name.includes('..') || name.includes('/') || name.includes('\\')) {
      return {
        success: false,
        name,
        error: `Invalid agent name: "${name}" contains path traversal characters`,
      };
    }

    // Check if worker already exists in this spawner
    if (this.activeWorkers.has(name)) {
      return {
        success: false,
        name,
        error: `Agent "${name}" is already running. Use a different name or release the existing agent first.`,
      };
    }

    // Check if agent is already connected to daemon (prevents duplicate connection storms)
    if (this.isAgentConnected(name)) {
      return {
        success: false,
        name,
        error: `Agent "${name}" is already connected to the daemon. Use a different name or wait for the existing agent to disconnect.`,
      };
    }

    // Enforce agent limit based on plan (MAX_AGENTS is set by provisioner based on plan)
    const maxAgents = parseInt(process.env.MAX_AGENTS || '10', 10);
    const currentAgentCount = this.activeWorkers.size;
    if (currentAgentCount >= maxAgents) {
      log.warn(`Agent limit reached: ${currentAgentCount}/${maxAgents}`);
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
        log.warn(`Policy blocked spawn: ${spawnerName} -> ${name}: ${decision.reason}`);
        return {
          success: false,
          name,
          error: `Policy denied: ${decision.reason}`,
          policyDecision: decision,
        };
      }
      if (debug) {
        log.debug(`Policy allowed spawn: ${spawnerName} -> ${name} (source: ${decision.policySource})`);
      }
    }

    try {
      // Parse CLI command and apply mapping (e.g., cursor -> agent)
      const cliParts = cli.split(' ');
      const rawCommandName = cliParts[0];
      const commandName = CLI_COMMAND_MAP[rawCommandName] || rawCommandName;
      const args = cliParts.slice(1);

      if (commandName !== rawCommandName && debug) {
        log.debug(`Mapped CLI '${rawCommandName}' -> '${commandName}'`);
      }

      // Resolve full path to avoid posix_spawnp failures
      const command = resolveCommand(commandName);
      if (debug) log.debug(`Resolved '${commandName}' -> '${command}'`);
      if (command === commandName && !commandName.startsWith('/')) {
        // Command wasn't resolved - it might not exist
        log.warn(`Could not resolve path for '${commandName}', spawn may fail`);
      }

      // Pre-configure MCP permissions for all supported CLIs
      // This creates/updates CLI-specific settings files with agent-relay permissions
      ensureMcpPermissions(this.projectRoot, commandName, debug);

      // Add --dangerously-skip-permissions for Claude agents
      const isClaudeCli = commandName.startsWith('claude');
      if (isClaudeCli) {
        if (!args.includes('--dangerously-skip-permissions')) {
          args.push('--dangerously-skip-permissions');
        }
      }

      // Add --force for Cursor agents (CLI is 'agent', may be passed as 'cursor')
      const isCursorCli = commandName === 'agent' || rawCommandName === 'cursor';
      if (isCursorCli && !args.includes('--force')) {
        args.push('--force');
      }

      // Apply agent config (model, --agent flag) from .claude/agents/ if available
      // This ensures spawned agents respect their profile settings
      if (isClaudeCli) {
        // Get agent config for model tracking and CLI variant selection
        const agentConfig = findAgentConfig(name, this.projectRoot);
        const modelFromProfile = agentConfig?.model?.trim();

        // Map model to CLI variant (e.g., 'opus' -> 'claude:opus')
        // This allows agent profiles to specify model preferences
        const cliVariant = modelFromProfile
          ? mapModelToCli(modelFromProfile)
          : mapModelToCli(); // defaults to claude:sonnet

        // Extract effective model name for logging
        const effectiveModel = modelFromProfile || 'opus';

        const configuredArgs = buildClaudeArgs(name, args, this.projectRoot);
        // Replace args with configured version (includes --model and --agent if found)
        args.length = 0;
        args.push(...configuredArgs);

        // Cost tracking: log which model is being used
        log.info(`Agent ${name}: model=${effectiveModel}, cli=${cli}, variant=${cliVariant}`);
        if (debug) log.debug(`Applied agent config for ${name}: ${args.join(' ')}`);
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

      // Auto-install MCP config if not present (project-local)
      // Uses .mcp.json in the project root - doesn't modify global settings
      // Feature gated: set RELAY_MCP_AUTO_INSTALL=1 to enable
      const projectMcpConfigPath = path.join(this.projectRoot, '.mcp.json');
      const mcpSocketPath = path.join(this.projectRoot, '.agent-relay', 'relay.sock');
      const hasMcpConfig = fs.existsSync(projectMcpConfigPath);
      const mcpAutoInstallEnabled = process.env.RELAY_MCP_AUTO_INSTALL === '1';

      if (!hasMcpConfig && mcpAutoInstallEnabled) {
        try {
          const result = installMcpConfig(projectMcpConfigPath, {
            configKey: 'mcpServers',
            // Set RELAY_SOCKET so MCP server finds daemon regardless of CWD
            env: { RELAY_SOCKET: mcpSocketPath },
          });
          if (result.success) {
            if (debug) log.debug(`Auto-installed MCP config at ${projectMcpConfigPath}`);
          } else {
            log.warn(`Failed to auto-install MCP config: ${result.error}`);
          }
        } catch (err) {
          log.warn('Failed to auto-install MCP config', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Check if MCP tools are available
      // Must verify BOTH conditions (matching inbox hook behavior from commit 18bab59):
      // 1. MCP config exists (user or project scope)
      // 2. Relay daemon socket is accessible (daemon must be running)
      // Without both, MCP context would be shown but tools wouldn't work
      // Use the actual socket path from config (project-local .agent-relay/relay.sock)
      // or fall back to environment variable
      const relaySocket = this.socketPath || process.env.RELAY_SOCKET || path.join(this.projectRoot, '.agent-relay', 'relay.sock');
      let hasMcp = false;
      // Check either user-scope or project-scope MCP config
      // hasMcpConfig was already computed above
      if (hasMcpConfig) {
        try {
          hasMcp = fs.statSync(relaySocket).isSocket();
        } catch {
          // Socket doesn't exist or isn't accessible - daemon not running
          hasMcp = false;
        }
      }
      if (debug && hasMcp) log.debug(`MCP tools available for ${name} (MCP config found, socket ${relaySocket})`);

      // Inject relay protocol instructions via CLI-specific system prompt
      let relayInstructions = getRelayInstructions(name, { hasMcp, includeWorkflowConventions });

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
              if (debug) log.debug(`Composed role prompt for ${name} (role: ${role})`);
            }
          } catch (err: any) {
            log.warn(`Failed to compose role prompt for ${name}: ${err.message}`);
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

      if (debug) log.debug(`Spawning ${name} with: ${command} ${args.join(' ')}`);

      // Create PtyWrapper config
      // Use dashboardPort for nested spawns (API-based, works in non-TTY contexts)
      // Fall back to callbacks only if no dashboardPort is not set
      // Note: Spawned agents CAN spawn sub-workers intentionally - the parser is strict enough
      // to avoid accidental spawns from documentation text (requires line start, PascalCase, known CLI)
      // Use request.cwd if specified, otherwise use projectRoot
      // Validate cwd to prevent path traversal attacks
      let agentCwd: string;
      if (request.cwd && typeof request.cwd === 'string') {
        // Resolve cwd relative to project root and ensure it stays within that root
        const resolvedCwd = path.resolve(this.projectRoot, request.cwd);
        const normalizedProjectRoot = path.resolve(this.projectRoot);
        const projectRootWithSep = normalizedProjectRoot.endsWith(path.sep)
          ? normalizedProjectRoot
          : normalizedProjectRoot + path.sep;
        
        // Ensure the resolved cwd is within the project root to prevent traversal
        if (resolvedCwd !== normalizedProjectRoot && !resolvedCwd.startsWith(projectRootWithSep)) {
          return {
            success: false,
            name,
            error: `Invalid cwd: "${request.cwd}" must be within the project root`,
          };
        }
        agentCwd = resolvedCwd;
      } else {
        agentCwd = this.projectRoot;
      }

      // Log whether nested spawning will be enabled for this agent
      log.info(`Spawning ${name}: dashboardPort=${this.dashboardPort || 'none'} (${this.dashboardPort ? 'nested spawns enabled' : 'nested spawns disabled'})`);

      let userEnv: Record<string, string> | undefined;
      if (userId) {
        try {
          const userDirService = getUserDirectoryService();
          userEnv = userDirService.getUserEnvironment(userId);
        } catch (err) {
          log.warn('Failed to resolve user environment, using default', {
            userId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const mergedUserEnv = { ...(userEnv ?? {}) };
      if (!mergedUserEnv.GH_TOKEN) {
        const ghToken = await this.resolveGhToken(userEnv?.HOME);
        if (ghToken) {
          mergedUserEnv.GH_TOKEN = ghToken;
        }
      }
      if (Object.keys(mergedUserEnv).length > 0) {
        userEnv = mergedUserEnv;
      }

      if (debug) log.debug(`Socket path for ${name}: ${this.socketPath ?? 'undefined'}`);

      // Require relay-pty binary
      if (!hasRelayPtyBinary()) {
        const tracedError = createTraceableError('relay-pty binary not found', {
          agentName: name,
          cli,
          hint: 'Install with: npm run build:relay-pty',
        });
        log.error(tracedError.logMessage);
        return {
          success: false,
          name,
          error: tracedError.userMessage,
          errorId: tracedError.errorId,
        };
      }

      // Common exit handler for both wrapper types
      const onExitHandler = (code: number) => {
        if (debug) log.debug(`Worker ${name} exited with code ${code}`);

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
          log.error('Failed to save metadata on exit', { error: err instanceof Error ? err.message : String(err) });
        }

        // Notify if agent died unexpectedly (non-zero exit)
        if (code !== 0 && code !== null && this.onAgentDeath) {
          const crashError = createTraceableError('Agent crashed unexpectedly', {
            agentName: name,
            exitCode: code,
            cli,
            agentId,
          });
          log.error(crashError.logMessage);
          this.onAgentDeath({
            name,
            exitCode: code,
            agentId,
            errorId: crashError.errorId,
            resumeInstructions: agentId
              ? `To resume this agent's work, use: --resume ${agentId}`
              : undefined,
          });
        }
      };

      // Common spawn/release handlers
      const onSpawnHandler = this.dashboardPort ? undefined : async (workerName: string, workerCli: string, workerTask: string) => {
        if (debug) log.debug(`Nested spawn: ${workerName}`);
        await this.spawn({
          name: workerName,
          cli: workerCli,
          task: workerTask,
          userId,
        });
      };

      const onReleaseHandler = this.dashboardPort ? undefined : async (workerName: string) => {
        if (debug) log.debug(`Release request: ${workerName}`);
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
        env: {
          ...userEnv,
          ...(spawnerName ? { AGENT_RELAY_SPAWNER: spawnerName } : {}),
          // Pass socket path for MCP server discovery
          // This allows the MCP server (started by Claude Code) to connect to the daemon
          ...(relaySocket ? { RELAY_SOCKET: relaySocket } : {}),
          // Pass agent name so MCP server knows its identity
          RELAY_AGENT_NAME: name,
        },
        streamLogs: true,
        shadowOf: request.shadowOf,
        shadowSpeakOn: request.shadowSpeakOn,
        skipContinuity: true,
        onSpawn: onSpawnHandler,
        onRelease: onReleaseHandler,
        onExit: onExitHandler,
        headless: true, // Force headless mode for spawned agents to enable task injection via stdin
        // In cloud environments (WORKSPACE_ID set), limit CPU per agent to prevent
        // one agent (e.g., running npm install) from starving others
        // Default: 100% of one core per agent. Set AGENT_CPU_LIMIT to override.
        cpuLimitPercent: process.env.WORKSPACE_ID
          ? parseInt(process.env.AGENT_CPU_LIMIT || '100', 10)
          : undefined,
      };
      const pty = new RelayPtyOrchestrator(ptyConfig);
      if (debug) log.debug(`Using RelayPtyOrchestrator for ${name}`);

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
        if (debug) log.debug(`Marked ${name} as spawning`);
      }

      await pty.start();

      if (debug) log.debug(`PTY started, pid: ${pty.pid}`);

      // Wait for the agent to register with the daemon
      const registered = await this.waitForAgentRegistration(name, 30_000, 500);
      if (!registered) {
        const tracedError = createTraceableError('Agent registration timeout', {
          agentName: name,
          cli,
          pid: pty.pid,
          timeoutMs: 30_000,
        });
        log.error(tracedError.logMessage);
        // Clear spawning flag since spawn failed
        if (this.onClearSpawning) {
          this.onClearSpawning(name);
        }
        await pty.kill();
        return {
          success: false,
          name,
          error: tracedError.userMessage,
          errorId: tracedError.errorId,
        };
      }

      // Send task to the newly spawned agent if provided
      // We do this AFTER registration AND after the orchestrator is FULLY ready for messages
      // This includes: CLI started, CLI idle, socket connected, readyForMessages flag set
      if (task && task.trim()) {
        const maxRetries = 3;
        const retryDelayMs = 2000;
        let taskSent = false;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            // Wait for full orchestrator readiness (CLI + socket + internal flags)
            if ('waitUntilReadyForMessages' in pty) {
              const orchestrator = pty as RelayPtyOrchestrator;
              const ready = await orchestrator.waitUntilReadyForMessages(20000, 100);
              if (!ready) {
                // Log retry attempts at DEBUG level to avoid terminal noise
                log.debug(`Attempt ${attempt}/${maxRetries}: ${name} not ready for messages within timeout`);
                if (attempt < maxRetries) {
                  await sleep(retryDelayMs);
                  continue;
                }
                log.error(`${name} failed to become ready after ${maxRetries} attempts - task may be lost`);
                break;
              }
            } else if ('waitUntilCliReady' in pty) {
              // Fallback for older wrapper types
              await (pty as RelayPtyOrchestrator).waitUntilCliReady(15000, 100);
            }

            // Inject task via socket (with verification and retries)
            const success = await pty.injectTask(task, spawnerName || 'spawner');
            if (success) {
              taskSent = true;
              if (debug) log.debug(`Task injected to ${name} (attempt ${attempt})`);
              break;
            } else {
              throw new Error('Task injection returned false');
            }
          } catch (err: any) {
            // Log retry attempts at DEBUG level to avoid terminal noise
            // Only the final summary (if all attempts fail) is logged at ERROR level
            log.debug(`Attempt ${attempt}/${maxRetries}: Error injecting task for ${name}: ${err.message}`);
            if (attempt < maxRetries) {
              await sleep(retryDelayMs);
            }
          }
        }

        if (!taskSent) {
          const tracedError = createTraceableError('Task injection failed', {
            agentName: name,
            cli,
            attempts: maxRetries,
            taskLength: task.length,
          });
          log.error(`CRITICAL: ${tracedError.logMessage}`);
          // Note: We don't return an error here because the agent is running,
          // but we track the errorId so support can investigate if user reports it
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
      log.info(`Spawned ${name} (${cli})${teamInfo}${shadowInfo} [pid: ${pty.pid}]`);

      return {
        success: true,
        name,
        pid: pty.pid,
      };
    } catch (err: any) {
      const tracedError = createTraceableError('Agent spawn failed', {
        agentName: name,
        cli,
        task: task?.substring(0, 100),
      }, err instanceof Error ? err : undefined);
      log.error(tracedError.logMessage);
      if (debug) log.debug('Full error', { error: err?.stack || String(err) });
      // Clear spawning flag since spawn failed
      if (this.onClearSpawning) {
        this.onClearSpawning(name);
      }
      return {
        success: false,
        name,
        error: tracedError.userMessage,
        errorId: tracedError.errorId,
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
      log.warn(`Shadow CLI selection failed for ${shadow.name}: ${err.message}`);
    }

    if (debug) {
      const mode = shadowSelection?.mode ?? 'unknown';
      const cli = shadowSelection?.command ?? shadow.command ?? primary.command ?? 'claude';
      log.debug(
        `spawnWithShadow: primary=${primary.name}, shadow=${shadow.name}, mode=${mode}, cli=${cli}, speakOn=${speakOn.join(',')}`
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
      log.info(
        `Shadow ${shadow.name} will run as ${shadowSelection.cli} subagent inside ${primary.name} (no separate process)`
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
      log.warn(`No authenticated shadow CLI available; ${primary.name} will run without a shadow`);
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
      log.warn(`Shadow agent ${shadow.name} failed to spawn, primary ${primary.name} continues without shadow`);
      return {
        success: true, // Primary succeeded, overall operation is partial success
        primary: primaryResult,
        shadow: shadowResult,
        error: `Shadow spawn failed: ${shadowResult.error}`,
      };
    }

    log.info(`Spawned pair: ${primary.name} with shadow ${shadow.name} (speakOn: ${speakOn.join(',')})`);

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
      log.debug(`Worker ${name} not found`);
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
      log.info(`Released ${name}`);

      return true;
    } catch (err: any) {
      log.error(`Failed to release ${name}: ${err.message}`);
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
   * Wait for an agent to appear in the connected list and registry (connected-agents.json + agents.json).
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
    return this.isAgentConnected(name) && this.isAgentRecentlySeen(name);
  }

  private isAgentConnected(name: string): boolean {
    if (!this.agentsPath) return false;
    if (!fs.existsSync(this.agentsPath)) return false;

    try {
      const raw = JSON.parse(fs.readFileSync(this.agentsPath, 'utf-8'));
      // connected-agents.json format: { agents: string[], users: string[], updatedAt: number }
      // agents is a string array of connected agent names (not objects)
      const agents: string[] = Array.isArray(raw?.agents) ? raw.agents : [];
      const updatedAt = typeof raw?.updatedAt === 'number' ? raw.updatedAt : 0;
      const isFresh = Date.now() - updatedAt <= AgentSpawner.ONLINE_THRESHOLD_MS;

      if (!isFresh) return false;

      // Case-insensitive check to match router behavior
      const lowerName = name.toLowerCase();
      return agents.some((a) => typeof a === 'string' && a.toLowerCase() === lowerName);
    } catch (err: any) {
      log.error('Failed to read connected-agents.json', { error: err.message });
      return false;
    }
  }

  private isAgentRecentlySeen(name: string): boolean {
    if (!this.registryPath) return false;
    if (!fs.existsSync(this.registryPath)) return false;

    try {
      const raw = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
      const agents = Array.isArray(raw?.agents)
        ? raw.agents
        : typeof raw?.agents === 'object' && raw?.agents !== null
          ? Object.values(raw.agents)
          : [];
      const lowerName = name.toLowerCase();
      const agent = agents.find((entry: { name?: string; lastSeen?: string }) => typeof entry?.name === 'string' && entry.name.toLowerCase() === lowerName);
      if (!agent?.lastSeen) return false;
      return Date.now() - new Date(agent.lastSeen).getTime() <= AgentSpawner.ONLINE_THRESHOLD_MS;
    } catch (err: any) {
      log.error('Failed to read agents.json', { error: err.message });
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
      log.error('Failed to save workers metadata', { error: err.message });
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
