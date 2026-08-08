export type DirectMessageMode = 'wait' | 'steer';

export type DirectMessageDeliveryReceipt = Record<string, unknown> & {
  target: { kind: 'agent'; agentName: string };
  delivery: {
    status: 'queued_unconfirmed' | 'recipient_mismatch';
    mode: DirectMessageMode;
    requestedRecipient: string;
    resolvedRecipient: string;
    recipientMatched: boolean;
    readConfirmed: false;
    note: string;
  };
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

function resolvedDirectRecipient(message: Record<string, unknown>, requestedRecipient: string): string {
  const target = asRecord(message.target);
  const targetName = target.agentName ?? target.agent_name;
  if (typeof targetName === 'string' && targetName.length > 0) return targetName;

  const recipient = asRecord(message.recipient);
  const recipientName = recipient.agentName ?? recipient.agent_name ?? recipient.name;
  if (typeof recipientName === 'string' && recipientName.length > 0) return recipientName;

  const directName = message.recipientName ?? message.recipient_name ?? message.to;
  return typeof directName === 'string' && directName.length > 0 ? directName : requestedRecipient;
}

/**
 * Add the delivery facts that Relaycast's create-message response does not
 * contain. A message id confirms durable enqueue only; delivery/read
 * confirmation remains observable through get_message_readers.
 */
export function directMessageReceipt(
  value: unknown,
  requestedRecipient: string,
  mode: DirectMessageMode = 'wait'
): DirectMessageDeliveryReceipt {
  const message = asRecord(value);
  const resolvedRecipient = resolvedDirectRecipient(message, requestedRecipient);
  const recipientMatched = resolvedRecipient === requestedRecipient;
  const note = recipientMatched
    ? mode === 'steer'
      ? 'Queued as an immediate injection request that may interrupt active work. This receipt does not confirm delivery or reading; call get_message_readers with the message id.'
      : "Queued for injection at the recipient's next safe idle boundary. It can remain unread while the recipient is busy. This receipt does not confirm delivery or reading; call get_message_readers with the message id."
    : `Recipient mismatch: requested ${requestedRecipient}, but the send response resolved ${resolvedRecipient}.`;

  return {
    ...message,
    target: { kind: 'agent', agentName: resolvedRecipient },
    delivery: {
      status: recipientMatched ? 'queued_unconfirmed' : 'recipient_mismatch',
      mode,
      requestedRecipient,
      resolvedRecipient,
      recipientMatched,
      readConfirmed: false,
      note,
    },
  };
}

export function messageReadersReceipt(readers: unknown[]): {
  readers: unknown[];
  delivery: { status: 'read' | 'queued_or_unread'; readConfirmed: boolean; signal: string };
} {
  const readConfirmed = readers.length > 0;
  return {
    readers,
    delivery: {
      status: readConfirmed ? 'read' : 'queued_or_unread',
      readConfirmed,
      signal: readConfirmed
        ? 'At least one agent has read this message.'
        : 'No agent has read this message. A send receipt confirms enqueue only; the recipient may still be busy or offline.',
    },
  };
}
