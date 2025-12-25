#!/usr/bin/env node
/**
 * Agent Relay CLI
 *
 * Commands:
 *   relay <cmd>         - Wrap agent with real-time messaging (default)
 *   relay -n Name cmd   - Wrap with specific agent name
 *   relay up            - Start daemon + dashboard
 *   relay read <id>     - Read full message by ID
 *   relay agents        - List connected agents
 *   relay who           - Show currently active agents
 */

import { Command } from 'commander';
import { config as dotenvConfig } from 'dotenv';
import { Daemon } from '../daemon/server.js';
import { RelayClient } from '../wrapper/client.js';
import { generateAgentName } from '../utils/name-generator.js';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

dotenvConfig();

const DEFAULT_DASHBOARD_PORT = process.env.AGENT_RELAY_DASHBOARD_PORT || '3888';

// Read version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJsonPath = path.resolve(__dirname, '../../package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
const VERSION = packageJson.version;
const execAsync = promisify(exec);

const program = new Command();

function pidFilePathForSocket(socketPath: string): string {
  return `${socketPath}.pid`;
}

program
  .name('agent-relay')
  .description('Agent-to-agent messaging')
  .version(VERSION, '-V, --version', 'Output the version number');

// Default action = wrap agent
program
  .option('-n, --name <name>', 'Agent name (auto-generated if not set)')
  .option('-q, --quiet', 'Disable debug output', false)
  .option('--prefix <pattern>', 'Relay prefix pattern (default: ->relay:)')
  .argument('[command...]', 'Command to wrap (e.g., claude)')
  .action(async (commandParts, options) => {
    // If no command provided, show help
    if (!commandParts || commandParts.length === 0) {
      program.help();
      return;
    }

    const { getProjectPaths } = await import('../utils/project-namespace.js');
    const { findAgentConfig, isClaudeCli, buildClaudeArgs } = await import('../utils/agent-config.js');
    const paths = getProjectPaths();

    const [mainCommand, ...commandArgs] = commandParts;
    const agentName = options.name ?? generateAgentName();

    console.error(`Agent: ${agentName}`);
    console.error(`Project: ${paths.projectId}`);

    // Auto-detect agent config and inject --model/--agent for Claude CLI
    let finalArgs = commandArgs;
    if (isClaudeCli(mainCommand)) {
      const config = findAgentConfig(agentName, paths.projectRoot);
      if (config) {
        console.error(`Agent config: ${config.configPath}`);
        if (config.model) {
          console.error(`Model: ${config.model}`);
        }
        finalArgs = buildClaudeArgs(agentName, commandArgs, paths.projectRoot);
      }
    }

    const { TmuxWrapper } = await import('../wrapper/tmux-wrapper.js');

    const wrapper = new TmuxWrapper({
      name: agentName,
      command: mainCommand,
      args: finalArgs,
      socketPath: paths.socketPath,
      debug: false,  // Use -q to keep quiet (debug off by default)
      relayPrefix: options.prefix,
      useInbox: true,
      inboxDir: paths.dataDir, // Use the project-specific data directory for the inbox
    });

    process.on('SIGINT', () => {
      wrapper.stop();
      process.exit(0);
    });

    await wrapper.start();
  });

// Team config types
interface TeamAgent {
  name: string;
  cli: string;
  role?: string;
}

interface TeamConfig {
  team?: string;
  agents: TeamAgent[];
  autoSpawn?: boolean;
}

// Load teams.json from project root or .agent-relay/
function loadTeamConfig(projectRoot: string): TeamConfig | null {
  const locations = [
    path.join(projectRoot, 'teams.json'),
    path.join(projectRoot, '.agent-relay', 'teams.json'),
  ];

  for (const configPath of locations) {
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf-8');
        return JSON.parse(content) as TeamConfig;
      } catch (err) {
        console.error(`Failed to parse ${configPath}:`, err);
      }
    }
  }
  return null;
}

// Spawn agents from team config using tmux
async function spawnTeamAgents(
  agents: TeamAgent[],
  socketPath: string,
  dataDir: string,
  projectRoot: string,
  relayPrefix?: string
): Promise<void> {
  const { TmuxWrapper } = await import('../wrapper/tmux-wrapper.js');
  const { findAgentConfig, isClaudeCli, buildClaudeArgs } = await import('../utils/agent-config.js');

  for (const agent of agents) {
    console.log(`Spawning agent: ${agent.name} (${agent.cli})`);

    // Parse CLI - handle "claude:opus" format
    const [mainCommand, ...cliArgs] = agent.cli.split(/\s+/);

    // Auto-detect agent config and inject --model/--agent for Claude CLI
    let finalArgs = cliArgs;
    if (isClaudeCli(mainCommand)) {
      const config = findAgentConfig(agent.name, projectRoot);
      if (config) {
        console.log(`  Agent config: ${config.configPath}`);
        if (config.model) {
          console.log(`  Model: ${config.model}`);
        }
        finalArgs = buildClaudeArgs(agent.name, cliArgs, projectRoot);
      }
    }

    const wrapper = new TmuxWrapper({
      name: agent.name,
      command: mainCommand,
      args: finalArgs,
      socketPath,
      debug: false,
      relayPrefix,
      useInbox: true,
      inboxDir: dataDir,
      // Note: agents run in tmux which is already background/detached
    });

    try {
      await wrapper.start();
      console.log(`  Started: ${agent.name}`);
    } catch (err) {
      console.error(`  Failed to start ${agent.name}:`, err);
    }
  }
}

// up - Start daemon + dashboard
program
  .command('up')
  .description('Start daemon + dashboard')
  .option('--no-dashboard', 'Disable web dashboard')
  .option('--port <port>', 'Dashboard port', DEFAULT_DASHBOARD_PORT)
  .action(async (options) => {
    const { getProjectPaths, ensureProjectDir } = await import('../utils/project-namespace.js');

    const paths = ensureProjectDir();
    const socketPath = paths.socketPath;
    const dbPath = paths.dbPath;
    const pidFilePath = pidFilePathForSocket(socketPath);

    console.log(`Project: ${paths.projectRoot}`);
    console.log(`Socket:  ${socketPath}`);

    const daemon = new Daemon({
      socketPath,
      pidFilePath,
      storagePath: dbPath,
      teamDir: paths.teamDir,
    });

    process.on('SIGINT', async () => {
      console.log('\nStopping...');
      await daemon.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await daemon.stop();
      process.exit(0);
    });

    try {
      await daemon.start();
      console.log('Daemon started.');

      // Dashboard starts by default (use --no-dashboard to disable)
      if (options.dashboard !== false) {
        const port = parseInt(options.port, 10);
        const { startDashboard } = await import('../dashboard/server.js');
        const actualPort = await startDashboard({
          port,
          dataDir: paths.dataDir,
          teamDir: paths.teamDir,
          dbPath,
          enableSpawner: true,
          projectRoot: paths.projectRoot,
        });
        console.log(`Dashboard: http://localhost:${actualPort}`);
      }

      console.log('Press Ctrl+C to stop.');
      await new Promise(() => {});
    } catch (err) {
      console.error('Failed:', err);
      process.exit(1);
    }
  });

// down - Stop daemon
program
  .command('down')
  .description('Stop daemon')
  .action(async () => {
    const { getProjectPaths } = await import('../utils/project-namespace.js');
    const paths = getProjectPaths();
    const pidPath = pidFilePathForSocket(paths.socketPath);

    if (!fs.existsSync(pidPath)) {
      console.log('Not running');
      return;
    }

    const pid = Number(fs.readFileSync(pidPath, 'utf-8').trim());
    try {
      process.kill(pid, 'SIGTERM');
      console.log('Stopped');
    } catch {
      fs.unlinkSync(pidPath);
      console.log('Cleaned up stale pid');
    }
  });

// status - Check daemon status
program
  .command('status')
  .description('Check daemon status')
  .action(async () => {
    const { getProjectPaths } = await import('../utils/project-namespace.js');
    const paths = getProjectPaths();
    const relaySessions = await discoverRelaySessions();

    if (!fs.existsSync(paths.socketPath)) {
      console.log('Status: STOPPED');
      logRelaySessions(relaySessions);
      return;
    }

    const client = new RelayClient({
      agentName: '__status__',
      socketPath: paths.socketPath,
      reconnect: false,
    });

    try {
      await client.connect();
      console.log('Status: RUNNING');
      console.log(`Socket: ${paths.socketPath}`);
      logRelaySessions(relaySessions);
      client.disconnect();
    } catch {
      console.log('Status: STOPPED');
      logRelaySessions(relaySessions);
    }
  });

// agents - List connected agents (from registry file)
program
  .command('agents')
  .description('List connected agents')
  .option('--all', 'Include internal/CLI agents')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const { getProjectPaths } = await import('../utils/project-namespace.js');
    const paths = getProjectPaths();
    const agentsPath = path.join(paths.teamDir, 'agents.json');

    const allAgents = loadAgents(agentsPath);
    const agents = options.all
      ? allAgents
      : allAgents.filter(isVisibleAgent);

    if (options.json) {
      console.log(JSON.stringify(agents.map(a => ({ ...a, status: getAgentStatus(a) })), null, 2));
      return;
    }

    if (!agents.length) {
      const hint = options.all ? '' : ' (use --all to include internal/cli agents)';
      console.log(`No agents found. Ensure the daemon is running and agents are connected${hint}.`);
      return;
    }

    console.log('NAME            STATUS   CLI       LAST SEEN');
    console.log('---------------------------------------------');
    agents.forEach((agent) => {
      const name = (agent.name ?? 'unknown').padEnd(15);
      const status = getAgentStatus(agent).padEnd(8);
      const cli = (agent.cli ?? '-').padEnd(8);
      const lastSeen = formatRelativeTime(agent.lastSeen);
      console.log(`${name} ${status} ${cli} ${lastSeen}`);
    });
  });

// who - Show currently active agents (online within last 30s)
program
  .command('who')
  .description('Show currently active agents (last seen within 30 seconds)')
  .option('--all', 'Include internal/CLI agents')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const { getProjectPaths } = await import('../utils/project-namespace.js');
    const paths = getProjectPaths();
    const agentsPath = path.join(paths.teamDir, 'agents.json');

    const allAgents = loadAgents(agentsPath);
    const visibleAgents = options.all
      ? allAgents
      : allAgents.filter(a => !isInternalAgent(a.name));

    const onlineAgents = visibleAgents.filter(isAgentOnline);

    if (options.json) {
      console.log(JSON.stringify(onlineAgents.map(a => ({ ...a, status: getAgentStatus(a) })), null, 2));
      return;
    }

    if (!onlineAgents.length) {
      const hint = options.all ? '' : ' (use --all to include internal/cli agents)';
      console.log(`No active agents found${hint}.`);
      return;
    }

    console.log('NAME            STATUS   CLI       LAST SEEN');
    console.log('---------------------------------------------');
    onlineAgents.forEach((agent) => {
      const name = (agent.name ?? 'unknown').padEnd(15);
      const status = getAgentStatus(agent).padEnd(8);
      const cli = (agent.cli ?? '-').padEnd(8);
      const lastSeen = formatRelativeTime(agent.lastSeen);
      console.log(`${name} ${status} ${cli} ${lastSeen}`);
    });
  });

// read - Read full message by ID (for truncated messages)
program
  .command('read')
  .description('Read full message by ID (for truncated messages)')
  .argument('<id>', 'Message ID')
  .action(async (messageId) => {
    const { getProjectPaths } = await import('../utils/project-namespace.js');
    const { createStorageAdapter } = await import('../storage/adapter.js');

    const paths = getProjectPaths();
    const adapter = await createStorageAdapter(paths.dbPath);

    if (!adapter.getMessageById) {
      console.error('Storage does not support message lookup');
      process.exit(1);
    }

    const msg = await adapter.getMessageById(messageId);
    if (!msg) {
      console.error(`Message not found: ${messageId}`);
      process.exit(1);
    }

    console.log(`From: ${msg.from}`);
    console.log(`To: ${msg.to}`);
    console.log(`Time: ${new Date(msg.ts).toISOString()}`);
    console.log('---');
    console.log(msg.body);
    await adapter.close?.();
  });

// ============================================
// Hidden commands (for agents, not in --help)
// ============================================

// history - Show recent messages (hidden from help, for agent use)
program
  .command('history', { hidden: true })
  .description('Show recent messages')
  .option('-n, --limit <count>', 'Number of messages to show', '50')
  .option('-f, --from <agent>', 'Filter by sender')
  .option('-t, --to <agent>', 'Filter by recipient')
  .option('--since <time>', 'Since time (e.g., "1h", "2024-01-01")')
  .option('--json', 'Output as JSON')
  .action(async (options: { limit?: string; from?: string; to?: string; since?: string; json?: boolean }) => {
    const { getProjectPaths } = await import('../utils/project-namespace.js');
    const { createStorageAdapter } = await import('../storage/adapter.js');

    const paths = getProjectPaths();
    const adapter = await createStorageAdapter(paths.dbPath);
    const limit = Number.parseInt(options.limit ?? '50', 10) || 50;
    const sinceTs = parseSince(options.since);

    try {
      const messages = await adapter.getMessages({
        limit,
        from: options.from,
        to: options.to,
        sinceTs,
        order: 'desc',
      });

      if (options.json) {
        const payload = messages.map((m) => ({
          id: m.id,
          ts: m.ts,
          timestamp: new Date(m.ts).toISOString(),
          from: m.from,
          to: m.to,
          topic: m.topic,
          thread: m.thread,
          kind: m.kind,
          body: m.body,
        }));
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      if (!messages.length) {
        console.log('No messages found.');
        return;
      }

      messages.forEach((msg) => {
        const ts = new Date(msg.ts).toISOString();
        const body = msg.body.length > 120 ? `${msg.body.slice(0, 117)}...` : msg.body;
        console.log(`${ts} ${msg.from} -> ${msg.to}:${body}`);
      });
    } finally {
      await adapter.close?.();
    }
  });

// version - Show version info
program
  .command('version')
  .description('Show version information')
  .action(() => {
    console.log(`agent-relay v${VERSION}`);
  });

// bridge - Multi-project orchestration
program
  .command('bridge')
  .description('Bridge multiple projects as orchestrator')
  .argument('[projects...]', 'Project paths to bridge')
  .option('--cli <tool>', 'CLI tool override for all projects')
  .action(async (projectPaths: string[], options) => {
    const { resolveProjects, validateDaemons } = await import('../bridge/config.js');
    const { MultiProjectClient } = await import('../bridge/multi-project-client.js');
    const { getProjectPaths } = await import('../utils/project-namespace.js');
    const fs = await import('node:fs');
    const pathModule = await import('node:path');

    // Resolve projects from args or config
    const projects = resolveProjects(projectPaths, options.cli);

    if (projects.length === 0) {
      console.error('No projects specified.');
      console.error('Usage: agent-relay bridge ~/project1 ~/project2');
      console.error('   or: Create ~/.agent-relay/bridge.json with project config');
      process.exit(1);
    }

    console.log('Bridge Mode - Multi-Project Orchestration');
    console.log('─'.repeat(40));

    // Check which daemons are running
    const { valid, missing } = validateDaemons(projects);

    if (missing.length > 0) {
      console.error('\nMissing daemons for:');
      for (const p of missing) {
        console.error(`  - ${p.path}`);
        console.error(`    Run: cd "${p.path}" && agent-relay up`);
      }
      console.error('');
    }

    if (valid.length === 0) {
      console.error('No projects have running daemons. Start them first.');
      process.exit(1);
    }

    console.log('\nConnecting to projects:');
    for (const p of valid) {
      console.log(`  - ${p.id} (${p.path})`);
      console.log(`    Lead: ${p.leadName}, CLI: ${p.cli}`);
    }
    console.log('');

    // Get data directories for ALL bridged projects (so each project's dashboard can show bridge state)
    const bridgeStatePaths: string[] = valid.map(p => {
      const projectPaths = getProjectPaths(p.path);
      // Ensure directory exists
      if (!fs.existsSync(projectPaths.dataDir)) {
        fs.mkdirSync(projectPaths.dataDir, { recursive: true });
      }
      return pathModule.join(projectPaths.dataDir, 'bridge-state.json');
    });

    // Bridge state tracking
    interface BridgeProject {
      id: string;
      name: string;
      path: string;
      connected: boolean;
      reconnecting?: boolean;
      lead?: { name: string; connected: boolean };
      agents: Array<{ name: string; status: string; task?: string }>;
    }
    interface BridgeMessage {
      id: string;
      from: string;
      to: string;
      body: string;
      sourceProject: string;
      targetProject?: string;
      timestamp: string;
    }
    interface BridgeState {
      projects: BridgeProject[];
      messages: BridgeMessage[];
      connected: boolean;
      startedAt: string;
    }

    const bridgeState: BridgeState = {
      projects: valid.map(p => ({
        id: p.id,
        name: pathModule.basename(p.path),
        path: p.path,
        connected: false,
        lead: { name: p.leadName, connected: false },
        agents: [],
      })),
      messages: [],
      connected: false,
      startedAt: new Date().toISOString(),
    };

    // Write bridge state to ALL project data directories
    const writeBridgeState = (): void => {
      const stateJson = JSON.stringify(bridgeState, null, 2);
      for (const statePath of bridgeStatePaths) {
        try {
          fs.writeFileSync(statePath, stateJson);
        } catch (err) {
          console.error(`[bridge] Failed to write state to ${statePath}:`, err);
        }
      }
    };

    // Initial state write
    writeBridgeState();
    console.log(`Bridge state written to ${bridgeStatePaths.length} project(s)`);

    // Connect to all project daemons
    const client = new MultiProjectClient(valid);

    // Track connection state changes (daemon connection, not agent registration)
    // Also track "reconnecting" state for UI feedback
    const wasConnected = new Map<string, boolean>();

    client.onProjectStateChange = (projectId, connected) => {
      const project = bridgeState.projects.find(p => p.id === projectId);
      if (project) {
        const hadConnection = wasConnected.get(projectId) || false;
        project.connected = connected;
        // Set reconnecting if we lost connection (had it before, now disconnected)
        project.reconnecting = !connected && hadConnection;
        wasConnected.set(projectId, connected);
        // Note: lead.connected should only be true when an actual lead agent registers
        // The bridge connecting to daemon doesn't mean a lead agent is active
      }
      bridgeState.connected = bridgeState.projects.some(p => p.connected);
      writeBridgeState();
    };

    try {
      await client.connect();
    } catch (err) {
      console.error('Failed to connect to all projects');
      writeBridgeState(); // Write final state before exit
      process.exit(1);
    }

    bridgeState.connected = true;
    writeBridgeState();

    console.log('Connected to all projects.');
    console.log('');
    console.log('Cross-project messaging:');
    console.log('  @relay:projectId:agent Message');
    console.log('  @relay:*:lead Broadcast to all leads');
    console.log('');

    // Handle messages from projects
    client.onMessage = (projectId, from, payload, messageId) => {
      console.log(`[${projectId}] ${from}: ${payload.body.substring(0, 80)}...`);

      // Track message in bridge state
      bridgeState.messages.push({
        id: messageId,
        from,
        to: '*', // Incoming messages are from agents
        body: payload.body,
        sourceProject: projectId,
        timestamp: new Date().toISOString(),
      });

      // Keep last 100 messages
      if (bridgeState.messages.length > 100) {
        bridgeState.messages = bridgeState.messages.slice(-100);
      }

      writeBridgeState();
    };

    // Clean up on exit
    const cleanup = (): void => {
      bridgeState.connected = false;
      bridgeState.projects.forEach(p => {
        p.connected = false;
        if (p.lead) p.lead.connected = false;
      });
      writeBridgeState();
    };

    // Keep running
    process.on('SIGINT', () => {
      console.log('\nDisconnecting...');
      cleanup();
      client.disconnect();
      process.exit(0);
    });

    // Start a simple REPL for sending messages
    const readline = await import('node:readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log('Enter messages as: projectId:agent message');
    console.log('Or: *:lead message (broadcast to all leads)');
    console.log('Type "quit" to exit.\n');

    const promptForInput = (): void => {
      rl.question('> ', (input) => {
        if (input.toLowerCase() === 'quit') {
          client.disconnect();
          rl.close();
          process.exit(0);
        }

        // Parse input: projectId:agent message
        const match = input.match(/^(\S+):(\S+)\s+(.+)$/);
        if (match) {
          const [, projectId, agent, message] = match;
          if (projectId === '*' && agent === 'lead') {
            client.broadcastToLeads(message);
            console.log('→ Broadcast to all leads');
          } else if (projectId === '*') {
            client.broadcastAll(message);
            console.log('→ Broadcast to all');
          } else {
            const sent = client.sendToProject(projectId, agent, message);
            if (sent) {
              console.log(`→ ${projectId}:${agent}`);
            }
          }
        } else {
          console.log('Format: projectId:agent message');
        }

        promptForInput();
      });
    };

    promptForInput();
  });

// lead - Start as project lead with spawn capability
program
  .command('lead')
  .description('Start as project lead with spawn capability')
  .argument('<name>', 'Your agent name')
  .argument('[cli]', 'CLI tool to use', 'claude')
  .action(async (name: string, cli: string) => {
    const { getProjectPaths } = await import('../utils/project-namespace.js');
    const { AgentSpawner } = await import('../bridge/spawner.js');
    const { TmuxWrapper } = await import('../wrapper/tmux-wrapper.js');
    const { findAgentConfig, isClaudeCli, buildClaudeArgs } = await import('../utils/agent-config.js');

    const paths = getProjectPaths();

    console.log('Lead Mode - Project Lead with Spawn Capability');
    console.log('─'.repeat(40));
    console.log(`Agent: ${name}`);
    console.log(`Project: ${paths.projectId}`);
    console.log(`CLI: ${cli}`);

    // Create spawner for this project
    const spawner = new AgentSpawner(paths.projectRoot);

    // Parse CLI - split on whitespace for args
    const [mainCommand, ...cliArgs] = cli.split(/\s+/);

    // Auto-detect agent config and inject --model/--agent for Claude CLI
    let finalArgs = cliArgs;
    if (isClaudeCli(mainCommand)) {
      const config = findAgentConfig(name, paths.projectRoot);
      if (config) {
        console.log(`Agent config: ${config.configPath}`);
        if (config.model) {
          console.log(`Model: ${config.model}`);
        }
        finalArgs = buildClaudeArgs(name, cliArgs, paths.projectRoot);
      }
    }

    console.log('');
    console.log('Spawn workers with:');
    console.log('  ->relay:spawn WorkerName cli "task"');
    console.log('Release workers with:');
    console.log('  ->relay:release WorkerName');
    console.log('');

    const wrapper = new TmuxWrapper({
      name,
      command: mainCommand,
      args: finalArgs.length > 0 ? finalArgs : undefined,
      socketPath: paths.socketPath,
      debug: true,
      // Wire up spawn/release callbacks
      onSpawn: async (workerName: string, workerCli: string, task: string) => {
        console.log(`[lead] Spawning ${workerName} (${workerCli})...`);
        const result = await spawner.spawn({
          name: workerName,
          cli: workerCli,
          task,
          requestedBy: name,
        });
        if (result.success) {
          console.log(`[lead] ✓ Spawned ${workerName} in ${result.window}`);
        } else {
          console.error(`[lead] ✗ Failed to spawn ${workerName}: ${result.error}`);
        }
      },
      onRelease: async (workerName: string) => {
        console.log(`[lead] Releasing ${workerName}...`);
        const released = await spawner.release(workerName);
        if (released) {
          console.log(`[lead] ✓ Released ${workerName}`);
        } else {
          console.error(`[lead] ✗ Worker ${workerName} not found`);
        }
      },
    });

    process.on('SIGINT', async () => {
      console.log('\nReleasing workers...');
      await spawner.releaseAll();
      wrapper.stop();
      process.exit(0);
    });

    await wrapper.start();
  });

// gc - Clean up orphaned tmux sessions (hidden - for agent use)
program
  .command('gc', { hidden: true })
  .description('Clean up orphaned tmux sessions (sessions with no connected agent)')
  .option('--dry-run', 'Show what would be cleaned without actually doing it')
  .option('--force', 'Kill all relay sessions regardless of connection status')
  .action(async (options: { dryRun?: boolean; force?: boolean }) => {
    const { getProjectPaths } = await import('../utils/project-namespace.js');
    const paths = getProjectPaths();
    const agentsPath = path.join(paths.teamDir, 'agents.json');

    // Get all relay tmux sessions
    const sessions = await discoverRelaySessions();
    if (!sessions.length) {
      console.log('No relay tmux sessions found.');
      return;
    }

    // Get connected agents
    const connectedAgents = new Set<string>();
    if (!options.force) {
      const agents = loadAgents(agentsPath);
      // Consider an agent "connected" if last seen within 30 seconds
      const staleThresholdMs = 30_000;
      const now = Date.now();
      agents.forEach(a => {
        if (a.name && a.lastSeen) {
          const lastSeenTs = Date.parse(a.lastSeen);
          if (!Number.isNaN(lastSeenTs) && now - lastSeenTs < staleThresholdMs) {
            connectedAgents.add(a.name);
          }
        }
      });
    }

    // Find orphaned sessions
    const orphaned = sessions.filter(s =>
      options.force || (s.agentName && !connectedAgents.has(s.agentName))
    );

    if (!orphaned.length) {
      console.log(`All ${sessions.length} session(s) have active agents.`);
      return;
    }

    console.log(`Found ${orphaned.length} orphaned session(s):`);
    for (const session of orphaned) {
      console.log(`  - ${session.sessionName} (agent: ${session.agentName ?? 'unknown'})`);
    }

    if (options.dryRun) {
      console.log('\nDry run - no sessions killed.');
      return;
    }

    // Kill orphaned sessions
    let killed = 0;
    for (const session of orphaned) {
      try {
        await execAsync(`tmux kill-session -t ${session.sessionName}`);
        killed++;
        console.log(`Killed: ${session.sessionName}`);
      } catch (err) {
        console.error(`Failed to kill ${session.sessionName}: ${(err as Error).message}`);
      }
    }

    console.log(`\nCleaned up ${killed}/${orphaned.length} session(s).`);
  });

interface RelaySessionInfo {
  sessionName: string;
  agentName?: string;
  cwd?: string;
}

async function discoverRelaySessions(): Promise<RelaySessionInfo[]> {
  try {
    const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}"');
    const sessionNames = stdout
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);

    const relaySessions = sessionNames
      .map(name => {
        const match = name.match(/^relay-(.+)$/);
        if (!match) return undefined;
        return { sessionName: name, agentName: match[1] };
      })
      .filter((s): s is { sessionName: string; agentName: string } => Boolean(s));

    return await Promise.all(
      relaySessions.map(async (session) => {
        let cwd: string | undefined;
        try {
          const { stdout: cwdOut } = await execAsync(
            `tmux display-message -t ${session.sessionName} -p '#{pane_current_path}'`
          );
          cwd = cwdOut.trim() || undefined;
        } catch {
          cwd = undefined;
        }
        return { ...session, cwd };
      })
    );
  } catch {
    return [];
  }
}

function logRelaySessions(sessions: RelaySessionInfo[]): void {
  if (!sessions.length) {
    console.log('Relay tmux sessions: none detected');
    return;
  }

  console.log('Relay tmux sessions:');
  sessions.forEach((session) => {
    const parts = [
      `agent: ${session.agentName ?? 'unknown'}`,
      session.cwd ? `cwd: ${session.cwd}` : undefined,
    ].filter(Boolean);
    console.log(`- ${session.sessionName}${parts.length ? ` (${parts.join(', ')})` : ''}`);
  });
}

interface RegistryAgent {
  id?: string;
  name?: string;
  cli?: string;
  workingDirectory?: string;
  firstSeen?: string;
  lastSeen?: string;
  messagesSent?: number;
  messagesReceived?: number;
}

function loadAgents(agentsPath: string): RegistryAgent[] {
  if (!fs.existsSync(agentsPath)) {
    return [];
  }

  try {
    const raw = JSON.parse(fs.readFileSync(agentsPath, 'utf-8'));
    const agentsArray = Array.isArray(raw?.agents)
      ? raw.agents
      : raw?.agents
        ? Object.values(raw.agents)
        : [];

    return agentsArray
      .filter((a: any) => a?.name)
      .map((a: any) => ({
        id: a.id,
        name: a.name,
        cli: a.cli,
        workingDirectory: a.workingDirectory,
        firstSeen: a.firstSeen,
        lastSeen: a.lastSeen,
        messagesSent: typeof a.messagesSent === 'number' ? a.messagesSent : 0,
        messagesReceived: typeof a.messagesReceived === 'number' ? a.messagesReceived : 0,
      }));
  } catch (err) {
    console.error('Failed to read agents.json:', (err as Error).message);
    return [];
  }
}

const STALE_THRESHOLD_MS = 30_000;

// Internal agents that should be hidden from `agents` and `who` by default
const INTERNAL_AGENTS = new Set(['cli', 'Dashboard']);

function isInternalAgent(name: string | undefined): boolean {
  if (!name) return true;
  if (name.startsWith('__')) return true;
  return INTERNAL_AGENTS.has(name);
}

function getAgentStatus(agent: RegistryAgent): 'ONLINE' | 'STALE' | 'UNKNOWN' {
  if (!agent.lastSeen) return 'UNKNOWN';
  const ts = Date.parse(agent.lastSeen);
  if (Number.isNaN(ts)) return 'UNKNOWN';
  return Date.now() - ts < STALE_THRESHOLD_MS ? 'ONLINE' : 'STALE';
}

function isAgentOnline(agent: RegistryAgent): boolean {
  return getAgentStatus(agent) === 'ONLINE';
}

// Visible agents: not internal and not stale (used by `agents` command)
function isVisibleAgent(agent: RegistryAgent): boolean {
  if (isInternalAgent(agent.name)) return false;
  if (getAgentStatus(agent) === 'STALE') return false;
  return true;
}

function formatRelativeTime(iso?: string): string {
  if (!iso) return 'unknown';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return 'unknown';
  const diffMs = Date.now() - ts;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 48) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function parseSince(input?: string): number | undefined {
  if (!input) return undefined;
  const trimmed = String(input).trim();
  if (!trimmed) return undefined;

  const durationMatch = trimmed.match(/^(-?\d+)([smhd])$/i);
  if (durationMatch) {
    const value = Number(durationMatch[1]);
    const unit = durationMatch[2].toLowerCase();
    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
    };
    return Date.now() - value * multipliers[unit];
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return parsed;
}

// ============================================
// Spawn/Worker debugging commands
// ============================================

const WORKER_SESSION = 'relay-workers';

// workers - List spawned workers
program
  .command('workers')
  .description('List spawned worker agents (from tmux)')
  .option('--json', 'Output as JSON')
  .action(async (options: { json?: boolean }) => {
    try {
      // Check if worker session exists
      try {
        await execAsync(`tmux has-session -t ${WORKER_SESSION} 2>/dev/null`);
      } catch {
        if (options.json) {
          console.log(JSON.stringify({ workers: [], session: null }));
        } else {
          console.log('No spawned workers (session does not exist)');
        }
        return;
      }

      // List windows in the worker session
      const { stdout } = await execAsync(
        `tmux list-windows -t ${WORKER_SESSION} -F "#{window_index}|#{window_name}|#{pane_current_command}|#{window_activity}"`
      );

      const workers = stdout
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [index, name, command, activity] = line.split('|');
          const activityTs = parseInt(activity, 10) * 1000;
          const lastActive = isNaN(activityTs) ? undefined : new Date(activityTs).toISOString();
          return {
            index: parseInt(index, 10),
            name,
            command,
            lastActive,
            window: `${WORKER_SESSION}:${name}`,
          };
        })
        // Filter out the default zsh window
        .filter(w => w.name !== 'zsh' && w.command !== 'zsh');

      if (options.json) {
        console.log(JSON.stringify({ workers, session: WORKER_SESSION }, null, 2));
        return;
      }

      if (!workers.length) {
        console.log('No spawned workers');
        return;
      }

      console.log('SPAWNED WORKERS');
      console.log('─'.repeat(50));
      console.log('NAME            COMMAND       WINDOW');
      console.log('─'.repeat(50));
      workers.forEach(w => {
        const name = w.name.padEnd(15);
        const cmd = (w.command || '-').padEnd(12);
        console.log(`${name} ${cmd}  ${w.window}`);
      });
      console.log('');
      console.log('Commands:');
      console.log('  agent-relay workers:logs <name>   - View worker output');
      console.log('  agent-relay workers:attach <name> - Attach to worker tmux');
      console.log('  agent-relay workers:kill <name>   - Kill a worker');
    } catch (err) {
      console.error('Failed to list workers:', (err as Error).message);
    }
  });

// workers:logs - Show tmux pane output for a worker
program
  .command('workers:logs')
  .description('Show recent output from a spawned worker')
  .argument('<name>', 'Worker name')
  .option('-n, --lines <n>', 'Number of lines to show', '50')
  .option('-f, --follow', 'Follow output (like tail -f)')
  .action(async (name: string, options: { lines?: string; follow?: boolean }) => {
    const window = `${WORKER_SESSION}:${name}`;

    try {
      // Check if window exists
      await execAsync(`tmux has-session -t ${window} 2>/dev/null`);
    } catch {
      console.error(`Worker "${name}" not found`);
      console.log(`Run 'agent-relay workers' to see available workers`);
      process.exit(1);
    }

    if (options.follow) {
      console.log(`Following output from ${window} (Ctrl+C to stop)...`);
      console.log('─'.repeat(50));

      // Use a polling approach to follow
      let lastContent = '';
      const poll = async () => {
        try {
          const { stdout } = await execAsync(`tmux capture-pane -t ${window} -p -S -100`);
          if (stdout !== lastContent) {
            // Print only new lines
            const newContent = stdout.replace(lastContent, '');
            if (newContent.trim()) {
              process.stdout.write(newContent);
            }
            lastContent = stdout;
          }
        } catch {
          console.error('\nWorker disconnected');
          process.exit(1);
        }
      };

      const interval = setInterval(poll, 500);
      process.on('SIGINT', () => {
        clearInterval(interval);
        console.log('\nStopped following');
        process.exit(0);
      });

      await poll(); // Initial fetch
      await new Promise(() => {}); // Keep running
    } else {
      try {
        const lines = parseInt(options.lines || '50', 10);
        const { stdout } = await execAsync(`tmux capture-pane -t ${window} -p -S -${lines}`);
        console.log(`Output from ${window} (last ${lines} lines):`);
        console.log('─'.repeat(50));
        console.log(stdout || '(empty)');
      } catch (err) {
        console.error('Failed to capture output:', (err as Error).message);
      }
    }
  });

// workers:attach - Attach to a worker's tmux window
program
  .command('workers:attach')
  .description('Attach to a spawned worker tmux window')
  .argument('<name>', 'Worker name')
  .action(async (name: string) => {
    const window = `${WORKER_SESSION}:${name}`;

    try {
      // Check if window exists
      await execAsync(`tmux has-session -t ${window} 2>/dev/null`);
    } catch {
      console.error(`Worker "${name}" not found`);
      console.log(`Run 'agent-relay workers' to see available workers`);
      process.exit(1);
    }

    console.log(`Attaching to ${window}...`);
    console.log('(Use Ctrl+B D to detach)');

    // Spawn tmux attach as a child process with stdio inherited
    const { spawn } = await import('child_process');
    const child = spawn('tmux', ['attach-session', '-t', window], {
      stdio: 'inherit',
    });

    child.on('exit', (code) => {
      process.exit(code || 0);
    });
  });

// workers:kill - Kill a spawned worker
program
  .command('workers:kill')
  .description('Kill a spawned worker')
  .argument('<name>', 'Worker name')
  .option('--force', 'Skip graceful shutdown, kill immediately')
  .action(async (name: string, options: { force?: boolean }) => {
    const window = `${WORKER_SESSION}:${name}`;

    try {
      // Check if window exists
      await execAsync(`tmux has-session -t ${window} 2>/dev/null`);
    } catch {
      console.error(`Worker "${name}" not found`);
      console.log(`Run 'agent-relay workers' to see available workers`);
      process.exit(1);
    }

    if (!options.force) {
      // Try graceful shutdown first
      console.log(`Sending /exit to ${name}...`);
      try {
        await execAsync(`tmux send-keys -t ${window} '/exit' Enter`);
        // Wait for graceful shutdown
        await new Promise(r => setTimeout(r, 2000));
      } catch {
        // Ignore errors, will force kill below
      }
    }

    // Kill the window
    try {
      await execAsync(`tmux kill-window -t ${window}`);
      console.log(`Killed worker: ${name}`);
    } catch (err) {
      console.error(`Failed to kill ${name}:`, (err as Error).message);
      process.exit(1);
    }
  });

// workers:session - Show tmux session info
program
  .command('workers:session')
  .description('Show worker tmux session details')
  .action(async () => {
    try {
      // Check if session exists
      try {
        await execAsync(`tmux has-session -t ${WORKER_SESSION} 2>/dev/null`);
      } catch {
        console.log(`Session "${WORKER_SESSION}" does not exist`);
        console.log('Spawn a worker to create it.');
        return;
      }

      console.log(`Session: ${WORKER_SESSION}`);
      console.log('─'.repeat(50));

      // Get session info
      const { stdout: sessionInfo } = await execAsync(
        `tmux display-message -t ${WORKER_SESSION} -p "Created: #{session_created_string}\\nWindows: #{session_windows}\\nAttached: #{?session_attached,yes,no}"`
      );
      console.log(sessionInfo);

      // List windows
      console.log('\nWindows:');
      const { stdout: windows } = await execAsync(
        `tmux list-windows -t ${WORKER_SESSION} -F "  #{window_index}: #{window_name} (#{pane_current_command})"`
      );
      console.log(windows || '  (none)');

      console.log('\nQuick commands:');
      console.log(`  tmux attach -t ${WORKER_SESSION}     # Attach to session`);
      console.log(`  tmux kill-session -t ${WORKER_SESSION}  # Kill entire session`);
    } catch (err) {
      console.error('Failed:', (err as Error).message);
    }
  });

program.parse();
