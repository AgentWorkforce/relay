#!/usr/bin/env node
/**
 * Agent Relay CLI
 * Command-line interface for agent-relay.
 */

import { Command } from 'commander';
import { config as dotenvConfig } from 'dotenv';
import { Daemon, DEFAULT_SOCKET_PATH } from '../daemon/server.js';
import { RelayClient } from '../wrapper/client.js';
import { generateAgentName } from '../utils/name-generator.js';
import { Supervisor } from '../supervisor/supervisor.js';
import { setupTicTacToe } from '../games/tictactoe.js';
import type { CLIType } from '../supervisor/types.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Load .env file if present
dotenvConfig();

// Default dashboard port (can be overridden via .env or CLI)
const DEFAULT_DASHBOARD_PORT = process.env.AGENT_RELAY_DASHBOARD_PORT || '3888';

const program = new Command();

function pidFilePathForSocket(socketPath: string): string {
  return `${socketPath}.pid`;
}

function supervisorPidFilePath(dataDir: string): string {
  return path.join(dataDir, 'supervisor.pid');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(pidPath: string): number | null {
  try {
    if (!fs.existsSync(pidPath)) return null;
    const raw = fs.readFileSync(pidPath, 'utf-8').trim();
    const pid = Number(raw);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

function startDetachedSupervisor(options: {
  socket: string;
  dataDir: string;
  pollInterval: number;
  verbose: boolean;
}): number {
  const pidPath = supervisorPidFilePath(options.dataDir);

  const existingPid = readPidFile(pidPath);
  if (existingPid && isProcessAlive(existingPid)) {
    return existingPid;
  }

  // process.argv[1] points to the current CLI entrypoint (dist/cli/index.js in normal usage).
  const cliEntrypoint = process.argv[1];
  if (!cliEntrypoint) {
    throw new Error('Unable to determine CLI entrypoint path for supervisor spawn');
  }

  fs.mkdirSync(options.dataDir, { recursive: true });

  const child = spawn(
    process.execPath,
    [
      cliEntrypoint,
      'supervisor',
      '-s',
      options.socket,
      '-d',
      options.dataDir,
      '-p',
      String(options.pollInterval),
      ...(options.verbose ? ['-v'] : []),
    ],
    {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    }
  );

  child.unref();
  fs.writeFileSync(pidPath, `${child.pid ?? ''}\n`, 'utf-8');
  return child.pid ?? -1;
}

function stopDetachedSupervisor(dataDir: string): { pid: number | null; stopped: boolean } {
  const pidPath = supervisorPidFilePath(dataDir);
  const pid = readPidFile(pidPath);
  if (!pid) return { pid: null, stopped: false };

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // process may already be dead
  }

  try {
    fs.unlinkSync(pidPath);
  } catch {
    // ignore
  }

  return { pid, stopped: true };
}

program
  .name('agent-relay')
  .description('Real-time agent-to-agent communication system')
  .version('0.1.0');

// Start daemon
program
  .command('start')
  .description('Start the relay daemon')
  .option('-s, --socket <path>', 'Socket path', DEFAULT_SOCKET_PATH)
  .option('-f, --foreground', 'Run in foreground', false)
  .option('--db-path <path>', 'SQLite DB path for message storage (defaults near socket)')
  .action(async (options) => {
    const socketPath = options.socket as string;
    const pidFilePath = pidFilePathForSocket(socketPath);
    const daemon = new Daemon({
      socketPath,
      pidFilePath,
      storagePath: options.dbPath ?? undefined,
    });

    // Handle shutdown
    process.on('SIGINT', async () => {
      console.log('\nShutting down...');
      await daemon.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await daemon.stop();
      process.exit(0);
    });

    try {
      await daemon.start();
      console.log('Daemon started. Press Ctrl+C to stop.');

      // Keep process alive
      if (options.foreground) {
        await new Promise(() => {}); // Never resolves
      }
    } catch (err) {
      console.error('Failed to start daemon:', err);
      process.exit(1);
    }
  });

// Stop daemon
program
  .command('stop')
  .description('Stop the relay daemon (and background supervisor if running)')
  .option('-s, --socket <path>', 'Socket path', DEFAULT_SOCKET_PATH)
  .option('-d, --data-dir <path>', 'Data directory (for supervisor pidfile)', '/tmp/agent-relay')
  .option('--daemon-only', 'Only stop the daemon (leave supervisor running)', false)
  .action(async (options) => {
    const socketPath = options.socket as string;
    const pidFilePath = pidFilePathForSocket(socketPath);

    // Stop supervisor first (best-effort) so it doesn't keep spawning while daemon stops.
    if (!options.daemonOnly) {
      const res = stopDetachedSupervisor(options.dataDir);
      if (res.pid) {
        console.log(`Supervisor stop requested (pid ${res.pid})`);
      }
    }

    if (!fs.existsSync(pidFilePath)) {
      console.log('Daemon not running (pid file not found)');
      return;
    }

    const pidRaw = fs.readFileSync(pidFilePath, 'utf-8').trim();
    const pid = Number(pidRaw);
    if (!Number.isFinite(pid) || pid <= 0) {
      console.error(`Invalid pid file: ${pidFilePath}`);
      return;
    }

    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      // Stale pid file
      console.warn(
        `Failed to signal pid ${pid} (${(err as Error).message}); cleaning up pid file`
      );
      fs.unlinkSync(pidFilePath);
    }

    // Wait briefly for socket/pid file cleanup
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const socketExists = fs.existsSync(socketPath);
      const pidExists = fs.existsSync(pidFilePath);
      if (!socketExists && !pidExists) {
        console.log('Daemon stopped');
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    console.warn('Stop requested, but daemon did not exit within 2s');
    console.warn(`Socket: ${socketPath}`);
    console.warn(`PID file: ${pidFilePath}`);
  });

// Wrap an agent
program
  .command('wrap')
  .description('Wrap an agent CLI command')
  .option('-n, --name <name>', 'Agent name (auto-generated if not provided)')
  .option('-s, --socket <path>', 'Socket path', DEFAULT_SOCKET_PATH)
  .option('-r, --raw', 'Raw mode - bypass parsing for terminal-heavy CLIs', false)
  .option('--pty', 'Use direct PTY mode (legacy)', false)
  .option('-t, --tmux', 'Use tmux for message injection (old implementation)', false)
  .option('-q, --quiet', 'Disable debug logging', false)
  .option('--log-interval <ms>', 'Throttle debug logs (ms)', (val) => parseInt(val, 10))
  .option('--inject-idle-ms <ms>', 'Idle time before injecting messages (ms)', (val) => parseInt(val, 10))
  .option('--inject-retry-ms <ms>', 'Retry interval while waiting to inject (ms)', (val) => parseInt(val, 10))
  .option('-o, --osascript', 'Use osascript for OS-level keyboard simulation (macOS)', false)
  .option('-i, --inbox', 'Use file-based inbox (agent reads messages from file)', false)
  .option('--inbox-dir <path>', 'Custom inbox directory', '/tmp/agent-relay')
  .argument('<command...>', 'Command to wrap')
  .action(async (commandParts, options) => {
    // For tmux2, we need to preserve args separately for proper quoting
    const [mainCommand, ...commandArgs] = commandParts;
    const command = commandParts.join(' ');

    // Auto-generate name if not provided
    const agentName = options.name ?? generateAgentName();
    process.stderr.write(`Agent name: ${agentName}\n`);
    // Determine mode - tmux is now the default
    const usePty = options.pty || options.tmux || options.osascript;

    if (options.inbox) {
      process.stderr.write(`Mode: inbox (file-based messaging)\n`);
    } else if (options.osascript) {
      process.stderr.write(`Mode: osascript (OS-level keyboard simulation)\n`);
    } else if (options.tmux) {
      process.stderr.write(`Mode: tmux (old implementation)\n`);
    } else if (options.pty) {
      process.stderr.write(`Mode: direct PTY (legacy)\n`);
    } else {
      process.stderr.write(`Mode: tmux (default)\n`);
    }

    // Use the new TmuxWrapper by default (unless --pty, --tmux, or --osascript specified)
    if (!usePty) {
      let TmuxWrapperClass: any;
      try {
        ({ TmuxWrapper: TmuxWrapperClass } = await import('../wrapper/tmux-wrapper.js'));
      } catch (err) {
        console.error('Failed to load TmuxWrapper.');
        console.error('Original error:', err);
        process.exit(1);
      }

      const wrapper = new TmuxWrapperClass({
        name: agentName,
        command: mainCommand,
        args: commandArgs,
        socketPath: options.socket,
        useInbox: options.inbox,
        inboxDir: options.inboxDir,
        debug: !options.quiet,
        debugLogIntervalMs: options.logInterval,
        idleBeforeInjectMs: options.injectIdleMs,
        injectRetryMs: options.injectRetryMs,
      });

      // Handle shutdown
      process.on('SIGINT', () => {
        wrapper.stop();
        process.exit(0);
      });

      try {
        await wrapper.start();
      } catch (err) {
        console.error('Failed to start tmux wrapper:', err);
        process.exit(1);
      }
      return;
    }

    // Use the original PtyWrapper
    let PtyWrapperClass: any;
    try {
      ({ PtyWrapper: PtyWrapperClass } = await import('../wrapper/pty-wrapper.js'));
    } catch (err) {
      console.error('Failed to load PTY wrapper dependencies (node-pty).');
      console.error('If you recently changed Node versions, rebuild native deps:');
      console.error('  npm rebuild node-pty');
      console.error('Original error:', err);
      process.exit(1);
    }

    const wrapper = new PtyWrapperClass({
      name: agentName,
      command,
      socketPath: options.socket,
      raw: options.raw,
      useTmux: options.tmux,
      useOsascript: options.osascript,
      useInbox: options.inbox,
      inboxDir: options.inboxDir,
    });

    // Handle shutdown
    process.on('SIGINT', () => {
      wrapper.stop();
      process.exit(0);
    });

    try {
      await wrapper.start();
    } catch (err) {
      console.error('Failed to start wrapper:', err);
      process.exit(1);
    }
  });

// Status
program
  .command('status')
  .description('Show relay daemon status')
  .option('-s, --socket <path>', 'Socket path', DEFAULT_SOCKET_PATH)
  .action(async (options) => {
    if (!fs.existsSync(options.socket)) {
      console.log('Status: STOPPED (socket not found)');
      return;
    }

    // Try to connect
    const client = new RelayClient({
      agentName: '__status_check__',
      socketPath: options.socket,
      reconnect: false,
    });

    try {
      await client.connect();
      console.log('Status: RUNNING');
      console.log(`Socket: ${options.socket}`);
      client.disconnect();
    } catch {
      console.log('Status: STOPPED (connection failed)');
    }
  });

// Send a message (for testing)
program
  .command('send')
  .description('Send a message to an agent')
  .option('-f, --from <name>', 'Sender agent name (auto-generated if not provided)')
  .requiredOption('-t, --to <name>', 'Recipient agent name (or * for broadcast)')
  .requiredOption('-m, --message <text>', 'Message body')
  .option('-s, --socket <path>', 'Socket path', DEFAULT_SOCKET_PATH)
  .action(async (options) => {
    const senderName = options.from ?? generateAgentName();
    const client = new RelayClient({
      agentName: senderName,
      socketPath: options.socket,
    });

    try {
      await client.connect();
      const success = client.sendMessage(options.to, options.message);
      if (success) {
        console.log(`Sent: ${options.message}`);
      } else {
        console.error('Failed to send message');
      }
      // Wait a bit for delivery then exit cleanly
      await new Promise((r) => setTimeout(r, 200));
      client.destroy();
      process.exit(0);
    } catch (err) {
      console.error('Error:', err);
      process.exit(1);
    }
  });

// List connected agents
program
  .command('agents')
  .description('List connected agents')
  .option('-s, --socket <path>', 'Socket path', DEFAULT_SOCKET_PATH)
  .action(async (_options) => {
    console.log('Note: Agent listing requires daemon introspection (not yet implemented)');
    console.log('Use the status command to check if daemon is running.');
  });

// Supervisor command
program
  .command('supervisor')
  .description('Run the spawn-per-message supervisor (CLI-agnostic agent management)')
  .option('-s, --socket <path>', 'Socket path', DEFAULT_SOCKET_PATH)
  .option('-d, --data-dir <path>', 'Data directory for agent state', '/tmp/agent-relay')
  .option('-p, --poll-interval <ms>', 'Polling interval in milliseconds', '2000')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .option('--detach', 'Run supervisor in background (writes supervisor.pid)', false)
  .action(async (options) => {
    if (options.detach) {
      const pid = startDetachedSupervisor({
        socket: options.socket,
        dataDir: options.dataDir,
        pollInterval: parseInt(options.pollInterval, 10),
        verbose: Boolean(options.verbose),
      });
      console.log(`Supervisor started in background (pid ${pid})`);
      console.log(`PID file: ${supervisorPidFilePath(options.dataDir)}`);
      return;
    }

    const supervisor = new Supervisor({
      socketPath: options.socket,
      dataDir: options.dataDir,
      pollIntervalMs: parseInt(options.pollInterval, 10),
      verbose: options.verbose,
    });

    // Handle shutdown
    process.on('SIGINT', () => {
      console.log('\nShutting down supervisor...');
      supervisor.stop();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      supervisor.stop();
      process.exit(0);
    });

    try {
      await supervisor.start();
      // Keep process alive
      await new Promise(() => {});
    } catch (err) {
      console.error('Failed to start supervisor:', err);
      process.exit(1);
    }
  });

program
  .command('supervisor-status')
  .description('Show background supervisor status (pidfile-based)')
  .option('-d, --data-dir <path>', 'Data directory', '/tmp/agent-relay')
  .action((options) => {
    const pidPath = supervisorPidFilePath(options.dataDir);
    const pid = readPidFile(pidPath);
    if (!pid) {
      console.log('Supervisor: STOPPED (pid file not found)');
      console.log(`PID file: ${pidPath}`);
      return;
    }
    console.log(`Supervisor: ${isProcessAlive(pid) ? 'RUNNING' : 'STOPPED'} (pid ${pid})`);
    console.log(`PID file: ${pidPath}`);
  });

program
  .command('supervisor-stop')
  .description('Stop background supervisor (pidfile-based)')
  .option('-d, --data-dir <path>', 'Data directory', '/tmp/agent-relay')
  .action((options) => {
    const res = stopDetachedSupervisor(options.dataDir);
    if (!res.pid) {
      console.log('Supervisor not running (pid file not found)');
      return;
    }
    console.log(`Stop requested for supervisor pid ${res.pid}`);
  });

// Register an agent with the supervisor
program
  .command('register')
  .description('Register an agent with the supervisor for spawn-per-message handling')
  .requiredOption('-n, --name <name>', 'Agent name')
  .requiredOption('-c, --cli <type>', 'CLI type: claude, codex, cursor, or custom')
  .option('-w, --cwd <path>', 'Working directory', process.cwd())
  .option('--command <cmd>', 'Custom command (required for cli=custom)')
  .option('-d, --data-dir <path>', 'Data directory', '/tmp/agent-relay')
  .option('-s, --socket <path>', 'Socket path (for supervisor)', DEFAULT_SOCKET_PATH)
  .option('--no-autostart-supervisor', 'Do not auto-start supervisor', false)
  .action(async (options) => {
    const validCLIs = ['claude', 'codex', 'cursor', 'custom'];
    if (!validCLIs.includes(options.cli)) {
      console.error(`Invalid CLI type: ${options.cli}. Must be one of: ${validCLIs.join(', ')}`);
      process.exit(1);
    }

    if (options.cli === 'custom' && !options.command) {
      console.error('--command is required when using cli=custom');
      process.exit(1);
    }

    const supervisor = new Supervisor({ dataDir: options.dataDir });
    const state = supervisor.registerAgent({
      name: options.name,
      cli: options.cli as CLIType,
      cwd: options.cwd,
      customCommand: options.command,
    });

    console.log(`Registered agent: ${state.name}`);
    console.log(`  CLI: ${state.cli}`);
    console.log(`  CWD: ${state.cwd}`);
    console.log(`  State: ${options.dataDir}/${state.name}/state.json`);
    console.log(`  Inbox: ${options.dataDir}/${state.name}/inbox.md`);

    if (options.autostartSupervisor !== false) {
      try {
        const pid = startDetachedSupervisor({
          socket: options.socket,
          dataDir: options.dataDir,
          pollInterval: 2000,
          verbose: false,
        });
        console.log(`  Supervisor: running (pid ${pid})`);
      } catch (err) {
        console.warn(`  Supervisor: failed to autostart (${(err as Error).message})`);
        console.warn(`  Start manually: agent-relay supervisor -d ${options.dataDir}`);
      }
    } else {
      console.log(`  Supervisor: not started (run: agent-relay supervisor -d ${options.dataDir})`);
    }
  });

// Poll inbox (blocking wait for messages)
program
  .command('inbox-poll')
  .description('Wait for messages in inbox (blocking poll for live agent sessions)')
  .requiredOption('-n, --name <name>', 'Agent name')
  .option('-d, --data-dir <path>', 'Data directory', '/tmp/agent-relay')
  .option('-i, --interval <ms>', 'Poll interval in milliseconds', '2000')
  .option('-t, --timeout <s>', 'Timeout in seconds (0 = forever)', '0')
  .option('--clear', 'Clear inbox after reading', false)
  .option('--pattern <regex>', 'Only return when inbox matches pattern', '## Message from')
  .action(async (options) => {
    // Validate agent name
    if (!options.name || options.name.includes('/') || options.name.includes('..')) {
      console.error('Error: Invalid agent name. Name cannot be empty or contain path separators.');
      process.exit(1);
    }

    // Validate poll interval
    const pollInterval = parseInt(options.interval, 10);
    if (isNaN(pollInterval) || pollInterval < 100) {
      console.error('Error: Poll interval must be at least 100ms');
      process.exit(1);
    }

    // Validate timeout
    const timeout = parseInt(options.timeout, 10) * 1000;
    if (isNaN(timeout) || timeout < 0) {
      console.error('Error: Timeout must be a non-negative number');
      process.exit(1);
    }

    // Validate regex pattern
    let pattern: RegExp;
    try {
      pattern = new RegExp(options.pattern);
    } catch (err) {
      console.error(`Error: Invalid regex pattern: ${(err as Error).message}`);
      process.exit(1);
    }

    const inboxPath = path.join(options.dataDir, options.name, 'inbox.md');
    const startTime = Date.now();

    // Ensure inbox directory exists
    const inboxDir = path.dirname(inboxPath);
    if (!fs.existsSync(inboxDir)) {
      fs.mkdirSync(inboxDir, { recursive: true });
    }

    // Initialize empty inbox if doesn't exist
    if (!fs.existsSync(inboxPath)) {
      fs.writeFileSync(inboxPath, '', 'utf-8');
    }

    process.stderr.write(`Polling inbox: ${inboxPath}\n`);
    process.stderr.write(`Pattern: ${options.pattern}\n`);
    process.stderr.write(`Interval: ${pollInterval}ms\n`);
    if (timeout > 0) {
      process.stderr.write(`Timeout: ${options.timeout}s\n`);
    }

    while (true) {
      // Check timeout
      if (timeout > 0 && Date.now() - startTime > timeout) {
        process.stderr.write('Timeout reached\n');
        process.exit(1);
      }

      // Check inbox
      try {
        const content = fs.readFileSync(inboxPath, 'utf-8');
        if (content.trim() && pattern.test(content)) {
          // Found matching content
          process.stdout.write(content);

          // Clear if requested
          if (options.clear) {
            fs.writeFileSync(inboxPath, '', 'utf-8');
          }

          process.exit(0);
        }
      } catch {
        // File might not exist yet, that's ok
      }

      // Wait before next poll
      await new Promise((r) => setTimeout(r, pollInterval));
    }
  });

// Read inbox without waiting
program
  .command('inbox-read')
  .description('Read current inbox contents (non-blocking)')
  .requiredOption('-n, --name <name>', 'Agent name')
  .option('-d, --data-dir <path>', 'Data directory', '/tmp/agent-relay')
  .option('--clear', 'Clear inbox after reading', false)
  .action((options) => {
    // Validate agent name
    if (!options.name || options.name.includes('/') || options.name.includes('..')) {
      console.error('Error: Invalid agent name. Name cannot be empty or contain path separators.');
      process.exit(1);
    }

    const inboxPath = path.join(options.dataDir, options.name, 'inbox.md');

    if (!fs.existsSync(inboxPath)) {
      console.log('(inbox empty)');
      return;
    }

    try {
      const content = fs.readFileSync(inboxPath, 'utf-8');
      if (!content.trim()) {
        console.log('(inbox empty)');
        return;
      }

      process.stdout.write(content);

      if (options.clear) {
        fs.writeFileSync(inboxPath, '', 'utf-8');
      }
    } catch (err) {
      console.error(`Error reading inbox: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// Write to another agent's inbox
program
  .command('inbox-write')
  .description('Write a message to agent inbox(es). Supports multiple recipients or broadcast.')
  .requiredOption('-t, --to <names>', 'Recipient(s): agent name, comma-separated list, or * for broadcast')
  .requiredOption('-f, --from <name>', 'Sender agent name')
  .requiredOption('-m, --message <text>', 'Message body')
  .option('-d, --data-dir <path>', 'Data directory', '/tmp/agent-relay')
  .action((options) => {
    // Validate sender name
    if (!options.from || options.from.includes('/') || options.from.includes('..')) {
      console.error('Error: Invalid sender name. Name cannot be empty or contain path separators.');
      process.exit(1);
    }

    // Validate message is not empty
    if (!options.message || !options.message.trim()) {
      console.error('Error: Message cannot be empty');
      process.exit(1);
    }

    const timestamp = new Date().toISOString();
    // Match wrapper/supervisor inbox format:
    // ## Message from <sender> | <timestamp>
    // <body>
    const formattedMessage = `\n## Message from ${options.from} | ${timestamp}\n${options.message}\n`;

    // Determine recipients
    let recipients: string[] = [];

    if (options.to === '*') {
      // Broadcast to all agents in data-dir except sender
      if (fs.existsSync(options.dataDir)) {
        const entries = fs.readdirSync(options.dataDir, { withFileTypes: true });
        recipients = entries
          .filter(e => e.isDirectory() && e.name !== options.from)
          .map(e => e.name);
      }
      if (recipients.length === 0) {
        console.log('No other agents found for broadcast');
        return;
      }
    } else {
      // Parse comma-separated list
      recipients = options.to.split(',').map((r: string) => r.trim()).filter((r: string) => r);

      // Validate recipient names
      for (const r of recipients) {
        if (r.includes('/') || r.includes('..')) {
          console.error(`Error: Invalid recipient name "${r}". Name cannot contain path separators.`);
          process.exit(1);
        }
      }

      if (recipients.length === 0) {
        console.error('Error: At least one recipient is required');
        process.exit(1);
      }
    }

    // Write to each recipient
    let successCount = 0;
    for (const recipient of recipients) {
      const inboxPath = path.join(options.dataDir, recipient, 'inbox.md');

      // Ensure directory exists
      const inboxDir = path.dirname(inboxPath);
      try {
        if (!fs.existsSync(inboxDir)) {
          fs.mkdirSync(inboxDir, { recursive: true });
        }

        fs.appendFileSync(inboxPath, formattedMessage, 'utf-8');
        console.log(`Message written to ${recipient}`);
        successCount++;
      } catch (err) {
        console.error(`Error writing to ${recipient}: ${(err as Error).message}`);
      }
    }

    if (successCount === 0) {
      process.exit(1);
    }
  });

// Dynamic team management
program
  .command('team-init')
  .description('Initialize a team workspace for multi-agent collaboration')
  .option('-d, --data-dir <path>', 'Team data directory', '/tmp/agent-relay-team')
  .option('-p, --project <path>', 'Project directory agents will work on', process.cwd())
  .option('-n, --name <name>', 'Team/project name', 'agent-team')
  .action((options) => {
    const teamDir = options.dataDir;
    const configPath = path.join(teamDir, 'team.json');

    fs.mkdirSync(teamDir, { recursive: true });

    const config = {
      name: options.name,
      projectDir: options.project,
      createdAt: new Date().toISOString(),
      agents: [] as { name: string; cli: string; role: string; tasks: string[] }[],
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    console.log(`Team workspace initialized: ${teamDir}`);
    console.log(`Project: ${options.project}`);
    console.log('');
    console.log('Add agents with:');
    console.log(`  agent-relay team-add -n AgentName -c claude -r "Role" -t "Task" -d ${teamDir}`);
  });

program
  .command('team-add')
  .description('Add an agent to the team')
  .requiredOption('-n, --name <name>', 'Agent name')
  .requiredOption('-c, --cli <type>', 'CLI type: claude, codex, gemini, cursor')
  .requiredOption('-r, --role <role>', 'Agent role (e.g., "Documentation Lead")')
  .option('-t, --task <task>', 'Task (repeatable)', (val: string, arr: string[]) => [...arr, val], [] as string[])
  .option('-d, --data-dir <path>', 'Team data directory', '/tmp/agent-relay-team')
  .action((options) => {
    const teamDir = options.dataDir;
    const configPath = path.join(teamDir, 'team.json');

    interface TeamConfig {
      name: string;
      projectDir: string;
      createdAt: string;
      agents: { name: string; cli: string; role: string; tasks: string[] }[];
    }

    let config: TeamConfig;
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } else {
      fs.mkdirSync(teamDir, { recursive: true });
      config = { name: 'agent-team', projectDir: process.cwd(), createdAt: new Date().toISOString(), agents: [] };
    }

    const existingIdx = config.agents.findIndex(a => a.name === options.name);
    const agentData = { name: options.name, cli: options.cli, role: options.role, tasks: options.task };

    if (existingIdx >= 0) {
      config.agents[existingIdx] = agentData;
      console.log(`Updated agent: ${options.name}`);
    } else {
      config.agents.push(agentData);
      console.log(`Added agent: ${options.name}`);
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const agentDir = path.join(teamDir, options.name);
    fs.mkdirSync(agentDir, { recursive: true });

    const inboxPath = path.join(agentDir, 'inbox.md');
    if (!fs.existsSync(inboxPath)) fs.writeFileSync(inboxPath, '');

    const teammates = config.agents.filter(a => a.name !== options.name).map(a => a.name);
    const taskList = options.task.length > 0 ? options.task.map((t: string, i: number) => `${i + 1}. ${t}`).join('\n') : '(Check with teammates for tasks)';
    const teammateList = teammates.length > 0 ? teammates.join(', ') : '(No other agents yet)';

    const instructions = `# You are ${options.name} - ${options.role}

## Project Location
\`${config.projectDir}\`

## Your Tasks
${taskList}

## Communication

**Your inbox:** \`${teamDir}/${options.name}/inbox.md\`
**Teammates:** ${teammateList}

### Commands
\`\`\`bash
# Check inbox (non-blocking peek)
node ${config.projectDir}/dist/cli/index.js team-check -n ${options.name} -d ${teamDir} --no-wait

# Check inbox (BLOCKS until message arrives)
node ${config.projectDir}/dist/cli/index.js team-check -n ${options.name} -d ${teamDir} --clear

# Send to teammate
node ${config.projectDir}/dist/cli/index.js team-send -n ${options.name} -t TEAMMATE -m "MESSAGE" -d ${teamDir}

# Broadcast to all
node ${config.projectDir}/dist/cli/index.js team-send -n ${options.name} -t "*" -m "MESSAGE" -d ${teamDir}

# Team status
node ${config.projectDir}/dist/cli/index.js team-status -d ${teamDir}
\`\`\`

### Protocol
- \`STATUS: <doing what>\` - Progress update
- \`DONE: <task>\` - Completed
- \`QUESTION: @Name <q>\` - Ask teammate
- \`BLOCKER: <issue>\` - Blocked

## CRITICAL: Work Loop (MUST FOLLOW)
\`\`\`
REPEAT:
  1. CHECK inbox (--no-wait)
  2. RESPOND to any messages
  3. DO one small task step (max 5 min work)
  4. BROADCAST status update
  5. GOTO 1
\`\`\`

**You MUST check inbox and broadcast after EVERY task step. Never go silent!**

## Start Now
1. Run team-check --no-wait to see any messages
2. Broadcast: STATUS: ${options.name} starting [first task]
3. Follow the work loop above
`;

    const instructionsPath = path.join(agentDir, 'INSTRUCTIONS.md');
    fs.writeFileSync(instructionsPath, instructions);

    console.log(`  CLI: ${options.cli}`);
    console.log(`  Role: ${options.role}`);
    console.log(`  Instructions: ${instructionsPath}`);
    console.log('');
    console.log('To start:');
    console.log(`  cd ${config.projectDir} && ${options.cli}`);
    console.log(`  Say: Read ${instructionsPath} and start working`);
  });

program
  .command('team-list')
  .description('List all agents in the team')
  .option('-d, --data-dir <path>', 'Team data directory', '/tmp/agent-relay-team')
  .option('--instructions', 'Show startup instructions', false)
  .action((options) => {
    const configPath = path.join(options.dataDir, 'team.json');

    if (!fs.existsSync(configPath)) {
      console.log('No team found. Initialize with: agent-relay team-init');
      return;
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    console.log(`Team: ${config.name}`);
    console.log(`Project: ${config.projectDir}`);
    console.log(`Agents: ${config.agents.length}`);
    console.log('');

    for (const agent of config.agents) {
      const inboxPath = path.join(options.dataDir, agent.name, 'inbox.md');
      const hasMessages = fs.existsSync(inboxPath) && fs.statSync(inboxPath).size > 10;
      const instructionsPath = path.join(options.dataDir, agent.name, 'INSTRUCTIONS.md');

      console.log(`━━━ ${agent.name} (${agent.cli}) ${hasMessages ? '📬' : ''}`);
      console.log(`    Role: ${agent.role}`);
      if (agent.tasks?.length > 0) console.log(`    Tasks: ${agent.tasks.join(', ')}`);

      if (options.instructions) {
        console.log(`    Start: cd ${config.projectDir} && ${agent.cli}`);
        console.log(`           Say: Read ${instructionsPath} and start working`);
      }
      console.log('');
    }
  });

// One-shot team setup from JSON config
program
  .command('team-setup')
  .description('Create a complete team from a JSON config file or inline JSON')
  .option('-f, --file <path>', 'Path to JSON config file')
  .option('-c, --config <json>', 'Inline JSON config')
  .option('-d, --data-dir <path>', 'Team data directory', '/tmp/agent-relay-team')
  .action((options) => {
    interface AgentConfig {
      name: string;
      cli: string;
      role: string;
      tasks?: string[];
    }
    interface TeamSetupConfig {
      name?: string;
      project?: string;
      agents: AgentConfig[];
    }

    let config: TeamSetupConfig;

    if (options.file) {
      if (!fs.existsSync(options.file)) {
        console.error(`Config file not found: ${options.file}`);
        process.exit(1);
      }
      config = JSON.parse(fs.readFileSync(options.file, 'utf-8'));
    } else if (options.config) {
      config = JSON.parse(options.config);
    } else {
      console.error('Provide --file or --config');
      process.exit(1);
    }

    const teamDir = options.dataDir;
    const projectDir = config.project || process.cwd();

    // Create team config
    fs.mkdirSync(teamDir, { recursive: true });
    const teamConfig = {
      name: config.name || 'agent-team',
      projectDir,
      createdAt: new Date().toISOString(),
      agents: config.agents.map(a => ({ ...a, tasks: a.tasks || [] })),
    };
    fs.writeFileSync(path.join(teamDir, 'team.json'), JSON.stringify(teamConfig, null, 2));

    // Create each agent
    for (const agent of config.agents) {
      const agentDir = path.join(teamDir, agent.name);
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, 'inbox.md'), '');

      const teammates = config.agents.filter(a => a.name !== agent.name).map(a => a.name);
      const taskList = (agent.tasks || []).map((t, i) => `${i + 1}. ${t}`).join('\n') || '(Check with teammates)';

      const instructions = `# You are ${agent.name} - ${agent.role}

## Project: \`${projectDir}\`

## Tasks
${taskList}

## Teammates: ${teammates.join(', ') || 'none yet'}

## Commands
\`\`\`bash
# Check inbox (non-blocking peek)
node ${projectDir}/dist/cli/index.js team-check -n ${agent.name} -d ${teamDir} --no-wait

# Check inbox (BLOCKS until message arrives)
node ${projectDir}/dist/cli/index.js team-check -n ${agent.name} -d ${teamDir} --clear

# Send message
node ${projectDir}/dist/cli/index.js team-send -n ${agent.name} -t RECIPIENT -m "message" -d ${teamDir}

# Broadcast to all
node ${projectDir}/dist/cli/index.js team-send -n ${agent.name} -t "*" -m "message" -d ${teamDir}

# Team status
node ${projectDir}/dist/cli/index.js team-status -d ${teamDir}
\`\`\`

## Protocol
- \`STATUS: <doing>\` - Update
- \`DONE: <task>\` - Complete
- \`QUESTION: @Name <q>\` - Ask
- \`BLOCKER: <issue>\` - Stuck

## CRITICAL: Work Loop (MUST FOLLOW)
\`\`\`
REPEAT:
  1. CHECK inbox (--no-wait)
  2. RESPOND to any messages
  3. DO one small task step (max 5 min work)
  4. BROADCAST status update
  5. GOTO 1
\`\`\`

**You MUST check inbox and broadcast after EVERY task step. Never go silent!**

## Start Now
1. Run team-check --no-wait to see any messages
2. Broadcast: STATUS: ${agent.name} starting [first task]
3. Follow the work loop above
`;
      fs.writeFileSync(path.join(agentDir, 'INSTRUCTIONS.md'), instructions);
    }

    console.log(`Team "${teamConfig.name}" created with ${config.agents.length} agents`);
    console.log(`Directory: ${teamDir}`);
    console.log('');
    console.log('Start agents with:');
    for (const agent of config.agents) {
      console.log(`  ${agent.cli}: Read ${teamDir}/${agent.name}/INSTRUCTIONS.md and start`);
    }
  });

// Self-register to a team (for agents to join)
program
  .command('team-join')
  .description('Join an existing team (for agents to self-register)')
  .requiredOption('-n, --name <name>', 'Your agent name')
  .requiredOption('-c, --cli <type>', 'Your CLI type')
  .requiredOption('-r, --role <role>', 'Your role')
  .option('-t, --task <task>', 'Your task (repeatable)', (v: string, a: string[]) => [...a, v], [] as string[])
  .option('-d, --data-dir <path>', 'Team directory', '/tmp/agent-relay-team')
  .action((options) => {
    const configPath = path.join(options.dataDir, 'team.json');

    if (!fs.existsSync(configPath)) {
      console.error('No team found. Create one first with team-init or team-setup');
      process.exit(1);
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    // Add or update agent
    const idx = config.agents.findIndex((a: { name: string }) => a.name === options.name);
    const agentData = { name: options.name, cli: options.cli, role: options.role, tasks: options.task };

    if (idx >= 0) {
      config.agents[idx] = agentData;
    } else {
      config.agents.push(agentData);
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    // Create inbox
    const agentDir = path.join(options.dataDir, options.name);
    fs.mkdirSync(agentDir, { recursive: true });
    if (!fs.existsSync(path.join(agentDir, 'inbox.md'))) {
      fs.writeFileSync(path.join(agentDir, 'inbox.md'), '');
    }

    console.log(`Joined team as ${options.name} (${options.role})`);
    console.log(`Teammates: ${config.agents.filter((a: { name: string }) => a.name !== options.name).map((a: { name: string }) => a.name).join(', ')}`);
  });

// Quick team status
program
  .command('team-status')
  .description('Show team status with message counts')
  .option('-d, --data-dir <path>', 'Team directory', '/tmp/agent-relay-team')
  .action((options) => {
    const configPath = path.join(options.dataDir, 'team.json');

    if (!fs.existsSync(configPath)) {
      console.log('No team found');
      return;
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    console.log(`\n📋 ${config.name} | ${config.agents.length} agents\n`);

    for (const agent of config.agents) {
      const inboxPath = path.join(options.dataDir, agent.name, 'inbox.md');
      let msgCount = 0;
      if (fs.existsSync(inboxPath)) {
        const content = fs.readFileSync(inboxPath, 'utf-8');
        msgCount = (content.match(/## Message from/g) || []).length;
      }

      const icon = msgCount > 0 ? '📬' : '📭';
      console.log(`  ${icon} ${agent.name} (${agent.cli}) - ${agent.role}${msgCount > 0 ? ` [${msgCount} msg]` : ''}`);
    }
    console.log('');
  });

// Simplified send (team-aware)
program
  .command('team-send')
  .description('Send a message to teammate(s)')
  .requiredOption('-n, --name <name>', 'Your agent name')
  .requiredOption('-t, --to <recipient>', 'Recipient name or * for broadcast')
  .requiredOption('-m, --message <text>', 'Message')
  .option('-d, --data-dir <path>', 'Team directory', '/tmp/agent-relay-team')
  .action((options) => {
    const configPath = path.join(options.dataDir, 'team.json');
    if (!fs.existsSync(configPath)) {
      console.error('No team found');
      process.exit(1);
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const timestamp = new Date().toISOString();
    const msg = `\n## Message from ${options.name} | ${timestamp}\n${options.message}\n`;

    let recipients: string[] = [];
    if (options.to === '*') {
      recipients = config.agents
        .filter((a: { name: string }) => a.name !== options.name)
        .map((a: { name: string }) => a.name);
    } else {
      recipients = options.to.split(',').map((r: string) => r.trim());
    }

    for (const r of recipients) {
      const inbox = path.join(options.dataDir, r, 'inbox.md');
      if (fs.existsSync(path.dirname(inbox))) {
        fs.appendFileSync(inbox, msg);
        console.log(`→ ${r}`);
      } else {
        console.log(`✗ ${r} (not found)`);
      }
    }
  });

// Simplified check inbox (team-aware)
program
  .command('team-check')
  .description('Check your inbox (blocking wait for messages)')
  .requiredOption('-n, --name <name>', 'Your agent name')
  .option('-d, --data-dir <path>', 'Team directory', '/tmp/agent-relay-team')
  .option('--no-wait', 'Just read, don\'t wait for messages')
  .option('--clear', 'Clear inbox after reading')
  .option('-t, --timeout <seconds>', 'Timeout in seconds (0=forever)', '0')
  .action(async (options) => {
    const inboxPath = path.join(options.dataDir, options.name, 'inbox.md');

    if (!fs.existsSync(path.dirname(inboxPath))) {
      fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
    }
    if (!fs.existsSync(inboxPath)) {
      fs.writeFileSync(inboxPath, '');
    }

    const timeout = parseInt(options.timeout, 10) * 1000;
    const startTime = Date.now();

    if (options.wait === false) {
      // Just read
      const content = fs.readFileSync(inboxPath, 'utf-8');
      if (content.trim()) {
        process.stdout.write(content);
        if (options.clear) fs.writeFileSync(inboxPath, '');
      } else {
        console.log('(no messages)');
      }
      return;
    }

    // Blocking wait
    process.stderr.write(`Waiting for messages...\n`);
    while (true) {
      if (timeout > 0 && Date.now() - startTime > timeout) {
        console.log('(timeout)');
        process.exit(1);
      }

      const content = fs.readFileSync(inboxPath, 'utf-8');
      if (content.includes('## Message from')) {
        process.stdout.write(content);
        if (options.clear) fs.writeFileSync(inboxPath, '');
        process.exit(0);
      }

      await new Promise(r => setTimeout(r, 2000));
    }
  });

// List agents in a data directory (for games)
program
  .command('inbox-agents')
  .description('List all agents with inboxes in a data directory')
  .option('-d, --data-dir <path>', 'Data directory', '/tmp/agent-relay')
  .action((options) => {
    if (!fs.existsSync(options.dataDir)) {
      console.log('No agents found');
      return;
    }

    const entries = fs.readdirSync(options.dataDir, { withFileTypes: true });
    const agents = entries
      .filter(e => e.isDirectory())
      .map(e => e.name);

    if (agents.length === 0) {
      console.log('No agents found');
      return;
    }

    console.log('Agents:');
    for (const agent of agents) {
      const inboxPath = path.join(options.dataDir, agent, 'inbox.md');
      const hasInbox = fs.existsSync(inboxPath);
      const inboxSize = hasInbox ? fs.statSync(inboxPath).size : 0;
      console.log(`  ${agent}${inboxSize > 0 ? ' (has messages)' : ''}`);
    }
  });

// Tic-tac-toe setup helper (writes instruction files + clears inboxes)
program
  .command('tictactoe-setup')
  .description('Create tic-tac-toe instruction files + empty inboxes for two agents')
  .option('-d, --data-dir <path>', 'Data directory', '/tmp/agent-relay-ttt')
  .option('--player-x <name>', 'Player X name', 'PlayerX')
  .option('--player-o <name>', 'Player O name', 'PlayerO')
  .action((options) => {
    const res = setupTicTacToe({
      dataDir: options.dataDir,
      playerX: options.playerX,
      playerO: options.playerO,
    });

    console.log('Created tic-tac-toe instructions:');
    console.log(`  X: ${res.instructionsXPath}`);
    console.log(`  O: ${res.instructionsOPath}`);
    console.log('');
    console.log('To start (2 terminals):');
    console.log(`  Terminal 1: start your agent, then read ${res.instructionsXPath}`);
    console.log(`  Terminal 2: start your agent, then read ${res.instructionsOPath}`);
  });

// List registered agents
program
  .command('list')
  .description('List registered agents')
  .option('-d, --data-dir <path>', 'Data directory', '/tmp/agent-relay')
  .action(async (options) => {
    const supervisor = new Supervisor({ dataDir: options.dataDir });
    const agents = supervisor.getAgents();

    if (agents.length === 0) {
      console.log('No registered agents');
      return;
    }

    const supPidPath = supervisorPidFilePath(options.dataDir);
    const supPid = readPidFile(supPidPath);
    const supRunning = supPid ? isProcessAlive(supPid) : false;
    console.log(`Supervisor: ${supRunning ? `RUNNING (pid ${supPid})` : 'STOPPED'}`);

    console.log('Registered agents:');
    for (const name of agents) {
      const diag = supervisor.getAgentDiagnostics(name);
      const state = diag.state;
      if (state) {
        const status = state.status ?? 'idle';
        const lock = diag.locked ? 'locked' : 'unlocked';
        const inbox = diag.hasUnreadInbox ? 'unread' : 'clear';
        console.log(`  ${name} (${state.cli}) - ${status}, ${lock}, inbox:${inbox}`);
        console.log(`    cwd: ${state.cwd}`);
        console.log(`    state: ${diag.statePath}`);
        console.log(`    inbox: ${diag.inboxPath}`);
      } else {
        console.log(`  ${name} (missing/invalid state.json)`);
      }
    }
  });

// Dashboard command
program
  .command('dashboard')
  .description('Start the web dashboard')
  .option('-p, --port <number>', 'Port to run on', DEFAULT_DASHBOARD_PORT)
  .option('-d, --data-dir <path>', 'Team data directory', '/tmp/agent-relay-team')
  .option('--db-path <path>', 'SQLite DB path for message storage', '/tmp/agent-relay.sqlite')
  .action(async (options) => {
    const { startDashboard } = await import('../dashboard/server.js');
    await startDashboard(parseInt(options.port, 10), options.dataDir, options.dbPath);
  });

// Team listen daemon - watches inboxes and spawns agents when messages arrive
program
  .command('team-listen')
  .description('Watch inboxes and spawn agents when messages arrive (for Codex, Gemini, etc.)')
  .option('-d, --data-dir <path>', 'Team data directory', '/tmp/agent-relay-team')
  .option('-a, --agents <names>', 'Comma-separated agent names to watch (default: all)')
  .option('--debounce <ms>', 'Debounce time before spawning (ms)', '3000')
  .option('--cooldown <s>', 'Minimum seconds between spawns per agent', '60')
  .option('--dry-run', 'Log what would happen without spawning', false)
  .action(async (options) => {
    const chokidar = await import('chokidar');
    const { spawn } = await import('child_process');
    const { AgentStateManager } = await import('../state/agent-state.js');

    const configPath = path.join(options.dataDir, 'team.json');
    if (!fs.existsSync(configPath)) {
      console.error('No team found. Initialize with: team-init or team-setup');
      process.exit(1);
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const stateManager = new AgentStateManager(options.dataDir);
    const debounceMs = parseInt(options.debounce, 10);
    const cooldownMs = parseInt(options.cooldown, 10) * 1000;

    // Filter agents
    const watchAgents = options.agents
      ? options.agents.split(',').map((n: string) => n.trim())
      : config.agents.map((a: { name: string }) => a.name);

    const agents = config.agents.filter((a: { name: string }) =>
      watchAgents.includes(a.name)
    );

    if (agents.length === 0) {
      console.error('No matching agents found');
      process.exit(1);
    }

    // Track state
    const lastSpawn = new Map<string, number>();
    const debounceTimers = new Map<string, NodeJS.Timeout>();
    const lastInboxSize = new Map<string, number>();

    console.log('Agent Relay Listener');
    console.log('====================');
    console.log(`Directory: ${options.dataDir}`);
    console.log(`Watching: ${agents.map((a: { name: string }) => a.name).join(', ')}`);
    console.log(`Debounce: ${debounceMs}ms, Cooldown: ${cooldownMs / 1000}s`);
    console.log('');

    // Get spawn command for CLI type
    const getSpawnCmd = (cli: string): { cmd: string; args: string[] } => {
      switch (cli.toLowerCase()) {
        case 'claude':
          return { cmd: 'claude', args: ['--dangerously-skip-permissions'] };
        case 'codex':
          return { cmd: 'codex', args: [] };
        case 'gemini':
          return { cmd: 'gemini', args: [] };
        case 'cursor':
          return { cmd: 'cursor', args: ['--cli'] };
        default:
          return { cmd: cli, args: [] };
      }
    };

    // Spawn agent with context
    const spawnAgent = (agent: { name: string; cli: string }) => {
      const now = Date.now();
      const last = lastSpawn.get(agent.name) || 0;

      // Check cooldown
      if (now - last < cooldownMs) {
        console.log(`[${new Date().toISOString()}] ${agent.name}: cooling down (${Math.round((cooldownMs - (now - last)) / 1000)}s remaining)`);
        return;
      }

      // Check inbox has content
      const inboxPath = path.join(options.dataDir, agent.name, 'inbox.md');
      if (!fs.existsSync(inboxPath)) return;
      const content = fs.readFileSync(inboxPath, 'utf-8');
      if (!content.includes('## Message from')) return;

      const { cmd, args } = getSpawnCmd(agent.cli);
      const instructionsPath = path.join(options.dataDir, agent.name, 'INSTRUCTIONS.md');

      // Build context-aware prompt
      const stateContext = stateManager.formatAsContext(agent.name);
      const prompt = `${stateContext}

You have NEW MESSAGES! Read ${instructionsPath} for your role.

IMMEDIATE ACTIONS:
1. Check inbox: node ${config.projectDir}/dist/cli/index.js team-check -n ${agent.name} -d ${options.dataDir} --no-wait
2. Respond to messages
3. Do ONE task step
4. Broadcast status update
5. Before exiting, save your state by outputting:
   [[STATE]]{"currentTask": "what you're working on", "context": "brief summary of progress"}[[/STATE]]

GO!`;

      console.log(`[${new Date().toISOString()}] Spawning ${agent.name} (${agent.cli})...`);

      if (options.dryRun) {
        console.log(`  DRY RUN: ${cmd} -p "${prompt.substring(0, 100)}..."`);
        return;
      }

      lastSpawn.set(agent.name, now);

      try {
        const child = spawn(cmd, [...args, '-p', prompt], {
          cwd: config.projectDir,
          stdio: 'inherit',
        });

        child.on('exit', (code) => {
          console.log(`[${new Date().toISOString()}] ${agent.name} exited (code ${code})`);
        });

        child.on('error', (err) => {
          console.error(`[${new Date().toISOString()}] ${agent.name} error: ${err.message}`);
        });
      } catch (err) {
        console.error(`Failed to spawn ${agent.name}:`, err);
      }
    };

    // Handle inbox changes
    const handleInboxChange = (filePath: string) => {
      const agentName = path.basename(path.dirname(filePath));
      const agent = agents.find((a: { name: string }) => a.name === agentName);
      if (!agent) return;

      // Check if file grew (new messages)
      const currentSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
      const previousSize = lastInboxSize.get(agentName) || 0;
      lastInboxSize.set(agentName, currentSize);

      if (currentSize <= previousSize) return; // File shrunk or same

      console.log(`[${new Date().toISOString()}] New message for ${agentName}`);

      // Debounce
      const timer = debounceTimers.get(agentName);
      if (timer) clearTimeout(timer);

      debounceTimers.set(agentName, setTimeout(() => {
        debounceTimers.delete(agentName);
        spawnAgent(agent);
      }, debounceMs));
    };

    // Initialize inbox sizes
    for (const agent of agents) {
      const inboxPath = path.join(options.dataDir, agent.name, 'inbox.md');
      if (fs.existsSync(inboxPath)) {
        lastInboxSize.set(agent.name, fs.statSync(inboxPath).size);
      }
    }

    // Start watching
    const watcher = chokidar.watch(path.join(options.dataDir, '*/inbox.md'), {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });

    watcher.on('change', handleInboxChange);
    watcher.on('add', handleInboxChange);

    console.log('Listening... (Ctrl+C to stop)\n');

    process.on('SIGINT', () => {
      console.log('\nShutting down...');
      watcher.close();
      for (const timer of debounceTimers.values()) clearTimeout(timer);
      process.exit(0);
    });
  });

// One command to start everything
program
  .command('team-start')
  .description('Start a team - sets up, listens, and spawns all agents')
  .option('-f, --file <path>', 'Team config JSON file')
  .option('-d, --data-dir <path>', 'Team data directory', '/tmp/agent-relay-team')
  .option('--spawn', 'Immediately spawn all agents', false)
  .option('--dashboard', 'Start dashboard server', false)
  .option('--dashboard-port <port>', 'Dashboard port', '3888')
  .action(async (options) => {
    const chokidar = await import('chokidar');
    const { spawn, execSync } = await import('child_process');
    const { AgentStateManager } = await import('../state/agent-state.js');

    console.log('');
    console.log('╔═══════════════════════════════════════╗');
    console.log('║       AGENT RELAY - TEAM START        ║');
    console.log('╚═══════════════════════════════════════╝');
    console.log('');

    // Step 1: Setup team if config provided
    const configPath = path.join(options.dataDir, 'team.json');

    if (options.file && fs.existsSync(options.file)) {
      console.log('📋 Setting up team from config...');
      const fileConfig = JSON.parse(fs.readFileSync(options.file, 'utf-8'));
      const projectDir = fileConfig.project || process.cwd();

      // Create team directory
      fs.mkdirSync(options.dataDir, { recursive: true });

      // Save team config
      const teamConfig = {
        name: fileConfig.name || 'team',
        projectDir,
        createdAt: new Date().toISOString(),
        agents: fileConfig.agents || [],
      };
      fs.writeFileSync(configPath, JSON.stringify(teamConfig, null, 2));

      // Create agent directories and instructions
      for (const agent of teamConfig.agents) {
        const agentDir = path.join(options.dataDir, agent.name);
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(path.join(agentDir, 'inbox.md'), '');

        const teammates = teamConfig.agents.filter((a: {name: string}) => a.name !== agent.name).map((a: {name: string}) => a.name);
        const taskList = (agent.tasks || []).map((t: string, i: number) => `${i + 1}. ${t}`).join('\n') || '(Check with teammates)';

        const instructions = `# You are ${agent.name} - ${agent.role}

## Project: \`${projectDir}\`

## Tasks
${taskList}

## Teammates: ${teammates.join(', ') || 'none'}

## Commands
\`\`\`bash
# Check inbox
node ${projectDir}/dist/cli/index.js team-check -n ${agent.name} -d ${options.dataDir} --no-wait

# Send message
node ${projectDir}/dist/cli/index.js team-send -n ${agent.name} -t RECIPIENT -m "message" -d ${options.dataDir}

# Broadcast
node ${projectDir}/dist/cli/index.js team-send -n ${agent.name} -t "*" -m "message" -d ${options.dataDir}
\`\`\`

## Work Loop (MUST FOLLOW)
1. CHECK inbox
2. RESPOND to messages
3. DO one task step
4. BROADCAST status
5. REPEAT

**Check inbox after every action!**
`;
        fs.writeFileSync(path.join(agentDir, 'INSTRUCTIONS.md'), instructions);
        console.log(`   ✓ ${agent.name} (${agent.cli})`);
      }
      console.log('');
    }

    // Load config
    if (!fs.existsSync(configPath)) {
      console.error('❌ No team config found. Provide -f <config.json> or run team-setup first.');
      process.exit(1);
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const stateManager = new AgentStateManager(options.dataDir);

    console.log(`📁 Team: ${config.name}`);
    console.log(`📂 Directory: ${options.dataDir}`);
    console.log(`👥 Agents: ${config.agents.map((a: {name: string}) => a.name).join(', ')}`);
    console.log('');

    // Step 2: Start dashboard if requested
    if (options.dashboard) {
      console.log(`🖥️  Starting dashboard on port ${options.dashboardPort}...`);
      const dashboardChild = spawn('node', [
        path.join(config.projectDir, 'dist/cli/index.js'),
        'dashboard',
        '-p', options.dashboardPort,
        '-d', options.dataDir,
      ], {
        cwd: config.projectDir,
        stdio: 'ignore',
        detached: true,
      });
      dashboardChild.unref();
      console.log(`   ✓ Dashboard: http://localhost:${options.dashboardPort}`);
      console.log('');
    }

    // Step 3: Spawn agents if requested
    if (options.spawn) {
      console.log('🚀 Opening agent terminals...');

      const getCliCmd = (cli: string): string => {
        switch (cli.toLowerCase()) {
          case 'claude': return 'claude --dangerously-skip-permissions';
          case 'codex': return 'codex';
          case 'gemini': return 'gemini';
          default: return cli;
        }
      };

      for (const agent of config.agents) {
        const cliCmd = getCliCmd(agent.cli);
        const instructionsPath = path.join(options.dataDir, agent.name, 'INSTRUCTIONS.md');
        const prompt = `Read ${instructionsPath} and start working. Check inbox first, then begin your tasks.`;

        // Escape for shell
        const escapedPrompt = prompt.replace(/"/g, '\\"').replace(/'/g, "'\\''");
        const fullCmd = `cd "${config.projectDir}" && ${cliCmd} -p "${escapedPrompt}"`;

        try {
          // Open in new Terminal.app window (macOS)
          const appleScript = `
            tell application "Terminal"
              activate
              do script "${fullCmd.replace(/"/g, '\\"')}"
              set custom title of front window to "${agent.name} (${agent.cli})"
            end tell
          `;
          execSync(`osascript -e '${appleScript.replace(/'/g, "'\\''")}'`, { stdio: 'ignore' });
          console.log(`   ✓ ${agent.name} (${agent.cli}) - new terminal window`);

          // Small delay between opening windows
          await new Promise(r => setTimeout(r, 500));
        } catch (_err) {
          // Fallback: try iTerm2
          try {
            const iTermScript = `
              tell application "iTerm"
                activate
                create window with default profile
                tell current session of current window
                  write text "${fullCmd.replace(/"/g, '\\"')}"
                end tell
              end tell
            `;
            execSync(`osascript -e '${iTermScript.replace(/'/g, "'\\''")}'`, { stdio: 'ignore' });
            console.log(`   ✓ ${agent.name} (${agent.cli}) - new iTerm window`);
          } catch {
            console.log(`   ✗ ${agent.name} - couldn't open terminal (run manually)`);
            console.log(`     ${fullCmd}`);
          }
        }
      }
      console.log('');
    }

    // Step 4: Start listening for messages
    console.log('👂 Listening for messages...');
    console.log('   When agents receive messages, they will be notified.');
    console.log('');

    const lastSpawn = new Map<string, number>();
    const debounceTimers = new Map<string, NodeJS.Timeout>();
    const lastInboxSize = new Map<string, number>();
    const cooldownMs = 60000;
    const debounceMs = 3000;

    const getSpawnCmd = (cli: string): { cmd: string; args: string[] } => {
      switch (cli.toLowerCase()) {
        case 'claude': return { cmd: 'claude', args: ['--dangerously-skip-permissions'] };
        case 'codex': return { cmd: 'codex', args: [] };
        case 'gemini': return { cmd: 'gemini', args: [] };
        default: return { cmd: cli, args: [] };
      }
    };

    const spawnAgent = (agent: { name: string; cli: string }) => {
      const now = Date.now();
      const last = lastSpawn.get(agent.name) || 0;
      if (now - last < cooldownMs) return;

      const inboxPath = path.join(options.dataDir, agent.name, 'inbox.md');
      if (!fs.existsSync(inboxPath)) return;
      const content = fs.readFileSync(inboxPath, 'utf-8');
      if (!content.includes('## Message from')) return;

      const { cmd, args } = getSpawnCmd(agent.cli);
      const instructionsPath = path.join(options.dataDir, agent.name, 'INSTRUCTIONS.md');
      const stateContext = stateManager.formatAsContext(agent.name);

      const prompt = `${stateContext}

NEW MESSAGES! Read ${instructionsPath}, check inbox, respond, do one task, broadcast status.`;

      console.log(`   → Spawning ${agent.name}...`);
      lastSpawn.set(agent.name, now);

      try {
        const child = spawn(cmd, [...args, '-p', prompt], {
          cwd: config.projectDir,
          stdio: 'inherit',
        });
        child.on('exit', () => console.log(`   ← ${agent.name} exited`));
      } catch (_err) {
        console.error(`   ✗ Failed to spawn ${agent.name}`);
      }
    };

    // Initialize sizes
    for (const agent of config.agents) {
      const inboxPath = path.join(options.dataDir, agent.name, 'inbox.md');
      if (fs.existsSync(inboxPath)) {
        lastInboxSize.set(agent.name, fs.statSync(inboxPath).size);
      }
    }

    // Watch inboxes
    const watcher = chokidar.watch(path.join(options.dataDir, '*/inbox.md'), {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });

    watcher.on('change', (filePath) => {
      const agentName = path.basename(path.dirname(filePath));
      const agent = config.agents.find((a: {name: string}) => a.name === agentName);
      if (!agent) return;

      const currentSize = fs.statSync(filePath).size;
      const previousSize = lastInboxSize.get(agentName) || 0;
      lastInboxSize.set(agentName, currentSize);
      if (currentSize <= previousSize) return;

      console.log(`   📨 New message for ${agentName}`);

      const timer = debounceTimers.get(agentName);
      if (timer) clearTimeout(timer);
      debounceTimers.set(agentName, setTimeout(() => {
        debounceTimers.delete(agentName);
        spawnAgent(agent);
      }, debounceMs));
    });

    console.log('Ready! Send messages with:');
    console.log(`   node dist/cli/index.js team-send -n You -t AgentName -m "message" -d ${options.dataDir}`);
    console.log('');
    console.log('Press Ctrl+C to stop.');

    process.on('SIGINT', () => {
      console.log('\n👋 Shutting down...');
      watcher.close();
      process.exit(0);
    });
  });

program.parse();
