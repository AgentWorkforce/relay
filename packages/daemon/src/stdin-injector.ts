/**
 * Stdin Injector — thin wrapper that pushes relay messages into a CLI's stdin.
 *
 * This replaces the entire relay-pty Rust binary with ~150 lines of Node.js.
 * No PTY wrapping. No output parsing. No Rust. Cross-platform.
 *
 * How it works:
 *   1. Spawns the target CLI (claude, codex, etc.) as a child process
 *   2. Pipes stdin through: terminal → injector → child
 *   3. stdout/stderr pass through unchanged (child → terminal)
 *   4. Connects to hosted daemon via WebSocket
 *   5. When a relay message arrives, formats it and writes to child's stdin
 *
 * Usage:
 *   relay run claude
 *   relay run codex --model gpt-4
 *   RELAY_URL=wss://host/ws relay run claude
 *
 * The child CLI sees relay messages as if the user typed them.
 * Outbound messaging works via MCP tools (relay_send, relay_inbox).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  type Envelope,
  type HelloPayload,
  type WelcomePayload,
  type SendPayload,
  type DeliverEnvelope,
} from '@agent-relay/protocol/types';

function generateId(): string {
  return randomUUID().replace(/-/g, '').substring(0, 16);
}

export interface StdinInjectorConfig {
  /** Command to run (e.g. 'claude') */
  command: string;
  /** Arguments for the command */
  args?: string[];
  /** Agent name (default: auto-generated from command name) */
  agentName?: string;
  /** WebSocket URL of hosted daemon (default: RELAY_URL env var) */
  url?: string;
  /** Auth token (default: RELAY_TOKEN env var) */
  token?: string;
  /** Format for injected messages */
  messageFormat?: 'relay' | 'plain';
}

/**
 * Format a relay message for injection into the CLI's stdin.
 *
 * Uses the same format that agents expect to see in relay snippets:
 *   Relay message from Alice [abc123]: Hello, can you help?
 */
function formatMessage(from: string, body: string, id: string, format: string): string {
  const shortId = id.substring(0, 8);
  if (format === 'plain') {
    return `${from}: ${body}\n`;
  }
  // Default relay format — matches what agents are trained to recognize
  return `Relay message from ${from} [${shortId}]: ${body}\n`;
}

/**
 * Run a CLI with relay message injection.
 *
 * Returns a promise that resolves with the child's exit code.
 */
export async function runWithInjection(config: StdinInjectorConfig): Promise<number> {
  const url = config.url || process.env.RELAY_URL || process.env.AGENT_RELAY_URL;
  if (!url) {
    console.error('[relay run] RELAY_URL not set. Set it to your hosted daemon URL.');
    console.error('  export RELAY_URL=wss://your-host/ws');
    return 1;
  }

  const token = config.token || process.env.RELAY_TOKEN || process.env.AGENT_RELAY_TOKEN;
  const agentName = config.agentName || `${config.command}-${generateId().substring(0, 6)}`;
  const format = config.messageFormat || 'relay';

  // Build WebSocket URL with optional token
  let wsUrl = url;
  if (token) {
    const sep = url.includes('?') ? '&' : '?';
    wsUrl = `${url}${sep}token=${token}`;
  }

  // Spawn the child process with stdin piped, stdout/stderr inherited
  const child = spawn(config.command, config.args ?? [], {
    stdio: ['pipe', 'inherit', 'inherit'],
    env: {
      ...process.env,
      // Ensure child has RELAY_URL so MCP tools work
      RELAY_URL: url,
      ...(token ? { RELAY_TOKEN: token } : {}),
      RELAY_AGENT_NAME: agentName,
    },
  });

  // Forward terminal stdin to child stdin
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.pipe(child.stdin!);

  // Connect to hosted daemon
  const ws = connectToDaemon(wsUrl, agentName, child, format);

  // Handle child exit
  return new Promise<number>((resolve) => {
    child.on('exit', (code) => {
      // Clean up
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.unpipe(child.stdin!);
      process.stdin.pause();

      // Close WebSocket
      ws.then(socket => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            v: PROTOCOL_VERSION,
            type: 'BYE',
            id: generateId(),
            ts: Date.now(),
            payload: {},
          }));
          socket.close();
        }
      }).catch(() => {});

      resolve(code ?? 0);
    });

    child.on('error', (err) => {
      console.error(`[relay run] Failed to start ${config.command}: ${err.message}`);
      resolve(1);
    });
  });
}

/**
 * Connect to the hosted daemon and inject messages into the child's stdin.
 */
async function connectToDaemon(
  url: string,
  agentName: string,
  child: ChildProcess,
  format: string
): Promise<WebSocket> {
  const ws = new WebSocket(url);

  ws.on('open', () => {
    // Send HELLO
    const hello: Envelope<HelloPayload> = {
      v: PROTOCOL_VERSION,
      type: 'HELLO',
      id: generateId(),
      ts: Date.now(),
      payload: {
        agent: agentName,
        capabilities: { ack: true, resume: true, max_inflight: 100, supports_topics: true },
        cli: 'stdin-injector',
      },
    };
    ws.send(JSON.stringify(hello));
  });

  ws.on('message', (data) => {
    const raw = typeof data === 'string' ? data : data.toString('utf-8');
    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch {
      return;
    }

    switch (envelope.type) {
      case 'WELCOME': {
        const welcome = envelope as Envelope<WelcomePayload>;
        // Silently connected — no noise in the child's output
        break;
      }

      case 'DELIVER': {
        const deliver = envelope as DeliverEnvelope;
        const from = deliver.from ?? 'unknown';
        const body = deliver.payload?.body ?? '';

        // THE KEY PART: inject the message into the child's stdin
        if (child.stdin && !child.stdin.destroyed) {
          const formatted = formatMessage(from, body, deliver.id, format);
          child.stdin.write(formatted);
        }

        // Send ACK
        ws.send(JSON.stringify({
          v: PROTOCOL_VERSION,
          type: 'ACK',
          id: generateId(),
          ts: Date.now(),
          from: agentName,
          to: from,
          payload: { ack_id: deliver.id },
        }));
        break;
      }

      case 'PING': {
        ws.send(JSON.stringify({
          v: PROTOCOL_VERSION,
          type: 'PONG',
          id: generateId(),
          ts: Date.now(),
          payload: (envelope.payload as { nonce?: string }) ?? {},
        }));
        break;
      }

      case 'ERROR': {
        const err = envelope.payload as { message?: string; fatal?: boolean };
        process.stderr.write(`[relay] Error: ${err.message}\n`);
        break;
      }
    }
  });

  ws.on('error', (err) => {
    process.stderr.write(`[relay] WebSocket error: ${err.message}\n`);
  });

  ws.on('close', () => {
    // Attempt reconnect after 2 seconds
    setTimeout(() => {
      if (!child.killed && child.exitCode === null) {
        connectToDaemon(url, agentName, child, format).catch(() => {});
      }
    }, 2000);
  });

  return ws;
}
