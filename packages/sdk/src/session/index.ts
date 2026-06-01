export * from './types.js';

import { createAgentHandle, type RelayAgentHandle } from '../listeners.js';
import type { AgentIdentity, AgentIdentityInput, HarnessConfig } from './types.js';

/**
 * Common shape of any agent produced by a harness factory: a {@link RelayAgentHandle}
 * (so `relay.on(agent.status.becomes(...))` works) tagged with the `kind` of factory
 * that built it (e.g. `'session'`, or `'pty'` from `@agent-relay/harnesses`).
 */
export interface RelayHarnessAgent extends RelayAgentHandle {
  kind: string;
}

/**
 * A harness factory: `create`/`new` produce a registerable {@link RelayHarnessAgent}.
 * The in-process session harnesses below and the PTY harnesses in
 * `@agent-relay/harnesses` share this shape.
 */
export interface HarnessFactory<TInput, TAgent extends RelayHarnessAgent> {
  readonly name: string;
  create(input?: TInput): Promise<TAgent>;
  /** Synchronous variant of {@link HarnessFactory.create}. */
  new: (input?: TInput) => TAgent;
}

const counters = new Map<string, number>();

/**
 * Generate the next default agent name for a harness `base` (e.g. `task-bot`,
 * `task-bot-2`, …), or return `explicit` unchanged when provided. Shared by all
 * harness factories so names stay unique.
 */
export function nextHarnessName(base: string, explicit?: string): string {
  if (explicit) return explicit;
  const n = (counters.get(base) ?? 0) + 1;
  counters.set(base, n);
  return n === 1 ? base : `${base}-${n}`;
}

/**
 * A ready-to-register agent produced by a {@link SessionHarness} factory. Carries
 * the identity and predicate builders used with `relay.on(...)`, plus the harness
 * `config` and `input` a runtime needs to bring the live {@link AgentSession} online
 * later.
 */
export interface SessionHarnessAgent<TInput = void> extends RelayHarnessAgent {
  kind: 'session';
  input: TInput;
  config: HarnessConfig<TInput>;
}

/**
 * A harness factory built from a {@link HarnessConfig}. `create`/`new` produce a
 * registerable {@link SessionHarnessAgent} so a custom in-process harness can be
 * registered and observed without installing a runtime/driver — only
 * `@agent-relay/sdk`. The adapter, including its `create(input, ctx)` session
 * factory, stays available on `config`.
 */
export interface SessionHarness<TInput = void>
  extends HarnessFactory<TInput, SessionHarnessAgent<TInput>> {
  readonly config: HarnessConfig<TInput>;
}

function explicitName<TInput>(input: TInput | undefined): string | undefined {
  return input && typeof input === 'object' ? (input as { name?: string }).name : undefined;
}

/**
 * Wrap a {@link HarnessConfig} in a factory with `create`/`new`. The returned
 * factory produces registerable {@link SessionHarnessAgent}s while keeping the
 * adapter reachable via `config` for runtimes that bring the session online.
 */
export function defineHarness<TInput = void>(config: HarnessConfig<TInput>): SessionHarness<TInput> {
  const build = (input?: TInput): SessionHarnessAgent<TInput> => {
    const name = nextHarnessName(config.name, explicitName(input));
    const handle = createAgentHandle({ id: `harness:${config.name}:${name}`, name });
    return { ...handle, kind: 'session', input: input as TInput, config };
  };

  return {
    name: config.name,
    config,
    create: async (input) => build(input),
    new: (input) => build(input),
  };
}

export function normalizeAgentIdentity(input: AgentIdentityInput): AgentIdentity {
  const handle = input.handle ?? formatAgentHandle(input.name);
  return {
    id: input.id ?? handle,
    name: input.name,
    handle,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

export function formatAgentHandle(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '@agent';
  return trimmed.startsWith('@') ? trimmed : `@${trimmed.replace(/\s+/g, '-')}`;
}
