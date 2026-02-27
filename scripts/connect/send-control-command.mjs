#!/usr/bin/env node

import { RelayCast } from '@agent-relay/sdk';

function printUsage() {
  console.log(`Usage:
  node scripts/connect/send-control-command.mjs --json '{"type":"status"}'

Options:
  --json <payload>          JSON control payload
  --type <type>             Build payload from flags (spawn|release|message|status|ping)
  --name <name>             Agent name (spawn/release)
  --cli <cli>               CLI name for spawn (codex|claude|gemini|aider|goose)
  --task <text>             Spawn task
  --model <model>           Spawn model
  --to <target>             Message target
  --body <text>             Message body
  --from <sender>           Message sender name
  --reason <reason>         Release reason
  --channel <name>          Control channel (default: control)
  --sender <name>           Helper sender identity (default: connect-orchestrator)
  --api-key <key>           Relaycast workspace key (fallback: RELAY_API_KEY)
  --base-url <url>          Relaycast base URL (fallback: RELAYCAST_BASE_URL or https://api.relaycast.dev)
`);
}

function parseArgv(argv) {
  const map = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      map.set(key, 'true');
      continue;
    }
    map.set(key, next);
    i += 1;
  }
  return map;
}

function buildPayload(args) {
  const rawJson = args.get('json');
  if (rawJson) {
    return JSON.parse(rawJson);
  }

  const type = args.get('type');
  if (!type) {
    throw new Error('Provide --json or --type');
  }

  if (type === 'spawn') {
    const name = args.get('name');
    const cli = args.get('cli');
    if (!name || !cli) {
      throw new Error('spawn requires --name and --cli');
    }

    const payload = {
      type: 'spawn',
      name,
      cli,
      task: args.get('task') ?? undefined,
      model: args.get('model') ?? undefined,
    };

    return payload;
  }

  if (type === 'release') {
    const name = args.get('name');
    if (!name) {
      throw new Error('release requires --name');
    }
    return {
      type: 'release',
      name,
      reason: args.get('reason') ?? undefined,
    };
  }

  if (type === 'message') {
    const to = args.get('to');
    const body = args.get('body');
    if (!to || !body) {
      throw new Error('message requires --to and --body');
    }

    return {
      type: 'message',
      to,
      body,
      from: args.get('from') ?? undefined,
    };
  }

  if (type === 'status' || type === 'ping') {
    return { type };
  }

  throw new Error(`Unsupported --type "${type}"`);
}

async function ensureChannel(client, channel) {
  try {
    await client.channels.join(channel);
    return;
  } catch {
    // fall through
  }

  try {
    await client.channels.create({
      name: channel,
      topic: 'Hosted connect control channel',
    });
  } catch {
    // already exists is fine
  }

  await client.channels.join(channel);
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.has('help') || args.has('h')) {
    printUsage();
    return;
  }

  const apiKey = (args.get('api-key') ?? process.env.RELAY_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new Error('Missing API key. Set RELAY_API_KEY or pass --api-key');
  }

  const baseUrl = args.get('base-url') ?? process.env.RELAYCAST_BASE_URL ?? 'https://api.relaycast.dev';
  const channel = args.get('channel') ?? 'control';
  const sender = args.get('sender') ?? 'connect-orchestrator';

  const payload = buildPayload(args);

  const relay = new RelayCast({ apiKey, baseUrl });
  const registration = await relay.agents.registerOrRotate({
    name: sender,
    type: 'agent',
  });
  const me = relay.as(registration.token);

  await ensureChannel(me, channel);
  await me.send(channel, `/connect ${JSON.stringify(payload)}`);

  console.log(`[send-control-command] sent to #${channel}`);
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[send-control-command] ${message}`);
  process.exit(1);
});
