/**
 * Utility functions for Agent Relay Inbox Check Hook
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InboxConfig, InboxMessage } from './types.js';

/** Default inbox directory */
export const DEFAULT_INBOX_DIR = '/tmp/agent-relay';

/**
 * Get the agent name from environment or config
 */
export function getAgentName(): string | undefined {
  // Check environment variable set by agent-relay wrapper
  return process.env.AGENT_RELAY_NAME;
}

/**
 * Get the inbox file path for an agent
 */
export function getInboxPath(config: InboxConfig): string {
  const agentName = config.agentName || getAgentName();
  if (!agentName) {
    throw new Error('Agent name not configured. Set AGENT_RELAY_NAME env var.');
  }
  return join(config.inboxDir, agentName, 'inbox.md');
}

/**
 * Check if inbox file exists and has content
 */
export function inboxExists(inboxPath: string): boolean {
  return existsSync(inboxPath);
}

/**
 * Read inbox file content
 */
export function readInbox(inboxPath: string): string {
  if (!inboxExists(inboxPath)) {
    return '';
  }
  return readFileSync(inboxPath, 'utf-8');
}

/**
 * Check if inbox has unread messages
 * Messages are marked with "## Message from" header
 */
export function hasUnreadMessages(inboxPath: string): boolean {
  const content = readInbox(inboxPath);
  if (!content || !content.trim()) {
    return false;
  }
  // Check for message headers
  return content.includes('## Message from');
}

/**
 * Count unread messages in inbox
 */
export function countMessages(inboxPath: string): number {
  const content = readInbox(inboxPath);
  if (!content) {
    return 0;
  }
  const matches = content.match(/## Message from/g);
  return matches ? matches.length : 0;
}

/**
 * Parse messages from inbox content
 */
export function parseMessages(inboxPath: string): InboxMessage[] {
  const content = readInbox(inboxPath);
  if (!content) {
    return [];
  }

  const messages: InboxMessage[] = [];
  const messageBlocks = content.split(/(?=## Message from)/);

  for (const block of messageBlocks) {
    const headerMatch = block.match(/## Message from (\S+) \| (.+)\n/);
    if (headerMatch) {
      const [, from, timestamp] = headerMatch;
      const body = block.replace(/## Message from .+\n/, '').trim();
      messages.push({ from, timestamp, body });
    }
  }

  return messages;
}

/**
 * Format a message for display
 */
export function formatMessagePreview(msg: InboxMessage, maxLength: number = 50): string {
  const preview = msg.body.length > maxLength
    ? msg.body.substring(0, maxLength) + '...'
    : msg.body;
  return `[${msg.from}]: ${preview}`;
}

/**
 * Build the block reason message
 */
export function buildBlockReason(inboxPath: string, messageCount: number): string {
  const messages = parseMessages(inboxPath);
  const previews = messages.slice(0, 3).map(m => formatMessagePreview(m));

  let reason = `You have ${messageCount} unread relay message(s) in ${inboxPath}.\n\n`;
  reason += 'Messages:\n';
  reason += previews.map(p => `  - ${p}`).join('\n');

  if (messages.length > 3) {
    reason += `\n  ... and ${messages.length - 3} more`;
  }

  reason += '\n\nPlease read the inbox file and respond to all messages before stopping.';

  return reason;
}
