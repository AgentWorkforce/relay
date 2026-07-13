/**
 * Spawn-request shaping: translate the SDK-facing spawn inputs into the plain
 * JSON bodies the broker `/api/spawn` endpoint accepts, and apply
 * `beforeAgentSpawn` patches.
 *
 * These are pure functions extracted from {@link HarnessDriverClient} so the
 * client can stay focused on transport and lifecycle while the request mapping
 * stays independently testable.
 */
import { actionSchemaToJsonSchema, type ActionSchema } from '@agent-relay/sdk/actions';

import type { HeadlessProvider } from './protocol.js';
import type { AgentTransport, SpawnCliInput, SpawnPtyInput } from './types.js';
import type { SpawnPatch } from './lifecycle-hooks.js';

export function isBundledHeadlessCli(value: string): value is HeadlessProvider {
  return value === 'claude' || value === 'opencode';
}

export function resolveSpawnTransport(input: SpawnCliInput): AgentTransport {
  if (input.transport) return input.transport;
  if (input.harnessConfig) return input.harnessConfig.runtime;
  return input.cli === 'opencode' ? 'headless' : 'pty';
}

/**
 * Coerce an `agentResultSchema` into the plain JSON Schema the broker accepts.
 * Raw JSON Schema (object or boolean) passes through unchanged; zod-style
 * validators are converted via the SDK's actions coercion helper.
 */
function resolveAgentResultSchema(
  schema: SpawnPtyInput['agentResultSchema']
): Record<string, unknown> | boolean | undefined {
  if (schema === undefined || typeof schema === 'boolean') return schema;
  return actionSchemaToJsonSchema(schema as ActionSchema);
}

/**
 * Serialize a {@link SpawnPtyInput} for the broker `/api/spawn` endpoint.
 * Factored out of {@link HarnessDriverClient.spawnPty} so the same shape can
 * be applied to the post-`beforeAgentSpawn` resolved input.
 */
export function buildSpawnPtyBody(input: SpawnPtyInput): Record<string, unknown> {
  return {
    name: input.name,
    cli: input.cli,
    ...(input.model !== undefined ? { model: input.model } : {}),
    args: input.args ?? [],
    ...(input.task !== undefined ? { task: input.task } : {}),
    channels: input.channels ?? [],
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.team !== undefined ? { team: input.team } : {}),
    ...(input.agentToken !== undefined ? { agentToken: input.agentToken } : {}),
    ...(input.shadowOf !== undefined ? { shadowOf: input.shadowOf } : {}),
    ...(input.shadowMode !== undefined ? { shadowMode: input.shadowMode } : {}),
    ...(input.continueFrom !== undefined ? { continueFrom: input.continueFrom } : {}),
    ...(input.harnessConfig !== undefined ? { harnessConfig: input.harnessConfig } : {}),
    ...(input.idleThresholdSecs !== undefined ? { idleThresholdSecs: input.idleThresholdSecs } : {}),
    ...(input.restartPolicy !== undefined ? { restartPolicy: input.restartPolicy } : {}),
    ...(input.spawnMode !== undefined ? { spawnMode: input.spawnMode } : {}),
    ...(input.exitAfterTask !== undefined ? { exitAfterTask: input.exitAfterTask } : {}),
    ...(input.skipRelayPrompt !== undefined ? { skipRelayPrompt: input.skipRelayPrompt } : {}),
    ...(input.agentResultSchema !== undefined
      ? { agentResultSchema: resolveAgentResultSchema(input.agentResultSchema) }
      : {}),
  };
}

export function buildSpawnCliBody(input: SpawnCliInput, transport: AgentTransport): Record<string, unknown> {
  return {
    name: input.name,
    cli: input.cli,
    ...(input.model !== undefined ? { model: input.model } : {}),
    args: input.args ?? [],
    ...(input.task !== undefined ? { task: input.task } : {}),
    channels: input.channels ?? [],
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.team !== undefined ? { team: input.team } : {}),
    ...(input.agentToken !== undefined ? { agentToken: input.agentToken } : {}),
    ...(input.shadowOf !== undefined ? { shadowOf: input.shadowOf } : {}),
    ...(input.shadowMode !== undefined ? { shadowMode: input.shadowMode } : {}),
    ...(input.continueFrom !== undefined ? { continueFrom: input.continueFrom } : {}),
    ...(input.harnessConfig !== undefined ? { harnessConfig: input.harnessConfig } : {}),
    ...(input.idleThresholdSecs !== undefined ? { idleThresholdSecs: input.idleThresholdSecs } : {}),
    ...(input.restartPolicy !== undefined ? { restartPolicy: input.restartPolicy } : {}),
    ...(input.spawnMode !== undefined ? { spawnMode: input.spawnMode } : {}),
    ...(input.exitAfterTask !== undefined ? { exitAfterTask: input.exitAfterTask } : {}),
    ...(input.skipRelayPrompt !== undefined ? { skipRelayPrompt: input.skipRelayPrompt } : {}),
    ...(input.agentResultSchema !== undefined
      ? { agentResultSchema: resolveAgentResultSchema(input.agentResultSchema) }
      : {}),
    transport,
  };
}

export function applySpawnPatch<TInput extends SpawnPtyInput | SpawnCliInput>(
  input: TInput,
  patch: SpawnPatch
): TInput {
  if (Object.hasOwn(patch, 'args')) input.args = patch.args;
  if (Object.hasOwn(patch, 'channels')) input.channels = patch.channels;
  if (Object.hasOwn(patch, 'task')) input.task = patch.task;
  if (Object.hasOwn(patch, 'model')) input.model = patch.model;
  if (Object.hasOwn(patch, 'team')) input.team = patch.team;
  if (Object.hasOwn(patch, 'agentToken')) input.agentToken = patch.agentToken;
  if (Object.hasOwn(patch, 'harnessConfig')) input.harnessConfig = patch.harnessConfig;
  if (Object.hasOwn(patch, 'spawnMode')) input.spawnMode = patch.spawnMode;
  if (Object.hasOwn(patch, 'exitAfterTask')) input.exitAfterTask = patch.exitAfterTask;
  return input;
}
