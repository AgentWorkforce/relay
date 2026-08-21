import { describe, expect, it } from 'vitest';

import {
  compactDirectMessageReceipt,
  directMessageDeliveryFailure,
  directMessageReceipt,
  messageReadersReceipt,
  resolveExactAgentName,
} from '../lib/message-delivery-receipts.js';

/**
 * Shape of the upstream create-message response, which carries the body twice:
 * once at `text` and once at the nested `message.text`.
 */
function sentMessageResponse(body: string) {
  return {
    conversationId: 'dm_abc123',
    message: {
      id: 'msg_1',
      agentId: 'agent_sender',
      agentName: 'sender',
      text: body,
      injectionMode: 'wait',
      attachments: [],
      metadata: { injection_mode: 'wait' },
    },
    createdAt: '2026-08-21T18:37:00.000Z',
    id: 'msg_1',
    fromAgentId: 'agent_sender',
    to: 'chief',
    text: body,
    injectionMode: 'wait',
    attachments: [],
    metadata: { injection_mode: 'wait' },
  };
}

describe('exact agent-name resolution', () => {
  it('chooses the full hyphenated name instead of an existing strict prefix', () => {
    expect(resolveExactAgentName([{ name: 'chief' }, { name: 'chief-khaliq' }], 'chief-khaliq')).toBe(
      'chief-khaliq'
    );
  });

  it('resolves an exact prefix-name request to that agent', () => {
    expect(resolveExactAgentName([{ name: 'chief' }, { name: 'chief-khaliq' }], 'chief')).toBe('chief');
  });

  it('leaves the recipient unresolved when there is no exact match', () => {
    expect(resolveExactAgentName([{ name: 'chief' }], 'chief-missing')).toBeUndefined();
  });
});

describe('direct message delivery receipts', () => {
  it('labels default wait-mode sends as queued and preserves the exact requested recipient', () => {
    const receipt = directMessageReceipt(
      { id: 'msg_wait', text: 'status', agentName: 'sender' },
      'chief-khaliq',
      'wait',
      'chief-khaliq'
    );

    expect(receipt).toMatchObject({
      id: 'msg_wait',
      target: { kind: 'agent', agentName: 'chief-khaliq' },
      delivery: {
        status: 'queued_unconfirmed',
        mode: 'wait',
        requestedRecipient: 'chief-khaliq',
        resolvedRecipient: 'chief-khaliq',
        recipientMatched: true,
        readConfirmed: false,
      },
    });
  });

  it('labels steer-mode sends as immediate injection requests without claiming delivery', () => {
    const receipt = directMessageReceipt(
      { id: 'msg_steer', text: 'urgent', agentName: 'sender' },
      'busy-worker',
      'steer',
      'busy-worker'
    );

    expect(receipt.delivery).toMatchObject({
      status: 'queued_unconfirmed',
      mode: 'steer',
      requestedRecipient: 'busy-worker',
      resolvedRecipient: 'busy-worker',
      readConfirmed: false,
    });
    expect(receipt.delivery.note).toContain('immediate injection');
  });

  it('fails the recipient-match signal when the send response names a different agent', () => {
    const receipt = directMessageReceipt(
      {
        id: 'msg_misdirected',
        target: { kind: 'agent', agentName: 'chief' },
      },
      'chief-khaliq',
      'wait',
      'chief'
    );

    expect(receipt).toMatchObject({
      target: { kind: 'agent', agentName: 'chief' },
      delivery: {
        status: 'recipient_mismatch',
        requestedRecipient: 'chief-khaliq',
        resolvedRecipient: 'chief',
        recipientMatched: false,
      },
    });
    expect(receipt.delivery.note).toContain('Recipient mismatch');
  });

  it('does not present the request as independently resolved when directory lookup is unavailable', () => {
    const receipt = directMessageReceipt(
      {
        id: 'msg_unresolved',
        target: { kind: 'agent', agentName: 'chief-khaliq' },
      },
      'chief-khaliq'
    );

    expect(receipt.delivery).toMatchObject({
      status: 'recipient_unresolved',
      requestedRecipient: 'chief-khaliq',
      resolvedRecipient: null,
      recipientMatched: null,
    });
    expect(receipt.target).toBeUndefined();
    expect(directMessageDeliveryFailure(receipt)).toContain('recipient_unresolved');
    expect(directMessageDeliveryFailure(receipt)).toContain('message msg_unresolved was enqueued');
    expect(directMessageDeliveryFailure(receipt)).toContain('retrying may duplicate it');
  });

  it('does not produce a failure for a resolved queued receipt', () => {
    const receipt = directMessageReceipt({ id: 'msg_ok' }, 'chief', 'wait', 'chief');
    expect(directMessageDeliveryFailure(receipt)).toBeUndefined();
  });

  it('surfaces an explicit signal when no recipient has consumed the message', () => {
    expect(messageReadersReceipt([])).toEqual({
      readers: [],
      delivery: {
        status: 'queued_or_unread',
        readConfirmed: false,
        signal:
          'No agent has read this message. A send receipt confirms enqueue only; the recipient may still be busy or offline.',
      },
    });
  });

  it('reports read only when the reader list is non-empty', () => {
    const readers = [{ agentName: 'busy-worker', readAt: '2026-08-08T20:00:00Z' }];

    expect(messageReadersReceipt(readers)).toEqual({
      readers,
      delivery: {
        status: 'read',
        readConfirmed: true,
        signal: 'At least one agent has read this message.',
      },
    });
  });
});

describe('compact direct message receipts', () => {
  const body = 'x'.repeat(4000);

  it('keeps the identifiers and the full delivery verdict', () => {
    const compact = compactDirectMessageReceipt(
      directMessageReceipt(sentMessageResponse(body), 'chief', 'wait', 'chief')
    );

    expect(compact).toEqual({
      id: 'msg_1',
      conversationId: 'dm_abc123',
      target: { kind: 'agent', agentName: 'chief' },
      delivery: {
        status: 'queued_unconfirmed',
        mode: 'wait',
        requestedRecipient: 'chief',
        resolvedRecipient: 'chief',
        recipientMatched: true,
        readConfirmed: false,
        note: "Queued for injection at the recipient's next safe idle boundary. It can remain unread while the recipient is busy. This receipt does not confirm delivery or reading; call get_message_readers with the message id.",
      },
    });
  });

  it('does not echo the message body anywhere in the serialised receipt', () => {
    const compact = compactDirectMessageReceipt(
      directMessageReceipt(sentMessageResponse(body), 'chief', 'wait', 'chief')
    );

    expect(JSON.stringify(compact)).not.toContain(body);
  });

  it('drops every body-bearing field the upstream response spreads in', () => {
    const full = directMessageReceipt(sentMessageResponse(body), 'chief', 'wait', 'chief');
    const compact = compactDirectMessageReceipt(full);

    // The defect: the uncompacted receipt carries the body twice.
    expect(JSON.stringify(full).split(body).length - 1).toBe(2);
    for (const dropped of ['text', 'message', 'metadata', 'attachments', 'fromAgentId', 'to', 'createdAt']) {
      expect(compact).not.toHaveProperty(dropped);
    }
  });

  it('keeps the receipt bounded no matter how large the message body is', () => {
    const short = compactDirectMessageReceipt(
      directMessageReceipt(sentMessageResponse('hi'), 'chief', 'wait', 'chief')
    );
    const long = compactDirectMessageReceipt(
      directMessageReceipt(sentMessageResponse('y'.repeat(50_000)), 'chief', 'wait', 'chief')
    );

    expect(JSON.stringify(long).length).toBe(JSON.stringify(short).length);
    expect(JSON.stringify(long).length).toBeLessThan(500);
  });

  it('still reports a recipient mismatch, including the message reference', () => {
    const compact = compactDirectMessageReceipt(
      directMessageReceipt(sentMessageResponse(body), 'chief-khaliq', 'wait', 'chief')
    );

    expect(compact.delivery.status).toBe('recipient_mismatch');
    const failure = directMessageDeliveryFailure(compact);
    expect(failure).toContain('recipient_mismatch');
    expect(failure).toContain('message msg_1 was enqueued');
    expect(failure).not.toContain(body);
  });

  it('omits identifiers that the upstream response did not provide', () => {
    const compact = compactDirectMessageReceipt(
      directMessageReceipt({ text: 'no id here' }, 'chief', 'wait', 'chief')
    );

    expect(compact).toEqual({
      target: { kind: 'agent', agentName: 'chief' },
      delivery: expect.objectContaining({ status: 'queued_unconfirmed' }),
    });
    expect(directMessageDeliveryFailure(compact)).toBeUndefined();
  });

  it('preserves the resolved-versus-unresolved recipient signal that target carries', () => {
    const resolved = compactDirectMessageReceipt(
      directMessageReceipt(sentMessageResponse(body), 'chief', 'wait', 'chief')
    );
    const unresolved = compactDirectMessageReceipt(
      directMessageReceipt(sentMessageResponse(body), 'chief')
    );

    expect(resolved.target).toEqual({ kind: 'agent', agentName: 'chief' });
    expect(unresolved).not.toHaveProperty('target');
    expect(unresolved.delivery.status).toBe('recipient_unresolved');
    expect(JSON.stringify(unresolved)).not.toContain(body);
  });
});
