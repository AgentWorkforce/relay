#!/usr/bin/env node
/**
 * CLI entry point for the OpenClaw adapter.
 *
 * Usage:
 *   npx @agent-relay/openclaw-adapter \
 *     --workspace rk_live_xxx \
 *     --gateway ws://127.0.0.1:18789 \
 *     [--gateway-token <token>] \
 *     [--channel openclaw] \
 *     [--prefix oc] \
 *     [--debug]
 *
 * Environment variables:
 *   RELAY_API_KEY           — Relaycast workspace key (alternative to --workspace)
 *   OPENCLAW_GATEWAY_URL    — Gateway WebSocket URL (alternative to --gateway)
 *   OPENCLAW_GATEWAY_TOKEN  — Gateway auth token (alternative to --gateway-token)
 */

import { parseArgs } from 'node:util';
import { OpenClawAdapter } from './adapter.js';

function printHelp(): void {
  console.log(`
  @agent-relay/openclaw-adapter — Bridge OpenClaw agents into Relaycast

  USAGE
    relay-openclaw --workspace <key> [options]

  OPTIONS
    --workspace, -w <key>     Relaycast workspace API key (or RELAY_API_KEY env)
    --gateway, -g <url>       OpenClaw gateway URL (default: ws://127.0.0.1:18789)
    --gateway-token <token>   Gateway auth token (or OPENCLAW_GATEWAY_TOKEN env)
    --channel <name>          Relaycast channel name (default: openclaw)
    --prefix <prefix>         Agent name prefix (default: oc)
    --debug                   Enable debug logging
    --help, -h                Show this help message

  EXAMPLES
    # Basic usage
    relay-openclaw --workspace rk_live_xxx

    # Custom gateway and channel
    relay-openclaw -w rk_live_xxx -g ws://10.0.0.5:18789 --channel team

    # Using environment variables
    RELAY_API_KEY=rk_live_xxx OPENCLAW_GATEWAY_URL=ws://10.0.0.5:18789 relay-openclaw
`.trim());
}

function main(): void {
  const { values } = parseArgs({
    options: {
      workspace: { type: 'string', short: 'w' },
      gateway: { type: 'string', short: 'g' },
      'gateway-token': { type: 'string' },
      channel: { type: 'string' },
      prefix: { type: 'string' },
      debug: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const workspaceKey =
    values.workspace || process.env.RELAY_API_KEY;
  const gatewayUrl =
    values.gateway || process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789';
  const gatewayToken =
    values['gateway-token'] || process.env.OPENCLAW_GATEWAY_TOKEN;

  if (!workspaceKey) {
    console.error(
      '[openclaw-adapter] Missing workspace key. Use --workspace or set RELAY_API_KEY.',
    );
    process.exit(1);
  }

  const adapter = new OpenClawAdapter({
    gatewayUrl,
    gatewayToken,
    workspaceKey,
    channel: values.channel,
    prefix: values.prefix,
    debug: values.debug,
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[openclaw-adapter] Shutting down...');
    await adapter.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  adapter.start().catch((err: Error) => {
    console.error(`[openclaw-adapter] Failed to start: ${err.message}`);
    process.exit(1);
  });
}

main();
