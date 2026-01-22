import { describe, it, expect, vi } from 'vitest';
import { Router } from './router.js';
import { PROTOCOL_VERSION, type Envelope, type SendPayload } from '@relay/protocol/types';

describe('Register-on-handshake behavior', () => {
  it('routes to a registered agent before that agent sends any SEND', () => {
    const router = new Router();

    let seq = 0;
    const receiverSend = vi.fn((..._args: any[]) => true);
    const receiver = {
      id: 'c-recv',
      agentName: 'agent-b',
      sessionId: 's-b',
      close: vi.fn(),
      send: receiverSend,
      getNextSeq: () => ++seq,
    };

    const sender = {
      id: 'c-send',
      agentName: 'agent-a',
      sessionId: 's-a',
      close: vi.fn(),
      send: vi.fn(() => true),
      getNextSeq: vi.fn(() => 1),
    };

    // This models daemon registering the connection on handshake completion (WELCOME -> ACTIVE).
    router.register(receiver);

    const sendEnvelope: Envelope<SendPayload> = {
      v: PROTOCOL_VERSION,
      type: 'SEND',
      id: 'm-1',
      ts: Date.now(),
      to: 'agent-b',
      payload: { kind: 'message', body: 'hello' },
    };

    router.route(sender, sendEnvelope);

    expect(receiverSend).toHaveBeenCalledTimes(1);
    const delivered = receiverSend.mock.calls[0]![0] as unknown as Envelope;
    expect(delivered.type).toBe('DELIVER');
    expect(delivered.from).toBe('agent-a');
    expect(delivered.to).toBe('agent-b');
    expect((delivered as any).payload?.body).toBe('hello');
  });
});
