#!/usr/bin/env node
/**
 * Agent Relay Inbox Check Hook
 *
 * A Claude Code Stop hook that checks for unread messages in the agent-relay inbox.
 * When messages are present, it blocks Claude from stopping and instructs it to
 * read and respond to the messages.
 *
 * This enables autonomous agent-to-agent communication without human intervention.
 *
 * Usage in .claude/settings.json:
 * {
 *   "hooks": {
 *     "Stop": [{
 *       "hooks": [{
 *         "type": "command",
 *         "command": "node /path/to/agent-relay/dist/hooks/inbox-check/hook.js"
 *       }]
 *     }]
 *   }
 * }
 *
 * Environment Variables:
 * - AGENT_RELAY_NAME: The agent's name (set by agent-relay wrapper)
 * - AGENT_RELAY_INBOX_DIR: Custom inbox directory (default: /tmp/agent-relay)
 */

import { readFileSync } from 'node:fs';
import type { HookInput, HookOutput } from './types.js';
import {
  DEFAULT_INBOX_DIR,
  getAgentName,
  getInboxPath,
  hasUnreadMessages,
  countMessages,
  buildBlockReason
} from './utils.js';

/**
 * Read hook input from stdin
 */
function readStdin(): HookInput {
  try {
    const input = readFileSync(0, 'utf-8');
    return JSON.parse(input);
  } catch {
    return {};
  }
}

/**
 * Output hook result as JSON
 */
function outputResult(result: HookOutput): void {
  console.log(JSON.stringify(result));
}

/**
 * Exit the hook process
 */
function exitHook(code: number): never {
  process.exit(code);
}

/**
 * Main hook execution
 */
async function main(): Promise<void> {
  try {
    // Read stdin (required by Claude Code hook protocol, but we only use env vars)
    readStdin();

    // Get agent name from env
    const agentName = getAgentName();

    // If no agent name configured, allow stop (not in relay mode)
    if (!agentName) {
      outputResult({ decision: 'approve' });
      exitHook(0);
    }

    // Get inbox configuration
    const inboxDir = process.env.AGENT_RELAY_INBOX_DIR || DEFAULT_INBOX_DIR;
    const inboxPath = getInboxPath({ inboxDir, agentName });

    // Check for unread messages
    if (hasUnreadMessages(inboxPath)) {
      const messageCount = countMessages(inboxPath);
      const reason = buildBlockReason(inboxPath, messageCount);

      // Log to stderr for visibility
      console.error(`[agent-relay] Found ${messageCount} unread message(s), blocking stop`);

      // Block stop and provide reason
      outputResult({
        decision: 'block',
        reason
      });
    } else {
      // No messages, allow stop
      outputResult({ decision: 'approve' });
    }

    exitHook(0);
  } catch (error) {
    // On error, allow stop to avoid blocking user
    console.error('[agent-relay] Hook error:', error);
    outputResult({ decision: 'approve' });
    exitHook(0);
  }
}

// Run the hook
main();
