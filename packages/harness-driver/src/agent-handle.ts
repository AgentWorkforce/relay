/**
 * Lifecycle-aware handle for a spawned agent.
 *
 * `HarnessDriverClient.spawnPty()` / `spawnCli()` / `spawnHeadless()` return one
 * of these instead of a bare {@link SpawnAgentResult}. It is a structural
 * superset of `SpawnAgentResult` (it still carries `name` / `runtime` /
 * `sessionId` / `pid`), so existing callers are unaffected, and it adds the
 * promise-based lifecycle operations consumers previously had to reconstruct
 * from the raw broker event stream:
 *
 *   - `waitForExit()` — resolve when the agent exits, with `code` / `signal`.
 *   - `waitForIdle()` — resolve on the next idle signal (or on exit).
 *   - `exit` / `exitCode` / `exitSignal` — synchronous view of a prior exit.
 *   - `release()` — release the agent via the broker.
 *
 * All operations are backed by the client's broker event stream and its event
 * history, so they are replay-correct: calling `waitForExit()` after the agent
 * has already exited resolves immediately from history rather than hanging.
 */
import type { HarnessDriverClient } from './client.js';
import type { AgentRuntime, BrokerEvent } from './protocol.js';
import type { SpawnAgentResult } from './types.js';

export interface AgentExitInfo {
  /** `'exited'` when the agent exited; `'timeout'` when the wait elapsed first. */
  reason: 'exited' | 'timeout';
  /** Process exit code, when the broker reported one. */
  code?: number;
  /** Terminating signal, when the agent was killed by one. */
  signal?: string;
}

export interface AgentIdleInfo {
  /** `'idle'` on an idle signal, `'exited'` if the agent exited first, `'timeout'` otherwise. */
  reason: 'idle' | 'exited' | 'timeout';
  /** Seconds the agent has been idle, when `reason === 'idle'`. */
  idleSecs?: number;
  /** Exit details, when `reason === 'exited'`. */
  exit?: AgentExitInfo;
}

export class SpawnedAgentHandle implements SpawnAgentResult {
  readonly name: string;
  readonly runtime: AgentRuntime;
  readonly sessionId?: string;
  readonly pid?: number;

  constructor(
    result: SpawnAgentResult,
    private readonly client: HarnessDriverClient
  ) {
    this.name = result.name;
    this.runtime = result.runtime;
    this.sessionId = result.sessionId;
    this.pid = result.pid;
  }

  /** Exit info if the agent has already exited (from broker event history), else `undefined`. */
  get exit(): AgentExitInfo | undefined {
    const exited = this.client.getLastEvent('agent_exited', this.name);
    if (exited && exited.kind === 'agent_exited') {
      return { reason: 'exited', code: exited.code, signal: exited.signal };
    }
    const exit = this.client.getLastEvent('agent_exit', this.name);
    if (exit && exit.kind === 'agent_exit') {
      return { reason: 'exited' };
    }
    return undefined;
  }

  get exitCode(): number | undefined {
    return this.exit?.code;
  }

  get exitSignal(): string | undefined {
    return this.exit?.signal;
  }

  /**
   * Resolve when the agent exits (with `code` / `signal` when the broker reports
   * them), or with `{ reason: 'timeout' }` if `timeoutMs` elapses first. Replays
   * a prior exit from broker history, so it is safe to call after the fact.
   */
  waitForExit(timeoutMs?: number): Promise<AgentExitInfo> {
    const already = this.exit;
    if (already) return Promise.resolve(already);

    return new Promise<AgentExitInfo>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (info: AgentExitInfo) => {
        if (timer) clearTimeout(timer);
        unsub();
        resolve(info);
      };
      const unsub = this.client.onEvent((event: BrokerEvent) => {
        const exit = matchExit(event, this.name);
        if (exit) settle(exit);
      });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => settle({ reason: 'timeout' }), timeoutMs);
      }
    });
  }

  /**
   * Resolve on the next idle signal for this agent (edge-triggered: a fresh
   * signal after the call, matching how runners poll-then-nudge). Also resolves
   * if the agent exits first, or with `{ reason: 'timeout' }` after `timeoutMs`.
   */
  waitForIdle(timeoutMs?: number): Promise<AgentIdleInfo> {
    const already = this.exit;
    if (already) return Promise.resolve({ reason: 'exited', exit: already });

    return new Promise<AgentIdleInfo>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (info: AgentIdleInfo) => {
        if (timer) clearTimeout(timer);
        unsubIdle();
        unsubExit();
        resolve(info);
      };
      const unsubIdle = this.client.addListener('agentIdle', (payload) => {
        if (payload.name === this.name) settle({ reason: 'idle', idleSecs: payload.idleSecs });
      });
      const unsubExit = this.client.onEvent((event: BrokerEvent) => {
        const exit = matchExit(event, this.name);
        if (exit) settle({ reason: 'exited', exit });
      });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => settle({ reason: 'timeout' }), timeoutMs);
      }
    });
  }

  /** Release the agent via the broker. */
  release(reason?: string): Promise<{ name: string }> {
    return this.client.release(this.name, reason);
  }
}

/** Match an exit `BrokerEvent` for `name`, normalising the two exit kinds. */
function matchExit(event: BrokerEvent, name: string): AgentExitInfo | undefined {
  if (event.kind === 'agent_exited' && event.name === name) {
    return { reason: 'exited', code: event.code, signal: event.signal };
  }
  if (event.kind === 'agent_exit' && event.name === name) {
    return { reason: 'exited' };
  }
  return undefined;
}
