#!/usr/bin/env node

/**
 * bridge.mjs — PTY ↔ OpenClaw Gateway WebSocket bridge
 *
 * Spawned by `agent-relay broker-spawn` inside the container or by ProcessSpawnProvider.
 * Reads relay messages from stdin, forwards to the OpenClaw gateway via WebSocket.
 * Receives chat events from the gateway, writes responses to stdout.
 *
 * Gateway protocol (v3):
 *   1. First message must be a `connect` RPC with client info
 *   2. Send messages via `chat.send` RPC (sessionKey + message + idempotencyKey)
 *   3. Receive streaming responses via `chat` events (state: delta/final)
 */

import { createRequire } from 'node:module';

// Resolve ws from this package's node_modules (works both inside containers
// and when installed via npm). Falls back to /opt/clawrunner/ for legacy containers.
let WebSocket;
try {
  const localRequire = createRequire(import.meta.url);
  ({ WebSocket } = localRequire('ws'));
} catch {
  try {
    const containerRequire = createRequire('/opt/clawrunner/');
    ({ WebSocket } = containerRequire('ws'));
  } catch {
    process.stderr.write('[bridge] FATAL: Cannot find "ws" package. Install with: npm install ws\n');
    process.exit(1);
  }
}

import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const GATEWAY_PORT = process.env.GATEWAY_PORT ?? '18789';
const GATEWAY_HOST = process.env.GATEWAY_HOST ?? '127.0.0.1';
const GATEWAY_URL = `ws://${GATEWAY_HOST}:${GATEWAY_PORT}`;
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? '';
const SESSION_KEY = `bridge-${randomUUID()}`;
const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 15;
const OPENCLAW_NAME = process.env.OPENCLAW_NAME ?? process.env.AGENT_NAME ?? 'agent';
const OPENCLAW_WORKSPACE_ID = process.env.OPENCLAW_WORKSPACE_ID ?? 'unknown';
const OPENCLAW_MODEL = process.env.OPENCLAW_MODEL ?? 'openai-codex/gpt-5.3-codex';

let ws = null;
let connected = false; // gateway handshake complete
let reconnectAttempts = 0;
let shuttingDown = false;

const RUNTIME_IDENTITY_PREAMBLE = [
  '[runtime-identity contract]',
  `name=${OPENCLAW_NAME}`,
  `workspace=${OPENCLAW_WORKSPACE_ID}`,
  `model=${OPENCLAW_MODEL}`,
  'platform=openclaw-gateway',
  'rule=never-claim-claude',
  'source=/workspace/config/runtime-identity.json',
  '[/runtime-identity contract]'
].join('\n');

// ── WebSocket RPC helpers ──────────────────────────────────────────────

function sendRpc(method, params = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    process.stderr.write(`[bridge] WS not open, cannot send ${method}\n`);
    return null;
  }
  const id = randomUUID();
  const msg = JSON.stringify({ type: 'req', id, method, params });
  ws.send(msg);
  return id;
}

// ── Gateway connect handshake ─────────────────────────────────────────

function sendConnect() {
  return sendRpc('connect', {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: 'gateway-client',
      displayName: 'openclaw-relaycast-bridge',
      version: '1.0.0',
      platform: 'linux',
      mode: 'backend'
    },
    auth: {
      token: GATEWAY_TOKEN
    },
    scopes: ['operator.read', 'operator.write', 'chat.read', 'chat.write']
  });
}

// ── Gateway connection ────────────────────────────────────────────────

function connect() {
  if (shuttingDown) return;

  process.stderr.write(`[bridge] Connecting to ${GATEWAY_URL} ...\n`);
  ws = new WebSocket(GATEWAY_URL);

  ws.on('open', () => {
    process.stderr.write('[bridge] WebSocket open, sending connect handshake\n');
    reconnectAttempts = 0;
    connected = false;
    sendConnect();
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      process.stderr.write(`[bridge] Unparseable WS message: ${data}\n`);
      return;
    }

    // Handle RPC responses
    if (msg.type === 'res') {
      if (msg.ok && !connected) {
        // This is the connect response
        connected = true;
        process.stderr.write('[bridge] Gateway handshake complete\n');
        flushPending();
        return;
      }
      if (!msg.ok) {
        process.stderr.write(`[bridge] RPC error: ${JSON.stringify(msg)}\n`);
      }
      return;
    }

    // Handle gateway events
    if (msg.type === 'event') {
      handleGatewayEvent(msg);
    }
  });

  ws.on('close', (code) => {
    process.stderr.write(`[bridge] WS closed (code=${code})\n`);
    connected = false;
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    process.stderr.write(`[bridge] WS error: ${err.message}\n`);
    // 'close' will fire after 'error', which triggers reconnect
  });
}

function scheduleReconnect() {
  if (shuttingDown) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    process.stderr.write('[bridge] Max reconnect attempts reached, exiting\n');
    process.exit(1);
  }
  reconnectAttempts++;
  const delay = RECONNECT_DELAY_MS * Math.min(reconnectAttempts, 5);
  process.stderr.write(`[bridge] Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})\n`);
  setTimeout(connect, delay);
}

// ── Gateway event handler ─────────────────────────────────────────────

function handleGatewayEvent(msg) {
  const { event, payload } = msg;

  if (event === 'chat') {
    // Chat events have state: "delta" (streaming) or "final" (done)
    if (payload?.state === 'delta' || payload?.state === 'final') {
      const content = payload?.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            process.stdout.write(block.text);
          }
        }
      } else if (typeof content === 'string' && content) {
        process.stdout.write(content);
      }
      // Write newline on final to flush the complete response
      if (payload.state === 'final') {
        process.stdout.write('\n');
      }
    }
    return;
  }

  // Log other events for debugging (not too noisy)
  if (event !== 'presence' && event !== 'tick' && event !== 'health') {
    process.stderr.write(`[bridge] Event: ${event}\n`);
  }
}

// ── Message cleaning ──────────────────────────────────────────────────

/** Accumulated raw lines from stdin (broker may split across lines). */
let inputBuffer = '';

/**
 * Strip <system-reminder> blocks and reformat the broker message.
 * Preserves sender name so the agent knows who they're talking to.
 * Returns a clean message like: "[from alice] What can you do?"
 */
function cleanBrokerMessage(raw) {
  // Remove all <system-reminder>...</system-reminder> blocks (may span lines)
  let cleaned = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');

  // Extract sender name from "Relay message from <name> [<id>]: <body>"
  const relayMatch = cleaned.match(/^Relay message from (.+?) \[[^\]]*\]:\s*([\s\S]*)$/i);
  if (relayMatch) {
    const sender = relayMatch[1].trim();
    const body = relayMatch[2].trim();
    if (body) return `[from ${sender}] ${body}`;
    return '';
  }

  return cleaned.trim();
}

function applyRuntimeIdentity(message) {
  return `${RUNTIME_IDENTITY_PREAMBLE}\n${message}`;
}

// ── Stdin (relay → gateway) ───────────────────────────────────────────

const pendingMessages = [];

function flushPending() {
  while (pendingMessages.length > 0 && connected) {
    const msg = pendingMessages.shift();
    sendChatMessage(msg);
  }
}

function sendChatMessage(text) {
  sendRpc('chat.send', {
    sessionKey: SESSION_KEY,
    message: text,
    idempotencyKey: randomUUID()
  });
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  // Accumulate lines — broker injection may span multiple lines.
  inputBuffer += line + '\n';

  // Check if we have a complete message (buffer contains the closing tag
  // or a "Relay message from" line, meaning the broker injection is done).
  // If no system-reminder tags at all, treat each line as a complete message.
  const hasOpenTag = inputBuffer.includes('<system-reminder>');
  const hasCloseTag = inputBuffer.includes('</system-reminder>');

  if (hasOpenTag && !hasCloseTag) {
    // Still accumulating a multi-line system-reminder block
    return;
  }

  const cleaned = cleanBrokerMessage(inputBuffer);
  inputBuffer = '';

  if (!cleaned) return;
  const message = applyRuntimeIdentity(cleaned);

  if (!connected) {
    process.stderr.write('[bridge] Not connected yet, buffering message\n');
    pendingMessages.push(message);
    return;
  }

  sendChatMessage(message);
});

rl.on('close', () => {
  process.stderr.write('[bridge] stdin closed, shutting down\n');
  shutdown();
});

// ── Graceful shutdown ─────────────────────────────────────────────────

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  if (ws) {
    try {
      ws.close(1000, 'bridge shutdown');
    } catch {
      // ignore
    }
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ── Start ─────────────────────────────────────────────────────────────

connect();
