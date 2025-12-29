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
import { getTmuxPath } from '../utils/tmux-resolver.js';
import { readWorkersMetadata, getWorkerLogsDir } from '../bridge/spawner.js';
import { checkForUpdatesInBackground, checkForUpdates } from '../utils/update-checker.js';
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

// Check for updates in background (non-blocking)
// Only show notification for interactive commands, not when wrapping agents or running update
const interactiveCommands = ['up', 'down', 'status', 'agents', 'who', 'version', '--version', '-V', '--help', '-h'];
const shouldCheckUpdates = process.argv.length > 2 &&
  interactiveCommands.includes(process.argv[2]);
if (shouldCheckUpdates) {
  checkForUpdatesInBackground(VERSION);
}

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
    const { AgentSpawner } = await import('../bridge/spawner.js');

    // Create spawner so any agent can spawn workers
    const spawner = new AgentSpawner(paths.projectRoot);

    const wrapper = new TmuxWrapper({
      name: agentName,
      command: mainCommand,
      args: finalArgs,
      socketPath: paths.socketPath,
      debug: false,  // Use -q to keep quiet (debug off by default)
      relayPrefix: options.prefix,
      useInbox: true,
      inboxDir: paths.dataDir, // Use the project-specific data directory for the inbox
      // Wire up spawn/release callbacks so any agent can spawn workers
      onSpawn: async (workerName: string, workerCli: string, task: string) => {
        console.error(`[${agentName}] Spawning ${workerName} (${workerCli})...`);
        const result = await spawner.spawn({
          name: workerName,
          cli: workerCli,
          task,
          // No team by default - agents are flat unless team is specified
        });
        if (result.success) {
          console.error(`[${agentName}] ✓ Spawned ${workerName} [pid: ${result.pid}]`);
        } else {
          console.error(`[${agentName}] ✗ Failed to spawn ${workerName}: ${result.error}`);
        }
      },
      onRelease: async (workerName: string) => {
        console.error(`[${agentName}] Releasing ${workerName}...`);
        const released = await spawner.release(workerName);
        if (released) {
          console.error(`[${agentName}] ✓ Released ${workerName}`);
        } else {
          console.error(`[${agentName}] ✗ Worker ${workerName} not found`);
        }
      },
    });

    process.on('SIGINT', async () => {
      await spawner.releaseAll();
      wrapper.stop();
      process.exit(0);
    });

    await wrapper.start();
  });

// up - Start daemon + dashboard
program
  .command('up')
  .description('Start daemon + dashboard')
  .option('--no-dashboard', 'Disable web dashboard')
  .option('--port <port>', 'Dashboard port', DEFAULT_DASHBOARD_PORT)
  .option('--spawn', 'Force spawn all agents from teams.json')
  .option('--no-spawn', 'Do not auto-spawn agents (just start daemon)')
  .action(async (options) => {
    const { ensureProjectDir } = await import('../utils/project-namespace.js');
    const { loadTeamsConfig } = await import('../bridge/teams-config.js');
    const { AgentSpawner } = await import('../bridge/spawner.js');

    const paths = ensureProjectDir();
    const socketPath = paths.socketPath;
    const dbPath = paths.dbPath;
    const pidFilePath = pidFilePathForSocket(socketPath);

    console.log(`Project: ${paths.projectRoot}`);
    console.log(`Socket:  ${socketPath}`);

    // Load teams.json if present
    const teamsConfig = loadTeamsConfig(paths.projectRoot);
    if (teamsConfig) {
      console.log(`Team: ${teamsConfig.team} (${teamsConfig.agents.length} agents defined)`);
    }

    const daemon = new Daemon({
      socketPath,
      pidFilePath,
      storagePath: dbPath,
      teamDir: paths.teamDir,
    });

    // Create spawner for auto-spawn (will be initialized after dashboard starts)
    let spawner: InstanceType<typeof AgentSpawner> | null = null;

    process.on('SIGINT', async () => {
      console.log('\nStopping...');
      if (spawner) {
        await spawner.releaseAll();
      }
      await daemon.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      if (spawner) {
        await spawner.releaseAll();
      }
      await daemon.stop();
      process.exit(0);
    });

    try {
      await daemon.start();
      console.log('Daemon started.');

      let dashboardPort: number | undefined;

      // Dashboard starts by default (use --no-dashboard to disable)
      if (options.dashboard !== false) {
        const port = parseInt(options.port, 10);
        const { startDashboard } = await import('../dashboard-server/server.js');
        dashboardPort = await startDashboard({
          port,
          dataDir: paths.dataDir,
          teamDir: paths.teamDir,
          dbPath,
          enableSpawner: true,
          projectRoot: paths.projectRoot,
        });
        console.log(`Dashboard: http://localhost:${dashboardPort}`);
      }

      // Determine if we should auto-spawn agents
      // --spawn: force spawn
      // --no-spawn: never spawn
      // Neither: check teamsConfig.autoSpawn
      const shouldSpawn = options.spawn === true
        ? true
        : options.spawn === false
          ? false
          : teamsConfig?.autoSpawn ?? false;

      if (shouldSpawn && teamsConfig && teamsConfig.agents.length > 0) {
        console.log('');
        console.log('Auto-spawning agents from teams.json...');

        spawner = new AgentSpawner(paths.projectRoot, undefined, dashboardPort);

        for (const agent of teamsConfig.agents) {
          console.log(`  Spawning ${agent.name} (${agent.cli})...`);
          const result = await spawner.spawn({
            name: agent.name,
            cli: agent.cli,
            task: agent.task ?? '',
            team: teamsConfig.team,
          });

          if (result.success) {
            console.log(`  ✓ ${agent.name} started [pid: ${result.pid}]`);
          } else {
            console.error(`  ✗ ${agent.name} failed: ${result.error}`);
          }
        }
        console.log('');
      } else if (options.spawn === true && !teamsConfig) {
        console.warn('Warning: --spawn specified but no teams.json found');
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

// agents - List connected agents (from registry file) and spawned workers
program
  .command('agents')
  .description('List connected agents and spawned workers')
  .option('--all', 'Include internal/CLI agents')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const { getProjectPaths } = await import('../utils/project-namespace.js');
    const paths = getProjectPaths();
    const agentsPath = path.join(paths.teamDir, 'agents.json');

    // Load registered agents
    const allAgents = loadAgents(agentsPath);
    const agents = options.all
      ? allAgents
      : allAgents.filter(isVisibleAgent);

    // Load spawned workers
    const workers = readWorkersMetadata(paths.projectRoot);

    // Merge agents and workers
    interface CombinedAgent {
      name: string;
      status: string;
      cli: string;
      lastSeen?: string;
      team?: string;
      pid?: number;
    }

    const combined: CombinedAgent[] = [];

    // Add registered agents
    agents.forEach((agent) => {
      const worker = workers.find(w => w.name === agent.name);
      combined.push({
        name: agent.name ?? 'unknown',
        status: getAgentStatus(agent),
        cli: agent.cli ?? '-',
        lastSeen: agent.lastSeen,
        team: worker?.team,
        pid: worker?.pid,
      });
    });

    // Add workers not in registry (orphaned or not yet registered)
    workers.forEach((worker) => {
      const existsInAgents = agents.some(a => a.name === worker.name);
      if (!existsInAgents) {
        combined.push({
          name: worker.name || 'unknown',
          status: 'ONLINE',
          cli: worker.cli || '-',
          team: worker.team,
          pid: worker.pid,
        });
      }
    });

    if (options.json) {
      console.log(JSON.stringify(combined, null, 2));
      return;
    }

    if (!combined.length) {
      const hint = options.all ? '' : ' (use --all to include internal/cli agents)';
      console.log(`No agents found. Ensure the daemon is running and agents are connected${hint}.`);
      return;
    }

    console.log('NAME            STATUS   CLI       TEAM');
    console.log('─'.repeat(50));
    combined.forEach((agent) => {
      const name = agent.name.padEnd(15);
      const status = agent.status.padEnd(8);
      const cli = agent.cli.padEnd(9);
      const team = agent.team ?? '-';
      console.log(`${name} ${status} ${cli} ${team}`);
    });

    if (workers.length > 0) {
      console.log('');
      console.log('Commands:');
      console.log('  agent-relay agents:logs <name>   - View spawned agent output');
      console.log('  agent-relay agents:kill <name>   - Kill a spawned agent');
    }
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

// update - Check for updates and optionally install
program
  .command('update')
  .description('Check for updates and install if available')
  .option('--check', 'Only check for updates, do not install')
  .action(async (options: { check?: boolean }) => {
    console.log(`Current version: ${VERSION}`);
    console.log('Checking for updates...');

    const info = await checkForUpdates(VERSION);

    if (info.error) {
      console.error(`Failed to check for updates: ${info.error}`);
      process.exit(1);
    }

    if (!info.updateAvailable) {
      console.log('You are running the latest version.');
      return;
    }

    console.log(`New version available: ${info.latestVersion}`);

    if (options.check) {
      console.log('Run `agent-relay update` to install.');
      return;
    }

    console.log('Installing update...');
    try {
      const { stdout, stderr } = await execAsync('npm install -g agent-relay@latest');
      if (stdout) console.log(stdout);
      if (stderr) console.error(stderr);
      console.log(`Successfully updated to ${info.latestVersion}`);
    } catch (err) {
      console.error('Failed to install update:', (err as Error).message);
      console.log('Try running manually: npm install -g agent-relay@latest');
      process.exit(1);
    }
  });

// check-tmux - Check tmux availability (hidden - for diagnostics)
program
  .command('check-tmux', { hidden: true })
  .description('Check tmux availability and version')
  .action(async () => {
    const { resolveTmux, checkTmuxVersion } = await import('../utils/tmux-resolver.js');

    const info = resolveTmux();
    if (!info) {
      console.log('tmux: NOT FOUND');
      console.log('');
      console.log('Install tmux, then reinstall agent-relay:');
      console.log('  brew install tmux          # macOS');
      console.log('  apt install tmux           # Ubuntu/Debian');
      console.log('  npm install agent-relay    # Reinstall to bundle tmux');
      process.exit(1);
    }

    console.log(`tmux: ${info.path}`);
    console.log(`Version: ${info.version}`);
    console.log(`Source: ${info.isBundled ? 'bundled' : 'system'}`);

    const versionCheck = checkTmuxVersion();
    if (!versionCheck.ok) {
      console.log(`Warning: tmux ${versionCheck.minimum}+ recommended`);
    }
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
    } catch (_err) {
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
    const tmuxPath = getTmuxPath();
    for (const session of orphaned) {
      try {
        await execAsync(`"${tmuxPath}" kill-session -t ${session.sessionName}`);
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
    const tmuxPath = getTmuxPath();
    const { stdout } = await execAsync(`"${tmuxPath}" list-sessions -F "#{session_name}"`);
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
            `"${tmuxPath}" display-message -t ${session.sessionName} -p '#{pane_current_path}'`
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
// Spawned agent debugging commands
// ============================================

// agents:logs - Show log file output for a spawned agent
program
  .command('agents:logs')
  .description('Show recent output from a spawned agent')
  .argument('<name>', 'Agent name')
  .option('-n, --lines <n>', 'Number of lines to show', '50')
  .option('-f, --follow', 'Follow output (like tail -f)')
  .action(async (name: string, options: { lines?: string; follow?: boolean }) => {
    const { getProjectPaths } = await import('../utils/project-namespace.js');
    const paths = getProjectPaths();
    const logsDir = getWorkerLogsDir(paths.projectRoot);
    const logFile = path.join(logsDir, `${name}.log`);

    if (!fs.existsSync(logFile)) {
      console.error(`No logs found for agent "${name}"`);
      console.log(`Log file not found: ${logFile}`);
      console.log(`Run 'agent-relay agents' to see available agents`);
      process.exit(1);
    }

    if (options.follow) {
      console.log(`Following logs for ${name} (Ctrl+C to stop)...`);
      console.log('─'.repeat(50));

      // Use tail -f approach
      const { spawn } = await import('child_process');
      const child = spawn('tail', ['-f', logFile], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });

      process.on('SIGINT', () => {
        child.kill();
        console.log('\nStopped following');
        process.exit(0);
      });

      child.on('exit', () => {
        process.exit(0);
      });
    } else {
      try {
        const lines = parseInt(options.lines || '50', 10);
        const { stdout } = await execAsync(`tail -n ${lines} "${logFile}"`);
        console.log(`Logs for ${name} (last ${lines} lines):`);
        console.log('─'.repeat(50));
        console.log(stdout || '(empty)');
      } catch (err) {
        console.error('Failed to read logs:', (err as Error).message);
      }
    }
  });

// agents:kill - Kill a spawned agent by PID
program
  .command('agents:kill')
  .description('Kill a spawned agent')
  .argument('<name>', 'Agent name')
  .option('--force', 'Skip graceful shutdown, kill immediately')
  .action(async (name: string, options: { force?: boolean }) => {
    const { getProjectPaths } = await import('../utils/project-namespace.js');
    const paths = getProjectPaths();
    const workers = readWorkersMetadata(paths.projectRoot);
    const worker = workers.find(w => w.name === name);

    if (!worker) {
      console.error(`Spawned agent "${name}" not found`);
      console.log(`Run 'agent-relay agents' to see available agents`);
      process.exit(1);
    }

    if (!worker.pid) {
      console.error(`Agent "${name}" has no PID recorded`);
      process.exit(1);
    }

    try {
      if (!options.force) {
        // Try graceful shutdown first (SIGTERM)
        console.log(`Sending SIGTERM to ${name} (pid: ${worker.pid})...`);
        process.kill(worker.pid, 'SIGTERM');
        // Wait for graceful shutdown
        await new Promise(r => setTimeout(r, 2000));

        // Check if still running
        try {
          process.kill(worker.pid, 0); // Check if process exists
          console.log(`Agent still running, sending SIGKILL...`);
          process.kill(worker.pid, 'SIGKILL');
        } catch {
          // Process no longer exists, graceful shutdown worked
        }
      } else {
        // Force kill immediately
        console.log(`Force killing ${name} (pid: ${worker.pid})...`);
        process.kill(worker.pid, 'SIGKILL');
      }

      console.log(`Killed agent: ${name}`);
    } catch (err: any) {
      if (err.code === 'ESRCH') {
        console.log(`Agent ${name} is no longer running (pid: ${worker.pid})`);
      } else {
        console.error(`Failed to kill ${name}:`, err.message);
        process.exit(1);
      }
    }
  });

program.parse();
