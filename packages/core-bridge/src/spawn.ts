/**
 * Typed helpers for the core's native spawn controls (`spawn.*`), copied from
 * `crates/relay-node/src/relay/contract/spawn_control.rs`. The contract carries
 * no token, URL or header: the core uses the caller's own stored registration.
 *
 * Server rules a caller must know:
 * - A service caller binds its connection first with `authenticate`
 *   (`auth.ts`) and then names no caller: the bound connection is the caller.
 *   Naming `caller_name` on a bound connection is refused.
 * - A session caller names `caller_name`, which must be an active local
 *   registration of this core that has a stored token; the core never
 *   returns that token.
 * - No credential is ever a param. A `caller_secret` key is refused
 *   (`legacy_credential_refused`) locally and by the core.
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
import { randomUUID } from 'node:crypto';
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
  /**
   * The session registration that calls. Omit it on a connection bound by
   * `authenticate`, where the core refuses it.
   */
  caller_name?: string;
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
  /**
   * The session registration that calls. Omit it on a connection bound by
   * `authenticate`, where the core refuses it.
   */
  caller_name?: string;
  action: SpawnControlAction;
  invocation_id: string;
}

/** The params of `spawn.release`; the core refuses any other key. */
export interface SpawnReleaseParams {
  /**
   * The session registration that calls. Omit it on a connection bound by
   * `authenticate`, where the core refuses it.
   */
  caller_name?: string;
  node_id: string;
  node_name: string;
  name: string;
  expected_agent_id: string;
  idempotency_key: string;
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

/**
 * The default timeout of `spawn.invoke` and `spawn.release`: six minutes,
 * because target lookup, verified agent startup and exact remote cleanup can
 * outlast the bridge client's 15-second call deadline. Override it per call
 * with {@link SpawnActionOptions.actionTimeoutMs}.
 */
export const DEFAULT_SPAWN_ACTION_TIMEOUT_MS = 360_000;

/** Call options for the action-length calls, `spawn.invoke` and `spawn.release`. */
export interface SpawnActionOptions extends CallOptions {
  /**
   * How long to wait for the action, in milliseconds. It is separate from the
   * client's call deadline (15 seconds by default), which other calls keep.
   * When unset, `timeoutMs` applies if given, else
   * {@link DEFAULT_SPAWN_ACTION_TIMEOUT_MS}.
   */
  actionTimeoutMs?: number;
}

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

function pick<K extends string>(params: object, keys: readonly K[]): Partial<Record<K, unknown>> {
  const out: Partial<Record<K, unknown>> = {};
  for (const k of keys) {
    const value = (params as Record<string, unknown>)[k];
    if (value !== undefined) out[k] = value;
  }
  return out;
}

/**
 * Refuses a `caller_secret` key before anything filters the params, so a
 * secret is never silently dropped or sent. The message never holds the value.
 */
function noLegacyCredential(params: object): void {
  if (params !== null && typeof params === 'object' && Object.hasOwn(params, 'caller_secret')) {
    throw new CoreBridgeError(
      'legacy_credential_refused',
      'caller_secret is no longer accepted; bind the connection with authenticate() and omit the caller.'
    );
  }
}

function optionalSegment(params: object, field: string): void {
  if ((params as Record<string, unknown>)[field] !== undefined) segment(params, field);
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
 * @param options - Optional timeout and cancellation controls.
 * `actionTimeoutMs` defaults to {@link DEFAULT_SPAWN_ACTION_TIMEOUT_MS} (six
 * minutes), separate from the bridge client's 15-second call deadline.
 * @returns The accepted spawn invocation receipt.
 */
export async function spawnInvoke(
  client: CoreClient,
  params: SpawnInvokeParams,
  options: SpawnActionOptions = {}
): Promise<SpawnControlInvocation> {
  noLegacyCredential(params);
  requireMethod(client, 'spawn.invoke');
  optionalSegment(params, 'caller_name');
  for (const field of ['node_id', 'node_name', 'name']) segment(params, field);
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
  noLegacyCredential(params);
  requireMethod(client, 'spawn.status');
  optionalSegment(params, 'caller_name');
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
 * @param options - Optional timeout and cancellation controls.
 * `actionTimeoutMs` defaults to {@link DEFAULT_SPAWN_ACTION_TIMEOUT_MS} (six
 * minutes), separate from the bridge client's 15-second call deadline.
 * @returns The accepted release invocation receipt.
 */
export async function spawnRelease(
  client: CoreClient,
  params: SpawnReleaseParams,
  options: SpawnActionOptions = {}
): Promise<SpawnControlInvocation> {
  noLegacyCredential(params);
  requireMethod(client, 'spawn.release');
  optionalSegment(params, 'caller_name');
  for (const field of ['node_id', 'node_name', 'name', 'expected_agent_id']) segment(params, field);
  key(params, 'idempotency_key');
  return invocationOf(
    await client.call<SpawnControlInvocation>(
      'spawn.release',
      pick(params, SPAWN_RELEASE_KEYS),
      spawnActionOptions(options)
    )
  );
}

function spawnActionOptions(options: SpawnActionOptions): CallOptions {
  const { actionTimeoutMs, ...call } = options;
  return { ...call, timeoutMs: actionTimeoutMs ?? call.timeoutMs ?? DEFAULT_SPAWN_ACTION_TIMEOUT_MS };
}
