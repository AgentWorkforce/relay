/**
 * File-Based Transport for MCP Tools
 *
 * IMPORTANT: This transport requires relay-pty to be running to process outbox files.
 * The daemon does NOT watch outbox directories directly - only relay-pty does.
 *
 * This transport is intended for scenarios where:
 * 1. An agent is wrapped by relay-pty (standard spawned agents)
 * 2. The agent outputs triggers like ->relay-file:msg which relay-pty detects
 *
 * For MCP tools, prefer using the socket-based client (createRelayClient) instead,
 * which communicates directly with the daemon.
 *
 * Protocol (processed by relay-pty, not daemon):
 * - Send: Write to outbox/msg with TO: header, output ->relay-file:msg
 * - Spawn: Write to outbox/spawn with KIND: spawn, output ->relay-file:spawn
 * - Release: Write to outbox/release with KIND: release, output ->relay-file:release
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface FileTransportOptions {
  /** Agent name for outbox/inbox directories */
  agentName: string;
  /** Base directory for .agent-relay (project root) */
  baseDir: string;
  /** Timeout for query responses in ms */
  queryTimeout?: number;
}

export interface SendOptions {
  to: string;
  message: string;
  thread?: string;
}

export interface SpawnOptions {
  name: string;
  cli: string;
  task: string;
  model?: string;
  cwd?: string;
}

export interface ReleaseOptions {
  name: string;
  reason?: string;
}

/**
 * File-based transport that mirrors the relay-pty file protocol.
 */
export class FileTransport {
  private outboxDir: string;
  private inboxDir: string;
  private queryTimeout: number;

  constructor(options: FileTransportOptions) {
    const relayDir = join(options.baseDir, '.agent-relay');
    this.outboxDir = join(relayDir, 'outbox', options.agentName);
    this.inboxDir = join(relayDir, 'inbox', options.agentName);
    this.queryTimeout = options.queryTimeout ?? 5000;

    // Ensure directories exist
    if (!existsSync(this.outboxDir)) {
      mkdirSync(this.outboxDir, { recursive: true });
    }
    if (!existsSync(this.inboxDir)) {
      mkdirSync(this.inboxDir, { recursive: true });
    }
  }

  /**
   * Send a message using file-based protocol.
   * Writes to outbox/msg in the format expected by relay-pty.
   */
  async send(options: SendOptions): Promise<void> {
    const { to, message, thread } = options;

    // Build message content in relay file format
    let content = `TO: ${to}\n`;
    if (thread) {
      content += `THREAD: ${thread}\n`;
    }
    content += `\n${message}`;

    // Write to outbox
    const msgPath = join(this.outboxDir, 'msg');
    writeFileSync(msgPath, content);

    // NOTE: relay-pty watches for ->relay-file:msg trigger in agent output.
    // The daemon does NOT watch outbox files directly.
    // The caller must output "->relay-file:msg" for relay-pty to process this file.
  }

  /**
   * Spawn an agent using file-based protocol.
   */
  async spawn(options: SpawnOptions): Promise<{ success: boolean; error?: string }> {
    const { name, cli, task, model, cwd } = options;

    // Build spawn content
    let content = `KIND: spawn\n`;
    content += `NAME: ${name}\n`;
    content += `CLI: ${cli}\n`;
    if (model) {
      content += `MODEL: ${model}\n`;
    }
    if (cwd) {
      content += `CWD: ${cwd}\n`;
    }
    content += `\n${task}`;

    // Write to outbox
    const spawnPath = join(this.outboxDir, 'spawn');
    writeFileSync(spawnPath, content);

    return { success: true };
  }

  /**
   * Release an agent using file-based protocol.
   */
  async release(options: ReleaseOptions): Promise<{ success: boolean; error?: string }> {
    const { name, reason } = options;

    let content = `KIND: release\n`;
    content += `NAME: ${name}\n`;
    if (reason) {
      content += `\n${reason}`;
    }

    const releasePath = join(this.outboxDir, 'release');
    writeFileSync(releasePath, content);

    return { success: true };
  }

  /**
   * Check inbox for messages.
   * Reads message files from the inbox directory.
   */
  async getInbox(options?: { unreadOnly?: boolean; limit?: number }): Promise<Array<{
    id: string;
    from: string;
    content: string;
    timestamp: number;
    thread?: string;
    channel?: string;
  }>> {
    const messages: Array<{
      id: string;
      from: string;
      content: string;
      timestamp: number;
      thread?: string;
      channel?: string;
    }> = [];

    if (!existsSync(this.inboxDir)) {
      return messages;
    }

    try {
      const files = readdirSync(this.inboxDir, { withFileTypes: true })
        .filter(d => d.isFile() && !d.name.startsWith('.'))
        .slice(0, options?.limit ?? 50);

      for (const file of files) {
        try {
          const filePath = join(this.inboxDir, file.name);
          const content = readFileSync(filePath, 'utf-8');

          // Parse message format: FROM: X\nTHREAD: Y\n\nBody
          const lines = content.split('\n');
          let from = 'unknown';
          let thread: string | undefined;
          let channel: string | undefined;
          let bodyStart = 0;

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line === '') {
              bodyStart = i + 1;
              break;
            }
            if (line.startsWith('FROM: ')) {
              from = line.slice(6).trim();
            } else if (line.startsWith('THREAD: ')) {
              thread = line.slice(8).trim();
            } else if (line.startsWith('CHANNEL: ')) {
              channel = line.slice(9).trim();
            }
          }

          const body = lines.slice(bodyStart).join('\n');

          messages.push({
            id: file.name,
            from,
            content: body,
            timestamp: Date.now(), // Could get from file mtime
            thread,
            channel,
          });

          // If unreadOnly, delete after reading
          if (options?.unreadOnly) {
            unlinkSync(filePath);
          }
        } catch {
          // Skip files that can't be read
        }
      }
    } catch {
      // Directory read error
    }

    return messages;
  }

  /**
   * Get outbox directory path (for external use).
   */
  getOutboxPath(): string {
    return this.outboxDir;
  }

  /**
   * Get inbox directory path (for external use).
   */
  getInboxPath(): string {
    return this.inboxDir;
  }
}

/**
 * Create a file transport instance.
 */
export function createFileTransport(options: FileTransportOptions): FileTransport {
  return new FileTransport(options);
}

/**
 * Discover the base directory for file-based protocol.
 * Looks for .agent-relay directory in cwd or parent directories.
 */
export function discoverBaseDir(): string | null {
  // Check environment variable first
  const envSocket = process.env.RELAY_SOCKET;
  if (envSocket) {
    // Socket path is like /path/to/project/.agent-relay/relay.sock
    // Base dir is the parent of .agent-relay
    const parts = envSocket.split('.agent-relay');
    if (parts.length > 1) {
      return parts[0].replace(/\/$/, '');
    }
  }

  // Search from cwd upward
  let dir = process.cwd();
  const root = '/';

  while (dir !== root) {
    const relayDir = join(dir, '.agent-relay');
    if (existsSync(relayDir)) {
      return dir;
    }
    dir = join(dir, '..');
  }

  return null;
}
