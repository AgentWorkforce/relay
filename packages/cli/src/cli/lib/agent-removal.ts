import { RelayError, safeRelayErrorMessage } from '@agent-relay/sdk';
import { normalizeTimeoutMs, shellQuote, withDeadline } from './agent-registration.js';

export const DEFAULT_REMOVAL_WAIT_TIMEOUT_MS = 30_000;
export const REMOVAL_POLL_INTERVAL_MS = 500;

export function isNotFoundError(error: unknown): boolean {
  if (error instanceof RelayError) return error.code === 'not_found' || error.statusCode === 404;
  const status =
    error && typeof error === 'object'
      ? ((error as { statusCode?: unknown }).statusCode ?? (error as { status?: unknown }).status)
      : undefined;
  return Number(status) === 404;
}

export interface RemovalResult {
  cleared: boolean;
  waitedMs: number;
  observedPresent: boolean;
  readError?: string;
}

export class AgentRemovalPendingError extends Error {
  readonly exitCode = 8;
  constructor(name: string) {
    super(
      `Removal of agent ${JSON.stringify(name)} was accepted, but its registration is still present. Re-check \`agent-relay agent list\` or run \`agent-relay agent remove ${shellQuote(name)} --wait\` before respawning.`
    );
  }
}

export async function waitForAgentRemoval(options: {
  name: string;
  getAgent: (name: string) => Promise<unknown>;
  listAgents: () => Promise<Array<{ name: string }>>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<RemovalResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  const budget = normalizeTimeoutMs(options.timeoutMs ?? DEFAULT_REMOVAL_WAIT_TIMEOUT_MS);
  const deadline = started + budget;
  let observedPresent = false;
  let readError: string | undefined;
  const result = (cleared: boolean): RemovalResult => ({
    cleared,
    waitedMs: now() - started,
    observedPresent,
    ...(readError ? { readError } : {}),
  });
  // Reserve one bounded read for membership corroboration at the deadline.
  // A released/offline status still owns the name and is never clearance.
  const read = <T>(fn: () => Promise<T>, ms: number) =>
    withDeadline(fn, () => new Error('Removal verification read timed out.'), ms);
  while (now() < deadline) {
    try {
      await read(() => options.getAgent(options.name), Math.max(1, deadline - now()));
      observedPresent = true;
      readError = undefined;
    } catch (error) {
      if (isNotFoundError(error)) return result(true);
      readError = safeRelayErrorMessage(error);
    }
    const remaining = deadline - now();
    if (remaining > 0)
      await sleep(
        Math.min(normalizeTimeoutMs(options.pollIntervalMs ?? REMOVAL_POLL_INTERVAL_MS), remaining)
      );
  }
  try {
    const agents = await read(options.listAgents, Math.min(1_000, budget));
    if (!agents.some((agent) => agent.name === options.name)) return result(true);
    observedPresent = true;
  } catch (error) {
    readError = safeRelayErrorMessage(error);
  }
  return result(false);
}
