/**
 * Hybrid Client for MCP Tools
 *
 * Uses file-based transport for writes (reliable) and socket for queries.
 * This gives the best of both worlds:
 * - Writes go through proven file-based protocol (no timeouts)
 * - Queries use efficient socket communication
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RelayClient } from './client.js';
import { createRelayClient } from './client.js';
import { discoverSocket } from './cloud.js';

export interface HybridClientOptions {
  /** Agent name */
  agentName: string;
  /** Project root directory (where .agent-relay lives) */
  projectRoot: string;
  /** Socket path (optional, will discover if not provided) */
  socketPath?: string;
  /** Project ID */
  project?: string;
}

/**
 * Create a hybrid client that uses file-based for writes, socket for queries.
 */
export function createHybridClient(options: HybridClientOptions): RelayClient {
  const { agentName, projectRoot, project = 'default' } = options;

  // Setup directories
  const relayDir = join(projectRoot, '.agent-relay');
  const outboxDir = join(relayDir, 'outbox', agentName);
  const inboxDir = join(relayDir, 'inbox', agentName);

  // Ensure directories exist
  if (!existsSync(outboxDir)) {
    mkdirSync(outboxDir, { recursive: true });
  }
  if (!existsSync(inboxDir)) {
    mkdirSync(inboxDir, { recursive: true });
  }

  // Get socket path for queries
  const socketPath = options.socketPath || discoverSocket()?.socketPath || join(relayDir, 'relay.sock');

  // Create socket client for queries only
  let socketClient: RelayClient | null = null;
  const getSocketClient = () => {
    if (!socketClient) {
      socketClient = createRelayClient({
        agentName,
        socketPath,
        project,
      });
    }
    return socketClient;
  };

  // File-based send (write to outbox)
  const send = async (to: string, message: string, opts: { thread?: string } = {}): Promise<void> => {
    let content = `TO: ${to}\n`;
    if (opts.thread) {
      content += `THREAD: ${opts.thread}\n`;
    }
    content += `\n${message}`;

    const msgPath = join(outboxDir, 'msg');
    writeFileSync(msgPath, content);
    // Daemon watches outbox and processes
  };

  // File-based sendAndWait (for now, delegate to socket - can improve later)
  const sendAndWait = async (
    to: string,
    message: string,
    opts: { thread?: string; timeoutMs?: number } = {}
  ): Promise<{ from: string; content: string; thread?: string }> => {
    // For await responses, we still use socket since we need the response
    // TODO: Implement file-based request/response pattern
    return getSocketClient().sendAndWait(to, message, opts);
  };

  // File-based spawn
  const spawn = async (opts: {
    name: string;
    cli: string;
    task: string;
    model?: string;
    cwd?: string;
  }): Promise<{ success: boolean; error?: string }> => {
    let content = `KIND: spawn\n`;
    content += `NAME: ${opts.name}\n`;
    content += `CLI: ${opts.cli}\n`;
    if (opts.model) {
      content += `MODEL: ${opts.model}\n`;
    }
    if (opts.cwd) {
      content += `CWD: ${opts.cwd}\n`;
    }
    content += `\n${opts.task}`;

    const spawnPath = join(outboxDir, 'spawn');
    writeFileSync(spawnPath, content);
    return { success: true };
  };

  // File-based release
  const release = async (name: string, reason?: string): Promise<{ success: boolean; error?: string }> => {
    let content = `KIND: release\n`;
    content += `NAME: ${name}\n`;
    if (reason) {
      content += `\n${reason}`;
    }

    const releasePath = join(outboxDir, 'release');
    writeFileSync(releasePath, content);
    return { success: true };
  };

  // File-based continuity (NEW - not in original MCP)
  const saveContinuity = async (state: {
    currentTask?: string;
    completed?: string;
    inProgress?: string;
    keyDecisions?: string;
    files?: string;
  }): Promise<void> => {
    let content = `KIND: continuity\n`;
    content += `ACTION: save\n\n`;
    if (state.currentTask) content += `Current task: ${state.currentTask}\n`;
    if (state.completed) content += `Completed: ${state.completed}\n`;
    if (state.inProgress) content += `In progress: ${state.inProgress}\n`;
    if (state.keyDecisions) content += `Key decisions: ${state.keyDecisions}\n`;
    if (state.files) content += `Files: ${state.files}\n`;

    const continuityPath = join(outboxDir, 'continuity');
    writeFileSync(continuityPath, content);
  };

  const loadContinuity = async (): Promise<void> => {
    const content = `KIND: continuity\nACTION: load\n`;
    const continuityPath = join(outboxDir, 'continuity');
    writeFileSync(continuityPath, content);
  };

  const markUncertain = async (item: string): Promise<void> => {
    const content = `KIND: continuity\nACTION: uncertain\n\n${item}`;
    const continuityPath = join(outboxDir, 'continuity');
    writeFileSync(continuityPath, content);
  };

  // Socket-based queries (these work fine over socket)
  const getStatus = async () => getSocketClient().getStatus();
  const getInbox = async (opts?: Parameters<RelayClient['getInbox']>[0]) => getSocketClient().getInbox(opts);
  const listAgents = async (opts?: Parameters<RelayClient['listAgents']>[0]) => getSocketClient().listAgents(opts);
  const getHealth = async (opts?: Parameters<RelayClient['getHealth']>[0]) => getSocketClient().getHealth(opts);
  const getMetrics = async (opts?: Parameters<RelayClient['getMetrics']>[0]) => getSocketClient().getMetrics(opts);

  return {
    send,
    sendAndWait,
    spawn,
    release,
    getStatus,
    getInbox,
    listAgents,
    getHealth,
    getMetrics,
    // Extended methods (not in base RelayClient interface but useful)
    saveContinuity,
    loadContinuity,
    markUncertain,
  } as RelayClient & {
    saveContinuity: typeof saveContinuity;
    loadContinuity: typeof loadContinuity;
    markUncertain: typeof markUncertain;
  };
}

/**
 * Discover project root from socket path or environment.
 */
export function discoverProjectRoot(): string | null {
  // Check RELAY_SOCKET env var
  const socketEnv = process.env.RELAY_SOCKET;
  if (socketEnv) {
    // Socket path is like /path/to/project/.agent-relay/relay.sock
    const match = socketEnv.match(/^(.+)\/\.agent-relay\/relay\.sock$/);
    if (match) {
      return match[1];
    }
  }

  // Search from cwd upward
  let dir = process.cwd();
  while (dir !== '/') {
    if (existsSync(join(dir, '.agent-relay'))) {
      return dir;
    }
    dir = dirname(dir);
  }

  return null;
}
