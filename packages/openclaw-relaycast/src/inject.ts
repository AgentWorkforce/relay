import { AgentRelayClient, type SendMessageInput } from '@agent-relay/sdk';

import type { InboundMessage, DeliveryResult } from './types.js';

/**
 * Deliver a message to the local claw using the best available method.
 *
 * Primary: Agent Relay SDK sendMessage() → broker JSON-RPC → PTY → agent stdin
 * Fallback: OpenClaw sessions_send RPC on localhost:18789
 */
export async function deliverMessage(
  message: InboundMessage,
  clawName: string,
  relayClient?: AgentRelayClient | null,
): Promise<DeliveryResult> {
  const formattedText = `[relaycast:${message.channel}] @${message.from}: ${message.text}`;

  // Try primary delivery via Agent Relay SDK
  if (relayClient) {
    try {
      const input: SendMessageInput = {
        to: clawName,
        text: formattedText,
        from: message.from,
        data: {
          source: 'relaycast',
          channel: message.channel,
          messageId: message.id,
        },
      };

      const result = await relayClient.sendMessage(input);
      if (Boolean(result.event_id) && result.event_id !== 'unsupported_operation') {
        return { ok: true, method: 'relay_sdk' };
      }
    } catch {
      // Fall through to RPC fallback
    }
  }

  // Try creating a new relay client if none was provided
  if (!relayClient) {
    try {
      const client = await AgentRelayClient.start({
        clientName: 'openclaw-relaycast',
        clientVersion: '1.0.0',
      });

      const input: SendMessageInput = {
        to: clawName,
        text: formattedText,
        from: message.from,
        data: {
          source: 'relaycast',
          channel: message.channel,
          messageId: message.id,
        },
      };

      const result = await client.sendMessage(input);
      const ok = Boolean(result.event_id) && result.event_id !== 'unsupported_operation';
      try { await client.shutdown(); } catch { /* best effort */ }
      if (ok) {
        return { ok: true, method: 'relay_sdk' };
      }
    } catch (err) {
      // Fall through to RPC fallback
    }
  }

  // Fallback: OpenClaw sessions_send RPC
  try {
    const response = await fetch('http://127.0.0.1:18789', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'sessions_send',
        params: { text: formattedText },
        id: message.id,
      }),
    });

    if (response.ok) {
      return { ok: true, method: 'sessions_rpc' };
    }
  } catch {
    // Both methods failed
  }

  return {
    ok: false,
    method: 'failed',
    error: 'Both relay SDK and sessions RPC delivery failed',
  };
}
