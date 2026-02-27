#!/usr/bin/env node

import { RelayCast } from '@agent-relay/sdk';

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toChannelName(value) {
  return value.replace(/^#/, '').trim();
}

async function ensureChannel(client, channel) {
  try {
    await client.channels.join(channel);
    return;
  } catch {
    // continue
  }

  try {
    await client.channels.create({
      name: channel,
      topic: 'Hosted connect codex swarm discussion',
    });
  } catch {
    // already exists is fine
  }

  await client.channels.join(channel);
}

async function sendControl(client, controlChannel, payload) {
  await client.send(controlChannel, `/connect ${JSON.stringify(payload)}`);
  console.log(`[swarm] control -> #${controlChannel}: ${JSON.stringify(payload)}`);
}

function buildWorkerTask({ workerName, leadName, chatChannel, topic }) {
  return [
    `You are ${workerName}.`,
    `You are in a 5-agent Codex discussion in #${chatChannel}.`,
    `Topic: ${topic}`,
    '',
    'Important:',
    `- Send all visible replies with relay_send(to: "#${chatChannel}", message: "...").`,
    '- Do not reply only in terminal text.',
    `- Wait for START_DISCUSSION from ${leadName}.`,
    '- After START_DISCUSSION:',
    '  1) Send one concise opening point (max 2 sentences).',
    '  2) Reply to at least one other agent by name.',
    '  3) Send a final short summary line prefixed with DONE:.',
  ].join('\n');
}

async function main() {
  const args = parseArgv(process.argv.slice(2));

  const apiKey = (args.get('api-key') ?? process.env.RELAY_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new Error('Missing API key. Set RELAY_API_KEY or pass --api-key');
  }

  const baseUrl = args.get('base-url') ?? process.env.RELAYCAST_BASE_URL ?? 'https://api.relaycast.dev';
  const controlChannel = toChannelName(args.get('control-channel') ?? 'control');
  const chatChannel = toChannelName(args.get('chat-channel') ?? 'debate');
  const topic = args.get('topic') ?? 'Should we prefer microservices or a modular monolith for a fast-moving startup?';
  const count = Number.parseInt(args.get('count') ?? '5', 10);
  const runSeconds = Number.parseInt(args.get('seconds') ?? '180', 10);
  const autoRelease = !args.has('no-release');

  if (!Number.isFinite(count) || count < 2 || count > 20) {
    throw new Error('--count must be between 2 and 20');
  }

  const id = Date.now().toString(36).slice(-6);
  const leadName = args.get('lead-name') ?? `swarm-lead-${id}`;
  const workerPrefix = args.get('worker-prefix') ?? `codex-swarm-${id}`;
  const workerNames = Array.from({ length: count }, (_v, idx) => `${workerPrefix}-${idx + 1}`);

  console.log(`[swarm] baseUrl=${baseUrl}`);
  console.log(`[swarm] lead=${leadName}`);
  console.log(`[swarm] workers=${workerNames.join(', ')}`);
  console.log(`[swarm] topic=${topic}`);

  const relay = new RelayCast({ apiKey, baseUrl });
  const registration = await relay.agents.registerOrRotate({
    name: leadName,
    type: 'agent',
    metadata: {
      source: 'connect-codex-swarm-demo',
    },
  });

  const lead = relay.as(registration.token);
  await ensureChannel(lead, controlChannel);
  await ensureChannel(lead, chatChannel);

  const connectedWorkers = new Set();
  const unsubs = [];

  lead.connect();

  await new Promise((resolve) => {
    const stop = lead.on.connected(() => {
      lead.subscribe([controlChannel, chatChannel]);
      stop();
      resolve(undefined);
    });
  });

  unsubs.push(
    lead.on.messageCreated((event) => {
      const channel = toChannelName(event.channel ?? '');
      const from = event.message?.agentName ?? 'unknown';
      const text = event.message?.text ?? '';
      if (!text) return;
      if (channel !== controlChannel && channel !== chatChannel) return;

      console.log(`[${channel}] ${from}: ${text}`);

      if (channel === controlChannel && text.startsWith('CONNECT_EVENT ')) {
        try {
          const payload = JSON.parse(text.slice('CONNECT_EVENT '.length));
          if (payload?.type === 'agent_connected' && typeof payload?.name === 'string') {
            connectedWorkers.add(payload.name);
          }
        } catch {
          // ignore malformed event payload
        }
      }
    })
  );

  for (const workerName of workerNames) {
    await sendControl(lead, controlChannel, {
      type: 'spawn',
      name: workerName,
      cli: 'codex',
      task: buildWorkerTask({
        workerName,
        leadName,
        chatChannel,
        topic,
      }),
      channels: [controlChannel, chatChannel],
      transport: 'injection',
      spawner: leadName,
    });
  }

  const connectedDeadline = Date.now() + 120_000;
  while (Date.now() < connectedDeadline) {
    if (workerNames.every((name) => connectedWorkers.has(name))) {
      break;
    }
    await sleep(500);
  }

  console.log(`[swarm] connected ${connectedWorkers.size}/${workerNames.length} workers`);

  for (const workerName of workerNames) {
    await sendControl(lead, controlChannel, {
      type: 'message',
      to: workerName,
      from: leadName,
      body: `START_DISCUSSION. Topic: ${topic}`,
    });
  }

  await lead.send(chatChannel, `Discussion started by ${leadName}. Topic: ${topic}`);

  console.log(`[swarm] running discussion for ${runSeconds}s...`);
  await sleep(runSeconds * 1000);

  if (autoRelease) {
    for (const workerName of workerNames) {
      await sendControl(lead, controlChannel, {
        type: 'release',
        name: workerName,
        reason: 'swarm_demo_complete',
      });
    }
  }

  await sleep(2000);

  for (const unsub of unsubs) {
    try {
      unsub();
    } catch {
      // noop
    }
  }

  await lead.disconnect();
  console.log('[swarm] done');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[swarm] ${message}`);
  process.exit(1);
});
