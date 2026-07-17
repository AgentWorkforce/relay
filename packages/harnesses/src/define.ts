import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAgentHandle,
  nextHarnessName,
  type AgentRelay,
  type AgentSessionEvent,
  type HarnessFactory,
  type RelayHarnessAgent,
} from '@agent-relay/sdk';
import type {
  AgentDriver,
  BrokerEvent,
  AgentEventEnvelope,
  SpawnRuntimeInput,
  StaticPtyHarnessDefinition,
} from '@agent-relay/harness-driver';

import { getHarnessDriver } from './broker-binding.js';
import { aiSdkAdapterRegistry, type AiSdkAdapterRegistryEntry } from './ai-sdk/adapter-registry.js';
import {
  AI_SDK_REFERENCE_OBSERVABILITY_PROFILE,
  createPtyObservabilityTranslator,
  getPtyObservabilityProfile,
} from './observability.js';

export type HarnessBackend = 'auto' | 'ai-sdk' | 'pty';
export type SelectedHarnessBackend = Exclude<HarnessBackend, 'auto'>;

export interface NativeHarnessSidecarLaunch {
  command: string;
  args: string[];
}

/** Options accepted when creating an agent from a harness. */
export interface HarnessCreateInput {
  /** Runtime selection. `auto` uses only adapters promoted to default. */
  backend?: HarnessBackend;
  /** Explicit agent name/handle. Defaults to `<command>-<n>`. */
  name?: string;
  /** Model passed through to the harness CLI (e.g. `sonnet`, `gpt-5.5`). */
  model?: string;
  /** Extra CLI arguments. */
  args?: string[];
  /** Initial task prompt for the agent. */
  task?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Channels the agent should join once registered. */
  channels?: string[];
  /**
   * When provided, {@link PtyHarness.create} starts a live PTY session in this
   * workspace: it attaches or starts the broker, spawns the agent, and returns a
   * handle to the already-registered agent. Omit it to build a descriptor for an
   * externally-run agent you register yourself.
   */
  relay?: AgentRelay;
}

/**
 * An agent produced by a harness factory. Carries the identity and predicate
 * builders used with `relay.on(...)`, plus the resolved spawn details the
 * runtime needs to actually launch the process.
 */
export interface HarnessAgent extends RelayHarnessAgent {
  kind: 'pty';
  backend: 'pty';
  cli: string;
  /** Driver runtime tag — the harness-driver `AgentRuntime` this agent maps to. */
  runtime: 'pty';
  model?: string;
  task?: string;
  args?: string[];
  channels?: string[];
  cwd?: string;
  env?: Record<string, string>;
  definition: StaticPtyHarnessDefinition;
  observability: ReturnType<typeof getPtyObservabilityProfile>;
}

export interface NativeHarnessAgent extends RelayHarnessAgent {
  kind: 'native';
  backend: 'ai-sdk';
  cli: string;
  runtime: 'native';
  adapter: string;
  model?: string;
  task?: string;
  args?: string[];
  channels?: string[];
  cwd?: string;
  env?: Record<string, string>;
  observability: typeof AI_SDK_REFERENCE_OBSERVABILITY_PROFILE;
}

export type ManagedHarnessAgent = HarnessAgent | NativeHarnessAgent;

export interface ManagedHarness extends HarnessFactory<HarnessCreateInput, ManagedHarnessAgent> {
  readonly runtime: 'pty' | 'native';
  readonly command: string;
  readonly adapter: AiSdkAdapterRegistryEntry;
  create(input?: HarnessCreateInput): Promise<ManagedHarnessAgent>;
  new: (input?: HarnessCreateInput) => ManagedHarnessAgent;
}

export type ManagedPtyHarness = ManagedHarness &
  StaticPtyHarnessDefinition & {
    readonly runtime: 'pty';
  };

/**
 * A harness factory. Remains structurally a {@link StaticPtyHarnessDefinition}
 * (so the runtime can resolve it) while adding the {@link HarnessFactory}
 * `create`/`new` methods that produce {@link HarnessAgent}s.
 */
export interface PtyHarness
  extends StaticPtyHarnessDefinition, HarnessFactory<HarnessCreateInput, HarnessAgent> {
  /**
   * With `{ relay }`, spawn a live PTY agent into that workspace and return a
   * handle to the running, already-registered agent. Without it, build a
   * descriptor for an externally-run agent you register yourself.
   */
  create(input?: HarnessCreateInput): Promise<HarnessAgent>;
  /** Synchronous descriptor builder — never spawns. Register it yourself. */
  new: (input?: HarnessCreateInput) => HarnessAgent;
}

/** Wrap a static PTY harness definition in a factory with `create`/`new`. */
export function definePtyHarness(definition: StaticPtyHarnessDefinition): PtyHarness {
  const build = (input: HarnessCreateInput = {}): HarnessAgent => {
    const name = nextHarnessName(definition.command, input.name);
    const handle = createAgentHandle({ id: `harness:${definition.command}:${name}`, name });
    return {
      ...handle,
      kind: 'pty',
      backend: 'pty',
      cli: definition.command,
      runtime: 'pty',
      model: input.model,
      task: input.task,
      args: input.args,
      channels: input.channels,
      cwd: input.cwd ?? definition.cwd,
      env: input.env ?? definition.env,
      definition,
      observability: getPtyObservabilityProfile(definition.command),
    };
  };

  const spawnLive = async (input: HarnessCreateInput, relay: AgentRelay): Promise<HarnessAgent> => {
    const driver = getHarnessDriver(relay);
    const cwd = input.cwd ?? definition.cwd;
    const runtime = await driver.spawn({
      name: nextHarnessName(definition.command, input.name),
      cli: definition.command,
      transport: 'pty',
      model: input.model,
      task: input.task,
      args: input.args,
      channels: input.channels,
      cwd,
    });
    const translator = createPtyObservabilityTranslator(definition.command);
    let turnId: string | undefined;
    const emitTranslated = (signal: Parameters<typeof translator.translate>[0]) => {
      for (const event of translator.translate(signal)) {
        // Broker-owned PTY observability is published to Relaycast for every
        // spawn surface. This local bridge only feeds listeners on the
        // AgentRelay instance that created this managed harness.
        relay.emitSessionEvent(runtime.agent.name, event);
      }
    };
    const signalFromBroker = async (event: BrokerEvent) => {
      switch (event.kind) {
        case 'agent_spawned':
          emitTranslated({ type: 'starting' });
          return;
        case 'worker_stream':
          turnId ??= `pty-${randomUUID()}`;
          emitTranslated({ type: 'busy', turnId });
          return;
        case 'agent_idle':
          if (turnId) {
            emitTranslated({ type: 'idle', turnId });
            turnId = undefined;
          }
          return;
        case 'worker_error':
          emitTranslated({ type: 'error', error: event.message, code: event.code });
          return;
        case 'agent_exit':
        case 'agent_exited':
          if (event.kind === 'agent_exited' && event.code === 0) return;
          emitTranslated({
            type: 'error',
            error:
              event.reason ??
              `PTY runtime exited${event.kind === 'agent_exited' && event.code != null ? ` (${event.code})` : ''}`,
            ...(event.kind === 'agent_exited' && event.code != null ? { code: String(event.code) } : {}),
          });
          return;
      }
    };
    await runtime.observeBrokerEvents?.(signalFromBroker);
    // Key the handle by the registered agent name so `agent.status.becomes(...)`
    // predicates match the workspace events emitted for that agent.
    const handle = createAgentHandle({ id: runtime.agent.name, name: runtime.agent.name });
    return {
      ...handle,
      kind: 'pty',
      backend: 'pty',
      cli: definition.command,
      runtime: 'pty',
      model: input.model,
      task: input.task,
      args: input.args,
      channels: input.channels,
      cwd,
      env: input.env ?? definition.env,
      definition,
      observability: getPtyObservabilityProfile(definition.command),
    };
  };

  return {
    ...definition,
    name: definition.command,
    create: async (input = {}) => {
      if (input.backend === 'ai-sdk') {
        throw new Error(`No AI SDK harness adapter is registered for ${definition.command}`);
      }
      return input.relay ? spawnLive(input, input.relay) : build(input);
    },
    new: (input) => build(input),
  };
}

export function selectHarnessBackend(
  adapter: AiSdkAdapterRegistryEntry,
  requested: HarnessBackend = 'auto'
): SelectedHarnessBackend {
  if (requested === 'ai-sdk') return 'ai-sdk';
  if (requested === 'pty') {
    if (!adapter.ptyAvailable) throw new Error(`${adapter.name} does not provide a PTY backend`);
    return 'pty';
  }
  if (adapter.rollout === 'default') return 'ai-sdk';
  if (adapter.ptyAvailable) return 'pty';
  throw new Error(
    `${adapter.name} is an experimental AI SDK-only harness; select backend: 'ai-sdk' explicitly`
  );
}

/** Resolve a public harness name or alias to the backend the CLI should launch. */
export function resolveHarnessBackend(
  harness: string,
  requested: HarnessBackend = 'auto'
): SelectedHarnessBackend {
  const adapter = aiSdkAdapterRegistry.get(harness);
  if (!adapter) {
    if (requested === 'ai-sdk') {
      throw new Error(`No AI SDK harness adapter is registered for ${harness}`);
    }
    return 'pty';
  }
  return selectHarnessBackend(adapter, requested);
}

function nativeDescriptor(
  adapter: AiSdkAdapterRegistryEntry,
  input: HarnessCreateInput,
  name = nextHarnessName(adapter.name, input.name)
): NativeHarnessAgent {
  const handle = createAgentHandle({ id: `harness:${adapter.name}:${name}`, name });
  return {
    ...handle,
    kind: 'native',
    backend: 'ai-sdk',
    cli: adapter.name,
    runtime: 'native',
    adapter: adapter.name,
    model: input.model,
    task: input.task,
    args: input.args,
    channels: input.channels,
    cwd: input.cwd,
    env: input.env,
    observability: AI_SDK_REFERENCE_OBSERVABILITY_PROFILE,
  };
}

function publicNativeLifecycle(adapter: AiSdkAdapterRegistryEntry) {
  return {
    activeInput: adapter.lifecycle.activeInput,
    toolApprovals: adapter.lifecycle.toolApprovals,
    compact: adapter.lifecycle.compact,
    continueTurn: false,
    suspendTurn: false,
    detach: false,
    stop: false,
    destroy: false,
    stopPreservesConversation: false,
  };
}

function sessionEventFromAgentEventEnvelope(envelope: AgentEventEnvelope): AgentSessionEvent | undefined {
  const { kind, ...payload } = envelope.event;
  if (typeof kind !== 'string') return undefined;
  return { type: kind, ...payload } as AgentSessionEvent;
}

/**
 * Build the broker launch contract for an AI SDK-backed native harness.
 *
 * Keeping this as a public, side-effect-free resolver lets the CLI launch the
 * sidecar through an already-running broker instead of starting a second one.
 */
export function createNativeHarnessLaunch(
  adapterName: string,
  input: HarnessCreateInput = {},
  sidecarLaunch?: NativeHarnessSidecarLaunch
): SpawnRuntimeInput {
  const adapter = aiSdkAdapterRegistry.require(adapterName);
  const name = nextHarnessName(adapter.name, input.name);
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const sessionId = `native-${randomUUID()}`;
  const sidecarEntry = fileURLToPath(new URL('./ai-sdk/sidecar-main.js', import.meta.url));
  const sidecarConfig = {
    name,
    harness: adapter.name,
    workspace: cwd,
    sessionId,
    settings: { ...(input.model ? { model: input.model } : {}) },
  };
  return {
    name,
    cli: adapter.name,
    task: input.task,
    model: input.model,
    channels: input.channels,
    cwd,
    transport: 'headless',
    harnessConfig: {
      runtime: 'native',
      command: sidecarLaunch?.command ?? process.execPath,
      args: sidecarLaunch?.args ?? [sidecarEntry],
      cwd,
      env: {
        ...input.env,
        RELAY_AI_SDK_SIDECAR_CONFIG: JSON.stringify(sidecarConfig),
      },
      sessionId,
      metadata: {
        runtimeKind: 'native',
        nativeHarnessProtocolVersion: 1,
        // Only operations reachable through the versioned sidecar protocol are
        // public runtime capabilities. The adapter may support additional
        // in-process lifecycle methods that cannot safely cross this boundary.
        nativeHarnessCapabilities: publicNativeLifecycle(adapter),
        observability: AI_SDK_REFERENCE_OBSERVABILITY_PROFILE,
      },
    },
  };
}

async function spawnNative(
  adapter: AiSdkAdapterRegistryEntry,
  input: HarnessCreateInput,
  driver: AgentDriver,
  relay: AgentRelay
): Promise<NativeHarnessAgent> {
  const launch = createNativeHarnessLaunch(adapter.name, input);
  const runtime = await driver.spawn(launch);
  await runtime.observeAgentEvents?.(async (envelope) => {
    const event = sessionEventFromAgentEventEnvelope(envelope);
    if (event) relay.emitSessionEvent(runtime.agent.name, event);
  });
  const descriptor = nativeDescriptor(adapter, { ...input, cwd: launch.cwd }, runtime.agent.name);
  return { ...descriptor, id: runtime.agent.name };
}

/** Define a harness that can select between one official adapter and PTY. */
export function defineManagedHarness(
  adapterName: string,
  ptyDefinition: StaticPtyHarnessDefinition
): ManagedPtyHarness;
export function defineManagedHarness(adapterName: string): ManagedHarness;
export function defineManagedHarness(
  adapterName: string,
  ptyDefinition?: StaticPtyHarnessDefinition
): ManagedHarness {
  const adapter = aiSdkAdapterRegistry.require(adapterName);
  if (Boolean(ptyDefinition) !== adapter.ptyAvailable) {
    throw new Error(`PTY availability for ${adapter.name} does not match its registry declaration`);
  }
  const pty = ptyDefinition ? definePtyHarness(ptyDefinition) : undefined;

  const build = (input: HarnessCreateInput = {}): ManagedHarnessAgent => {
    const backend = selectHarnessBackend(adapter, input.backend);
    return backend === 'pty' ? pty!.new({ ...input, backend: 'pty' }) : nativeDescriptor(adapter, input);
  };

  return {
    runtime: ptyDefinition ? 'pty' : 'native',
    name: adapter.name,
    command: ptyDefinition?.command ?? adapter.name,
    adapter,
    create: async (input = {}) => {
      const backend = selectHarnessBackend(adapter, input.backend);
      if (backend === 'pty') return pty!.create({ ...input, backend: 'pty' });
      return input.relay
        ? spawnNative(adapter, input, getHarnessDriver(input.relay), input.relay)
        : nativeDescriptor(adapter, input);
    },
    new: build,
  };
}
