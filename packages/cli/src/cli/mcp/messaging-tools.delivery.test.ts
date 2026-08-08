import { describe, expect, it } from 'vitest';

import {
  directMessageReceipt,
  messageReadersReceipt,
  resolveExactAgentName,
} from '../lib/message-delivery-receipts.js';

describe('exact agent-name resolution', () => {
  it('chooses the full hyphenated name instead of an existing strict prefix', () => {
    expect(resolveExactAgentName([{ name: 'chief' }, { name: 'chief-khaliq' }], 'chief-khaliq')).toBe(
      'chief-khaliq'
    );
  });

  it('resolves an exact prefix-name request to that agent', () => {
    expect(resolveExactAgentName([{ name: 'chief' }, { name: 'chief-khaliq' }], 'chief')).toBe('chief');
  });

  it('fails visibly when there is no exact match', () => {
    expect(() => resolveExactAgentName([{ name: 'chief' }], 'chief-missing')).toThrow(
      'Recipient "chief-missing" was not found by exact agent-name match.'
    );
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
