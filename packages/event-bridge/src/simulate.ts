#!/usr/bin/env node
import { AgentRelayClient } from '@agent-relay/sdk/client';

import { createEventBridge, type BrokerLike } from './bridge.js';
import type { EventBridgeConfig } from './config.js';

/**
 * Local loop test for the event bridge — no cloud gateway, no real Slack.
 *
 * Drives the REAL bridge and your REAL local broker agent with a synthetic
 * Slack message: the agent receives an injected nudge, writes its reply to the
 * outbox, and this harness prints exactly what would be posted back to Slack.
 *
 * Usage:
 *   node dist/simulate.js --agent <name> [--channel ops] [--user alice] \
 *     [--text "deploy staging"] [--outbox ./outbox]
 *
 * Requires a running broker (`agent-relay up`) with an agent of `--agent` name
 * spawned (`agent-relay spawn ... --name <name>`). Set RELAY_BROKER_URL to
 * target a remote broker instead of the local `.agent-relay/connection.json`.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const agentName = args.agent;
  if (!agentName) {
    console.error(
      'Usage: simulate --agent <name> [--channel ops] [--user alice] [--text "..."] [--outbox ./outbox]'
    );
    process.exit(2);
  }

  const channel = args.channel ?? 'ops';
  const user = args.user ?? 'alice';
  const text = args.text ?? 'Hey team, can you deploy staging?';
  const outboxDir = args.outbox ?? './outbox';

  const config: EventBridgeConfig = {
    workspace: 'sim',
    apiKey: process.env.RELAY_API_KEY ?? 'sim',
    agentName,
    providers: ['slack'],
    outboxDir,
    injectMode: 'wait',
  };

  const broker = resolveBroker(config);

  // Fake gateway stream: emits one synthetic Slack change, serves its content,
  // and prints anything the bridge writes back (the would-be Slack post).
  const ts = `${Math.floor(Date.now() / 1000)}_000100`;
  const messagePath = `/slack/channels/C-SIM__${channel}/messages/${ts}/meta.json`;
  const message = { type: 'message', user: `U-${user}`, username: user, text };

  const createStream = ((opts: { onEvent: (event: unknown) => Promise<void> | void }) => {
    setTimeout(() => {
      void opts.onEvent({
        id: `sim-${ts}`,
        workspace: 'sim',
        type: 'relayfile.changed',
        occurredAt: new Date().toISOString(),
        attempt: 1,
        resource: { path: messagePath, kind: 'slack.message', id: ts, provider: 'slack' },
        summary: {},
        expand: async () => ({}),
        path: messagePath,
        action: 'created',
      });
    }, 100);

    return {
      ready: Promise.resolve(),
      close: async () => {},
      registerWatches: async () => ({}),
      readFile: async (path: string) => ({ path, content: JSON.stringify(message) }),
      writeFile: async (path: string, body: unknown) => {
        console.log(`\n📤 [SIM] would post to Slack via writeback path:\n   ${path}\n   ${String(body)}\n`);
        console.log('✅ Loop complete. Ctrl+C to exit.');
      },
    } as never;
  }) as never;

  const bridge = createEventBridge(config, {
    createStream,
    broker,
    logger: (message, fields) =>
      console.error(`[sim] ${message}${fields ? ` ${JSON.stringify(fields)}` : ''}`),
  });

  await bridge.ready;
  console.error(
    `\n[sim] Injected a fake Slack message into agent "${agentName}":\n` +
      `      #${channel} ${user}: "${text}"\n` +
      `      Watch the agent's terminal — it should write its reply to ${outboxDir}/<id>.md,\n` +
      `      which will be printed here as the would-be Slack post.\n`
  );

  const shutdown = (): void => void bridge.stop().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function resolveBroker(config: EventBridgeConfig): BrokerLike {
  const brokerUrl = process.env.RELAY_BROKER_URL?.trim();
  if (brokerUrl) {
    return new AgentRelayClient({ baseUrl: brokerUrl, apiKey: config.apiKey });
  }
  return AgentRelayClient.connect({ cwd: process.env.RELAY_BROKER_CWD?.trim() ?? process.cwd() });
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = 'true';
      }
    }
  }
  return out;
}

main().catch((err: unknown) => {
  console.error('[sim] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
