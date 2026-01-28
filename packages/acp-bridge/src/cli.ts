#!/usr/bin/env node
/**
 * CLI entry point for the ACP Bridge
 *
 * Usage:
 *   relay-acp [options]
 *
 * Options:
 *   --name <name>     Agent name (default: relay-acp)
 *   --socket <path>   Relay daemon socket path
 *   --debug           Enable debug logging
 *
 * Environment:
 *   ANTHROPIC_API_KEY  Not required (we use relay agents, not Claude API directly)
 *   WORKSPACE_ID       Used to determine default socket path
 */

import { RelayACPAgent } from './acp-agent.js';
import type { ACPBridgeConfig } from './types.js';

function parseArgs(): ACPBridgeConfig {
  const args = process.argv.slice(2);
  const config: ACPBridgeConfig = {
    agentName: 'relay-acp',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--name' && args[i + 1]) {
      config.agentName = args[++i];
    } else if (arg === '--socket' && args[i + 1]) {
      config.socketPath = args[++i];
    } else if (arg === '--debug') {
      config.debug = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--version' || arg === '-v') {
      printVersion();
      process.exit(0);
    }
  }

  return config;
}

function printHelp(): void {
  console.log(`
relay-acp - ACP Bridge for Agent Relay

Exposes Agent Relay agents to ACP-compatible editors like Zed.

USAGE:
  relay-acp [OPTIONS]

OPTIONS:
  --name <name>     Agent name for relay identification (default: relay-acp)
  --socket <path>   Path to relay daemon socket
  --debug           Enable debug logging to stderr
  --help, -h        Show this help message
  --version, -v     Show version

ENVIRONMENT:
  WORKSPACE_ID      Used to determine default socket path

EXAMPLE:
  # Start the bridge
  relay-acp --name my-agent --debug

  # Use with Zed (add to Zed agent configuration)
  # See: https://zed.dev/docs/agents

NOTES:
  - Requires a running Agent Relay daemon
  - Communicates with editors via stdin/stdout (ACP protocol)
  - Debug output goes to stderr to avoid interfering with ACP protocol
`);
}

function printVersion(): void {
  console.log('relay-acp 0.1.0');
}

async function main(): Promise<void> {
  const config = parseArgs();

  if (config.debug) {
    console.error('[relay-acp] Starting with config:', JSON.stringify(config, null, 2));
  }

  const agent = new RelayACPAgent(config);

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    if (config.debug) {
      console.error('[relay-acp] Received SIGINT, shutting down...');
    }
    await agent.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    if (config.debug) {
      console.error('[relay-acp] Received SIGTERM, shutting down...');
    }
    await agent.stop();
    process.exit(0);
  });

  // Handle uncaught errors
  process.on('uncaughtException', (err) => {
    console.error('[relay-acp] Uncaught exception:', err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[relay-acp] Unhandled rejection:', reason);
    process.exit(1);
  });

  try {
    await agent.start();

    if (config.debug) {
      console.error('[relay-acp] Agent started, waiting for ACP connections...');
    }
  } catch (err) {
    console.error('[relay-acp] Failed to start:', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[relay-acp] Fatal error:', err);
  process.exit(1);
});
