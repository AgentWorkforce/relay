#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { ExecutionBridge } from './bridge.js';
import { configSchema } from './config.js';
import { CoreNode } from './core-node.js';
import { exitCode } from './ports.js';
import { RelayHttpClient } from './relay-http.js';
import { BridgeStore } from './store.js';

const TOKEN_ENV = 'CHIEF_BRIDGE_RELAY_TOKEN';

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error('usage: chief-execution-bridge <config.json>');
  const parsed = configSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new Error('bridge_config_invalid');
  const config = parsed.data;
  const token = process.env[TOKEN_ENV];
  if (!token) throw new Error('bridge_token_missing');
  delete process.env[TOKEN_ENV];

  const store = new BridgeStore(config.ledgerPath);
  const bridge = new ExecutionBridge({
    config,
    store,
    relay: new RelayHttpClient(config.relayOrigin, token),
    node: new CoreNode({ socket: config.coreSocket }),
    log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
  });

  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());

  await bridge.start();
  while (!stop.signal.aborted) {
    await bridge.tick();
    await sleep(config.pollIntervalMs, undefined, { signal: stop.signal }).catch(() => undefined);
  }
  store.close();
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: 'bridge_exit', code: exitCode(error) }));
  process.exit(1);
});
