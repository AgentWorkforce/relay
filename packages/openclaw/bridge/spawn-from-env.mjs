#!/usr/bin/env node

import { AgentRelayClient } from '@agent-relay/driver';

function csv(value) {
  return value
    ? value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

async function main() {
  const name = process.env.AGENT_NAME;
  const cli = process.env.AGENT_CLI || 'node';
  const args = process.env.AGENT_ARGS ? [process.env.AGENT_ARGS] : [];
  const channels = csv(process.env.AGENT_CHANNELS);

  if (!name) {
    throw new Error('AGENT_NAME is required');
  }

  const client = await AgentRelayClient.spawn({
    brokerName: name,
    channels,
    cwd: process.env.AGENT_CWD || process.cwd(),
    env: process.env,
  });

  try {
    const agent = await client.spawnPty({
      name,
      cli,
      args,
      channels,
      task: process.env.AGENT_TASK,
      cwd: process.env.AGENT_CWD,
    });

    await new Promise((resolve) => {
      client.addListener('agentExited', (event) => {
        if (event.name === agent.name) {
          resolve();
        }
      });
    });
  } finally {
    await client.shutdown().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
