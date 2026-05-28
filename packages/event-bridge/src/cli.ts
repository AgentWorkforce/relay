#!/usr/bin/env node
import { bootstrapGatewayAccess } from './bootstrap.js';
import { createEventBridge } from './bridge.js';
import type { EventBridgeConfig } from './config.js';

/**
 * Run the event bridge as a daemon.
 *
 * By default it bootstraps the gateway URL + scoped token from cloud using your
 * stored login (`agent-relay login`) — reusing the deployed cloud, nothing runs
 * locally. Pass `--gateway-url` + `--api-key` (or the matching env vars) to skip
 * the bootstrap. Logs go to stderr so stdout stays clean.
 *
 * Flags (env fallback in parens):
 *   --workspace <id|name>   (RELAY_WORKSPACE)        required
 *   --agent <name>          (EVENT_BRIDGE_AGENT)     required
 *   --providers <csv>       (EVENT_BRIDGE_PROVIDERS) default: slack
 *   --outbox <dir>          (EVENT_BRIDGE_OUTBOX)    default: ./outbox
 *   --inject-mode <m>       (EVENT_BRIDGE_INJECT_MODE) wait | steer
 *   --api-url <url>         (CLOUD_API_URL)          cloud base for bootstrap
 *   --gateway-url <ws-url>  (RELAY_GATEWAY_URL)      skip bootstrap when set
 *   --api-key <token>       (RELAY_API_KEY)          skip bootstrap when set
 *   --broker-url <url>      (RELAY_BROKER_URL)       remote broker; else local
 *   --no-bootstrap                                   error instead of bootstrapping
 */
async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const env = process.env;

  const workspace = flags.workspace ?? env.RELAY_WORKSPACE ?? env.RELAY_WORKSPACE_ID;
  const agentName = flags.agent ?? env.EVENT_BRIDGE_AGENT;
  if (!workspace || !agentName) {
    console.error(
      'Usage: agent-relay-event-bridge --workspace <id|name> --agent <name> [--providers slack] [--gateway-url <url> --api-key <token>]'
    );
    process.exit(2);
  }

  const providers = csv(flags.providers ?? env.EVENT_BRIDGE_PROVIDERS) ?? ['slack'];
  const outboxDir = flags.outbox ?? env.EVENT_BRIDGE_OUTBOX ?? './outbox';
  const injectMode = (flags['inject-mode'] ?? env.EVENT_BRIDGE_INJECT_MODE) === 'steer' ? 'steer' : 'wait';

  let resolvedWorkspace = workspace;
  let gatewayUrl = flags['gateway-url'] ?? env.RELAY_GATEWAY_URL;
  let apiKey = flags['api-key'] ?? env.RELAY_API_KEY;

  if (!gatewayUrl || !apiKey) {
    if (flags.bootstrap === 'false') {
      console.error('Missing --gateway-url/--api-key and --no-bootstrap was set.');
      process.exit(2);
    }
    console.error(`[event-bridge] bootstrapping gateway access for workspace "${workspace}" from cloud…`);
    const access = await bootstrapGatewayAccess({
      workspace,
      ...(flags['api-url'] ? { apiUrl: flags['api-url'] } : {}),
    });
    resolvedWorkspace = access.workspaceId;
    gatewayUrl = gatewayUrl ?? access.gatewayUrl;
    apiKey = apiKey ?? access.apiKey;
    console.error(`[event-bridge] gateway: ${gatewayUrl}`);
  }

  const config: EventBridgeConfig = {
    workspace: resolvedWorkspace,
    apiKey,
    agentName,
    providers,
    outboxDir,
    gatewayUrl,
    injectMode,
    ...((flags['broker-url'] ?? env.RELAY_BROKER_URL)
      ? { brokerUrl: flags['broker-url'] ?? env.RELAY_BROKER_URL }
      : {}),
    ...(env.RELAY_BROKER_CWD ? { brokerCwd: env.RELAY_BROKER_CWD } : {}),
    ...(env.EVENT_BRIDGE_REPLAY ? { replayOnStart: env.EVENT_BRIDGE_REPLAY } : {}),
  };

  const bridge = createEventBridge(config, {
    logger: (message, fields) =>
      console.error(`[event-bridge] ${message}${fields ? ` ${JSON.stringify(fields)}` : ''}`),
  });

  await bridge.ready;

  const shutdown = (signal: NodeJS.Signals): void => {
    console.error(`[event-bridge] received ${signal}, shutting down`);
    void bridge.stop().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    if (key.startsWith('no-')) {
      out[key.slice(3)] = 'false';
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

function csv(value: string | undefined): string[] | undefined {
  const parts = value
    ?.split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return parts && parts.length > 0 ? parts : undefined;
}

main().catch((err: unknown) => {
  console.error('[event-bridge] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
