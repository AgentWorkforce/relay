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

/** Return the visible failure text for a receipt that cannot confirm its recipient. */
export function directMessageDeliveryFailure(receipt: DirectMessageDeliveryReceipt): string | undefined {
  if (receipt.delivery.status === 'queued_unconfirmed') return undefined;
  const rawMessageId = receipt.messageId ?? receipt.id;
  const messageReference = typeof rawMessageId === 'string' ? `message ${rawMessageId}` : 'the message';
  return (
    `Direct message recipient verification failed (${receipt.delivery.status}) after ${messageReference} ` +
    `was enqueued; delivery is not confirmed and retrying may duplicate it. ${receipt.delivery.note}`
  );
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

/**
 * Project a direct-message send receipt down to what the caller needs to act on
 * it, dropping the echoed message body.
 *
 * The upstream create-message response carries the body twice — once at `text`
 * and once at the nested `message.text` — and `directMessageReceipt` spreads
 * that response wholesale. On the MCP path that puts two further copies of a DM
 * into the *sender's* own context window, on top of the `tool_use` parameter
 * that already holds it. The sender wrote the text; echoing it back informs no
 * decision, and it is charged against the context budget of exactly the
 * long-lived resident agents that send the most DMs.
 *
 * The projection is an allowlist rather than a denylist on purpose: deleting
 * known body fields would start leaking the body again the first time the
 * upstream response grows another text-bearing field.
 *
 * Everything kept is fixed-size, so the receipt no longer grows with the
 * message. `delivery` is kept whole because it is the part that stops an agent
 * reporting an enqueue as a confirmed delivery; `id` because it is how the
 * caller follows up with `get_message_readers`; and `target` because its
 * presence — versus its absence on an unresolved recipient — is an existing
 * signal that the directory independently confirmed who was addressed.
 */
export function compactDirectMessageReceipt(
  receipt: DirectMessageDeliveryReceipt
): DirectMessageDeliveryReceipt {
  // The upstream response names the identifier `id` or `messageId` depending on
  // the endpoint — `directMessageDeliveryFailure` already reads both. Collapse
  // them to the single `id` the tool's output schema advertises, so a caller
  // told to follow up with `get_message_readers` always finds it under the
  // documented name rather than under whichever alias the endpoint happened to
  // use. An existing `id` wins; `messageId` is a fallback, never an extra field.
  const id = typeof receipt.id === 'string' ? receipt.id : receipt.messageId;
  const conversationId = receipt.conversationId;

  return {
    ...(typeof id === 'string' ? { id } : {}),
    ...(typeof conversationId === 'string' ? { conversationId } : {}),
    ...(receipt.target ? { target: receipt.target } : {}),
    delivery: receipt.delivery,
  };
}
