import type { AgentRelayClient, SendMessageInput } from '@agent-relay/sdk';

import type { InboundMessage, DeliveryResult } from './types.js';

/**
 * Deliver a message to the local claw using the best available method.
 *
 * Primary: Agent Relay SDK sendMessage() via a shared, long-lived client
 * Fallback: OpenClaw sessions_send RPC on localhost (last resort only)
 *
 * Callers should maintain a single shared AgentRelayClient instance and pass it
 * to every deliverMessage() call. Creating a client per message is wasteful and
 * was removed in favor of this shared-client pattern.
 */
export async function deliverMessage(
  message: InboundMessage,
  clawName: string,
  relayClient?: AgentRelayClient | null,
): Promise<DeliveryResult> {
  const formattedText = `[relaycast:${message.channel}] @${message.from}: ${message.text}`;

  // Primary: deliver via shared relay client
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

  // Fallback: OpenClaw sessions_send RPC (last resort — no relay client available)
  try {
    const gatewayPort = process.env.GATEWAY_PORT ?? '18789';
    const response = await fetch(`http://127.0.0.1:${gatewayPort}`, {
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
    error: relayClient
      ? 'Both relay SDK and sessions RPC delivery failed'
      : 'No relay client provided and sessions RPC fallback failed',
  };
}
