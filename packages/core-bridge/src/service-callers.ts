/**
 * Typed helpers for the service-caller identity and result-inbox methods.
 *
 * These methods are called only after {@link authenticate} has bound the
 * bridge connection. They therefore never accept or send `caller_name` or
 * `caller_secret`: the connection itself is the caller. The shapes mirror
 * Agent Relay Desktop's `contract/service_callers.rs` schema-v2 contract.
 */
import type { CallOptions, CoreClient } from './client.js';
import { CoreBridgeError, CoreRpcError } from './errors.js';
import type { CallerFileDescriptor } from './auth.js';

export const SERVICE_CALLER_IDENTITY_METHOD = 'spawn_callers.identity';
export const SERVICE_CALLER_INBOX_OPEN_METHOD = 'spawn_callers.inbox.open';
export const SERVICE_CALLER_INBOX_NEXT_METHOD = 'spawn_callers.inbox.next';
export const SERVICE_CALLER_INBOX_ACK_METHOD = 'spawn_callers.inbox.ack';
export const SERVICE_CALLER_INBOX_FAIL_METHOD = 'spawn_callers.inbox.fail';
export const SERVICE_CALLER_INBOX_CLOSE_METHOD = 'spawn_callers.inbox.close';
export const SERVICE_CALLER_DISCONNECT_METHOD = 'spawn_callers.disconnect';

/** The longest long-poll Desktop accepts for `inbox.next`. */
export const MAX_INBOX_NEXT_TIMEOUT_MS = 30_000;
/** Extra transport time for Desktop to encode and return a completed poll. */
export const INBOX_NEXT_CALL_GRACE_MS = 5_000;

export interface CallerPublisher {
  id: string;
  name: string;
}

export interface CallerNode {
  id: string;
  name: string;
}

export interface CallerIdentity {
  publisher: CallerPublisher;
  node: CallerNode;
  base_url: string;
  workspace_id: string;
  relaycast_workspace_id: string;
}

/**
 * Refuses when Desktop's bound identity is not the identity covered by the
 * caller file. The local node is intentionally not compared: it is returned
 * only by Desktop and selects the spawn target after this check.
 * @param descriptor - The validated schema-v2 caller handoff.
 * @param identity - The identity reported by the authenticated bridge connection.
 * @returns Nothing when the publisher and workspace identities match exactly.
 */
export function assertServiceCallerIdentity(
  descriptor: CallerFileDescriptor,
  identity: CallerIdentity
): void {
  if (
    descriptor.publisher.id !== identity.publisher.id ||
    descriptor.publisher.name !== identity.publisher.name ||
    descriptor.workspace.base_url !== identity.base_url ||
    descriptor.workspace.workspace_id !== identity.workspace_id ||
    descriptor.workspace.relaycast_workspace_id !== identity.relaycast_workspace_id
  ) {
    throw new CoreBridgeError(
      'caller_identity_mismatch',
      'The authenticated service caller does not match caller.json; rotate it in Agent Relay Desktop.'
    );
  }
}

export interface InboxOpened {
  iterator_id: string;
}

export interface InboxSender {
  id: string;
  name: string;
}

export const INBOX_FAILURE_CODES = ['result_too_large', 'result_write_failed'] as const;
export type InboxFailureCode = (typeof INBOX_FAILURE_CODES)[number];

export interface InboxFailure {
  code: InboxFailureCode;
  bytes: number;
  limit: number;
}

export interface InboxDelivery {
  item_id: string;
  message_id: string;
  sender: InboxSender;
  text?: string;
  failure?: InboxFailure;
  invocation_id: string;
  sent_at: string;
}

export interface InboxNext {
  delivery: InboxDelivery | null;
}

export type InboxSettleAction = 'ack' | 'fail';
export type InboxSettleState = 'acked' | 'failed';

export interface InboxSettled {
  item_id: string;
  message_id: string;
  action: InboxSettleAction;
  state: InboxSettleState;
  settled_at_ms: number;
}

const ID = /^[A-Za-z0-9_-]{1,256}$/;
const ITERATOR_ID = /^it_[0-9a-f]{32}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const FAILURE_CODES = new Set<string>(INBOX_FAILURE_CODES);

function invalid(field: string, rule: string): CoreBridgeError {
  return new CoreBridgeError('invalid_params', `Service-caller input is invalid: ${field} ${rule}.`);
}

function badReply(method: string, rule: string): CoreRpcError {
  return new CoreRpcError(`The ${method} reply is invalid: ${rule}.`, {
    rpcCode: -32603,
    kind: 'internal',
    retryable: false,
  });
}

function requireMethod(client: Pick<CoreClient, 'hello'>, method: string): void {
  if (client.hello.methods.includes(method)) return;
  throw new CoreRpcError(`This Agent Relay core does not offer ${method}; update Agent Relay Desktop.`, {
    rpcCode: -32601,
    kind: 'method_not_found',
    retryable: false,
  });
}

function record(method: string, value: unknown, field = 'it must be an object'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badReply(method, field);
  return value as Record<string, unknown>;
}

function text(method: string, value: unknown, field: string, max = 2048): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > max) {
    throw badReply(method, `${field} must be 1 to ${max} bytes`);
  }
  return value;
}

function id(method: string, value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw badReply(method, `${field} is malformed`);
  return value;
}

function safeCount(method: string, value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw badReply(method, `${field} must be an integer from 0 to 2^53 - 1`);
  }
  return value as number;
}

function inputId(field: string, value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw invalid(field, 'is malformed');
  return value;
}

function inputIteratorId(value: unknown): string {
  if (typeof value !== 'string' || !ITERATOR_ID.test(value)) {
    throw invalid('iterator_id', 'is malformed');
  }
  return value;
}

function checkDone(method: string, value: unknown): void {
  record(method, value);
}

function checkIdentity(value: unknown): CallerIdentity {
  const method = SERVICE_CALLER_IDENTITY_METHOD;
  const reply = record(method, value);
  const publisher = record(method, reply.publisher, 'publisher must be an object');
  const node = record(method, reply.node, 'node must be an object');
  const baseUrl = text(method, reply.base_url, 'base_url');
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw badReply(method, 'base_url must be an absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw badReply(method, 'base_url must use http or https');
  }
  return {
    publisher: {
      id: text(method, publisher.id, 'publisher.id', 256),
      name: text(method, publisher.name, 'publisher.name', 256),
    },
    node: {
      id: text(method, node.id, 'node.id', 256),
      name: text(method, node.name, 'node.name', 256),
    },
    base_url: baseUrl,
    workspace_id: text(method, reply.workspace_id, 'workspace_id', 256),
    relaycast_workspace_id: text(method, reply.relaycast_workspace_id, 'relaycast_workspace_id', 256),
  };
}

function checkOpened(value: unknown): InboxOpened {
  const method = SERVICE_CALLER_INBOX_OPEN_METHOD;
  const reply = record(method, value);
  if (typeof reply.iterator_id !== 'string' || !ITERATOR_ID.test(reply.iterator_id)) {
    throw badReply(method, 'iterator_id is malformed');
  }
  return { iterator_id: reply.iterator_id };
}

function checkDelivery(value: unknown): InboxDelivery {
  const method = SERVICE_CALLER_INBOX_NEXT_METHOD;
  const reply = record(method, value, 'delivery must be an object or null');
  const sender = record(method, reply.sender, 'delivery.sender must be an object');
  const hasText = typeof reply.text === 'string';
  const hasFailure = reply.failure !== undefined && reply.failure !== null;
  if (hasText === hasFailure) {
    throw badReply(method, 'delivery must carry exactly one of text or failure');
  }
  let failure: InboxFailure | undefined;
  if (hasFailure) {
    const raw = record(method, reply.failure, 'delivery.failure must be an object');
    if (typeof raw.code !== 'string' || !FAILURE_CODES.has(raw.code)) {
      throw badReply(method, 'delivery.failure.code is unknown');
    }
    failure = {
      code: raw.code as InboxFailureCode,
      bytes: safeCount(method, raw.bytes, 'delivery.failure.bytes'),
      limit: safeCount(method, raw.limit, 'delivery.failure.limit'),
    };
  }
  const sentAt = text(method, reply.sent_at, 'delivery.sent_at', 128);
  if (!RFC3339.test(sentAt) || !Number.isFinite(Date.parse(sentAt))) {
    throw badReply(method, 'delivery.sent_at must be RFC 3339');
  }
  const delivery: InboxDelivery = {
    item_id: id(method, reply.item_id, 'delivery.item_id'),
    message_id: id(method, reply.message_id, 'delivery.message_id'),
    sender: {
      id: text(method, sender.id, 'delivery.sender.id', 256),
      name: text(method, sender.name, 'delivery.sender.name', 256),
    },
    invocation_id: id(method, reply.invocation_id, 'delivery.invocation_id'),
    sent_at: sentAt,
  };
  if (hasText) delivery.text = reply.text as string;
  if (failure) delivery.failure = failure;
  return delivery;
}

function checkNext(value: unknown): InboxNext {
  const method = SERVICE_CALLER_INBOX_NEXT_METHOD;
  const reply = record(method, value);
  if (reply.delivery === null) return { delivery: null };
  if (reply.delivery === undefined) throw badReply(method, 'delivery is missing');
  return { delivery: checkDelivery(reply.delivery) };
}

function checkSettled(
  value: unknown,
  itemId: string,
  action: InboxSettleAction,
  state: InboxSettleState
): InboxSettled {
  const method = action === 'ack' ? SERVICE_CALLER_INBOX_ACK_METHOD : SERVICE_CALLER_INBOX_FAIL_METHOD;
  const reply = record(method, value);
  if (reply.item_id !== itemId) throw badReply(method, 'item_id is not the item that was settled');
  if (reply.action !== action) throw badReply(method, `action must be ${action}`);
  if (reply.state !== state) throw badReply(method, `state must be ${state}`);
  return {
    item_id: itemId,
    message_id: id(method, reply.message_id, 'message_id'),
    action,
    state,
    settled_at_ms: safeCount(method, reply.settled_at_ms, 'settled_at_ms'),
  };
}

/**
 * Returns the publisher, local node and Relaycast scope of the bound caller.
 * @param client - An authenticated service-caller bridge connection.
 * @param options - Optional timeout and cancellation controls for the call.
 * @returns The validated publisher, node, base URL and workspace identity.
 */
export async function serviceCallerIdentity(
  client: CoreClient,
  options?: CallOptions
): Promise<CallerIdentity> {
  requireMethod(client, SERVICE_CALLER_IDENTITY_METHOD);
  return checkIdentity(await client.call(SERVICE_CALLER_IDENTITY_METHOD, {}, options));
}

/**
 * Opens one inbox iterator, scoped durably to exactly one spawn invocation.
 * @param client - An authenticated service-caller bridge connection.
 * @param invocationId - The exact spawn invocation whose result is awaited.
 * @param options - Optional timeout and cancellation controls for the call.
 * @returns The validated identifier of the opened iterator.
 */
export async function serviceCallerInboxOpen(
  client: CoreClient,
  invocationId: string,
  options?: CallOptions
): Promise<InboxOpened> {
  requireMethod(client, SERVICE_CALLER_INBOX_OPEN_METHOD);
  return checkOpened(
    await client.call(
      SERVICE_CALLER_INBOX_OPEN_METHOD,
      { invocation_id: inputId('invocation_id', invocationId) },
      options
    )
  );
}

/**
 * Long-polls the next terminal delivery for an open iterator.
 * @param client - An authenticated service-caller bridge connection.
 * @param iteratorId - The exact iterator returned by {@link serviceCallerInboxOpen}.
 * @param timeoutMs - The server-side long-poll duration, from zero through 30 seconds.
 * @param options - Optional call timeout and cancellation controls.
 * @returns The validated terminal delivery, or `null` when the poll elapsed.
 */
export async function serviceCallerInboxNext(
  client: CoreClient,
  iteratorId: string,
  timeoutMs = MAX_INBOX_NEXT_TIMEOUT_MS,
  options: CallOptions = {}
): Promise<InboxNext> {
  requireMethod(client, SERVICE_CALLER_INBOX_NEXT_METHOD);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_INBOX_NEXT_TIMEOUT_MS) {
    throw invalid('timeout_ms', `must be an integer from 0 to ${MAX_INBOX_NEXT_TIMEOUT_MS}`);
  }
  const callOptions: CallOptions = {
    ...options,
    timeoutMs: options.timeoutMs ?? timeoutMs + INBOX_NEXT_CALL_GRACE_MS,
  };
  return checkNext(
    await client.call(
      SERVICE_CALLER_INBOX_NEXT_METHOD,
      { iterator_id: inputIteratorId(iteratorId), timeout_ms: timeoutMs },
      callOptions
    )
  );
}

async function settle(
  client: CoreClient,
  itemId: string,
  action: InboxSettleAction,
  options?: CallOptions
): Promise<InboxSettled> {
  const method = action === 'ack' ? SERVICE_CALLER_INBOX_ACK_METHOD : SERVICE_CALLER_INBOX_FAIL_METHOD;
  const state = action === 'ack' ? 'acked' : 'failed';
  const metadata = action === 'ack' ? 'journaled' : 'rejected';
  requireMethod(client, method);
  const id = inputId('item_id', itemId);
  return checkSettled(
    await client.call(method, { item_id: id, metadata: { relayflows_result: metadata } }, options),
    id,
    action,
    state
  );
}

/**
 * Acknowledges an item only after Relayflows durably journaled its result.
 * @param client - An authenticated service-caller bridge connection.
 * @param itemId - The exact inbox item whose result was journaled.
 * @param options - Optional timeout and cancellation controls for the call.
 * @returns The core's validated acknowledgement receipt.
 */
export function serviceCallerInboxAck(
  client: CoreClient,
  itemId: string,
  options?: CallOptions
): Promise<InboxSettled> {
  return settle(client, itemId, 'ack', options);
}

/**
 * Rejects an item whose result cannot be accepted into the Relayflows journal.
 * @param client - An authenticated service-caller bridge connection.
 * @param itemId - The exact inbox item whose result was rejected.
 * @param options - Optional timeout and cancellation controls for the call.
 * @returns The core's validated failure-settlement receipt.
 */
export function serviceCallerInboxFail(
  client: CoreClient,
  itemId: string,
  options?: CallOptions
): Promise<InboxSettled> {
  return settle(client, itemId, 'fail', options);
}

/**
 * Closes one iterator and releases any unsettled delivery lease it holds.
 * @param client - An authenticated service-caller bridge connection.
 * @param iteratorId - The exact iterator to close.
 * @param options - Optional timeout and cancellation controls for the call.
 * @returns A promise that resolves after the core confirms closure.
 */
export async function serviceCallerInboxClose(
  client: CoreClient,
  iteratorId: string,
  options?: CallOptions
): Promise<void> {
  requireMethod(client, SERVICE_CALLER_INBOX_CLOSE_METHOD);
  checkDone(
    SERVICE_CALLER_INBOX_CLOSE_METHOD,
    await client.call(
      SERVICE_CALLER_INBOX_CLOSE_METHOD,
      { iterator_id: inputIteratorId(iteratorId) },
      options
    )
  );
}

/**
 * Invalidates this connection's binding after every iterator is closed.
 * @param client - An authenticated service-caller bridge connection.
 * @param options - Optional timeout and cancellation controls for the call.
 * @returns A promise that resolves after the core confirms disconnection.
 */
export async function serviceCallerDisconnect(client: CoreClient, options?: CallOptions): Promise<void> {
  requireMethod(client, SERVICE_CALLER_DISCONNECT_METHOD);
  checkDone(
    SERVICE_CALLER_DISCONNECT_METHOD,
    await client.call(SERVICE_CALLER_DISCONNECT_METHOD, {}, options)
  );
}
