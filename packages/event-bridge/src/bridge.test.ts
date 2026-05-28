import { describe, expect, it, vi } from 'vitest';

import { createEventBridge } from './bridge.js';
import type { EventBridgeConfig } from './config.js';

const META_PATH = '/slack/channels/C123__ops/messages/1700000000_000100/meta.json';

const config: EventBridgeConfig = {
  workspace: 'ws-1',
  apiKey: 'key',
  agentName: 'lead',
  providers: ['slack'],
  outboxDir: '/tmp/outbox',
  injectMode: 'wait',
};

function relayfileChange() {
  return {
    id: 'evt-1',
    workspace: 'ws-1',
    type: 'relayfile.changed' as const,
    occurredAt: '2026-05-28T00:00:00.000Z',
    attempt: 1,
    resource: { path: META_PATH, kind: 'slack.message', id: 'm1', provider: 'slack' },
    summary: {},
    expand: async () => ({}),
    path: META_PATH,
    action: 'created' as const,
  };
}

describe('createEventBridge', () => {
  it('injects inbound messages and relays outbox replies back through the gateway', async () => {
    let capturedOnEvent: ((event: unknown) => Promise<void> | void) | undefined;
    const writes: Array<{ path: string; body: unknown; meta?: unknown }> = [];

    const createStream = vi.fn((opts: { onEvent: (event: unknown) => Promise<void> | void }) => {
      capturedOnEvent = opts.onEvent;
      return {
        ready: Promise.resolve(),
        close: vi.fn(async () => {}),
        registerWatches: vi.fn(async () => ({})),
        readFile: vi.fn(async (path: string) => ({
          path,
          content: JSON.stringify({ type: 'message', user: 'U1', username: 'alice', text: 'ship it' }),
        })),
        writeFile: vi.fn(async (path: string, body: unknown, meta?: unknown) => {
          writes.push({ path, body, meta });
        }),
      } as never;
    });

    const sendMessage = vi.fn(async () => ({}));

    let outboxOnReply: ((replyId: string, text: string) => Promise<void> | void) | undefined;
    const startOutbox = vi.fn(
      async (opts: { onReply: (id: string, text: string) => Promise<void> | void }) => {
        outboxOnReply = opts.onReply;
        return { stop: vi.fn(async () => {}) };
      }
    );

    const bridge = createEventBridge(config, {
      createStream: createStream as never,
      broker: { sendMessage },
      startOutbox: startOutbox as never,
    });
    await bridge.ready;

    expect(createStream).toHaveBeenCalledOnce();
    expect(startOutbox).toHaveBeenCalledOnce();

    // Inbound: simulate a Slack message change arriving on the stream.
    await capturedOnEvent?.(relayfileChange());

    expect(sendMessage).toHaveBeenCalledOnce();
    const injected = sendMessage.mock.calls[0][0] as { to: string; from?: string; text: string };
    expect(injected.to).toBe('lead');
    expect(injected.from).toBe('slack:#ops');
    expect(injected.text).toContain('ship it');

    // Recover the minted replyId from the injected outbox instruction.
    const replyId = /r-[0-9a-f]{8}/.exec(injected.text)?.[0];
    expect(replyId).toBeTruthy();

    // Outbound: simulate the agent writing its reply to the outbox.
    await outboxOnReply?.(replyId as string, 'shipping now\n');

    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(
      `/slack/channels/C123__ops/messages/1700000000_000100/replies/draft-${replyId}.json`
    );
    expect(writes[0].body).toBe('{"text":"shipping now"}');

    await bridge.stop();
  });

  it('ignores non-relayfile events', async () => {
    let capturedOnEvent: ((event: unknown) => Promise<void> | void) | undefined;
    const createStream = vi.fn((opts: { onEvent: (event: unknown) => Promise<void> | void }) => {
      capturedOnEvent = opts.onEvent;
      return {
        ready: Promise.resolve(),
        close: vi.fn(async () => {}),
        registerWatches: vi.fn(async () => ({})),
        readFile: vi.fn(),
        writeFile: vi.fn(),
      } as never;
    });
    const sendMessage = vi.fn(async () => ({}));

    const bridge = createEventBridge(config, {
      createStream: createStream as never,
      broker: { sendMessage },
      startOutbox: (async () => ({ stop: async () => {} })) as never,
    });
    await bridge.ready;

    await capturedOnEvent?.({ type: 'cron.tick' });
    await capturedOnEvent?.({ type: 'relaycast.message' });

    expect(sendMessage).not.toHaveBeenCalled();
    await bridge.stop();
  });
});
