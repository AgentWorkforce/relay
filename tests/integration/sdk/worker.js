#!/usr/bin/env node
/**
 * SDK Worker Agent
 *
 * A worker process that uses the SDK to connect and communicate.
 * This is NOT an AI agent - it's a Node.js process using the SDK directly.
 *
 * Environment variables:
 *   AGENT_RELAY_NAME - Name to register as
 *   ORCHESTRATOR - Name of orchestrator to report to
 *   TASK_ID - Task identifier
 */

import { RelayClient } from '@agent-relay/sdk';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const socketPath = resolve(projectRoot, '.agent-relay', 'relay.sock');

const agentName = process.env.AGENT_RELAY_NAME;
const orchestratorName = process.env.ORCHESTRATOR;
const taskId = process.env.TASK_ID || 'default';

if (!agentName || !orchestratorName) {
  console.error('Missing AGENT_RELAY_NAME or ORCHESTRATOR env var');
  process.exit(1);
}

async function main() {
  const client = new RelayClient({
    agentName,
    socketPath,
    quiet: false, // Enable SDK logs
    reconnect: false, // Disable auto-reconnect to see errors
  });

  // Error handler
  client.onError = (err) => {
    console.error(`[${agentName}] SDK Error: ${err.message}`);
  };

  // State change handler
  client.onStateChange = (state) => {
    console.log(`[${agentName}] State changed: ${state}`);
  };

  // Handle messages from orchestrator
  client.onMessage = (from, payload) => {
    const body = payload.body;
    console.log(`[${agentName}] Message from ${from}: ${JSON.stringify(body)}`);

    if (body === 'SHUTDOWN') {
      console.log(`[${agentName}] Shutting down...`);
      client.disconnect();
      process.exit(0);
    }

    // Echo back any other messages
    if (body?.type === 'ping') {
      client.sendMessage(from, { type: 'pong', echo: body.data });
    }
  };

  try {
    await client.connect();
    console.log(`[${agentName}] Connected`);

    // Wait for connection to stabilize
    await new Promise(r => setTimeout(r, 500));

    // Simulate work
    console.log(`[${agentName}] Working on task: ${taskId}`);
    await new Promise(r => setTimeout(r, 1000));

    // Report completion
    const msg = {
      type: 'TASK_COMPLETE',
      taskId,
      worker: agentName,
      result: `Completed ${taskId}`,
    };
    console.log(`[${agentName}] Sending to ${orchestratorName}: ${JSON.stringify(msg)}`);
    const sent = client.sendMessage(orchestratorName, msg);
    console.log(`[${agentName}] sendMessage returned: ${sent}`);

    // Wait for message to be flushed
    await new Promise(r => setTimeout(r, 1000));
    console.log(`[${agentName}] Message should be delivered now`);

    // Wait for shutdown or timeout
    setTimeout(() => {
      console.log(`[${agentName}] Timeout, exiting`);
      client.disconnect();
      process.exit(0);
    }, 30000);

  } catch (error) {
    console.error(`[${agentName}] Error: ${error.message}`);
    process.exit(1);
  }
}

main();
