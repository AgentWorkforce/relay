/**
 * Derive which agents currently need attention based on message history.
 *
 * Heuristic:
 * - Track the most recent inbound message to an agent for each conversation key.
 * - Conversation key is thread ID if present, otherwise the counterparty agent.
 * - Track the most recent outbound message from the agent for the same key.
 * - An agent needs attention if their latest inbound message for any key is newer
 *   than their latest outbound message for that key.
 */

export interface AttentionMessage {
  from: string;
  to: string;
  timestamp: string;
  thread?: string;
}

type TimestampMap = Map<string, number>;

// Only consider messages from the last 30 minutes for "needs attention"
const ATTENTION_WINDOW_MS = 30 * 60 * 1000;

function updateLatest(map: Map<string, TimestampMap>, agent: string, key: string, ts: number): void {
  const agentMap = map.get(agent) ?? new Map<string, number>();
  const prev = agentMap.get(key) ?? -Infinity;
  if (ts > prev) {
    agentMap.set(key, ts);
    map.set(agent, agentMap);
  }
}

/**
 * Compute which agents have pending inbound messages they haven't answered.
 * Only considers messages within the attention window (last 30 minutes).
 */
export function computeNeedsAttention(messages: AttentionMessage[]): Set<string> {
  const latestInbound: Map<string, TimestampMap> = new Map();  // agent -> (key -> ts)
  const latestOutbound: Map<string, TimestampMap> = new Map(); // agent -> (key -> ts)
  const now = Date.now();
  const cutoffTime = now - ATTENTION_WINDOW_MS;

  for (const message of messages) {
    const ts = Date.parse(message.timestamp);
    if (Number.isNaN(ts)) continue;

    // Inbound: messages directed to a specific agent (ignore broadcasts)
    if (message.to && message.to !== '*') {
      const inboundKey = message.thread ? `thread:${message.thread}` : `sender:${message.from}`;
      updateLatest(latestInbound, message.to, inboundKey, ts);
    }

    // Outbound: track replies by thread (preferred) or by target agent
    // Also treat broadcasts as clearing attention for all prior senders
    if (message.from) {
      const outboundKey = message.thread
        ? `thread:${message.thread}`
        : (message.to && message.to !== '*')
          ? `sender:${message.to}`
          : null;

      if (outboundKey) {
        updateLatest(latestOutbound, message.from, outboundKey, ts);
      }

      // Broadcasts clear attention: agent is actively participating
      // Track as a "catch-all" outbound timestamp for this agent
      if (message.to === '*') {
        updateLatest(latestOutbound, message.from, '__broadcast__', ts);
      }
    }
  }

  const needsAttention = new Set<string>();

  latestInbound.forEach((keyMap, agent) => {
    keyMap.forEach((inboundTs, key) => {
      // Skip if inbound message is too old (outside attention window)
      if (inboundTs < cutoffTime) return;

      const outboundTs = latestOutbound.get(agent)?.get(key) ?? -Infinity;
      // Also check if agent sent a broadcast after the inbound message
      const broadcastTs = latestOutbound.get(agent)?.get('__broadcast__') ?? -Infinity;
      const latestReply = Math.max(outboundTs, broadcastTs);

      if (inboundTs > latestReply) {
        needsAttention.add(agent);
      }
    });
  });

  return needsAttention;
}
