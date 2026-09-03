#!/usr/bin/env node
/**
 * Minimal MCP stdio server used only by `scripts/check-argv-secrets.mjs`.
 *
 * The broker refuses to build spawn args unless it can preflight a working
 * Agent Relay MCP command (initialize + tools/list exposing the coordination
 * tools). Pointing the guard at the installed `agent-relay` would make a
 * security check depend on a working npm install and a 10s network-ish probe;
 * this stub answers the handshake locally so the guard tests the *argv
 * construction* and nothing else.
 */

const REQUIRED_TOOLS = ['send_dm', 'post_message', 'check_inbox'];

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(line);
  }
});

function reply(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === 'initialize') {
    reply({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'argv-guard-stub', version: '1.0' },
      },
    });
    return;
  }
  if (message.method === 'tools/list') {
    reply({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: REQUIRED_TOOLS.map((name) => ({
          name,
          description: `stub ${name}`,
          inputSchema: { type: 'object', properties: {} },
        })),
      },
    });
  }
}
