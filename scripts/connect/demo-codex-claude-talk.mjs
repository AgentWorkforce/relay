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
      topic: 'Hosted connect demo channel',
    });
  } catch {
    // already exists is fine
  }

  await client.channels.join(channel);
}

async function sendControl(client, channel, payload) {
  await client.send(channel, `/connect ${JSON.stringify(payload)}`);
  console.log(`[demo] control -> #${channel}: ${JSON.stringify(payload)}`);
}

async function main() {
  const args = parseArgv(process.argv.slice(2));

  const apiKey = (args.get('api-key') ?? process.env.RELAY_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new Error('Missing API key. Set RELAY_API_KEY or pass --api-key');
  }

  const baseUrl = args.get('base-url') ?? process.env.RELAYCAST_BASE_URL ?? 'https://api.relaycast.dev';
  const controlChannel = args.get('control-channel') ?? 'control';
  const chatChannel = args.get('chat-channel') ?? 'general';
  const runSeconds = Number.parseInt(args.get('seconds') ?? '120', 10);

  const id = Date.now().toString(36).slice(-6);
  const leadName = `demo-lead-${id}`;
  const claudeName = `claude-demo-${id}`;
  const codexName = `codex-demo-${id}`;

  console.log(`[demo] baseUrl=${baseUrl}`);
  console.log(`[demo] lead=${leadName} claude=${claudeName} codex=${codexName}`);

  const relay = new RelayCast({ apiKey, baseUrl });
  const registration = await relay.agents.registerOrRotate({
    name: leadName,
    type: 'agent',
    metadata: {
      source: 'connect-demo',
    },
  });

  const lead = relay.as(registration.token);

  await ensureChannel(lead, controlChannel);
  await ensureChannel(lead, chatChannel);

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
      const channel = event.channel ?? '';
      const from = event.message?.agentName ?? 'unknown';
      const text = event.message?.text ?? '';
      if (!text) return;
      if (channel !== controlChannel && channel !== chatChannel) return;
      console.log(`[${channel}] ${from}: ${text}`);
    })
  );

  const claudeTask = [
    `You are ${claudeName}.`,
    `Use relay_send(to: "#${chatChannel}", message: "...") for all replies.`,
    `When you receive START_CHAT from ${leadName}:`,
    `1) Post one short greeting to #${chatChannel} addressed to ${codexName}.`,
    `2) Wait for ${codexName}'s reply in #${chatChannel}.`,
    `3) Reply one more time in #${chatChannel}.`,
    `4) Send DONE message to #${chatChannel}.`,
  ].join('\n');

  const codexTask = [
    `You are ${codexName}.`,
    `Use relay_send(to: "#${chatChannel}", message: "...") for all replies.`,
    `When ${claudeName} posts in #${chatChannel}, respond briefly and continue the short chat.`,
    `After one back-and-forth, post DONE in #${chatChannel}.`,
  ].join('\n');

  await sendControl(lead, controlChannel, {
    type: 'spawn',
    name: claudeName,
    cli: 'claude',
    task: claudeTask,
    channels: [controlChannel, chatChannel],
    transport: 'injection',
    spawner: leadName,
  });

  await sendControl(lead, controlChannel, {
    type: 'spawn',
    name: codexName,
    cli: 'codex',
    task: codexTask,
    channels: [controlChannel, chatChannel],
    transport: 'injection',
    spawner: leadName,
  });

  console.log('[demo] waiting 25s for agents to become ready...');
  await sleep(25_000);

  await sendControl(lead, controlChannel, {
    type: 'message',
    to: claudeName,
    from: leadName,
    body: `START_CHAT. Talk with ${codexName} in #${chatChannel} now.`,
  });

  console.log(`[demo] running conversation window for ${runSeconds}s...`);
  await sleep(runSeconds * 1000);

  await sendControl(lead, controlChannel, {
    type: 'release',
    name: claudeName,
    reason: 'demo_complete',
  });

  await sendControl(lead, controlChannel, {
    type: 'release',
    name: codexName,
    reason: 'demo_complete',
  });

  await sleep(2000);

  for (const unsub of unsubs) {
    try {
      unsub();
    } catch {
      // ignore
    }
  }

  await lead.disconnect();
  console.log('[demo] done');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[demo] ${message}`);
  process.exit(1);
});
