import { RelayPlacementError, safeRelayErrorMessage, type RelayNode } from '@agent-relay/sdk';
import { shellQuote, withDeadline } from './agent-registration.js';
import { isNotFoundError } from './agent-removal.js';
import {
  heartbeatAgeMs,
  isAvailableFleetNode,
  MAX_LIVE_HEARTBEAT_AGE_MS,
  readRemoteLiveAgents,
} from './fleet-live-agents.js';

export interface SpawnLiveness {
  evidence: 'invocation_terminal' | 'live' | 'live_elsewhere' | 'stale' | 'registered' | 'absent' | 'unknown';
  node?: string;
  heartbeatAgeMs?: number | null;
  readError?: string;
  invocation?: Record<string, unknown>;
}

interface SpawnContext {
  invocationId?: string;
  node?: string;
  dispatchState?: string;
  receipt?: Record<string, unknown>;
}

export class FleetSpawnError extends Error {
  readonly state: 'pending' | 'failed';
  readonly exitCode: number;
  readonly invocationId?: string;
  readonly node?: string;
  readonly dispatchState?: string;
  readonly receipt?: Record<string, unknown>;
  constructor(
    readonly code: 'spawn_pending' | 'spawn_name_taken',
    message: string,
    context: SpawnContext,
    readonly liveness?: SpawnLiveness,
    readonly diagnostic?: string
  ) {
    super(message);
    this.state = code === 'spawn_pending' ? 'pending' : 'failed';
    this.exitCode = code === 'spawn_pending' ? 8 : 1;
    this.invocationId = context.invocationId;
    this.node = context.node;
    this.dispatchState = context.dispatchState;
    this.receipt = context.receipt;
  }
}

export function mayStillBeRunning(error: unknown): boolean {
  return (
    (error instanceof RelayPlacementError && error.state === 'unconfirmed_may_be_running') ||
    (error instanceof FleetSpawnError && error.code === 'spawn_pending')
  );
}

export function pendingSpawnError(
  name: string,
  context: SpawnContext,
  liveness: SpawnLiveness,
  diagnostic?: string
): FleetSpawnError {
  const nodeOption = context.node ? ` --node ${shellQuote(context.node)}` : '';
  return new FleetSpawnError(
    'spawn_pending',
    `Spawn of ${JSON.stringify(name)} was accepted; its outcome is pending. ` +
      `Evidence: ${liveness.evidence}${liveness.node ? ` on ${JSON.stringify(liveness.node)}` : ''}. ` +
      `Invocation: ${context.invocationId ?? 'unavailable'}; dispatch: ${context.dispatchState ?? 'unknown'}. ` +
      `Check \`agent-relay fleet agent list${nodeOption}\` before retrying. ` +
      `Only if no worker is running and you intend to reclaim the name, run \`agent-relay agent remove ${shellQuote(name)} --wait\` and wait for clearance before respawning.`,
    context,
    liveness,
    diagnostic
  );
}

export function classifySpawnFailure(message: string): 'spawn_name_taken' | undefined {
  // Anchored to the broker formatter; unrelated "already exists" failures are not registration collisions.
  return /(?:^|:\s)failed to pre-register worker '[^\n]+': agent '[^\n]+' already exists and registration is create-only(?:;|$)/i.test(
    message
  )
    ? 'spawn_name_taken'
    : undefined;
}

export function nameTakenSpawnError(name: string, error: Error & SpawnContext): FleetSpawnError {
  return new FleetSpawnError(
    'spawn_name_taken',
    `${safeRelayErrorMessage(error)} A removal or cleanup from a previous unsuccessful spawn may still be in flight. Re-check \`agent-relay agent list\`; if the name is present with no worker running, run \`agent-relay agent remove ${shellQuote(name)} --wait\`, wait for clearance, then retry.`,
    error
  );
}

/** Reads are bounded and client construction is fallible (agent-token-only callers are supported). */
export async function probeSpawnLiveness(options: {
  name: string;
  targetNode?: string;
  getInvocation?: () => Promise<unknown>;
  createClient: () => {
    nodes: { get: (name: string) => Promise<RelayNode | null>; list: () => Promise<RelayNode[]> };
    agents: { get: (name: string) => Promise<unknown> };
  };
  now?: () => number;
}): Promise<SpawnLiveness> {
  let readError: string | undefined;
  const read = <T>(fn: () => Promise<T>) =>
    withDeadline(fn, () => new Error('Spawn evidence read timed out.'), 2_000);
  if (options.getInvocation) {
    try {
      const value = await read(options.getInvocation);
      if (value && typeof value === 'object') {
        const invocation = value as Record<string, unknown>;
        if (
          /^(completed|succeeded|success|failed|error|cancelled|canceled|denied)$/i.test(
            String(invocation.status)
          )
        ) {
          return { evidence: 'invocation_terminal', invocation };
        }
      }
    } catch (error) {
      readError = safeRelayErrorMessage(error);
    }
  }
  try {
    const client = options.createClient();
    try {
      const target = options.targetNode ? await read(() => client.nodes.get(options.targetNode!)) : undefined;
      const nodes = options.targetNode && target ? [target] : await read(() => client.nodes.list());
      // Prefer the targeted read; consult the fleet only if it doesn't claim this name.
      if (
        options.targetNode &&
        target &&
        !readRemoteLiveAgents(target).agents.some((a) => a.name === options.name)
      ) {
        nodes.push(...(await read(() => client.nodes.list())));
      }
      let weaker: SpawnLiveness | undefined;
      for (const node of nodes) {
        if (
          !isAvailableFleetNode(node) ||
          !readRemoteLiveAgents(node).agents.some((agent) => agent.name === options.name)
        )
          continue;
        const age = heartbeatAgeMs(node, options.now?.() ?? Date.now());
        const evidence =
          age === null || age > MAX_LIVE_HEARTBEAT_AGE_MS
            ? 'stale'
            : options.targetNode && node.name !== options.targetNode
              ? 'live_elsewhere'
              : 'live';
        const result: SpawnLiveness = { evidence, node: node.name, heartbeatAgeMs: age };
        if (evidence === 'live') return result;
        weaker ??= result;
      }
      if (weaker) return weaker;
    } catch (error) {
      readError = safeRelayErrorMessage(error);
    }
    try {
      await read(() => client.agents.get(options.name));
      return { evidence: 'registered', ...(readError ? { readError } : {}) };
    } catch (error) {
      if (isNotFoundError(error)) return { evidence: 'absent', ...(readError ? { readError } : {}) };
      readError = safeRelayErrorMessage(error);
    }
  } catch (error) {
    readError = safeRelayErrorMessage(error);
  }
  return { evidence: 'unknown', readError };
}

/** Preserve the original request's launch/readiness contract on the final invocation read. */
export function terminalSpawnOutcome(
  invocation: Record<string, unknown>,
  context: SpawnContext,
  requireReady: boolean
): Record<string, unknown> {
  const output = invocation.output as Record<string, unknown> | undefined;
  if (
    !/^(completed|succeeded|success)$/i.test(String(invocation.status)) ||
    output?.spawned !== true ||
    typeof output.ready !== 'boolean' ||
    (requireReady && output.ready !== true)
  ) {
    throw new RelayPlacementError(
      'spawn_failed',
      typeof invocation.error === 'string'
        ? invocation.error
        : 'Spawn completed without the requested launch/readiness proof.',
      {
        capability: 'spawn',
        attempts: 1,
        state: 'failed',
        invocationId: context.invocationId,
        node: context.node,
        dispatchState: context.dispatchState as 'dispatched' | 'not_dispatched' | 'unknown',
        receipt: invocation,
      }
    );
  }
  return {
    ...invocation,
    placement: {
      state: output.ready ? 'ready' : 'accepted',
      confirmed: true,
      invocationId: context.invocationId,
      dispatchState: context.dispatchState,
    },
  };
}
