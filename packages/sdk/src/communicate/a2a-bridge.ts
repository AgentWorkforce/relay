/**
 * Bridge that connects an external A2A agent into a Relay workspace.
 *
 * - Registers a proxy agent on the Relay workspace
 * - When Relay messages arrive for the proxy, forwards them as A2A JSON-RPC
 *   message/send calls to the external agent
 * - When A2A responses come back, forwards them as Relay DMs
 */

import { randomUUID } from 'node:crypto';

import { Relay } from './core.js';
import {
  type A2AAgentCard,
  a2aAgentCardFromDict,
} from './a2a-types.js';
import type { Message, RelayConfig } from './types.js';

export class A2ABridge {
  readonly relay: Relay;
  readonly a2aAgentUrl: string;
  readonly proxyName: string;

  private _agentCard?: A2AAgentCard;
  private _started = false;

  constructor(
    relayConfig: RelayConfig,
    a2aAgentUrl: string,
    proxyName: string,
  ) {
    this.relay = new Relay(proxyName, relayConfig);
    this.a2aAgentUrl = a2aAgentUrl.replace(/\/+$/, '');
    this.proxyName = proxyName;
  }

  async start(): Promise<void> {
    this.relay.onMessage((msg) => this._handleRelayMessage(msg));
    this._started = true;
  }

  async stop(): Promise<void> {
    this._started = false;
    await this.relay.close();
  }

  async discoverAgent(): Promise<A2AAgentCard> {
    const url = `${this.a2aAgentUrl}/.well-known/agent.json`;
    const response = await fetch(url);
    const data = (await response.json()) as Record<string, unknown>;
    this._agentCard = a2aAgentCardFromDict(data);
    return this._agentCard;
  }

  async sendA2AMessage(text: string): Promise<string | null> {
    const a2aMsg = {
      role: 'user' as const,
      parts: [{ text }],
      messageId: randomUUID(),
    };

    const jsonrpcRequest = {
      jsonrpc: '2.0' as const,
      method: 'message/send',
      params: { message: a2aMsg },
      id: randomUUID(),
    };

    const targetUrl = this._agentCard?.url ?? this.a2aAgentUrl;

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(jsonrpcRequest),
    });

    const data = (await response.json()) as Record<string, unknown>;
    const result = (data.result ?? {}) as Record<string, unknown>;

    // Extract response text from task status message
    const status = (result.status ?? {}) as Record<string, unknown>;
    const statusMsg = (status.message ?? {}) as Record<string, unknown>;
    const statusParts = (statusMsg.parts ?? []) as Record<string, unknown>[];
    if (statusParts.length > 0) {
      const t = statusParts[0].text as string | undefined;
      if (t) return t;
    }

    // Try from messages list
    const messages = (result.messages ?? []) as Record<string, unknown>[];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'agent') {
        const msgParts = (msg.parts ?? []) as Record<string, unknown>[];
        if (msgParts.length > 0) {
          const t = msgParts[0].text as string | undefined;
          if (t) return t;
        }
      }
    }

    return null;
  }

  private async _handleRelayMessage(msg: Message): Promise<void> {
    const responseText = await this.sendA2AMessage(msg.text);
    if (responseText) {
      await this.relay.send(msg.sender, responseText);
    }
  }
}
