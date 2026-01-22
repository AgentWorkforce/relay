/**
 * Inbox Resource
 *
 * Provides current inbox contents as an MCP resource.
 * URI: relay://inbox
 */

import type { Resource } from '@modelcontextprotocol/sdk/types.js';
import type { RelayClient } from '../client.js';

export const inboxResource: Resource = {
  uri: 'relay://inbox',
  name: 'Message Inbox',
  description: 'Your pending messages',
  mimeType: 'application/json',
};

export async function getInboxResource(client: RelayClient): Promise<string> {
  const messages = await client.getInbox({ unread_only: true, limit: 50 });
  return JSON.stringify(messages, null, 2);
}
