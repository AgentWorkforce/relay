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
  .option('--prefix <pattern>', 'Relay prefix pattern (default: >>relay:)')
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
