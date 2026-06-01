import { createAgentHandle, type RelayAgentHandle } from '@agent-relay/sdk';
import type { StaticPtyHarnessDefinition } from '@agent-relay/harness-driver';

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
}

/**
 * An agent produced by a harness factory. Carries the identity and predicate
 * builders used with `relay.on(...)`, plus the resolved spawn details the
 * runtime needs to actually launch the process.
 */
export interface HarnessAgent extends RelayAgentHandle {
  cli: string;
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
 * (so the runtime can resolve it) while adding `create`/`new` factories that
 * produce ready-to-register {@link HarnessAgent}s.
 */
export interface PtyHarness extends StaticPtyHarnessDefinition {
  readonly name: string;
  create(input?: HarnessCreateInput): Promise<HarnessAgent>;
  /** Synchronous variant of {@link PtyHarness.create}. */
  new: (input?: HarnessCreateInput) => HarnessAgent;
}

const counters = new Map<string, number>();

function nextName(command: string, explicit?: string): string {
  if (explicit) return explicit;
  const n = (counters.get(command) ?? 0) + 1;
  counters.set(command, n);
  return n === 1 ? command : `${command}-${n}`;
}

/** Wrap a static PTY harness definition in a factory with `create`/`new`. */
export function definePtyHarness(definition: StaticPtyHarnessDefinition): PtyHarness {
  const build = (input: HarnessCreateInput = {}): HarnessAgent => {
    const name = nextName(definition.command, input.name);
    const handle = createAgentHandle({ id: `harness:${definition.command}:${name}`, name });
    return {
      ...handle,
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

  return {
    ...definition,
    name: definition.command,
    create: async (input) => build(input),
    new: (input) => build(input),
  };
}
