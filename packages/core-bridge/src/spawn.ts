/**
 * Typed helpers for the core's native spawn controls (`spawn.*`), copied from
 * `crates/relay-node/src/relay/contract/spawn_control.rs`. The contract carries
 * no token, URL or header. Session callers use the core's stored registration;
 * service callers prove their secret once per connection without sending it.
 *
 * Server rules a caller must know:
 * - A session `caller_name` must be an active local registration with a stored
 *   token. A service caller must first use `spawnCallerAuthenticate`; the core
 *   rechecks its bound authority on every operation.
 * - `spawn.invoke` targets only this computer's own spawn node, which must be
 *   live, have `handlers_live`, not be stale, and advertise `spawn:<harness>`.
 * - Idempotency keys must be persisted by the caller and reused on retry.
 * - `spawn.status` fills in `agent_id`, `name` and `node_id` only for a spawn
 *   made on this core.
 *
 * The helpers check params locally with the core's own rules and throw
 * `CoreBridgeError` with code `invalid_params`, to save a round trip; the
 * core stays authoritative.
 */
import { createHmac, randomUUID } from 'node:crypto';
import path from 'node:path';

import type { CallOptions, CoreClient } from './client.js';
import { CoreBridgeError, CoreRpcError } from './errors.js';

/** One spawn node the workspace knows (`SpawnControlTarget`). */
export interface SpawnControlTarget {
  id: string;
  name: string;
  live: boolean;
  handlers_live: boolean;
  stale: boolean;
  /** `spawn:<harness>` entries only. */
  capabilities: string[];
  active_agents: number;
  reserved_agents: number;
  max_agents: number;
}

/** The result of `spawn.targets`. */
export interface SpawnTargets {
  targets: SpawnControlTarget[];
}

/** The params of `spawn.invoke`; the core refuses any other key. */
export interface SpawnInvokeParams {
  caller_name: string;
  node_id: string;
  node_name: string;
  name: string;
  harness: string;
  task: string;
  directory: string;
  idempotency_key: string;
}

/** Which invocation family `spawn.status` reads. */
export type SpawnControlAction = 'spawn' | 'release';

/** The params of `spawn.status`; the core refuses any other key. */
export interface SpawnStatusParams {
  caller_name: string;
  action: SpawnControlAction;
  invocation_id: string;
}

/** The params of `spawn.release`; the core refuses any other key. */
export interface SpawnReleaseParams {
  caller_name: string;
  node_id: string;
  node_name: string;
  name: string;
  expected_agent_id: string;
  idempotency_key: string;
}

/** A fresh one-use challenge bound by the core to this exact connection. */
export interface SpawnCallerChallenge {
  challenge: string;
  expires_at_ms: number;
}

/** Confirmation that this connection is bound, with no reusable credential. */
export interface SpawnCallerAuthenticated {
  caller_name: string;
}

/** Every invocation status the core passes through (`spawn/control.rs`). */
export const SPAWN_STATUSES = ['pending', 'dispatched', 'running', 'completed', 'failed'] as const;
export type SpawnStatus = (typeof SPAWN_STATUSES)[number];

/** The bounded machine codes the core lets through (`spawn/control.rs` `error_code`). */
export const SPAWN_ERROR_CODES = [
  'spawn_failed',
  'spawn_invalid_input',
  'spawn_harness_unavailable',
  'spawn_harness_unsupported',
  'spawn_capacity_exceeded',
  'capacity_changed',
  'spawn_target_unavailable',
  'spawn_target_offline',
  'spawn_agent_name_in_use',
  'spawn_disabled',
  'release_identity_mismatch',
  'release_failed',
  'handler_unavailable',
  'capability_mismatch',
] as const;
export type SpawnErrorCode = (typeof SPAWN_ERROR_CODES)[number];

/** A spawn or release invocation (`SpawnControlInvocation`); absent values are `null`. */
export interface SpawnControlInvocation {
  id: string;
  /** Set only from this core's own registration for this exact spawn. */
  agent_id: string | null;
  status: SpawnStatus;
  node_id: string | null;
  name: string | null;
  spawned: boolean;
  ready: boolean;
  /**
   * True only when the provider reported the agent released. Never derived
   * from `status`: a `completed` release without it is not a confirmed one.
   * An older core that does not send it reads as `false`.
   */
  released: boolean;
  task_unconfirmed: boolean;
  error_code: SpawnErrorCode | null;
}

/**
 * Whether a release is confirmed: only when the core reported
 * `released === true`. A `completed` status, a missing field or any other
 * value (the string `"true"` included) is not a confirmed release.
 * @param invocation - A spawn control invocation, or a raw reply.
 * @returns True only for an invocation whose `released` is exactly `true`.
 */
export function isReleaseConfirmed(invocation: { readonly released?: unknown } | null | undefined): boolean {
  return invocation?.released === true;
}

/** A reply as the core sent it, with `released` read strictly. */
function invocationOf(reply: SpawnControlInvocation): SpawnControlInvocation {
  return { ...reply, released: isReleaseConfirmed(reply) };
}

/**
 * The exact keys each params struct has, in the Rust field order. Optional
 * keys left undefined are not sent.
 */
export const SPAWN_INVOKE_KEYS = [
  'caller_name',
  'node_id',
  'node_name',
  'name',
  'harness',
  'task',
  'directory',
  'idempotency_key',
] as const satisfies readonly (keyof SpawnInvokeParams)[];
export const SPAWN_STATUS_KEYS = [
  'caller_name',
  'action',
  'invocation_id',
] as const satisfies readonly (keyof SpawnStatusParams)[];
export const SPAWN_RELEASE_KEYS = [
  'caller_name',
  'node_id',
  'node_name',
  'name',
  'expected_agent_id',
  'idempotency_key',
] as const satisfies readonly (keyof SpawnReleaseParams)[];

const SEGMENT = /^[A-Za-z0-9_-]{1,200}$/;
const MIN_KEY_LENGTH = 16;
const MAX_TASK_BYTES = 64 * 1024;
const DEFAULT_SPAWN_ACTION_TIMEOUT_MS = 360_000;

function invalid(field: string, rule: string): CoreBridgeError {
  // Names the field only: values (the task above all) may hold user text.
  return new CoreBridgeError('invalid_params', `Native spawn input is invalid: ${field} ${rule}.`);
}

function segment(params: object, field: string): void {
  const value = (params as Record<string, unknown>)[field];
  if (typeof value !== 'string' || !SEGMENT.test(value)) {
    throw invalid(field, 'must be 1 to 200 letters, digits, "_" or "-"');
  }
}

function key(params: object, field: string): void {
  segment(params, field);
  if (((params as Record<string, unknown>)[field] as string).length < MIN_KEY_LENGTH) {
    throw invalid(field, `must be at least ${MIN_KEY_LENGTH} characters`);
  }
}

function rejectLegacyCallerSecret(params: object): void {
  if (Object.prototype.hasOwnProperty.call(params, 'caller_secret')) {
    throw invalid('caller_secret', 'is not accepted; call spawnCallerAuthenticate first');
  }
}

function pick<K extends string>(params: object, keys: readonly K[]): Partial<Record<K, unknown>> {
  const out: Partial<Record<K, unknown>> = {};
  for (const k of keys) {
    const value = (params as Record<string, unknown>)[k];
    if (value !== undefined) out[k] = value;
  }
  return out;
}

function requireMethod(client: CoreClient, method: string): void {
  if (!client.hello.methods.includes(method)) {
    throw new CoreRpcError(`This Agent Relay core does not offer ${method}; update the core.`, {
      rpcCode: -32601,
      kind: 'method_not_found',
      retryable: false,
    });
  }
}

const SPAWN_CALLER_CHALLENGE = /^agent-relay\/spawn-caller\/v1:[A-Za-z0-9_-]{43}$/;

/**
 * Proves a service-caller secret once and binds it to this exact greeted core
 * connection. The secret itself is used only as the local HMAC key and never
 * appears in bridge params, replies or errors.
 * @param client - The greeted core connection to authenticate.
 * @param callerName - The service caller name.
 * @param secret - The reusable secret used locally to compute the proof.
 * @param options - Optional timeout and cancellation controls for each call.
 * @returns Confirmation of the caller bound to this connection.
 */
export async function spawnCallerAuthenticate(
  client: CoreClient,
  callerName: string,
  secret: string,
  options?: CallOptions
): Promise<SpawnCallerAuthenticated> {
  requireMethod(client, 'spawn.caller.challenge');
  requireMethod(client, 'spawn.caller.authenticate');
  segment({ caller_name: callerName }, 'caller_name');
  if (typeof secret !== 'string' || secret.trim().length === 0) {
    throw invalid('service caller secret', 'must be a non-empty string');
  }
  const rawChallenge = await client.call<unknown>(
    'spawn.caller.challenge',
    { caller_name: callerName },
    options
  );
  const challenge = rawChallenge as Partial<SpawnCallerChallenge> | null;
  if (
    challenge === null ||
    typeof challenge !== 'object' ||
    typeof challenge.challenge !== 'string' ||
    !SPAWN_CALLER_CHALLENGE.test(challenge.challenge) ||
    typeof challenge.expires_at_ms !== 'number' ||
    !Number.isSafeInteger(challenge.expires_at_ms) ||
    challenge.expires_at_ms < 0
  ) {
    throw new CoreBridgeError('invalid_reply', 'Agent Relay core returned an invalid caller challenge.');
  }
  const authenticator = createHmac('sha256', secret).update(challenge.challenge, 'utf8').digest('hex');
  const authenticated = await client.call<unknown>(
    'spawn.caller.authenticate',
    { caller_name: callerName, challenge: challenge.challenge, authenticator },
    options
  );
  if (
    authenticated === null ||
    typeof authenticated !== 'object' ||
    (authenticated as Partial<SpawnCallerAuthenticated>).caller_name !== callerName
  ) {
    throw new CoreBridgeError('invalid_reply', 'Agent Relay core returned an invalid caller binding.');
  }
  return authenticated as SpawnCallerAuthenticated;
}

/**
 * A fresh idempotency key: a random UUID without dashes (32 hex characters).
 * Persist it and reuse it when retrying the same spawn or release.
 * @returns A fresh 32-character hexadecimal idempotency key.
 */
export function newIdempotencyKey(): string {
  return randomUUID().replace(/-/g, '');
}

/**
 * Lists the workspace's spawn nodes (`spawn.targets`).
 * @param client - A greeted connection to the Agent Relay core.
 * @param options - Optional timeout and cancellation controls for this call.
 * @returns The spawn targets visible to the core.
 */
export async function spawnTargets(client: CoreClient, options?: CallOptions): Promise<SpawnTargets> {
  requireMethod(client, 'spawn.targets');
  return client.call<SpawnTargets>('spawn.targets', undefined, options);
}

/**
 * Starts an agent on this computer's own spawn node (`spawn.invoke`). This
 * makes Relaycast calls; poll on a second connection while it runs.
 * @param client - A greeted connection to the Agent Relay core.
 * @param params - The exact spawn request accepted by the core.
 * @param options - Optional timeout and cancellation controls. The default
 * timeout is six minutes because target lookup and verified agent startup can
 * legitimately exceed the bridge client's 15-second default.
 * @returns The accepted spawn invocation receipt.
 */
export async function spawnInvoke(
  client: CoreClient,
  params: SpawnInvokeParams,
  options: CallOptions = {}
): Promise<SpawnControlInvocation> {
  requireMethod(client, 'spawn.invoke');
  rejectLegacyCallerSecret(params);
  for (const field of ['caller_name', 'node_id', 'node_name', 'name']) segment(params, field);
  key(params, 'idempotency_key');
  if (typeof params.harness !== 'string' || params.harness.length === 0)
    throw invalid('harness', 'must be named');
  if (
    typeof params.task !== 'string' ||
    params.task.trim().length === 0 ||
    Buffer.byteLength(params.task, 'utf8') > MAX_TASK_BYTES
  ) {
    throw invalid('task', 'must be non-empty and at most 64 KiB');
  }
  if (
    typeof params.directory !== 'string' ||
    !path.isAbsolute(params.directory) ||
    params.directory.includes('\0')
  ) {
    throw invalid('directory', 'must be an absolute path');
  }
  return invocationOf(
    await client.call<SpawnControlInvocation>(
      'spawn.invoke',
      pick(params, SPAWN_INVOKE_KEYS),
      spawnActionOptions(options)
    )
  );
}

/**
 * Reads a spawn or release invocation (`spawn.status`).
 * @param client - A greeted connection to the Agent Relay core.
 * @param params - The invocation identity and action family to read.
 * @param options - Optional timeout and cancellation controls for this call.
 * @returns The current invocation state.
 */
export async function spawnStatus(
  client: CoreClient,
  params: SpawnStatusParams,
  options?: CallOptions
): Promise<SpawnControlInvocation> {
  requireMethod(client, 'spawn.status');
  rejectLegacyCallerSecret(params);
  segment(params, 'caller_name');
  segment(params, 'invocation_id');
  if (params.action !== 'spawn' && params.action !== 'release')
    throw invalid('action', 'must be "spawn" or "release"');
  return invocationOf(
    await client.call<SpawnControlInvocation>('spawn.status', pick(params, SPAWN_STATUS_KEYS), options)
  );
}

/**
 * Releases an agent this core spawned, by its exact identity (`spawn.release`).
 * @param client - A greeted connection to the Agent Relay core.
 * @param params - The exact worker identity and stable release key.
 * @param options - Optional timeout and cancellation controls. The default
 * timeout is six minutes because exact remote cleanup can exceed the bridge
 * client's 15-second default.
 * @returns The accepted release invocation receipt.
 */
export async function spawnRelease(
  client: CoreClient,
  params: SpawnReleaseParams,
  options: CallOptions = {}
): Promise<SpawnControlInvocation> {
  requireMethod(client, 'spawn.release');
  rejectLegacyCallerSecret(params);
  for (const field of ['caller_name', 'node_id', 'node_name', 'name', 'expected_agent_id'])
    segment(params, field);
  key(params, 'idempotency_key');
  return invocationOf(
    await client.call<SpawnControlInvocation>(
      'spawn.release',
      pick(params, SPAWN_RELEASE_KEYS),
      spawnActionOptions(options)
    )
  );
}

function spawnActionOptions(options: CallOptions): CallOptions {
  return { ...options, timeoutMs: options.timeoutMs ?? DEFAULT_SPAWN_ACTION_TIMEOUT_MS };
}
