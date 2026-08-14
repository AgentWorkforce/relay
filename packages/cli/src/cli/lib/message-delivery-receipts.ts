export type DirectMessageMode = 'wait' | 'steer';

export type DirectMessageDeliveryReceipt = Record<string, unknown> & {
  target?: { kind: 'agent'; agentName: string };
  delivery: {
    status: 'queued_unconfirmed' | 'recipient_mismatch' | 'recipient_unresolved';
    mode: DirectMessageMode;
    requestedRecipient: string;
    resolvedRecipient: string | null;
    recipientMatched: boolean | null;
    readConfirmed: false;
    note: string;
  };
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

/** Resolve only a full, exact agent name; never fall back to a prefix. */
export function resolveExactAgentName(
  agents: readonly unknown[],
  requestedRecipient: string
): string | undefined {
  return agents
    .map((agent) => {
      const name = asRecord(agent).name;
      return typeof name === 'string' ? name : undefined;
    })
    .find((name) => name === requestedRecipient);
}

/**
 * Add the delivery facts that Relaycast's create-message response does not
 * contain. A message id confirms durable enqueue only; delivery/read
 * confirmation remains observable through get_message_readers. The resolved
 * recipient must come from an independent directory lookup; the created
 * message's target may only echo the request and is deliberately not trusted.
 */
export function directMessageReceipt(
  value: unknown,
  requestedRecipient: string,
  mode: DirectMessageMode = 'wait',
  resolvedRecipient?: string
): DirectMessageDeliveryReceipt {
  const message = asRecord(value);
  const messageWithoutUntrustedTarget = { ...message };
  delete messageWithoutUntrustedTarget.target;
  const recipientMatched = resolvedRecipient ? resolvedRecipient === requestedRecipient : null;
  const status =
    recipientMatched === null
      ? 'recipient_unresolved'
      : recipientMatched
        ? 'queued_unconfirmed'
        : 'recipient_mismatch';
  const note =
    recipientMatched === null
      ? `Recipient resolution was unavailable for ${requestedRecipient}; enqueue is not reported as successful delivery.`
      : recipientMatched
        ? mode === 'steer'
          ? 'Queued as an immediate injection request that may interrupt active work. This receipt does not confirm delivery or reading; call get_message_readers with the message id.'
          : "Queued for injection at the recipient's next safe idle boundary. It can remain unread while the recipient is busy. This receipt does not confirm delivery or reading; call get_message_readers with the message id."
        : `Recipient mismatch: requested ${requestedRecipient}, but the directory resolved ${resolvedRecipient}.`;

  return {
    ...messageWithoutUntrustedTarget,
    ...(resolvedRecipient ? { target: { kind: 'agent' as const, agentName: resolvedRecipient } } : {}),
    delivery: {
      status,
      mode,
      requestedRecipient,
      resolvedRecipient: resolvedRecipient ?? null,
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
