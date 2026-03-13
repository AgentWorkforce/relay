#!/usr/bin/env node

import { readFileSync } from 'node:fs';

type HookInput = {
  stop_hook_active?: boolean;
};

type HookOutput = {
  decision: 'approve' | 'block';
  reason?: string;
};

type InboxMessage = {
  id?: string;
  from?: string;
  text?: string;
  channel?: string;
};

const DEFAULT_BASE_URL = 'https://api.relaycast.dev';
const MAX_RENDERED_MESSAGES = 20;

function readInput(): HookInput {
  try {
    const raw = readFileSync(0, 'utf8').trim();
    return raw ? (JSON.parse(raw) as HookInput) : {};
  } catch {
    return {};
  }
}

function writeOutput(output: HookOutput): void {
  process.stdout.write(JSON.stringify(output));
}

function normalizeBaseUrl(value: string | undefined): string {
  return (value?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function cleanText(value: string | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function formatMessage(message: InboxMessage): string {
  const from = cleanText(message.from) || 'unknown';
  const text = cleanText(message.text) || '(no text)';
  const id = cleanText(message.id);
  const channel = cleanText(message.channel);
  const prefix = channel
    ? `Relay message from ${from} in #${channel}`
    : `Relay message from ${from}`;
  const suffix = id ? ` [${id}]` : '';
  return `${prefix}${suffix}: ${text}`;
}

async function checkInbox(token: string, baseUrl: string): Promise<InboxMessage[]> {
  const response = await fetch(`${baseUrl}/v1/inbox/check`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });

  if (!response.ok) {
    throw new Error(`Inbox check failed: ${response.status}`);
  }

  const payload = (await response.json()) as { messages?: InboxMessage[] } | null;
  return Array.isArray(payload?.messages) ? payload.messages : [];
}

async function main(): Promise<void> {
  try {
    const input = readInput();

    if (input.stop_hook_active) {
      writeOutput({ decision: 'approve' });
      return;
    }

    const token = process.env.RELAY_TOKEN?.trim();
    if (!token) {
      writeOutput({ decision: 'approve' });
      return;
    }

    const baseUrl = normalizeBaseUrl(process.env.RELAY_BASE_URL);
    const messages = await checkInbox(token, baseUrl);

    if (messages.length === 0) {
      writeOutput({ decision: 'approve' });
      return;
    }

    const rendered = messages
      .slice(0, MAX_RENDERED_MESSAGES)
      .map(formatMessage)
      .join('\n');
    const overflow =
      messages.length > MAX_RENDERED_MESSAGES
        ? `\n... and ${messages.length - MAX_RENDERED_MESSAGES} more unread relay message(s).`
        : '';

    writeOutput({
      decision: 'block',
      reason:
        `You have ${messages.length} unread relay message(s):\n` +
        `${rendered}${overflow}\n` +
        'Please read and respond.',
    });
  } catch (error) {
    console.error('[claude-relay-plugin] stop-inbox hook error:', error);
    writeOutput({ decision: 'approve' });
  }
}

void main();
