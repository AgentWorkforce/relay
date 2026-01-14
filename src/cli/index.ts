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
import type { SpawnRequest, SpawnResult } from '../bridge/types.js';
import { getShadowForAgent } from '../bridge/shadow-config.js';
import { selectShadowCli } from '../bridge/shadow-cli.js';
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
  .option('--dashboard-port <port>', 'Dashboard port for spawn/release API (auto-detected if not set)')
  .option('--shadow <name>', 'Spawn a shadow agent with this name that monitors the primary')
  .option('--shadow-role <role>', 'Shadow role: reviewer, auditor, or triggers (comma-separated: SESSION_END,CODE_WRITTEN,REVIEW_REQUEST,EXPLICIT_ASK,ALL_MESSAGES)')
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

    // Determine dashboard port for spawn/release API
    // Priority: CLI flag > env var > auto-detect default port
    let dashboardPort: number | undefined;
    if (options.dashboardPort) {
      dashboardPort = parseInt(options.dashboardPort, 10);
    } else {
      // Try to detect if dashboard is running at default port
      const defaultPort = parseInt(DEFAULT_DASHBOARD_PORT, 10);
      try {
        const response = await fetch(`http://localhost:${defaultPort}/api/status`, {
          method: 'GET',
          signal: AbortSignal.timeout(500), // Quick timeout for detection
        });
        if (response.ok) {
          dashboardPort = defaultPort;
          console.error(`Dashboard detected: http://localhost:${dashboardPort}`);
        }
      } catch {
        // Dashboard not running - spawn/release will use fallback callbacks
      }
    }

    // Create spawner as fallback for direct spawn (if dashboard API not available)
    const spawner = new AgentSpawner(paths.projectRoot, undefined, dashboardPort);

    const wrapper = new TmuxWrapper({
      name: agentName,
      command: mainCommand,
      args: finalArgs,
      socketPath: paths.socketPath,
      debug: false,  // Use -q to keep quiet (debug off by default)
      relayPrefix: options.prefix,
      useInbox: true,
      inboxDir: paths.dataDir, // Use the project-specific data directory for the inbox
      // Use dashboard API for spawn/release when available (preferred - works from any context)
      dashboardPort,
      // Wire up spawn/release callbacks as fallback (if no dashboardPort)
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
      await wrapper.stop();
      process.exit(0);
    });

    await wrapper.start();

    // Determine shadow configuration - CLI flags take precedence over config file
    type SpeakOnTrigger = 'SESSION_END' | 'CODE_WRITTEN' | 'REVIEW_REQUEST' | 'EXPLICIT_ASK' | 'ALL_MESSAGES';
    let shadowName: string | undefined;
    let shadowRole: string | undefined;
    let speakOn: SpeakOnTrigger[] | undefined;
    let shadowCli: string | undefined;
    let shadowPrompt: string | undefined;

    const rolePresets: Record<string, SpeakOnTrigger[]> = {
      reviewer: ['CODE_WRITTEN', 'REVIEW_REQUEST', 'EXPLICIT_ASK'],
      auditor: ['SESSION_END', 'EXPLICIT_ASK'],
      active: ['ALL_MESSAGES'],
    };

    if (options.shadow) {
      // CLI flags provided
      shadowName = options.shadow;
      const role = options.shadowRole || 'EXPLICIT_ASK';
      shadowRole = role;

      if (rolePresets[role.toLowerCase()]) {
        speakOn = rolePresets[role.toLowerCase()];
      } else {
        speakOn = role.split(',').map((s: string) => s.trim().toUpperCase()) as SpeakOnTrigger[];
      }
    } else {
      // Check config file for shadow configuration
      const shadowConfig = getShadowForAgent(paths.projectRoot, agentName);
      if (shadowConfig) {
        shadowName = shadowConfig.shadowName;
        shadowRole = shadowConfig.roleName;
        speakOn = shadowConfig.speakOn;
        shadowCli = shadowConfig.cli;
        shadowPrompt = shadowConfig.prompt;
        console.error(`Shadow config: ${shadowName} (from .agent-relay.json)`);
      }
    }

    // Spawn shadow if configured
    if (shadowName && speakOn) {
      // Decide how to run the shadow (subagent for Claude/OpenCode primaries)
      let shadowSelection: Awaited<ReturnType<typeof selectShadowCli>> | null = null;
      try {
        shadowSelection = await selectShadowCli(mainCommand, { preferredShadowCli: shadowCli });
        console.error(
          `[shadow] Mode: ${shadowSelection.mode} via ${shadowSelection.command || shadowSelection.cli} (primary: ${mainCommand})`
        );
      } catch (err: any) {
        console.error(`[shadow] Shadow CLI selection failed: ${err.message}`);
      }

      // Subagent mode: do not spawn a separate shadow process
      if (shadowSelection?.mode === 'subagent') {
        console.error(
          `[shadow] ${shadowName} will run as ${shadowSelection.cli} subagent inside ${agentName}; no separate process spawned`
        );
        return;
      }

      console.error(`Shadow: ${shadowName} (shadowing ${agentName}, speakOn: ${speakOn.join(',')})`);

      // Wait for primary to register before spawning shadow
      await new Promise(r => setTimeout(r, 3000));

      // Build shadow task prompt
      const defaultPrompt = `You are a shadow agent monitoring "${agentName}". You receive copies of their messages. Your role: ${shadowRole || 'observer'}. Stay passive unless your triggers activate.`;
      const shadowTask = shadowPrompt || defaultPrompt;

      const result = await spawner.spawn({
        name: shadowName,
        cli: shadowSelection?.command || shadowCli || mainCommand,
        task: shadowTask,
        shadowOf: agentName,
        shadowSpeakOn: speakOn,
      });

      if (result.success) {
        console.error(`Shadow ${shadowName} started [pid: ${result.pid}]`);
      } else {
        console.error(`Failed to spawn shadow ${shadowName}: ${result.error}`);
      }
    }
  });

// up - Start daemon + dashboard
program
  .command('up')
  .description('Start daemon + dashboard')
  .option('--no-dashboard', 'Disable web dashboard')
  .option('--port <port>', 'Dashboard port', DEFAULT_DASHBOARD_PORT)
  .option('--spawn', 'Force spawn all agents from teams.json')
  .option('--no-spawn', 'Do not auto-spawn agents (just start daemon)')
  .option('--watch', 'Auto-restart daemon on crash (supervisor mode)')
  .option('--max-restarts <n>', 'Max restarts in 60s before giving up (default: 5)', '5')
  .action(async (options) => {
    // If --watch is specified, run in supervisor mode
    if (options.watch) {
      const { spawn } = await import('node:child_process');
      const maxRestarts = parseInt(options.maxRestarts, 10) || 5;
      const restartWindow = 60_000; // 60 seconds
      const restartTimes: number[] = [];
      let child: ReturnType<typeof spawn> | null = null;
      let shuttingDown = false;

      const startDaemon = (): void => {
        // Build args without --watch to prevent infinite recursion
        const args = ['up'];
        if (options.dashboard === false) args.push('--no-dashboard');
        if (options.port) args.push('--port', options.port);
        if (options.spawn === true) args.push('--spawn');
        if (options.spawn === false) args.push('--no-spawn');

        console.log(`[supervisor] Starting daemon...`);
        child = spawn(process.execPath, [process.argv[1], ...args], {
          stdio: 'inherit',
          env: { ...process.env, AGENT_RELAY_SUPERVISED: '1' },
        });

        child.on('exit', (code, signal) => {
          if (shuttingDown) {
            process.exit(0);
            return;
          }

          const now = Date.now();
          restartTimes.push(now);

          // Remove restarts outside the window
          while (restartTimes.length > 0 && restartTimes[0] < now - restartWindow) {
            restartTimes.shift();
          }

          if (restartTimes.length >= maxRestarts) {
            console.error(`[supervisor] Daemon crashed ${maxRestarts} times in ${restartWindow / 1000}s, giving up`);
            process.exit(1);
          }

          const exitReason = signal ? `signal ${signal}` : `code ${code}`;
          console.log(`[supervisor] Daemon exited (${exitReason}), restarting in 2s... (${restartTimes.length}/${maxRestarts} restarts)`);
          setTimeout(startDaemon, 2000);
        });
      };

      process.on('SIGINT', () => {
        console.log('\n[supervisor] Stopping...');
        shuttingDown = true;
        if (child) child.kill('SIGINT');
      });

      process.on('SIGTERM', () => {
        shuttingDown = true;
        if (child) child.kill('SIGTERM');
      });

      startDaemon();
      return;
    }
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

    // Track if we're already shutting down to prevent double-cleanup
    let isShuttingDown = false;

    const gracefulShutdown = async (reason: string): Promise<void> => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      console.log(`\n[daemon] ${reason}, shutting down...`);
      try {
        if (spawner) await spawner.releaseAll();
        await daemon.stop();
      } catch (err) {
        console.error('[daemon] Error during shutdown:', err);
      }
      process.exit(1);
    };

    // Handle uncaught exceptions - log and exit (supervisor will restart)
    process.on('uncaughtException', (err) => {
      console.error('[daemon] Uncaught exception:', err);
      gracefulShutdown('Uncaught exception');
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      console.error('[daemon] Unhandled rejection at:', promise, 'reason:', reason);
      // Don't exit on unhandled rejections - just log them
      // Most are recoverable (e.g., failed message delivery)
    });

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

        // Hook daemon log output to dashboard WebSocket
        daemon.onLogOutput = (agentName, data, _timestamp) => {
          const broadcast = (global as any).__broadcastLogOutput;
          if (broadcast) {
            broadcast(agentName, data);
          }
        };
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
  .option('--remote', 'Include agents from other linked machines (requires cloud link)')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const { getProjectPaths } = await import('../utils/project-namespace.js');
    const os = await import('node:os');
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
      location?: string; // 'local' or daemon name for remote
      daemonId?: string;
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
        location: 'local',
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
          location: 'local',
        });
      }
    });

    // Include remote agents if --remote flag is set
    if (options.remote) {
      const dataDir = process.env.AGENT_RELAY_DATA_DIR ||
        path.join(os.homedir(), '.local', 'share', 'agent-relay');
      const configPath = path.join(dataDir, 'cloud-config.json');

      if (fs.existsSync(configPath)) {
        try {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          const response = await fetch(`${config.cloudUrl}/api/daemons/agents`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${config.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ agents: [] }),
          });

          if (response.ok) {
            const data = await response.json() as {
              allAgents: Array<{
                name: string;
                status: string;
                daemonId: string;
                daemonName: string;
              }>;
            };

            // Add remote agents (exclude local ones by name)
            const localNames = new Set(combined.map(a => a.name));
            for (const agent of data.allAgents) {
              if (!localNames.has(agent.name)) {
                combined.push({
                  name: agent.name,
                  status: agent.status.toUpperCase(),
                  cli: '-',
                  location: agent.daemonName,
                  daemonId: agent.daemonId,
                });
              }
            }
          }
        } catch (err) {
          console.error('[warn] Failed to fetch remote agents:', (err as Error).message);
        }
      } else {
        console.error('[warn] Cloud not linked. Run `agent-relay cloud link` to see remote agents.');
      }
    }

    if (options.json) {
      console.log(JSON.stringify(combined, null, 2));
      return;
    }

    if (!combined.length) {
      const hint = options.all ? '' : ' (use --all to include internal/cli agents)';
      console.log(`No agents found. Ensure the daemon is running and agents are connected${hint}.`);
      return;
    }

    const hasRemote = combined.some(a => a.location !== 'local');
    if (hasRemote) {
      console.log('NAME            STATUS   CLI       LOCATION');
      console.log('─'.repeat(55));
      combined.forEach((agent) => {
        const name = agent.name.padEnd(15);
        const status = agent.status.padEnd(8);
        const cli = agent.cli.padEnd(9);
        const location = agent.location ?? 'local';
        console.log(`${name} ${status} ${cli} ${location}`);
      });
    } else {
      console.log('NAME            STATUS   CLI       TEAM');
      console.log('─'.repeat(50));
      combined.forEach((agent) => {
        const name = agent.name.padEnd(15);
        const status = agent.status.padEnd(8);
        const cli = agent.cli.padEnd(9);
        const team = agent.team ?? '-';
        console.log(`${name} ${status} ${cli} ${team}`);
      });
    }

    if (workers.length > 0) {
      console.log('');
      console.log('Commands:');
      console.log('  agent-relay agents:logs <name>   - View spawned agent output');
      console.log('  agent-relay agents:kill <name>   - Kill a spawned agent');
    }

    if (!options.remote) {
      console.log('');
      console.log('Tip: Use --remote to include agents from other linked machines.');
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
  .option('--architect [cli]', 'Spawn an architect agent to coordinate all projects (default: claude)')
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
    console.log('  ->relay:projectId:agent Message');
    console.log('  ->relay:*:lead Broadcast to all leads');
    console.log('');

    // Spawn architect agent if --architect flag is set
    let architectWrapper: any = null;
    if (options.architect !== undefined) {
      const { TmuxWrapper } = await import('../wrapper/tmux-wrapper.js');

      // Determine CLI to use (default to claude)
      const architectCli = typeof options.architect === 'string' ? options.architect : 'claude';

      // Use first project as the base for the architect
      const baseProject = valid[0];
      const basePaths = getProjectPaths(baseProject.path);

      // Build project context for the architect
      const projectContext = valid.map(p => `- ${p.id}: ${p.path} (Lead: ${p.leadName})`).join('\n');

      // Create architect system prompt
      const architectPrompt = `You are the Architect, a cross-project coordinator overseeing multiple codebases.

## Connected Projects
${projectContext}

## Your Role
- Coordinate high-level work across all projects
- Assign tasks to project leads
- Ensure consistency and resolve cross-project dependencies
- Review overall architecture decisions

## Cross-Project Messaging

Use this syntax to message agents in specific projects:

\`\`\`
->relay:${valid[0].id}:${valid[0].leadName} <<<
Your message to this project's lead>>>

->relay:${valid.length > 1 ? valid[1].id : valid[0].id}:* <<<
Broadcast to all agents in a project>>>

->relay:*:* <<<
Broadcast to ALL agents in ALL projects>>>
\`\`\`

Format: \`->relay:project-id:agent-name\`

## Getting Started
1. Check in with each project lead to understand current status
2. Identify cross-project dependencies
3. Coordinate work across teams

Start by greeting the project leads and asking for status updates.`;

      console.log('Spawning Architect agent...');
      console.log(`  CLI: ${architectCli}`);
      console.log(`  Base project: ${baseProject.path}`);
      console.log('');

      // Determine command and args based on CLI
      let command: string;
      let args: string[] = [];

      if (architectCli === 'claude' || architectCli.startsWith('claude:')) {
        command = 'claude';
        args = ['--dangerously-skip-permissions'];
        // Add model if specified (e.g., claude:opus)
        if (architectCli.includes(':')) {
          const model = architectCli.split(':')[1];
          args.push('--model', model);
        }
      } else if (architectCli === 'codex') {
        command = 'codex';
        args = ['--dangerously-skip-permissions'];
      } else {
        command = architectCli;
      }

      try {
        architectWrapper = new TmuxWrapper({
          name: 'Architect',
          command,
          args,
          socketPath: basePaths.socketPath,
          debug: false,
          useInbox: true,
          inboxDir: basePaths.dataDir,
        });

        await architectWrapper.start();

        // Wait for agent to be ready, then inject the prompt
        setTimeout(async () => {
          try {
            await architectWrapper.injectMessage(architectPrompt);
            console.log('Architect agent started and initialized.');
            console.log('Attach to session: tmux attach -t relay-Architect');
            console.log('');
          } catch (err) {
            console.error('Failed to inject architect prompt:', err);
          }
        }, 3000);

      } catch (err) {
        console.error('Failed to spawn Architect agent:', err);
      }
    }

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

// spawn - Spawn an agent via API (works from any context, no tmux required)
program
  .command('spawn', { hidden: true })
  .description('Spawn an agent via dashboard API (no tmux required, works in containers)')
  .argument('<name>', 'Agent name')
  .argument('<cli>', 'CLI to use (claude, codex, gemini, etc.)')
  .argument('[task]', 'Task description (can also be piped via stdin)')
  .option('--port <port>', 'Dashboard port', DEFAULT_DASHBOARD_PORT)
  .option('--team <team>', 'Team name for the agent')
  .option('--spawner <name>', 'Name of the agent requesting the spawn (for policy enforcement)')
  .option('--interactive', 'Disable auto-accept of permission prompts (for auth setup flows)')
  .option('--cwd <path>', 'Working directory for the agent')
  .option('--shadow-mode <mode>', 'Shadow execution mode: subagent or process')
  .option('--shadow-of <name>', 'Primary agent to shadow (if this agent is a shadow)')
  .option('--shadow-agent <profile>', 'Shadow agent profile to use')
  .option('--shadow-triggers <triggers>', 'When to trigger shadow (comma-separated: SESSION_END,CODE_WRITTEN,REVIEW_REQUEST,EXPLICIT_ASK,ALL_MESSAGES)')
  .option('--shadow-speak-on <triggers>', 'When shadow should speak (comma-separated, same values as --shadow-triggers)')
  .action(async (name: string, cli: string, task: string | undefined, options: {
    port?: string;
    team?: string;
    spawner?: string;
    interactive?: boolean;
    cwd?: string;
    shadowMode?: string;
    shadowOf?: string;
    shadowAgent?: string;
    shadowTriggers?: string;
    shadowSpeakOn?: string;
  }) => {
    const port = options.port || DEFAULT_DASHBOARD_PORT;

    // Read task from stdin if not provided as argument
    let finalTask = task;
    if (!finalTask && !process.stdin.isTTY) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      finalTask = Buffer.concat(chunks).toString('utf-8').trim();
    }

    if (!finalTask) {
      console.error('Error: Task description required (as argument or via stdin)');
      process.exit(1);
    }

    // Validate shadow mode if provided
    if (options.shadowMode && !['subagent', 'process'].includes(options.shadowMode)) {
      console.error('Error: --shadow-mode must be "subagent" or "process"');
      process.exit(1);
    }

    // Parse comma-separated trigger lists
    const parseTriggers = (value: string | undefined) => {
      if (!value) return undefined;
      const validTriggers = ['SESSION_END', 'CODE_WRITTEN', 'REVIEW_REQUEST', 'EXPLICIT_ASK', 'ALL_MESSAGES'];
      const triggers = value.split(',').map(t => t.trim().toUpperCase());
      const invalid = triggers.filter(t => !validTriggers.includes(t));
      if (invalid.length > 0) {
        console.error(`Error: Invalid triggers: ${invalid.join(', ')}`);
        console.error(`Valid triggers: ${validTriggers.join(', ')}`);
        process.exit(1);
      }
      return triggers as Array<'SESSION_END' | 'CODE_WRITTEN' | 'REVIEW_REQUEST' | 'EXPLICIT_ASK' | 'ALL_MESSAGES'>;
    };

    try {
      // Build spawn request using the SpawnRequest type for consistency
      const spawnRequest: SpawnRequest = {
        name,
        cli,
        task: finalTask,
        team: options.team,
        spawnerName: options.spawner,
        interactive: options.interactive,
        cwd: options.cwd,
        shadowMode: options.shadowMode as 'subagent' | 'process' | undefined,
        shadowOf: options.shadowOf,
        shadowAgent: options.shadowAgent,
        shadowTriggers: parseTriggers(options.shadowTriggers),
        shadowSpeakOn: parseTriggers(options.shadowSpeakOn),
      };

      const response = await fetch(`http://localhost:${port}/api/spawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spawnRequest),
      });

      const result = await response.json() as SpawnResult;

      if (result.success) {
        console.log(`Spawned agent: ${name} (pid: ${result.pid})`);
        process.exit(0);
      } else {
        if (result.policyDecision) {
          console.error(`Policy denied spawn: ${result.policyDecision.reason}`);
          console.error(`Policy source: ${result.policyDecision.policySource}`);
        } else {
          console.error(`Failed to spawn ${name}: ${result.error || 'Unknown error'}`);
        }
        process.exit(1);
      }
    } catch (err: any) {
      if (err.code === 'ECONNREFUSED') {
        console.error(`Cannot connect to dashboard at port ${port}. Is the daemon running?`);
        console.log(`Run 'agent-relay up' to start the daemon.`);
      } else {
        console.error(`Failed to spawn ${name}: ${err.message}`);
      }
      process.exit(1);
    }
  });

// release - Release a spawned agent via API (works from any context, no terminal required)
program
  .command('release')
  .description('Release a spawned agent via API (no terminal required)')
  .argument('<name>', 'Agent name to release')
  .option('--port <port>', 'Dashboard port', DEFAULT_DASHBOARD_PORT)
  .action(async (name: string, options: { port?: string }) => {
    const port = options.port || DEFAULT_DASHBOARD_PORT;

    try {
      const response = await fetch(`http://localhost:${port}/api/spawned/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });

      const result = await response.json() as { success: boolean; error?: string };

      if (result.success) {
        console.log(`Released agent: ${name}`);
        process.exit(0);
      } else {
        console.error(`Failed to release ${name}: ${result.error || 'Unknown error'}`);
        process.exit(1);
      }
    } catch (err: any) {
      // If API call fails, try to provide helpful error message
      if (err.code === 'ECONNREFUSED') {
        console.error(`Cannot connect to dashboard at port ${port}. Is the daemon running?`);
        console.log(`Run 'agent-relay up' to start the daemon.`);
      } else {
        console.error(`Failed to release ${name}: ${err.message}`);
      }
      process.exit(1);
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

// ============================================================================
// Cloud commands
// ============================================================================

const cloudCommand = program
  .command('cloud')
  .description('Cloud account and sync commands');

cloudCommand
  .command('link')
  .description('Link this machine to your Agent Relay Cloud account')
  .option('--name <name>', 'Name for this machine')
  .option('--cloud-url <url>', 'Cloud API URL', process.env.AGENT_RELAY_CLOUD_URL || 'https://agent-relay.com')
  .action(async (options) => {
    const os = await import('node:os');
    const crypto = await import('node:crypto');
    const readline = await import('node:readline');

    const cloudUrl = options.cloudUrl;
    const machineName = options.name || os.hostname();

    // Generate machine ID
    const dataDir = process.env.AGENT_RELAY_DATA_DIR ||
      path.join(os.homedir(), '.local', 'share', 'agent-relay');
    const machineIdPath = path.join(dataDir, 'machine-id');
    const configPath = path.join(dataDir, 'cloud-config.json');

    let machineId: string;
    if (fs.existsSync(machineIdPath)) {
      machineId = fs.readFileSync(machineIdPath, 'utf-8').trim();
    } else {
      machineId = `${os.hostname()}-${crypto.randomBytes(8).toString('hex')}`;
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(machineIdPath, machineId);
    }

    console.log('');
    console.log('🔗 Agent Relay Cloud - Link Machine');
    console.log('');
    console.log(`Machine: ${machineName}`);
    console.log(`ID: ${machineId}`);
    console.log('');

    // Generate a temporary code for the browser auth flow
    const tempCode = crypto.randomBytes(16).toString('hex');

    // Store temp code for callback
    const tempCodePath = path.join(dataDir, '.link-code');
    fs.writeFileSync(tempCodePath, tempCode);

    const authUrl = `${cloudUrl.replace('/api', '')}/cloud/link?code=${tempCode}&machine=${encodeURIComponent(machineId)}&name=${encodeURIComponent(machineName)}`;

    console.log('Open this URL in your browser to authenticate:');
    console.log('');
    console.log(`  ${authUrl}`);
    console.log('');

    // Try to open browser automatically
    try {
      const openCommand = process.platform === 'darwin' ? 'open' :
                          process.platform === 'win32' ? 'start' : 'xdg-open';
      await execAsync(`${openCommand} "${authUrl}"`);
      console.log('(Browser opened automatically)');
    } catch {
      console.log('(Copy the URL above and paste it in your browser)');
    }

    console.log('');
    console.log('After authenticating, paste your API key here:');

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const apiKey = await new Promise<string>((resolve) => {
      rl.question('API Key: ', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });

    if (!apiKey || !apiKey.startsWith('ar_live_')) {
      console.error('');
      console.error('Invalid API key format. Expected ar_live_...');
      process.exit(1);
    }

    // Verify the API key works
    console.log('');
    console.log('Verifying API key...');

    try {
      const response = await fetch(`${cloudUrl}/api/daemons/heartbeat`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          agents: [],
          metrics: { linkedAt: new Date().toISOString() },
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`Failed to verify API key: ${error}`);
        process.exit(1);
      }

      // Save config
      const config = {
        apiKey,
        cloudUrl,
        machineId,
        machineName,
        linkedAt: new Date().toISOString(),
      };

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      fs.chmodSync(configPath, 0o600); // Secure the file

      // Clean up temp code
      if (fs.existsSync(tempCodePath)) {
        fs.unlinkSync(tempCodePath);
      }

      console.log('');
      console.log('✓ Machine linked successfully!');
      console.log('');
      console.log('Your daemon will now sync with Agent Relay Cloud.');
      console.log('Run `agent-relay up` to start with cloud sync enabled.');
      console.log('');
    } catch (err: any) {
      console.error(`Failed to connect to cloud: ${err.message}`);
      process.exit(1);
    }
  });

cloudCommand
  .command('unlink')
  .description('Unlink this machine from Agent Relay Cloud')
  .action(async () => {
    const os = await import('node:os');

    const dataDir = process.env.AGENT_RELAY_DATA_DIR ||
      path.join(os.homedir(), '.local', 'share', 'agent-relay');
    const configPath = path.join(dataDir, 'cloud-config.json');

    if (!fs.existsSync(configPath)) {
      console.log('This machine is not linked to Agent Relay Cloud.');
      return;
    }

    // Read current config
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // Delete config file
    fs.unlinkSync(configPath);

    console.log('');
    console.log('✓ Machine unlinked from Agent Relay Cloud');
    console.log('');
    console.log(`Machine ID: ${config.machineId}`);
    console.log(`Was linked since: ${config.linkedAt}`);
    console.log('');
    console.log('Note: The API key has been removed locally. To fully revoke access,');
    console.log('visit your Agent Relay Cloud dashboard and remove this machine.');
    console.log('');
  });

cloudCommand
  .command('status')
  .description('Show cloud sync status')
  .action(async () => {
    const os = await import('node:os');

    const dataDir = process.env.AGENT_RELAY_DATA_DIR ||
      path.join(os.homedir(), '.local', 'share', 'agent-relay');
    const configPath = path.join(dataDir, 'cloud-config.json');

    if (!fs.existsSync(configPath)) {
      console.log('');
      console.log('Cloud sync: Not configured');
      console.log('');
      console.log('Run `agent-relay cloud link` to connect to Agent Relay Cloud.');
      console.log('');
      return;
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    console.log('');
    console.log('Cloud sync: Enabled');
    console.log('');
    console.log(`  Machine: ${config.machineName}`);
    console.log(`  ID: ${config.machineId}`);
    console.log(`  Cloud URL: ${config.cloudUrl}`);
    console.log(`  Linked: ${new Date(config.linkedAt).toLocaleString()}`);
    console.log('');

    // Check if daemon is running and connected
    const { getProjectPaths } = await import('../utils/project-namespace.js');
    const paths = getProjectPaths();

    if (fs.existsSync(paths.socketPath)) {
      console.log('  Daemon: Running');

      // Try to get cloud sync status from daemon
      try {
        const response = await fetch(`${config.cloudUrl}/api/daemons/heartbeat`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ agents: [], metrics: {} }),
        });

        if (response.ok) {
          console.log('  Cloud connection: Online');
        } else {
          console.log('  Cloud connection: Error (API key may be invalid)');
        }
      } catch (err: any) {
        console.log(`  Cloud connection: Offline (${err.message})`);
      }
    } else {
      console.log('  Daemon: Not running');
      console.log('  Cloud connection: Offline (daemon not started)');
    }

    console.log('');
  });

cloudCommand
  .command('sync')
  .description('Manually sync credentials from cloud')
  .action(async () => {
    const os = await import('node:os');

    const dataDir = process.env.AGENT_RELAY_DATA_DIR ||
      path.join(os.homedir(), '.local', 'share', 'agent-relay');
    const configPath = path.join(dataDir, 'cloud-config.json');

    if (!fs.existsSync(configPath)) {
      console.error('Not linked to cloud. Run `agent-relay cloud link` first.');
      process.exit(1);
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    console.log('Syncing credentials from cloud...');

    try {
      const response = await fetch(`${config.cloudUrl}/api/daemons/credentials`, {
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
        },
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`Failed to sync: ${error}`);
        process.exit(1);
      }

      const data = await response.json() as { credentials: Array<{ provider: string; accessToken: string }> };

      console.log('');
      console.log(`Synced ${data.credentials.length} provider credentials:`);
      for (const cred of data.credentials) {
        console.log(`  - ${cred.provider}`);
      }

      // Save credentials locally for daemon to use
      const credentialsPath = path.join(dataDir, 'cloud-credentials.json');
      fs.writeFileSync(credentialsPath, JSON.stringify(data.credentials, null, 2));
      fs.chmodSync(credentialsPath, 0o600);

      console.log('');
      console.log('✓ Credentials synced successfully');
      console.log('');
    } catch (err: any) {
      console.error(`Failed to sync: ${err.message}`);
      process.exit(1);
    }
  });

// ============================================================================
// TRAJECTORY COMMANDS (trail proxy)
// ============================================================================

// trail - Proxy to trail CLI for trajectory tracking
program
  .command('trail')
  .description('Trajectory tracking commands (proxies to trail CLI)')
  .argument('[args...]', 'Arguments to pass to trail CLI')
  .allowUnknownOption()
  .action(async (args: string[]) => {
    const { spawn } = await import('node:child_process');
    const { getProjectPaths } = await import('../utils/project-namespace.js');
    const { getPrimaryTrajectoriesDir, ensureTrajectoriesDir } = await import('../trajectory/config.js');

    const paths = getProjectPaths();

    // Check if trail is available
    const trailCheck = spawn('which', ['trail'], { stdio: 'pipe' });
    const trailExists = await new Promise<boolean>((resolve) => {
      trailCheck.on('close', (code) => resolve(code === 0));
      trailCheck.on('error', () => resolve(false));
    });

    if (!trailExists) {
      console.error('trail CLI not found. Install with: npm install -g agent-trajectories');
      console.log('');
      console.log('The trail CLI provides trajectory tracking for agent work:');
      console.log('  trail start "<task>"         Start tracking a new trajectory');
      console.log('  trail status                 Show current trajectory status');
      console.log('  trail phase <phase>          Transition to PDERO phase');
      console.log('  trail decision "<choice>"    Record a decision');
      console.log('  trail complete               Complete the trajectory');
      console.log('  trail list                   List all trajectories');
      console.log('');
      console.log('PDERO phases: plan, design, execute, review, observe');
      process.exit(1);
    }

    // Get trajectory storage path based on config (respects opt-in/opt-out)
    // Uses TRAJECTORIES_DATA_DIR env var which trail CLI reads
    const trajectoriesDir = getPrimaryTrajectoriesDir(paths.projectRoot);
    ensureTrajectoriesDir(paths.projectRoot);

    // Spawn trail with the provided arguments
    const trailProc = spawn('trail', args, {
      cwd: paths.projectRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        // Trajectory env vars override parent shell settings
        // This ensures config-based TRAJECTORIES_DATA_DIR takes precedence
        TRAJECTORIES_PROJECT: paths.projectId,
        TRAJECTORIES_DATA_DIR: trajectoriesDir,
      },
    });

    trailProc.on('close', (code) => {
      process.exit(code ?? 0);
    });

    trailProc.on('error', (err) => {
      console.error(`Failed to run trail: ${err.message}`);
      process.exit(1);
    });
  });

cloudCommand
  .command('agents')
  .description('List agents across all linked machines')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const os = await import('node:os');

    const dataDir = process.env.AGENT_RELAY_DATA_DIR ||
      path.join(os.homedir(), '.local', 'share', 'agent-relay');
    const configPath = path.join(dataDir, 'cloud-config.json');

    if (!fs.existsSync(configPath)) {
      console.error('Not linked to cloud. Run `agent-relay cloud link` first.');
      process.exit(1);
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    try {
      // Get agents from cloud
      const response = await fetch(`${config.cloudUrl}/api/daemons/agents`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ agents: [] }), // Report no agents, just fetch list
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`Failed to fetch agents: ${error}`);
        process.exit(1);
      }

      const data = await response.json() as {
        allAgents: Array<{
          name: string;
          status: string;
          daemonId: string;
          daemonName: string;
          machineId: string;
        }>;
      };

      if (options.json) {
        console.log(JSON.stringify(data.allAgents, null, 2));
        return;
      }

      if (!data.allAgents.length) {
        console.log('No agents found across linked machines.');
        console.log('Make sure daemons are running on linked machines.');
        return;
      }

      console.log('');
      console.log('Agents across all linked machines:');
      console.log('');
      console.log('NAME            STATUS   DAEMON              MACHINE');
      console.log('─'.repeat(65));

      // Group by daemon
      const byDaemon = new Map<string, typeof data.allAgents>();
      for (const agent of data.allAgents) {
        const existing = byDaemon.get(agent.daemonName) || [];
        existing.push(agent);
        byDaemon.set(agent.daemonName, existing);
      }

      for (const [daemonName, agents] of byDaemon.entries()) {
        for (const agent of agents) {
          const name = agent.name.padEnd(15);
          const status = agent.status.padEnd(8);
          const daemon = daemonName.padEnd(18);
          const machine = agent.machineId.substring(0, 20);
          console.log(`${name} ${status} ${daemon} ${machine}`);
        }
      }

      console.log('');
      console.log(`Total: ${data.allAgents.length} agents on ${byDaemon.size} machines`);
      console.log('');
    } catch (err: any) {
      console.error(`Failed to fetch agents: ${err.message}`);
      process.exit(1);
    }
  });

cloudCommand
  .command('send')
  .description('Send a message to an agent on any linked machine')
  .argument('<agent>', 'Target agent name')
  .argument('<message>', 'Message to send')
  .option('--from <name>', 'Sender name', 'cli')
  .action(async (agent: string, message: string, options: { from: string }) => {
    const os = await import('node:os');

    const dataDir = process.env.AGENT_RELAY_DATA_DIR ||
      path.join(os.homedir(), '.local', 'share', 'agent-relay');
    const configPath = path.join(dataDir, 'cloud-config.json');

    if (!fs.existsSync(configPath)) {
      console.error('Not linked to cloud. Run `agent-relay cloud link` first.');
      process.exit(1);
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    console.log(`Sending message to ${agent}...`);

    try {
      // First, find which daemon the agent is on
      const agentsResponse = await fetch(`${config.cloudUrl}/api/daemons/agents`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ agents: [] }),
      });

      if (!agentsResponse.ok) {
        const error = await agentsResponse.text();
        console.error(`Failed to find agent: ${error}`);
        process.exit(1);
      }

      const agentsData = await agentsResponse.json() as {
        allAgents: Array<{
          name: string;
          status: string;
          daemonId: string;
          daemonName: string;
        }>;
      };

      const targetAgent = agentsData.allAgents.find(a => a.name === agent);
      if (!targetAgent) {
        console.error(`Agent "${agent}" not found.`);
        console.log('Available agents:');
        for (const a of agentsData.allAgents) {
          console.log(`  - ${a.name} (on ${a.daemonName})`);
        }
        process.exit(1);
      }

      // Send the message
      const sendResponse = await fetch(`${config.cloudUrl}/api/daemons/message`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          targetDaemonId: targetAgent.daemonId,
          targetAgent: agent,
          message: {
            from: options.from,
            content: message,
          },
        }),
      });

      if (!sendResponse.ok) {
        const error = await sendResponse.text();
        console.error(`Failed to send message: ${error}`);
        process.exit(1);
      }

      console.log('');
      console.log(`✓ Message sent to ${agent} on ${targetAgent.daemonName}`);
      console.log('');
    } catch (err: any) {
      console.error(`Failed to send message: ${err.message}`);
      process.exit(1);
    }
  });

cloudCommand
  .command('daemons')
  .description('List all linked daemon instances')
  .option('--json', 'Output as JSON')
  .action(async (_options) => {
    const os = await import('node:os');

    const dataDir = process.env.AGENT_RELAY_DATA_DIR ||
      path.join(os.homedir(), '.local', 'share', 'agent-relay');
    const configPath = path.join(dataDir, 'cloud-config.json');

    if (!fs.existsSync(configPath)) {
      console.error('Not linked to cloud. Run `agent-relay cloud link` first.');
      process.exit(1);
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    try {
      // Get daemons list (requires browser auth, so we use a workaround)
      // For now, just show what we know about our own daemon
      console.log('');
      console.log('Linked Daemon:');
      console.log('');
      console.log(`  Machine: ${config.machineName}`);
      console.log(`  ID: ${config.machineId}`);
      console.log(`  Cloud: ${config.cloudUrl}`);
      console.log(`  Linked: ${new Date(config.linkedAt).toLocaleString()}`);
      console.log('');
      console.log('Note: To see all linked daemons, visit your cloud dashboard.');
      console.log('');
    } catch (err: any) {
      console.error(`Failed: ${err.message}`);
      process.exit(1);
    }
  });

// ============================================================================
// Monitoring commands (metrics, health, profiler)
// ============================================================================

// metrics - Show agent memory metrics
program
  .command('metrics')
  .description('Show agent memory metrics and resource usage')
  .option('--agent <name>', 'Show metrics for specific agent')
  .option('--port <port>', 'Dashboard port', DEFAULT_DASHBOARD_PORT)
  .option('--json', 'Output as JSON')
  .option('--watch', 'Continuously update metrics')
  .option('--interval <ms>', 'Update interval for watch mode', '5000')
  .action(async (options: { agent?: string; port?: string; json?: boolean; watch?: boolean; interval?: string }) => {
    const port = options.port || DEFAULT_DASHBOARD_PORT;

    const fetchMetrics = async () => {
      try {
        const response = await fetch(`http://localhost:${port}/api/metrics/agents`);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return await response.json() as {
          agents: Array<{
            name: string;
            pid?: number;
            status: string;
            rssBytes?: number;
            cpuPercent?: number;
            trend?: string;
            alertLevel?: string;
            highWatermark?: number;
            uptimeMs?: number;
          }>;
          system: {
            totalMemory: number;
            freeMemory: number;
            heapUsed: number;
          };
        };
      } catch (err: any) {
        if (err.code === 'ECONNREFUSED') {
          console.error(`Cannot connect to dashboard at port ${port}. Is the daemon running?`);
          console.log(`Run 'agent-relay up' to start the daemon.`);
        } else {
          console.error(`Failed to fetch metrics: ${err.message}`);
        }
        process.exit(1);
      }
    };

    const formatBytes = (bytes: number): string => {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
      return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
    };

    const formatUptime = (ms: number): string => {
      if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
      if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
      return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
    };

    const displayMetrics = (data: Awaited<ReturnType<typeof fetchMetrics>>) => {
      let agents = data.agents;

      if (options.agent) {
        agents = agents.filter(a => a.name === options.agent);
        if (agents.length === 0) {
          console.error(`Agent "${options.agent}" not found`);
          return;
        }
      }

      if (options.json) {
        console.log(JSON.stringify({ agents, system: data.system }, null, 2));
        return;
      }

      if (options.watch) {
        // Clear screen for watch mode
        console.clear();
        console.log(`Agent Metrics (updating every ${options.interval}ms)  [Ctrl+C to stop]`);
        console.log(`System: ${formatBytes(data.system.heapUsed)} heap / ${formatBytes(data.system.freeMemory)} free`);
        console.log('');
      }

      if (agents.length === 0) {
        console.log('No agents with memory metrics.');
        console.log('Ensure agents are running and memory monitoring is enabled.');
        return;
      }

      console.log('AGENT           PID      MEMORY      CPU    TREND       ALERT     UPTIME');
      console.log('─'.repeat(75));

      for (const agent of agents) {
        const name = agent.name.padEnd(15);
        const pid = (agent.pid?.toString() || '-').padEnd(8);
        const memory = formatBytes(agent.rssBytes || 0).padEnd(11);
        const cpu = ((agent.cpuPercent?.toFixed(1) || '0') + '%').padEnd(6);
        const trend = (agent.trend || 'unknown').padEnd(11);
        const alertColors: Record<string, string> = {
          normal: 'normal',
          warning: '\x1b[33mwarning\x1b[0m',
          critical: '\x1b[31mcritical\x1b[0m',
          oom_imminent: '\x1b[31;1mOOM!\x1b[0m',
        };
        const alert = (alertColors[agent.alertLevel || 'normal'] || agent.alertLevel || '-').padEnd(9);
        const uptime = formatUptime(agent.uptimeMs || 0);

        console.log(`${name} ${pid} ${memory} ${cpu} ${trend} ${alert} ${uptime}`);
      }

      if (!options.watch) {
        console.log('');
        console.log(`Total: ${agents.length} agent(s)`);
        if (agents.some(a => a.alertLevel && a.alertLevel !== 'normal')) {
          console.log('');
          console.log('⚠️  Some agents have elevated memory usage. Run `agent-relay health` for details.');
        }
      }
    };

    if (options.watch) {
      const interval = parseInt(options.interval || '5000', 10);

      const update = async () => {
        try {
          const data = await fetchMetrics();
          displayMetrics(data);
        } catch {
          // Error already logged in fetchMetrics
        }
      };

      process.on('SIGINT', () => {
        console.log('\nStopped watching metrics.');
        process.exit(0);
      });

      await update();
      setInterval(update, interval);
    } else {
      const data = await fetchMetrics();
      displayMetrics(data);
    }
  });

// health - Show crash insights and system health
program
  .command('health')
  .description('Show system health, crash insights, and recommendations')
  .option('--port <port>', 'Dashboard port', DEFAULT_DASHBOARD_PORT)
  .option('--json', 'Output as JSON')
  .option('--crashes', 'Show recent crash history')
  .option('--alerts', 'Show unacknowledged alerts')
  .action(async (options: { port?: string; json?: boolean; crashes?: boolean; alerts?: boolean }) => {
    const port = options.port || DEFAULT_DASHBOARD_PORT;

    try {
      const response = await fetch(`http://localhost:${port}/api/metrics/health`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as {
        healthScore: number;
        summary: string;
        issues: Array<{ severity: string; message: string }>;
        recommendations: string[];
        crashes: Array<{
          id: string;
          agentName: string;
          crashedAt: string;
          likelyCause: string;
          summary: string;
        }>;
        alerts: Array<{
          id: string;
          agentName: string;
          alertType: string;
          message: string;
          createdAt: string;
        }>;
        stats: {
          totalCrashes24h: number;
          totalAlerts24h: number;
          agentCount: number;
        };
      };

      if (options.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      // Health score with color
      const scoreColor = data.healthScore >= 80 ? '\x1b[32m' : // Green
                         data.healthScore >= 50 ? '\x1b[33m' : // Yellow
                         '\x1b[31m'; // Red
      const resetColor = '\x1b[0m';

      console.log('');
      console.log('═══════════════════════════════════════════════════════════════');
      console.log(`  SYSTEM HEALTH: ${scoreColor}${data.healthScore}/100${resetColor}`);
      console.log('═══════════════════════════════════════════════════════════════');
      console.log('');
      console.log(`  ${data.summary}`);
      console.log('');

      // Show stats
      console.log(`  Agents: ${data.stats.agentCount}`);
      console.log(`  Crashes (24h): ${data.stats.totalCrashes24h}`);
      console.log(`  Alerts (24h): ${data.stats.totalAlerts24h}`);
      console.log('');

      // Show issues
      if (data.issues.length > 0) {
        console.log('  ISSUES:');
        for (const issue of data.issues) {
          const icon = issue.severity === 'critical' ? '🔴' :
                       issue.severity === 'high' ? '🟠' :
                       issue.severity === 'medium' ? '🟡' : '🔵';
          console.log(`    ${icon} ${issue.message}`);
        }
        console.log('');
      }

      // Show recommendations
      if (data.recommendations.length > 0) {
        console.log('  RECOMMENDATIONS:');
        for (const rec of data.recommendations) {
          console.log(`    → ${rec}`);
        }
        console.log('');
      }

      // Show crashes if requested
      if (options.crashes && data.crashes.length > 0) {
        console.log('  RECENT CRASHES:');
        console.log('  ─────────────────────────────────────────────────────────────');
        for (const crash of data.crashes.slice(0, 10)) {
          const time = new Date(crash.crashedAt).toLocaleString();
          console.log(`    ${crash.agentName} - ${time}`);
          console.log(`      Cause: ${crash.likelyCause} | ${crash.summary.slice(0, 60)}...`);
        }
        console.log('');
      }

      // Show alerts if requested
      if (options.alerts && data.alerts.length > 0) {
        console.log('  UNACKNOWLEDGED ALERTS:');
        console.log('  ─────────────────────────────────────────────────────────────');
        for (const alert of data.alerts.slice(0, 10)) {
          const _time = new Date(alert.createdAt).toLocaleString();
          const icon = alert.alertType === 'oom_imminent' ? '🔴' :
                       alert.alertType === 'critical' ? '🟠' : '🟡';
          console.log(`    ${icon} ${alert.agentName} - ${alert.alertType}`);
          console.log(`      ${alert.message}`);
        }
        console.log('');
      }

      console.log('═══════════════════════════════════════════════════════════════');
      console.log('');

      if (!options.crashes && data.stats.totalCrashes24h > 0) {
        console.log('  Tip: Run `agent-relay health --crashes` to see crash details');
      }
      if (!options.alerts && data.stats.totalAlerts24h > 0) {
        console.log('  Tip: Run `agent-relay health --alerts` to see alerts');
      }
      console.log('');

    } catch (err: any) {
      if (err.code === 'ECONNREFUSED') {
        console.error(`Cannot connect to dashboard at port ${port}. Is the daemon running?`);
        console.log(`Run 'agent-relay up' to start the daemon.`);
      } else {
        console.error(`Failed to fetch health data: ${err.message}`);
      }
      process.exit(1);
    }
  });

// profile - Run agent with profiling enabled
program
  .command('profile')
  .description('Run an agent with memory profiling enabled')
  .argument('<command...>', 'Command to profile')
  .option('-n, --name <name>', 'Agent name')
  .option('--heap-snapshot-interval <ms>', 'Take heap snapshots at interval (ms)', '60000')
  .option('--output-dir <dir>', 'Directory for profile output', './profiles')
  .option('--expose-gc', 'Expose garbage collector for manual GC')
  .action(async (commandParts: string[], options: {
    name?: string;
    heapSnapshotInterval?: string;
    outputDir?: string;
    exposeGc?: boolean;
  }) => {
    const { getProjectPaths } = await import('../utils/project-namespace.js');

    if (!commandParts || commandParts.length === 0) {
      console.error('No command specified');
      process.exit(1);
    }

    const [cmd, ...args] = commandParts;
    const agentName = options.name ?? generateAgentName();
    const outputDir = options.outputDir || './profiles';
    const snapshotInterval = parseInt(options.heapSnapshotInterval || '60000', 10);

    // Create output directory
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    console.log('');
    console.log('🔬 Agent Relay Profiler');
    console.log('');
    console.log(`  Agent: ${agentName}`);
    console.log(`  Command: ${cmd} ${args.join(' ')}`);
    console.log(`  Output: ${outputDir}`);
    console.log(`  Heap snapshots: every ${snapshotInterval}ms`);
    console.log('');

    // Build Node.js flags for profiling
    const nodeFlags: string[] = [
      '--inspect',  // Enable inspector
      '--inspect-brk=0',  // Don't actually break, just enable
    ];

    if (options.exposeGc) {
      nodeFlags.push('--expose-gc');
    }

    // Set environment variables for profiling
    const profileEnv = {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} ${nodeFlags.join(' ')}`.trim(),
      AGENT_RELAY_PROFILE_ENABLED: '1',
      AGENT_RELAY_PROFILE_OUTPUT: outputDir,
      AGENT_RELAY_PROFILE_INTERVAL: snapshotInterval.toString(),
    };

    console.log('Starting profiled agent...');
    console.log('');

    // Use the regular wrapper but with profiling environment
    const paths = getProjectPaths();
    const { TmuxWrapper } = await import('../wrapper/tmux-wrapper.js');

    const wrapper = new TmuxWrapper({
      name: agentName,
      command: cmd,
      args,
      socketPath: paths.socketPath,
      debug: true,
      env: profileEnv,
      useInbox: true,
      inboxDir: paths.dataDir,
    });

    // Start memory sampling
    const sampleInterval = setInterval(() => {
      const memUsage = process.memoryUsage();
      const timestamp = new Date().toISOString();
      const sample = {
        timestamp,
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
        external: memUsage.external,
        rss: memUsage.rss,
      };

      // Append to samples file
      const samplesFile = path.join(outputDir, `${agentName}-memory.jsonl`);
      fs.appendFileSync(samplesFile, JSON.stringify(sample) + '\n');
    }, 5000);

    process.on('SIGINT', async () => {
      clearInterval(sampleInterval);
      console.log('\n');
      console.log('Profiling stopped.');
      console.log('');
      console.log(`Profile data saved to: ${outputDir}/`);
      console.log(`  - ${agentName}-memory.jsonl  (memory samples)`);
      console.log('');
      console.log('To analyze:');
      console.log(`  1. Open chrome://inspect in Chrome`);
      console.log(`  2. Load CPU/heap profiles from ${outputDir}/`);
      console.log('');
      wrapper.stop();
      process.exit(0);
    });

    await wrapper.start();
    console.log(`Profiling ${agentName}... Press Ctrl+C to stop.`);
  });

// ============================================================================
// codex-auth - SSH tunnel helper for Codex/OpenAI authentication
// ============================================================================

program
  .command('codex-auth')
  .description('Connect Codex via SSH tunnel to workspace (run this when connecting Codex in Agent Relay)')
  .option('--workspace <id>', 'Workspace ID to connect to')
  .option('--cloud-url <url>', 'Cloud API URL', process.env.AGENT_RELAY_CLOUD_URL || 'https://agent-relay.com')
  .option('--token <token>', 'CLI authentication token (from dashboard)')
  .option('--session-cookie <cookie>', 'Session cookie for authentication (deprecated, use --token)')
  .option('--timeout <seconds>', 'Timeout in seconds (default: 300)', '300')
  .action(async (options: { workspace?: string; cloudUrl: string; token?: string; sessionCookie?: string; timeout: string }) => {
    const TIMEOUT_MS = parseInt(options.timeout, 10) * 1000;
    const CLOUD_URL = options.cloudUrl.replace(/\/$/, '');
    const TUNNEL_PORT = 1455;

    // Colors for terminal output
    const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
    const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
    const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
    const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
    const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

    console.log('');
    console.log(cyan('═══════════════════════════════════════════════════'));
    console.log(cyan('       Codex Authentication Helper'));
    console.log(cyan('═══════════════════════════════════════════════════'));
    console.log('');

    if (!options.workspace) {
      console.log(red('Missing --workspace parameter.'));
      console.log('');
      console.log('To connect Codex, follow these steps:');
      console.log('');
      console.log('  1. Go to the Agent Relay dashboard');
      console.log('  2. Click "Connect with Codex" (Settings → AI Providers)');
      console.log('  3. Copy the command shown (it includes the workspace ID and token)');
      console.log('  4. Run the command in your terminal');
      console.log('');
      console.log('The command will look like:');
      console.log(cyan('  npx agent-relay codex-auth --workspace=<ID> --token=<TOKEN>'));
      console.log('');
      process.exit(1);
    }

    const workspaceId = options.workspace;
    console.log(`Workspace: ${workspaceId.slice(0, 8)}...`);

    // Get tunnel info from cloud API
    console.log('Getting workspace connection info...');

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.sessionCookie) {
      headers['Cookie'] = options.sessionCookie;
    }

    // Validate token is provided
    if (!options.token && !options.sessionCookie) {
      console.log(red('Missing --token parameter.'));
      console.log('');
      console.log('The token is provided by the dashboard when you click "Connect with Codex".');
      console.log('Copy the complete command from the dashboard and paste it here.');
      console.log('');
      process.exit(1);
    }

    let tunnelInfo: {
      host: string;
      port: number;
      user: string;
      password: string;
      tunnelPort: number;
      workspaceName: string;
      authUrl?: string; // OAuth URL if provided by dashboard
    };

    try {
      // Build URL with token query parameter
      const tunnelInfoUrl = new URL(`${CLOUD_URL}/api/auth/codex-helper/tunnel-info/${workspaceId}`);
      if (options.token) {
        tunnelInfoUrl.searchParams.set('token', options.token);
      }

      const response = await fetch(tunnelInfoUrl.toString(), {
        method: 'GET',
        headers,
        credentials: 'include',
      });

      if (!response.ok) {
        const errorData = await response.json() as { error?: string };
        console.log(red(`Failed to get tunnel info: ${errorData.error || response.statusText}`));
        process.exit(1);
      }

      tunnelInfo = await response.json() as typeof tunnelInfo;
    } catch (err) {
      console.log(red(`Failed to connect to cloud API: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }

    console.log(`Workspace: ${cyan(tunnelInfo.workspaceName)}`);
    console.log('');

    // Establish SSH tunnel using ssh2 library (no external tools needed)
    console.log(yellow('Establishing SSH tunnel...'));
    console.log(dim(`  SSH: ${tunnelInfo.host}:${tunnelInfo.port}`));
    console.log(dim(`  Tunnel: localhost:${TUNNEL_PORT} → workspace:${tunnelInfo.tunnelPort}`));
    console.log('');

    const { Client } = await import('ssh2');
    const net = await import('node:net');

    const sshClient = new Client();
    // Use object to hold server reference (avoids TypeScript narrowing issues)
    const tunnel: { server: ReturnType<typeof net.createServer> | null } = { server: null };
    let tunnelReady = false;
    let tunnelError: string | null = null;

    // Create a promise that resolves when tunnel is ready or rejects on error
    const tunnelPromise = new Promise<void>((resolve, reject) => {
      sshClient.on('ready', () => {
        // Create local server that forwards connections through SSH
        tunnel.server = net.createServer((localSocket) => {
          sshClient.forwardOut(
            '127.0.0.1',
            TUNNEL_PORT,
            'localhost',
            tunnelInfo.tunnelPort,
            (err, stream) => {
              if (err) {
                localSocket.end();
                return;
              }
              localSocket.pipe(stream).pipe(localSocket);
            }
          );
        });

        tunnel.server.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            tunnelError = `Port ${TUNNEL_PORT} is already in use. Close any other applications using this port.`;
          } else {
            tunnelError = err.message;
          }
          reject(new Error(tunnelError));
        });

        tunnel.server.listen(TUNNEL_PORT, '127.0.0.1', () => {
          tunnelReady = true;
          resolve();
        });
      });

      sshClient.on('error', (err) => {
        if (err.message.includes('Authentication')) {
          tunnelError = 'SSH authentication failed. Check the password.';
        } else if (err.message.includes('ECONNREFUSED')) {
          tunnelError = `Cannot connect to SSH server at ${tunnelInfo.host}:${tunnelInfo.port}. Is the workspace running and SSH enabled?`;
        } else if (err.message.includes('ENOTFOUND') || err.message.includes('getaddrinfo')) {
          tunnelError = `Cannot resolve hostname: ${tunnelInfo.host}. Check network connectivity.`;
        } else if (err.message.includes('ETIMEDOUT')) {
          tunnelError = `Connection timed out to ${tunnelInfo.host}:${tunnelInfo.port}. Is the workspace running?`;
        } else {
          tunnelError = `SSH error: ${err.message}`;
        }
        reject(new Error(tunnelError));
      });

      sshClient.on('close', () => {
        if (!tunnelReady) {
          // Only set error if not already set by error handler
          if (!tunnelError) {
            tunnelError = `SSH connection to ${tunnelInfo.host}:${tunnelInfo.port} closed unexpectedly. The workspace may not have SSH enabled or the port may be blocked.`;
          }
          reject(new Error(tunnelError));
        }
      });

      // Connect to SSH server
      sshClient.connect({
        host: tunnelInfo.host,
        port: tunnelInfo.port,
        username: tunnelInfo.user,
        password: tunnelInfo.password,
        readyTimeout: 10000,
        // Disable host key checking for simplicity (workspace containers)
        hostVerifier: () => true,
      });
    });

    // Wait for tunnel to establish
    try {
      await Promise.race([
        tunnelPromise,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('SSH connection timeout')), 15000)
        ),
      ]);
    } catch (err) {
      console.log(red(`Failed to establish tunnel: ${err instanceof Error ? err.message : String(err)}`));
      sshClient.end();
      process.exit(1);
    }

    console.log(green('✓ SSH tunnel established!'));
    console.log('');

    // Handle Ctrl+C gracefully
    const cleanup = () => {
      console.log('');
      console.log(dim('Shutting down...'));
      if (tunnel.server) {
        tunnel.server.close();
      }
      sshClient.end();
      process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    // Display the OAuth URL
    if (tunnelInfo.authUrl) {
      console.log('');
      console.log(green('Ready! Open this URL in your browser to complete authentication:'));
      console.log('');
      console.log(cyan(tunnelInfo.authUrl));
      console.log('');
      console.log(dim('The browser will redirect to localhost:1455, which tunnels to the workspace.'));
      console.log(dim('The Codex CLI in the workspace will receive the callback and complete auth.'));
      console.log('');
    } else {
      console.log('');
      console.log(yellow('OAuth URL not available. Please start authentication from the dashboard.'));
      console.log('');
    }

    // Poll for authentication completion
    console.log(cyan(`Waiting for authentication... (timeout: ${options.timeout}s)`));

    const startTime = Date.now();
    let authenticated = false;

    while (!authenticated && (Date.now() - startTime) < TIMEOUT_MS) {
      await new Promise(resolve => setTimeout(resolve, 3000));

      try {
        // Build URL with token for authentication
        const authStatusUrl = new URL(`${CLOUD_URL}/api/auth/codex-helper/auth-status/${workspaceId}`);
        if (options.token) {
          authStatusUrl.searchParams.set('token', options.token);
        }

        const statusResponse = await fetch(
          authStatusUrl.toString(),
          { method: 'GET', headers, credentials: 'include' }
        );

        if (statusResponse.ok) {
          const statusData = await statusResponse.json() as { authenticated: boolean };
          if (statusData.authenticated) {
            authenticated = true;
          }
        }
      } catch {
        // Ignore polling errors
      }

      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      if (!authenticated && elapsed > 0 && elapsed % 30 === 0) {
        console.log(`  Still waiting... (${elapsed}s)`);
      }
    }

    // Cleanup SSH tunnel
    if (tunnel.server) {
      tunnel.server.close();
    }
    sshClient.end();

    if (authenticated) {
      console.log('');
      console.log(green('═══════════════════════════════════════════════════'));
      console.log(green('          Authentication Complete!'));
      console.log(green('═══════════════════════════════════════════════════'));
      console.log('');
      console.log('Your Codex account is now connected to the workspace.');
      console.log('You can close this terminal and return to the dashboard.');
      console.log('');
    } else {
      console.log('');
      console.log(red('Timeout waiting for authentication.'));
      console.log('');
      console.log('If you completed sign-in, the workspace may not have received');
      console.log('the callback. Check if the SSH tunnel was working correctly.');
      process.exit(1);
    }
  });

program.parse();
