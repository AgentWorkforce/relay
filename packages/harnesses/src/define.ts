import {
  createAgentHandle,
  nextHarnessName,
  type AgentRelay,
  type HarnessFactory,
  type RelayHarnessAgent,
} from '@agent-relay/sdk';
import type { StaticPtyHarnessDefinition } from '@agent-relay/harness-driver';

import { getHarnessDriver } from './broker-binding.js';

/** Options accepted when creating an agent from a harness. */
export interface HarnessCreateInput {
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
}

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
      cli: definition.command,
      runtime: 'pty',
      model: input.model,
      task: input.task,
      args: input.args,
      channels: input.channels,
      cwd: input.cwd ?? definition.cwd,
      env: input.env ?? definition.env,
      definition,
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
    // Key the handle by the registered agent name so `agent.status.becomes(...)`
    // predicates match the workspace events emitted for that agent.
    const handle = createAgentHandle({ id: runtime.agent.name, name: runtime.agent.name });
    return {
      ...handle,
      kind: 'pty',
      cli: definition.command,
      runtime: 'pty',
      model: input.model,
      task: input.task,
      args: input.args,
      channels: input.channels,
      cwd,
      env: input.env ?? definition.env,
      definition,
    };
  };

  return {
    ...definition,
    name: definition.command,
    create: async (input = {}) => (input.relay ? spawnLive(input, input.relay) : build(input)),
    new: (input) => build(input),
  };
}
