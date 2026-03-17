import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { onRelay } from '../../../communicate/adapters/openai-agents.js';
import type { Message, MessageCallback } from '../../../communicate/types.js';

const API_KEY = process.env.RELAY_API_KEY!;
const BASE_URL = process.env.RELAY_BASE_URL!;
const AGENT_NAME = `e2e-oai-${randomUUID().slice(0, 8)}`;

/**
 * Lightweight relay implementation that speaks the real Relaycast API surface
 * (the SDK transport endpoints are currently misaligned).
 */
class LiveRelay {
  private agentToken?: string;
  private agentId?: string;
  private callbacks = new Set<MessageCallback>();
  private pending: Message[] = [];

  constructor(private name: string) {}

  async register(): Promise<void> {
    const res = await fetch(`${BASE_URL}/v1/agents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: this.name, type: 'agent' }),
    });
    const body = await res.json() as any;
    if (!body.ok) throw new Error(`register failed: ${JSON.stringify(body)}`);
    this.agentId = body.data.id;
    this.agentToken = body.data.token;
  }

  async send(to: string, text: string): Promise<void> {
    const res = await fetch(`${BASE_URL}/v1/dm`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.agentToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, text }),
    });
    const body = await res.json() as any;
    if (!body.ok) throw new Error(`send failed: ${JSON.stringify(body)}`);
  }

  async post(channel: string, text: string): Promise<void> {
    const res = await fetch(`${BASE_URL}/v1/channels/${encodeURIComponent(channel)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.agentToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const body = await res.json() as any;
    if (!body.ok) throw new Error(`post failed: ${JSON.stringify(body)}`);
  }

  async inbox(): Promise<Message[]> {
    const msgs = [...this.pending];
    this.pending = [];
    return msgs;
  }

  async agents(): Promise<string[]> {
    const res = await fetch(`${BASE_URL}/v1/agents`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const body = await res.json() as any;
    if (!body.ok) throw new Error(`agents failed: ${JSON.stringify(body)}`);
    return (body.data as any[]).map((a) => a.name);
  }

  onMessage(callback: MessageCallback): () => void {
    this.callbacks.add(callback);
    return () => { this.callbacks.delete(callback); };
  }

  async cleanup(): Promise<void> {
    if (!this.name) return;
    await fetch(`${BASE_URL}/v1/agents/${encodeURIComponent(this.name)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'offline' }),
    }).catch(() => {});
  }
}

function createAgent(name: string) {
  return {
    name,
    instructions: 'You are an e2e test agent.',
    tools: [] as any[],
  };
}

test('OpenAI Agents adapter e2e against live Relaycast', async (t) => {
  const relay = new LiveRelay(AGENT_NAME);
  await relay.register();

  const agent = createAgent(AGENT_NAME);
  const { agent: augmented, cleanup } = onRelay(agent, relay);

  await t.test('onRelay injects 4 relay tools', () => {
    const names = augmented.tools.map((tool: any) => tool.name);
    assert.deepEqual(names, ['relay_send', 'relay_inbox', 'relay_post', 'relay_agents']);
  });

  await t.test('relay_agents returns live agent list including ours', async () => {
    const tool = augmented.tools.find((t: any) => t.name === 'relay_agents')!;
    const result: string = await tool.invoke(null, '{}');
    assert.ok(result.includes(AGENT_NAME), `Expected agent list to contain "${AGENT_NAME}", got: ${result.slice(0, 200)}`);
  });

  await t.test('relay_send delivers a DM without error', async () => {
    const tool = augmented.tools.find((t: any) => t.name === 'relay_send')!;
    const result: string = await tool.invoke(null, JSON.stringify({ to: AGENT_NAME, text: 'e2e self-ping' }));
    assert.match(result, /Sent relay message to/);
  });

  await t.test('relay_post posts to channel without error', async () => {
    const tool = augmented.tools.find((t: any) => t.name === 'relay_post')!;
    const result: string = await tool.invoke(null, JSON.stringify({ channel: 'general', text: `e2e from ${AGENT_NAME}` }));
    assert.match(result, /Posted relay message to #general/);
  });

  await t.test('relay_inbox returns string result', async () => {
    const tool = augmented.tools.find((t: any) => t.name === 'relay_inbox')!;
    const result: string = await tool.invoke(null, '{}');
    assert.ok(typeof result === 'string');
  });

  await t.test('cleanup restores agent and removes tools', () => {
    cleanup();
    assert.equal(augmented.tools.length, 0);
    assert.equal(augmented.instructions, 'You are an e2e test agent.');
  });

  await relay.cleanup();
});
