#!/usr/bin/env node
/**
 * Agent Relay CLI
 *
 * Commands:
 *   relay <cmd>         - Wrap agent with real-time messaging (default)
 *   relay -n Name cmd   - Wrap with specific agent name
 *   relay up            - Start daemon + dashboard
 *   relay read <id>     - Read full message by ID
 */

import { Command } from 'commander';
import { config as dotenvConfig } from 'dotenv';
import { Daemon, DEFAULT_SOCKET_PATH } from '../daemon/server.js';
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
  .option('--prefix <pattern>', 'Relay prefix pattern (default: @relay: or >> for Gemini)')
  .argument('[command...]', 'Command to wrap (e.g., claude)')
  .action(async (commandParts, options) => {
    // If no command provided, show help
    if (!commandParts || commandParts.length === 0) {
      program.help();
      return;
    }

    const { getProjectPaths } = await import('../utils/project-namespace.js');
    const paths = getProjectPaths();

    const [mainCommand, ...commandArgs] = commandParts;
    const agentName = options.name ?? generateAgentName();

    console.error(`Agent: ${agentName}`);
    console.error(`Project: ${paths.projectId}`);

    const { TmuxWrapper } = await import('../wrapper/tmux-wrapper.js');

    const wrapper = new TmuxWrapper({
      name: agentName,
      command: mainCommand,
      args: commandArgs,
      socketPath: paths.socketPath,
      debug: !options.quiet,
      relayPrefix: options.prefix,
    });

    process.on('SIGINT', () => {
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
  .action(async (options) => {
    const { ensureProjectDir } = await import('../utils/project-namespace.js');

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
        const actualPort = await startDashboard(port, paths.teamDir, dbPath);
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

    // Connect to all project daemons
    const client = new MultiProjectClient(valid);

    try {
      await client.connect();
    } catch (err) {
      console.error('Failed to connect to all projects');
      process.exit(1);
    }

    console.log('Connected to all projects.');
    console.log('');
    console.log('Cross-project messaging:');
    console.log('  @relay:projectId:agent Message');
    console.log('  @relay:*:lead Broadcast to all leads');
    console.log('');

    // Handle messages from projects
    client.onMessage = (projectId, from, payload, messageId) => {
      console.log(`[${projectId}] ${from}: ${payload.body.substring(0, 80)}...`);
    };

    // Keep running
    process.on('SIGINT', () => {
      console.log('\nDisconnecting...');
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

    const paths = getProjectPaths();

    console.log('Lead Mode - Project Lead with Spawn Capability');
    console.log('─'.repeat(40));
    console.log(`Agent: ${name}`);
    console.log(`Project: ${paths.projectId}`);
    console.log(`CLI: ${cli}`);
    console.log('');
    console.log('Spawn workers with:');
    console.log('  @relay:spawn WorkerName cli "task"');
    console.log('Release workers with:');
    console.log('  @relay:release WorkerName');
    console.log('');

    // Create spawner for this project
    const spawner = new AgentSpawner(paths.projectRoot);

    // Parse CLI for model variant (e.g., claude:opus)
    const [mainCommand, ...commandArgs] = cli.split(':');

    const wrapper = new TmuxWrapper({
      name,
      command: mainCommand,
      args: commandArgs.length > 0 ? commandArgs : undefined,
      socketPath: paths.socketPath,
      debug: true,
    });

    // Extend wrapper to handle spawn/release commands
    // This will be done via parser extension

    process.on('SIGINT', async () => {
      console.log('\nReleasing workers...');
      await spawner.releaseAll();
      wrapper.stop();
      process.exit(0);
    });

    await wrapper.start();
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
        const match = name.match(/^relay-(.+)-\d+$/);
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

program.parse();
