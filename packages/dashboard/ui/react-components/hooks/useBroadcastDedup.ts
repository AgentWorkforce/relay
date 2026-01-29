/**
 * Broadcast message deduplication utilities
 *
 * When a broadcast is sent (to='*'), the backend delivers it to each
 * recipient separately. Each delivery gets a unique ID and is stored separately.
 * In #general channel, this causes the same message to appear multiple times
 * (once per recipient).
 *
 * This module provides utilities to deduplicate broadcast messages by grouping
 * those with the same sender, content, and approximate timestamp.
 */

import { useMemo } from 'react';
import type { Message } from '../../types';

/**
 * Check if a message is a broadcast message.
 * A message is considered a broadcast if:
 * - isBroadcast flag is true, OR
 * - to field is '*'
 */
function isBroadcastMessage(message: Message): boolean {
  return message.isBroadcast === true || message.to === '*';
}

/**
 * Generate a deduplication key for broadcast messages.
 * Uses sender + content + timestamp bucket (1-second window).
 *
 * @param message The message to generate a key for
 * @returns A string key for deduplication
 */
export function getBroadcastKey(message: Message): string {
  const timestampBucket = Math.floor(new Date(message.timestamp).getTime() / 1000);
  return `${message.from}:${timestampBucket}:${message.content}`;
}

/**
 * Deduplicate broadcast messages.
 *
 * When a broadcast is sent, it gets delivered to each recipient separately,
 * resulting in multiple stored messages with the same content. This function
 * deduplicates them by grouping broadcasts with the same:
 * - from (sender)
 * - content (message body)
 * - timestamp (within 1 second window)
 *
 * Non-broadcast messages (direct messages) are preserved unchanged.
 * Message order is maintained, keeping the first occurrence of each broadcast.
 *
 * @param messages Array of messages to deduplicate
 * @returns Deduplicated array with broadcast duplicates removed
 */
export function deduplicateBroadcasts(messages: Message[]): Message[] {
  const seenBroadcastKeys = new Set<string>();
  const result: Message[] = [];

  for (const message of messages) {
    // Non-broadcast messages pass through unchanged
    if (!isBroadcastMessage(message)) {
      result.push(message);
      continue;
    }

    // For broadcasts, check if we've seen this key before
    const key = getBroadcastKey(message);
    if (!seenBroadcastKeys.has(key)) {
      seenBroadcastKeys.add(key);
      result.push(message);
    }
    // If key already seen, skip this duplicate
  }

  return result;
}

/**
 * Hook for using broadcast deduplication with React state.
 * Uses useMemo to prevent unnecessary recalculations when messages haven't changed.
 *
 * @param messages Array of messages to deduplicate
 * @returns Deduplicated messages
 */
export function useBroadcastDedup(messages: Message[]): Message[] {
  return useMemo(() => deduplicateBroadcasts(messages), [messages]);
}
