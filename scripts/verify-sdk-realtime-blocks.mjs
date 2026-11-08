import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Build both SDKs first, then pass the companion Relaycast checkout path.
// All HTTP and WebSocket I/O below uses fixtures, never a live service.
if (!process.argv[2])
  throw new Error('Usage: node scripts/verify-sdk-realtime-blocks.mjs <relaycast-checkout>');
const relayRoot = fileURLToPath(new URL('..', import.meta.url));
const castRoot = resolve(process.argv[2]);
const load = (root, file) => import(pathToFileURL(resolve(root, file)).href);
const [{ AgentClient }, { HttpClient }, { RelayCast }, { AgentRelay }, { RelaycastMessagingClient }] =
  await Promise.all([
    load(castRoot, 'packages/sdk-typescript/dist/agent.js'),
    load(castRoot, 'packages/sdk-typescript/dist/client.js'),
    load(castRoot, 'packages/sdk-typescript/dist/index.js'),
    load(relayRoot, 'packages/sdk/dist/index.js'),
    load(relayRoot, 'packages/sdk/dist/messaging/relaycast.js'),
  ]);

const blocks = [
  { type: 'text', text: 'proof-'.repeat(8192) },
  { kind: 'test', payload: 'abc' },
];
const stored = { id: 'm_proof', agent_id: 'bot_1', agent_name: 'Bot', text: 'proof', blocks };
const sockets = [];
class FixtureSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 1;
  constructor() {
    sockets.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
}
globalThis.WebSocket = FixtureSocket;
globalThis.fetch = async (url) =>
  new Response(
    JSON.stringify({
      ok: true,
      data: String(url).endsWith('/v1/agent/node-token')
        ? { node_id: 'node_fixture', node_name: 'fixture', token: 'fixture-token' }
        : stored,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
const agent = new AgentClient(new HttpClient({ apiKey: 'fixture-token', baseUrl: 'http://fixture.invalid' }));
const workspace = new RelayCast({ apiKey: 'fixture-token', baseUrl: 'http://fixture.invalid' });
const messaging = new RelaycastMessagingClient({ relaycast: workspace, agentClient: agent });
const errors = [];
const relay = new AgentRelay({ agentToken: 'fixture-token', messaging, onError: (e) => errors.push(e) });
const received = [];
try {
  relay.addListener('message.created', (event) => received.push(event.message));
  for (let i = 0; i < 20 && sockets.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sockets.length, 1);
  sockets[0].onopen?.();
  sockets[0].onmessage?.({
    data: JSON.stringify({
      v: 1,
      type: 'deliver',
      delivery_id: 'delivery_fixture',
      agent: 'worker',
      seq: 1,
      payload: {
        type: 'message.created',
        data: { ...stored, from_name: 'Bot', channel_name: 'general', attachments: [] },
      },
    }),
  });
  const read = await messaging.messages.get(stored.id);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].blocks, blocks);
  assert.deepEqual(received[0].blocks, read.blocks);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: 49 KB blocks and arbitrary kind/payload survive Relaycast WebSocket -> Relay public listener, matching REST readback. All I/O uses fixtures.'
  );
} finally {
  await relay.events.disconnect();
}
