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
        const actualPort = await startDashboard(port, paths.dataDir, paths.teamDir, dbPath);
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
        console.log(`${ts} ${msg.from} -> ${msg.to}: ${body}`);
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

program.parse();
