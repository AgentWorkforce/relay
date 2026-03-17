import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { onRelay } from '../../../communicate/adapters/google-adk.js';
import type { Message, MessageCallback } from '../../../communicate/types.js';

const API_KEY = process.env.RELAY_API_KEY!;
const BASE_URL = (process.env.RELAY_BASE_URL ?? 'https://api.relaycast.dev').replace(/\/+$/, '');
const AGENT_NAME = `e2e-adk-${randomUUID().slice(0, 8)}`;

class LiveRelay {
  private agentToken?: string;
  private agentId?: string;
  private callbacks: MessageCallback[] = [];

  constructor(private readonly name: string) {}

  async register(): Promise<void> {
    const res = await fetch(`${BASE_URL}/v1/agents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: this.name, type: 'agent' }),
    });
    const body = (await res.json()) as any;
    if (!body.ok) throw new Error(`Register failed: ${JSON.stringify(body)}`);
    this.agentId = body.data.id;
    this.agentToken = body.data.token;
  }

  async send(to: string, text: string): Promise<void> {
    const res = await fetch(`${BASE_URL}/v1/dm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.agentToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ to, text }),
    });
    const body = (await res.json()) as any;
    if (!body.ok) throw new Error(`DM failed: ${JSON.stringify(body)}`);
  }

  async post(channel: string, text: string): Promise<void> {
    const res = await fetch(`${BASE_URL}/v1/channels/${encodeURIComponent(channel)}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.agentToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const body = (await res.json()) as any;
    if (!body.ok) throw new Error(`Post failed: ${JSON.stringify(body)}`);
  }

  async inbox(): Promise<Message[]> {
    const res = await fetch(`${BASE_URL}/v1/inbox`, {
      headers: { authorization: `Bearer ${this.agentToken}` },
    });
    const body = (await res.json()) as any;
    if (!body.ok) throw new Error(`Inbox failed: ${JSON.stringify(body)}`);
    const msgs: Message[] = [];
    for (const dm of body.data.unread_dms ?? []) {
      msgs.push({ sender: dm.from ?? 'unknown', text: dm.text ?? '' });
    }
    return msgs;
  }

  async agents(): Promise<string[]> {
    const res = await fetch(`${BASE_URL}/v1/agents`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    const body = (await res.json()) as any;
    if (!body.ok) throw new Error(`Agents failed: ${JSON.stringify(body)}`);
    return (body.data as any[]).map((a: any) => a.name);
  }

  onMessage(callback: MessageCallback): () => void {
    this.callbacks.push(callback);
    return () => {
      this.callbacks = this.callbacks.filter((c) => c !== callback);
    };
  }

  async close(): Promise<void> {
    if (!this.agentId) return;
    try {
      await fetch(`${BASE_URL}/v1/agents/${this.agentId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${API_KEY}` },
      });
    } catch {
      /* ignore */
    }
  }
}

test('Google ADK adapter e2e: relay tools work against live Relaycast', async () => {
  const relay = new LiveRelay(AGENT_NAME);
  await relay.register();

  try {
    const mockAgent = { name: 'test-adk-agent', tools: [] as any[] };
    const { agent, tools, unsubscribe } = onRelay(AGENT_NAME, { agent: mockAgent }, relay);

    // Verify tools were injected into the agent
    assert.ok(agent.tools.length >= 4, `Expected >= 4 relay tools on agent, got ${agent.tools.length}`);

    const findTool = (name: string) => {
      const tool = tools.find((t: any) => t.name === name);
      assert.ok(tool, `Tool ${name} not found`);
      return tool;
    };

    const relayAgents = findTool('relay_agents');
    const relaySend = findTool('relay_send');
    const relayPost = findTool('relay_post');
    const relayInbox = findTool('relay_inbox');

    // 1. relay_agents — should include our freshly registered agent
    const agentsResult = await (relayAgents as any).execute({});
    const agentsText = agentsResult.result as string;
    console.log('relay_agents:', agentsText.split('\n').length, 'agents');
    assert.ok(agentsText.includes(AGENT_NAME), `Agent list must include ${AGENT_NAME}`);

    // 2. relay_send — DM to self
    const sendResult = await (relaySend as any).execute({ to: AGENT_NAME, text: 'e2e self-ping' });
    console.log('relay_send:', sendResult.result);
    assert.ok((sendResult.result as string).includes('Sent relay message'));

    // 3. relay_post — post to general channel
    const postResult = await (relayPost as any).execute({
      channel: 'general',
      text: `e2e ADK test from ${AGENT_NAME}`,
    });
    console.log('relay_post:', postResult.result);
    assert.ok((postResult.result as string).includes('Posted relay message'));

    // 4. relay_inbox — drain inbox
    await new Promise((r) => setTimeout(r, 1000));
    const inboxResult = await (relayInbox as any).execute({});
    console.log('relay_inbox:', inboxResult.result);
    assert.ok(typeof inboxResult.result === 'string');

    // 5. Verify unsubscribe stops routing
    let routerFired = false;
    const mockRunner = {
      async *runAsync() {
        routerFired = true;
      },
    };
    const { unsubscribe: unsub2 } = onRelay(
      `${AGENT_NAME}-sub`,
      { agent: { name: 'sub-agent', tools: [] }, runner: mockRunner },
      relay,
    );
    unsub2();
    // After unsubscribe, incoming messages should NOT invoke the runner
    await (relaySend as any).execute({ to: AGENT_NAME, text: 'should-not-route' });
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!routerFired, 'Expected runner NOT to fire after unsubscribe');

    // Also test that unsubscribe from the main config works
    unsubscribe();

    console.log('All Google ADK adapter e2e checks passed.');
  } finally {
    await relay.close();
    console.log('Relay closed.');
  }
});
