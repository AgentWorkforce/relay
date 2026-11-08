/**
 * Typed helpers for the core's native spawn controls (`spawn.*`), copied from
 * `crates/relay-node/src/relay/contract/spawn_control.rs`. The contract carries
 * no token, URL or header: the core uses the caller's own stored registration.
 *
 * Server rules a caller must know:
 * - `caller_name` must be an active local registration of this core that has
 *   a stored token; the core never returns that token.
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

import type { CoreClient } from './client.js';
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
  /**
   * A secret naming a service caller the core's spawn caller plugin vouches
   * for instead of a session registration; omit it for a session caller. A
   * core without the plugin refuses it.
   */
  caller_secret?: string;
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
  /**
   * A secret naming a service caller the core's spawn caller plugin vouches
   * for instead of a session registration; omit it for a session caller. A
   * core without the plugin refuses it.
   */
  caller_secret?: string;
  action: SpawnControlAction;
  invocation_id: string;
}

/** The params of `spawn.release`; the core refuses any other key. */
export interface SpawnReleaseParams {
  caller_name: string;
  /**
   * A secret naming a service caller the core's spawn caller plugin vouches
   * for instead of a session registration; omit it for a session caller. A
   * core without the plugin refuses it.
   */
  caller_secret?: string;
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
  task_unconfirmed: boolean;
  error_code: SpawnErrorCode | null;
}

/**
 * The exact keys each params struct has, in the Rust field order. Optional
 * keys left undefined are not sent.
 */
export const SPAWN_INVOKE_KEYS = [
  'caller_name',
  'caller_secret',
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
  'caller_secret',
  'action',
  'invocation_id',
] as const satisfies readonly (keyof SpawnStatusParams)[];
export const SPAWN_RELEASE_KEYS = [
  'caller_name',
  'caller_secret',
  'node_id',
  'node_name',
  'name',
  'expected_agent_id',
  'idempotency_key',
] as const satisfies readonly (keyof SpawnReleaseParams)[];

const SEGMENT = /^[A-Za-z0-9_-]{1,200}$/;
const MIN_KEY_LENGTH = 16;
const MAX_TASK_BYTES = 64 * 1024;

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

function callerSecret(params: object): void {
  const value = (params as Record<string, unknown>).caller_secret;
  // Names the field only: the value is a credential.
  if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
    throw invalid('caller_secret', 'must be a non-empty string when given');
  }
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
 */
export function newIdempotencyKey(): string {
  return randomUUID().replace(/-/g, '');
}

/** Lists the workspace's spawn nodes (`spawn.targets`). */
export async function spawnTargets(client: CoreClient): Promise<SpawnTargets> {
  requireMethod(client, 'spawn.targets');
  return client.call<SpawnTargets>('spawn.targets');
}

/**
 * Starts an agent on this computer's own spawn node (`spawn.invoke`). This
 * makes Relaycast calls; poll on a second connection while it runs.
 */
export async function spawnInvoke(
  client: CoreClient,
  params: SpawnInvokeParams
): Promise<SpawnControlInvocation> {
  requireMethod(client, 'spawn.invoke');
  for (const field of ['caller_name', 'node_id', 'node_name', 'name']) segment(params, field);
  callerSecret(params);
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
  return client.call<SpawnControlInvocation>('spawn.invoke', pick(params, SPAWN_INVOKE_KEYS));
}

/** Reads a spawn or release invocation (`spawn.status`). */
export async function spawnStatus(
  client: CoreClient,
  params: SpawnStatusParams
): Promise<SpawnControlInvocation> {
  requireMethod(client, 'spawn.status');
  segment(params, 'caller_name');
  callerSecret(params);
  segment(params, 'invocation_id');
  if (params.action !== 'spawn' && params.action !== 'release')
    throw invalid('action', 'must be "spawn" or "release"');
  return client.call<SpawnControlInvocation>('spawn.status', pick(params, SPAWN_STATUS_KEYS));
}

/** Releases an agent this core spawned, by its exact identity (`spawn.release`). */
export async function spawnRelease(
  client: CoreClient,
  params: SpawnReleaseParams
): Promise<SpawnControlInvocation> {
  requireMethod(client, 'spawn.release');
  for (const field of ['caller_name', 'node_id', 'node_name', 'name', 'expected_agent_id'])
    segment(params, field);
  callerSecret(params);
  key(params, 'idempotency_key');
  return client.call<SpawnControlInvocation>('spawn.release', pick(params, SPAWN_RELEASE_KEYS));
}
