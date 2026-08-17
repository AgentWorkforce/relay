import { z } from 'zod';
import { claude, codex, definePtyHarness, gemini, type PtyHarness } from '@agent-relay/harnesses';
import { resolveStaticHarnessConfig, type StaticPtyHarnessDefinition } from '@agent-relay/harness-driver';
import type {
  AgentSpec,
  MessageInjectionMode,
  RestartPolicy,
  JsonValue,
} from '@agent-relay/harness-driver/protocol';

/** Runtime compatibility marker for dynamic `spawn:*` action delegation. */
export const FLEET_DYNAMIC_SPAWN_DELEGATION = true;

export type MaybePromise<T> = T | Promise<T>;

export interface FleetNodeInfo {
  name: string;
  maxAgents?: number;
  capabilities: string[];
}

export interface FleetRelaySendMessageInput {
  to: string;
  text: string;
  from?: string;
  mode?: MessageInjectionMode;
  data?: Record<string, unknown>;
}

export interface FleetScopedRelayClient {
  sendMessage(input: FleetRelaySendMessageInput): Promise<unknown>;
}

/**
 * Declared organizational identity for a spawned worker.
 *
 * These are intentionally explicit rather than derived from the agent name:
 * names are an implementation label, whereas this data is the caller's
 * statement of where the work belongs. `objective` is normally supplied by a
 * spawn's initial task when callers do not provide a narrower declaration.
 */
export interface FleetAgentRegistrationMetadata {
  organization?: string;
  project?: string;
  workstream?: string;
  role?: string;
  objective?: string;
}

export interface FleetSpawnAgentInput {
  agent: AgentSpec;
  initialTask?: string;
  registrationMetadata?: FleetAgentRegistrationMetadata;
  skipRelayPrompt?: boolean;
  invocationId?: string;
}

export interface FleetActionContext {
  node: FleetNodeInfo;
  relay: FleetScopedRelayClient;
  invocationId?: string;
  spawnAgent(input: FleetSpawnAgentInput): Promise<unknown>;
}

export type FleetActionHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  ctx: FleetActionContext
) => MaybePromise<TOutput>;

export interface FleetActionDefinition<TInput = unknown, TOutput = unknown> {
  readonly kind: 'action';
  readonly input?: ZodLikeSchema<TInput>;
  readonly handler: FleetActionHandler<TInput, TOutput>;
  readonly metadata?: Record<string, JsonValue>;
}

export interface FleetSpawnDefinition<TInput = SpawnInput, TOutput = unknown> extends FleetActionDefinition<
  TInput,
  TOutput
> {
  readonly kind: 'action';
  readonly fleetKind: 'spawn';
  readonly harness: StaticPtyHarnessDefinition;
}

export type FleetCapabilityValue = FleetActionDefinition | FleetSpawnDefinition | FleetActionHandler;

export interface FleetNodeDefinitionInput {
  name: string;
  maxAgents?: number;
  capabilities: Record<string, FleetCapabilityValue>;
  triggers?: FleetTriggerDescriptor[];
  tags?: string[];
  version?: string;
}

export interface FleetNodeDefinition {
  readonly __agentRelayFleetNode: true;
  readonly name: string;
  readonly maxAgents?: number;
  readonly capabilities: Record<string, FleetCapability>;
  readonly triggers: FleetTriggerDescriptor[];
  readonly tags?: string[];
  readonly version?: string;
}

export interface FleetCapability<TInput = unknown, TOutput = unknown> {
  name: string;
  kind: 'action' | 'spawn';
  input?: ZodLikeSchema<TInput>;
  handler: FleetActionHandler<TInput, TOutput>;
  metadata?: Record<string, JsonValue>;
}

export interface OnMessageTriggerInput {
  channel?: string;
  match?: RegExp | string;
  mention?: boolean | string;
}

export interface FleetTriggerDescriptor {
  type: 'message';
  channel?: string;
  match?: RegExp | string;
  mention?: boolean | string;
  actionName: string;
}

export interface RelayTriggerSyncInput {
  channel?: string;
  pattern?: string;
  mention?: boolean | string;
  actionName: string;
  enabled: boolean;
}

export type ZodLikeSchema<T = unknown> = Pick<z.ZodType<T>, 'safeParse'> & {
  description?: string;
};

const spawnInputSchema = z
  .looseObject({
    name: z.string().min(1).optional(),
    agent: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    session_ref: z.string().min(1).optional(),
    task: z.string().optional(),
    channels: z.array(z.string().min(1)).optional(),
    worker_cwd: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    team: z.string().min(1).optional(),
    organization: z.string().min(1).optional(),
    project: z.string().min(1).optional(),
    workstream: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
    objective: z.string().min(1).optional(),
    skip_relay_prompt: z.boolean().optional(),
  })
  .refine((input) => Boolean(input.name ?? input.agent), {
    message: 'spawn input requires name or agent',
    path: ['name'],
  });

export type SpawnInput = z.infer<typeof spawnInputSchema>;

export interface SpawnHandlerOptions {
  model?: string;
  args?: string[];
  channels?: string[];
  cwd?: string;
  team?: string;
  skipRelayPrompt?: boolean;
  restartPolicy?: RestartPolicy;
  metadata?: Record<string, JsonValue>;
}

export function defineNode(input: FleetNodeDefinitionInput): FleetNodeDefinition {
  const name = nonEmpty(input.name, 'node name');
  const capabilityEntries = Object.entries(input.capabilities ?? {});
  if (capabilityEntries.length === 0) {
    throw new Error('defineNode requires at least one capability');
  }
  if (input.maxAgents !== undefined && (!Number.isInteger(input.maxAgents) || input.maxAgents <= 0)) {
    throw new Error('maxAgents must be a positive integer');
  }

  const capabilities: Record<string, FleetCapability> = {};
  const seenCapabilityNames = new Set<string>();
  for (const [rawName, value] of capabilityEntries) {
    const capabilityName = nonEmpty(rawName, 'capability name');
    if (seenCapabilityNames.has(capabilityName)) {
      throw new Error(
        `defineNode requires unique capability names; duplicate "${capabilityName}" after trimming`
      );
    }
    seenCapabilityNames.add(capabilityName);
    capabilities[capabilityName] = normalizeCapability(capabilityName, value);
  }

  const triggers = input.triggers ?? [];
  for (const trigger of triggers) {
    if (!capabilities[trigger.actionName]) {
      throw new Error(`Trigger references unknown action "${trigger.actionName}"`);
    }
    if (trigger.match instanceof RegExp && trigger.match.flags) {
      throw new Error(
        `trigger regex flags are not supported yet; match is case-sensitive — use character classes like [Ss]hip (got /${trigger.match.source}/${trigger.match.flags} for action "${trigger.actionName}")`
      );
    }
  }

  return {
    __agentRelayFleetNode: true,
    name,
    ...(input.maxAgents !== undefined ? { maxAgents: input.maxAgents } : {}),
    capabilities,
    triggers: [...triggers],
    ...(input.tags ? { tags: [...input.tags] } : {}),
    ...(input.version ? { version: input.version } : {}),
  };
}

export function isFleetNodeDefinition(value: unknown): value is FleetNodeDefinition {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as { __agentRelayFleetNode?: unknown }).__agentRelayFleetNode === true
  );
}

export function action<TInput = unknown, TOutput = unknown>(
  options: { input?: ZodLikeSchema<TInput>; metadata?: Record<string, JsonValue> },
  handler: FleetActionHandler<TInput, TOutput>
): FleetActionDefinition<TInput, TOutput> {
  if (typeof handler !== 'function') {
    throw new Error('action handler must be a function');
  }
  return {
    kind: 'action',
    ...(options.input ? { input: options.input } : {}),
    handler,
    ...(options.metadata ? { metadata: { ...options.metadata } } : {}),
  };
}

export function spawn(
  harness: StaticPtyHarnessDefinition | PtyHarness,
  options: SpawnHandlerOptions = {}
): FleetSpawnDefinition<SpawnInput, unknown> {
  const definition = normalizePtyHarness(harness);
  const handler: FleetActionHandler<SpawnInput, unknown> = async (rawInput, ctx) => {
    const input = parseWithSchema(spawnInputSchema, rawInput);
    const name = input.name ?? input.agent;
    if (!name) {
      throw new Error('spawn input requires name or agent');
    }
    const model = input.model ?? options.model;
    const rawArgs = [...(options.args ?? []), ...(input.args ?? [])];
    // `worker_cwd` is the unambiguous Fleet action field. Keep `cwd` as the
    // Fleet DSL's legacy working-directory input, but do not make callers
    // guess whether it is the MCP persona-registry cwd.
    const cwd = input.worker_cwd ?? input.cwd ?? options.cwd ?? definition.cwd;
    const channels = input.channels ?? options.channels;
    const task = input.task;
    const metadata = registrationMetadata(input, task);
    const harnessConfig = resolveStaticHarnessConfig({
      name,
      cli: definition.command,
      definition,
      args: rawArgs,
      task,
      model,
      cwd,
    });
    if (input.session_ref && harnessConfig.runtime === 'pty') {
      harnessConfig.sessionId = input.session_ref;
    }

    const agent: AgentSpec = {
      name,
      runtime: 'pty',
      cli: definition.command,
      ...(model ? { model } : {}),
      ...(rawArgs.length > 0 ? { args: rawArgs } : {}),
      ...(channels ? { channels } : {}),
      ...(cwd ? { cwd } : {}),
      ...((input.team ?? options.team) ? { team: input.team ?? options.team } : {}),
      ...(input.session_ref ? { session_id: input.session_ref } : {}),
      ...(options.restartPolicy ? { restart_policy: options.restartPolicy } : {}),
      harness_config: harnessConfig,
    };

    return ctx.spawnAgent({
      agent,
      ...(task !== undefined ? { initialTask: task } : {}),
      ...(metadata ? { registrationMetadata: metadata } : {}),
      skipRelayPrompt: input.skip_relay_prompt ?? options.skipRelayPrompt ?? false,
      invocationId: ctx.invocationId,
    });
  };

  return {
    kind: 'action',
    fleetKind: 'spawn',
    input: spawnInputSchema,
    handler,
    harness: definition,
    metadata: {
      cli: definition.command,
      runtime: definition.runtime,
      ...(definition.metadata ?? {}),
      ...(options.metadata ?? {}),
    },
  };
}

function registrationMetadata(
  input: Pick<SpawnInput, 'organization' | 'project' | 'workstream' | 'role' | 'objective'>,
  task: string | undefined
): FleetAgentRegistrationMetadata | undefined {
  // Trim and omit blanks, matching the CLI's `declaredWorkforceMetadata` and
  // the broker's `declared_metadata_map`. A whitespace-only value is a declared
  // nothing, and the broker merges these over metadata the engine already
  // holds, so emitting one would overwrite an engine-owned field with an empty
  // string.
  const declared: Array<[keyof FleetAgentRegistrationMetadata, string | undefined]> = [
    ['organization', input.organization],
    ['project', input.project],
    ['workstream', input.workstream],
    ['role', input.role],
    ['objective', input.objective ?? task],
  ];
  const metadata: FleetAgentRegistrationMetadata = {};
  for (const [key, value] of declared) {
    const trimmed = value?.trim();
    if (trimmed) metadata[key] = trimmed;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function onMessage(input: OnMessageTriggerInput, actionName: string): FleetTriggerDescriptor {
  return {
    type: 'message',
    ...(input.channel ? { channel: input.channel } : {}),
    ...(input.match ? { match: input.match } : {}),
    ...(input.mention !== undefined ? { mention: input.mention } : {}),
    actionName: nonEmpty(actionName, 'action name'),
  };
}

export function nodeInfo(definition: FleetNodeDefinition): FleetNodeInfo {
  return {
    name: definition.name,
    ...(definition.maxAgents !== undefined ? { maxAgents: definition.maxAgents } : {}),
    capabilities: Object.keys(definition.capabilities),
  };
}

export async function invokeNodeHandler(
  definition: FleetNodeDefinition,
  name: string,
  input: unknown,
  ctx: FleetActionContext
): Promise<unknown> {
  const capability = definition.capabilities[name];
  if (!capability) {
    throw new Error(`Unknown fleet handler "${name}"`);
  }
  const parsedInput = capability.input ? parseWithSchema(capability.input, input) : input;
  return capability.handler(parsedInput, ctx);
}

export function triggerSyncInputs(definition: FleetNodeDefinition): RelayTriggerSyncInput[] {
  return definition.triggers.map((trigger) => ({
    ...(trigger.channel ? { channel: trigger.channel } : {}),
    ...(trigger.match
      ? { pattern: trigger.match instanceof RegExp ? trigger.match.source : trigger.match }
      : {}),
    ...(trigger.mention !== undefined ? { mention: trigger.mention } : {}),
    actionName: trigger.actionName,
    enabled: true,
  }));
}

export function defineDefaultLocalNode(input: {
  name: string;
  maxAgents?: number;
  teams?: { agents?: Array<{ cli?: string }> } | null;
}): FleetNodeDefinition {
  const harnesses = new Map<string, StaticPtyHarnessDefinition>([
    ['claude', claude],
    ['codex', codex],
    ['gemini', gemini],
  ]);
  for (const agent of input.teams?.agents ?? []) {
    const cli = agent.cli?.trim();
    if (cli && !harnesses.has(cli)) {
      harnesses.set(cli, definePtyHarness({ runtime: 'pty', command: cli }));
    }
  }

  const capabilities: Record<string, FleetCapabilityValue> = {};
  for (const [cli, harness] of harnesses) {
    capabilities[`spawn:${cli}`] = spawn(harness);
  }
  return defineNode({
    name: input.name,
    ...(input.maxAgents !== undefined ? { maxAgents: input.maxAgents } : {}),
    capabilities,
  });
}

function normalizeCapability(name: string, value: FleetCapabilityValue): FleetCapability {
  if (isFleetActionDefinition(value)) {
    return {
      name,
      kind: isFleetSpawnDefinition(value) ? 'spawn' : 'action',
      ...(value.input ? { input: value.input } : {}),
      handler: value.handler as FleetActionHandler,
      ...(value.metadata ? { metadata: { ...value.metadata } } : {}),
    };
  }
  if (typeof value === 'function') {
    return {
      name,
      kind: 'action',
      handler: value,
    };
  }
  throw new Error(`Capability "${name}" must be an action, spawn handler, or async function`);
}

function isFleetActionDefinition(value: FleetCapabilityValue): value is FleetActionDefinition {
  return Boolean(value && typeof value === 'object' && (value as FleetActionDefinition).kind === 'action');
}

function isFleetSpawnDefinition(value: FleetActionDefinition): boolean {
  return (value as FleetSpawnDefinition).fleetKind === 'spawn';
}

function normalizePtyHarness(harness: StaticPtyHarnessDefinition | PtyHarness): StaticPtyHarnessDefinition {
  if (!harness || typeof harness !== 'object') {
    throw new Error('spawn requires a PTY harness definition');
  }
  if (harness.runtime !== 'pty' || typeof harness.command !== 'string' || harness.command.trim() === '') {
    throw new Error('spawn requires a PTY harness with a command');
  }
  return {
    ...harness,
    command: harness.command.trim(),
  };
}

function nonEmpty(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

function parseWithSchema<T>(schema: ZodLikeSchema<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return parsed.data;
  }
  const message = 'error' in parsed ? parsed.error.message : 'input validation failed';
  throw new Error(message);
}

export * from './serve-node.js';
