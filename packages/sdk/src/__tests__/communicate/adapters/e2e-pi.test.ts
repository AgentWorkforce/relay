import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';

import { onRelay } from '../../../communicate/adapters/pi.js';
import type { Message, MessageCallback } from '../../../communicate/types.js';

const API_KEY = process.env.RELAY_API_KEY!;
const BASE_URL = (process.env.RELAY_BASE_URL ?? 'https://api.relaycast.dev').replace(/\/+$/, '');
const AGENT_NAME = `e2e-pi-${randomUUID().slice(0, 8)}`;

/**
 * Minimal relay implementation that speaks the real Relaycast API surface.
 * The Pi adapter accepts any RelayLike — this lets us e2e-test the adapter
 * independent of the SDK transport layer.
 */
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
    // Map the real inbox shape into Message[]
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
    return (body.data as any[]).map((a) => a.name);
  }

  onMessage(callback: MessageCallback): () => void {
    this.callbacks.push(callback);
    return () => {
      this.callbacks = this.callbacks.filter((c) => c !== callback);
    };
  }

  async close(): Promise<void> {
    if (!this.agentId) return;
    // Best-effort unregister
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

// TODO(sdk-test-fix): live Relaycast integration. Requires RELAY_API_KEY env var
// to run against a real backend. Skipped in CI / clean-env probes.
test.skipIf(!process.env.RELAY_API_KEY)(
  'Pi adapter e2e: relay tools work against live Relaycast',
  async () => {
    const relay = new LiveRelay(AGENT_NAME);
    await relay.register();

    try {
      const config = onRelay(AGENT_NAME, {}, relay);

      const findTool = (name: string) => {
        const tool = config.customTools.find((t: any) => t.name === name);
        assert.ok(tool, `Tool ${name} not found`);
        return tool;
      };

      const relayAgents = findTool('relay_agents');
      const relaySend = findTool('relay_send');
      const relayPost = findTool('relay_post');
      const relayInbox = findTool('relay_inbox');

      // 1. relay_agents — should include our freshly registered agent
      const agentsResult = await relayAgents.execute('call-1', {});
      const agentsText = agentsResult.content[0].text;
      console.log('relay_agents:', agentsText.split('\n').length, 'agents');
      assert.ok(agentsText.includes(AGENT_NAME), `Agent list must include ${AGENT_NAME}`);

      // 2. relay_send — DM to self
      const sendResult = await relaySend.execute('call-2', { to: AGENT_NAME, text: 'e2e self-ping' });
      console.log('relay_send:', sendResult.content[0].text);
      assert.ok(sendResult.content[0].text.includes('Sent relay message'));

      // 3. relay_post — post to general channel
      const postResult = await relayPost.execute('call-3', {
        channel: 'general',
        text: `e2e from ${AGENT_NAME}`,
      });
      console.log('relay_post:', postResult.content[0].text);
      assert.ok(postResult.content[0].text.includes('Posted relay message'));

      // 4. relay_inbox — drain inbox
      const inboxResult = await relayInbox.execute('call-4', {});
      console.log('relay_inbox:', inboxResult.content[0].text);
      assert.ok(typeof inboxResult.content[0].text === 'string');

      console.log('All Pi adapter e2e checks passed.');
    } finally {
      await relay.close();
      console.log('Relay closed.');
    }
  },
  20_000
);
