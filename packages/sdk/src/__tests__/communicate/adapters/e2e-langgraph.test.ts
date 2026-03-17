import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { onRelay, type RelayToolDef } from '../../../communicate/adapters/langgraph.js';
import type { Message, MessageCallback } from '../../../communicate/types.js';

const API_KEY = process.env.RELAY_API_KEY!;
const BASE_URL = (process.env.RELAY_BASE_URL ?? 'https://api.relaycast.dev').replace(/\/+$/, '');
const AGENT_NAME = `e2e-lg-${randomUUID().slice(0, 8)}`;
const CHANNEL = 'general';

/**
 * Thin RelayLike wrapper that talks to the real Relaycast API using correct
 * endpoints (POST /v1/agents, POST /v1/channels/{name}/messages, etc.).
 * The SDK's Relay/RelayTransport uses legacy routes that 404 on the live API,
 * so we bypass it for this e2e test.
 */
class LiveRelay {
  private agentToken?: string;
  private agentId?: string;
  private callbacks = new Set<MessageCallback>();

  constructor(private name: string) {}

  async register(): Promise<void> {
    const res = await fetch(`${BASE_URL}/v1/agents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: this.name }),
    });
    if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as any;
    this.agentToken = body.data.token;
    this.agentId = body.data.id;

    // join channel
    await fetch(`${BASE_URL}/v1/channels/${CHANNEL}/join`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.agentToken}` },
    });
  }

  async send(to: string, text: string): Promise<void> {
    const res = await fetch(`${BASE_URL}/v1/dm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.agentToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ to, text }),
    });
    if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
  }

  async post(channel: string, text: string): Promise<void> {
    const res = await fetch(`${BASE_URL}/v1/channels/${encodeURIComponent(channel)}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.agentToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`post failed: ${res.status} ${await res.text()}`);
  }

  async inbox(): Promise<Message[]> {
    const res = await fetch(`${BASE_URL}/v1/inbox`, {
      headers: { authorization: `Bearer ${this.agentToken}` },
    });
    if (!res.ok) throw new Error(`inbox failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as any;
    const msgs: Message[] = [];
    for (const dm of body.data?.unread_dms ?? []) {
      msgs.push({ sender: dm.from ?? '', text: dm.text ?? '' });
    }
    return msgs;
  }

  async agents(): Promise<string[]> {
    const res = await fetch(`${BASE_URL}/v1/agents`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    if (!res.ok) throw new Error(`agents failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as any;
    return (body.data ?? []).map((a: any) => a.name as string);
  }

  onMessage(callback: MessageCallback): () => void {
    this.callbacks.add(callback);
    return () => { this.callbacks.delete(callback); };
  }

  async simulateIncoming(message: Message): Promise<void> {
    for (const cb of [...this.callbacks]) await cb(message);
  }

  async disconnect(): Promise<void> {
    if (!this.agentToken) return;
    await fetch(`${BASE_URL}/v1/agents/disconnect`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.agentToken}` },
    }).catch(() => {});
  }
}

function createFakeGraph() {
  return {
    nodes: {},
    invokeCalls: [] as Array<{ input: Record<string, unknown> }>,
    async invoke(input: Record<string, unknown>) {
      this.invokeCalls.push({ input });
      return { messages: [] };
    },
  };
}

test('LangGraph e2e: full lifecycle against live Relaycast', async () => {
  const relay = new LiveRelay(AGENT_NAME);
  await relay.register();
  console.log(`[e2e] Registered agent: ${AGENT_NAME}`);

  const graph = createFakeGraph();

  try {
    // 1. onRelay returns tools and unsubscribe handle
    const result = onRelay(graph, relay as any);
    assert.ok(result.tools, 'tools should be defined');
    assert.ok(typeof result.unsubscribe === 'function', 'unsubscribe should be a function');

    const toolMap = new Map<string, RelayToolDef>();
    for (const t of result.tools) toolMap.set(t.name, t);

    assert.ok(toolMap.has('relay_send'), 'should have relay_send');
    assert.ok(toolMap.has('relay_inbox'), 'should have relay_inbox');
    assert.ok(toolMap.has('relay_post'), 'should have relay_post');
    assert.ok(toolMap.has('relay_agents'), 'should have relay_agents');
    console.log('[e2e] onRelay returned 4 tools + unsubscribe');

    // 2. relay_agents returns a real agent list that includes ourselves
    const agentsOutput = await toolMap.get('relay_agents')!.invoke({});
    assert.ok(typeof agentsOutput === 'string', 'agents output should be a string');
    const agentNames = agentsOutput.split('\n');
    assert.ok(agentNames.includes(AGENT_NAME), `agents list should include "${AGENT_NAME}"`);
    console.log(`[e2e] relay_agents OK: ${agentNames.length} agent(s), self found`);

    // 3. relay_post sends a message to a channel (real HTTP 201)
    const postOutput = await toolMap.get('relay_post')!.invoke({ channel: CHANNEL, text: `e2e post from ${AGENT_NAME}` });
    assert.equal(postOutput, `Posted relay message to #${CHANNEL}.`);
    console.log('[e2e] relay_post OK');

    // 4. relay_send sends a DM to ourselves (real HTTP 201)
    const sendOutput = await toolMap.get('relay_send')!.invoke({ to: AGENT_NAME, text: 'e2e self-DM' });
    assert.equal(sendOutput, `Sent relay message to ${AGENT_NAME}.`);
    console.log('[e2e] relay_send OK');

    // 5. relay_inbox drains messages (real HTTP 200)
    await sleep(500);
    const inboxOutput = await toolMap.get('relay_inbox')!.invoke({});
    assert.ok(typeof inboxOutput === 'string', 'inbox output should be a string');
    console.log('[e2e] relay_inbox OK:', inboxOutput.slice(0, 120));

    // 6. Test message routing into graph via simulateIncoming
    await relay.simulateIncoming({ sender: 'test-peer', text: 'routed msg', messageId: 'msg-sim-1' });
    assert.equal(graph.invokeCalls.length, 1, 'graph should receive 1 routed message');
    const call = graph.invokeCalls[0];
    assert.ok(Array.isArray(call.input.messages));
    const routedMsg = (call.input.messages as any[])[0];
    assert.equal(routedMsg.role, 'user');
    assert.match(routedMsg.content, /test-peer/);
    assert.match(routedMsg.content, /routed msg/);
    console.log('[e2e] message routing into graph OK');

    // 7. unsubscribe stops routing
    result.unsubscribe();
    await relay.simulateIncoming({ sender: 'test-peer', text: 'should not route', messageId: 'msg-sim-2' });
    assert.equal(graph.invokeCalls.length, 1, 'graph should NOT receive messages after unsubscribe');
    console.log('[e2e] unsubscribe OK');

    console.log('[e2e] All LangGraph e2e checks passed.');
  } finally {
    await relay.disconnect();
    console.log('[e2e] Agent disconnected.');
  }
});
