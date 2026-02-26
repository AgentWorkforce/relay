/**
 * Broker test harness — manages lifecycle of the agent-relay-broker binary
 * for integration tests.
 *
 * Provides helpers to start/stop the broker, spawn/release agents,
 * send messages, and wait for specific broker events.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  AgentRelayClient,
  type AgentRelayClientOptions,
  type ListAgent,
  type SendMessageInput,
  type BrokerEvent,
  AgentRelay,
  RelaycastApi,
} from '@agent-relay/sdk';

// ── Dynamic API key provisioning ─────────────────────────────────────────────

let _cachedApiKey: string | undefined;

/**
 * Ensure RELAY_API_KEY is available, creating an ephemeral workspace if needed.
 * Caches the key for the lifetime of the process.
 */
export async function ensureApiKey(): Promise<string> {
  if (_cachedApiKey) return _cachedApiKey;
  if (process.env.RELAY_API_KEY?.trim()) {
    _cachedApiKey = process.env.RELAY_API_KEY.trim();
    return _cachedApiKey;
  }
  const ws = await RelaycastApi.createWorkspace(`test-${Date.now().toString(36)}`);
  _cachedApiKey = ws.apiKey;
  process.env.RELAY_API_KEY = ws.apiKey;
  return _cachedApiKey;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface BrokerHarnessOptions {
  /** Path to the agent-relay-broker binary. Auto-resolved if not set. */
  binaryPath?: string;
  /** Unique broker name registered in Relaycast. Auto-generated if not set. */
  brokerName?: string;
  /** Channels for the broker to subscribe to. Default: ["general"] */
  channels?: string[];
  /** Request timeout in ms. Default: 10_000 */
  requestTimeoutMs?: number;
  /** Shutdown timeout in ms. Default: 3_000 */
  shutdownTimeoutMs?: number;
  /** Extra env vars to pass to the broker process. */
  env?: NodeJS.ProcessEnv;
}

export interface EventWaiter {
  /** Resolves when a matching event arrives. Rejects on timeout. */
  promise: Promise<BrokerEvent>;
  /** Cancel this waiter (resolve with undefined). */
  cancel(): void;
}

// ── Harness ──────────────────────────────────────────────────────────────────

export class BrokerHarness {
  /** High-level facade — use for spawning agents, sending messages. */
  relay!: AgentRelay;
  /** Low-level client — use for protocol-level tests. */
  client!: AgentRelayClient;

  private readonly opts: Required<BrokerHarnessOptions>;
  private events: BrokerEvent[] = [];
  private eventListeners: Array<(event: BrokerEvent) => void> = [];
  private unsubEvent?: () => void;
  private started = false;

  constructor(options: BrokerHarnessOptions = {}) {
    this.opts = {
      binaryPath: options.binaryPath ?? resolveBinaryPath(),
      brokerName:
        options.brokerName ??
        `test-harness-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      channels: options.channels ?? ['general'],
      requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 3_000,
      env: options.env ?? process.env,
    };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Start the broker process, wait for hello_ack.
   * Creates both a low-level client and a high-level facade.
   */
  async start(): Promise<void> {
    if (this.started) return;

    // Ensure we have an API key (creates ephemeral workspace if needed)
    const apiKey = await ensureApiKey();
    this.opts.env = { ...this.opts.env, RELAY_API_KEY: apiKey };

    const clientOpts: AgentRelayClientOptions = {
      binaryPath: this.opts.binaryPath,
      brokerName: this.opts.brokerName,
      channels: this.opts.channels,
      requestTimeoutMs: this.opts.requestTimeoutMs,
      shutdownTimeoutMs: this.opts.shutdownTimeoutMs,
      env: this.opts.env,
    };

    // Start the low-level client (spawns broker process)
    this.client = await AgentRelayClient.start(clientOpts);

    // Wire event collection
    this.unsubEvent = this.client.onEvent((event: BrokerEvent) => {
      this.events.push(event);
      for (const listener of this.eventListeners) {
        listener(event);
      }
    });

    // Create a high-level facade sharing the same binary/options
    this.relay = new AgentRelay({
      binaryPath: this.opts.binaryPath,
      brokerName: this.opts.brokerName,
      channels: this.opts.channels,
      requestTimeoutMs: this.opts.requestTimeoutMs,
      shutdownTimeoutMs: this.opts.shutdownTimeoutMs,
      env: this.opts.env,
    });

    this.started = true;
  }

  /**
   * Gracefully shut down the broker. Safe to call multiple times.
   */
  async stop(): Promise<void> {
    if (!this.started) return;

    this.unsubEvent?.();
    this.unsubEvent = undefined;
    this.eventListeners = [];

    // Shut down the facade first (it has its own client)
    try {
      await this.relay.shutdown();
    } catch {
      // Ignore — may already be down
    }

    // Shut down the low-level client
    try {
      await this.client.shutdown();
    } catch {
      // Ignore — may already be down
    }

    this.started = false;
  }

  // ── Agent management ─────────────────────────────────────────────────────

  /**
   * Spawn a PTY agent via the low-level client.
   * Uses `cat` as default CLI (no-op, lightweight).
   */
  async spawnAgent(
    name: string,
    cli = 'cat',
    channels?: string[],
    options?: { task?: string; continueFrom?: string }
  ): Promise<{ name: string; runtime: string }> {
    return this.client.spawnPty({
      name,
      cli,
      channels: channels ?? ['general'],
      task: options?.task,
      continueFrom: options?.continueFrom,
    });
  }

  /**
   * Release an agent by name via the low-level client.
   */
  async releaseAgent(name: string): Promise<{ name: string }> {
    return this.client.release(name);
  }

  /**
   * List all agents currently registered with the broker.
   */
  async listAgents(): Promise<ListAgent[]> {
    return this.client.listAgents();
  }

  // ── Messaging ────────────────────────────────────────────────────────────

  /**
   * Send a message between agents via the low-level client.
   */
  async sendMessage(input: SendMessageInput): Promise<{ event_id: string; targets: string[] }> {
    return this.client.sendMessage(input);
  }

  // ── Event utilities ──────────────────────────────────────────────────────

  /**
   * Return all events captured since broker start (or last clearEvents call).
   */
  getEvents(): BrokerEvent[] {
    return [...this.events];
  }

  /**
   * Return events filtered by kind.
   */
  getEventsByKind(kind: string): BrokerEvent[] {
    return this.events.filter((e) => e.kind === kind);
  }

  /**
   * Clear the captured events buffer.
   */
  clearEvents(): void {
    this.events = [];
  }

  /**
   * Wait for a specific broker event kind, with timeout.
   *
   * If a matching event is already in the buffer, resolves immediately.
   * Otherwise listens for new events.
   */
  waitForEvent(kind: string, timeoutMs = 5_000, predicate?: (event: BrokerEvent) => boolean): EventWaiter {
    let cancel: () => void = () => {};

    const promise = new Promise<BrokerEvent>((resolve, reject) => {
      // Check buffer first
      const existing = this.events.find((e) => e.kind === kind && (!predicate || predicate(e)));
      if (existing) {
        resolve(existing);
        return;
      }

      // eslint-disable-next-line prefer-const
      let timer: ReturnType<typeof setTimeout>;
      let settled = false;

      const listener = (event: BrokerEvent) => {
        if (settled) return;
        if (event.kind === kind && (!predicate || predicate(event))) {
          settled = true;
          clearTimeout(timer);
          removeListener();
          resolve(event);
        }
      };

      const removeListener = () => {
        const idx = this.eventListeners.indexOf(listener);
        if (idx !== -1) this.eventListeners.splice(idx, 1);
      };

      this.eventListeners.push(listener);

      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        removeListener();
        reject(new Error(`Timed out waiting for event "${kind}" after ${timeoutMs}ms`));
      }, timeoutMs);

      cancel = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        removeListener();
        // Resolve with a synthetic "cancelled" — callers should use .promise
        reject(new Error('Waiter cancelled'));
      };
    });

    return { promise, cancel };
  }

  /**
   * Collect all events that arrive within the given duration.
   */
  async collectEvents(durationMs: number): Promise<BrokerEvent[]> {
    const collected: BrokerEvent[] = [];
    const listener = (event: BrokerEvent) => collected.push(event);
    this.eventListeners.push(listener);

    await new Promise((resolve) => setTimeout(resolve, durationMs));

    const idx = this.eventListeners.indexOf(listener);
    if (idx !== -1) this.eventListeners.splice(idx, 1);

    return collected;
  }

  /**
   * Subscribe to events. Returns an unsubscribe function.
   */
  onEvent(listener: (event: BrokerEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      const idx = this.eventListeners.indexOf(listener);
      if (idx !== -1) this.eventListeners.splice(idx, 1);
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function resolveBinaryPath(): string {
  if (process.env.AGENT_RELAY_BIN) {
    return process.env.AGENT_RELAY_BIN;
  }
  // Resolve relative to this file → repo root/target/debug/agent-relay-broker
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');
  return path.resolve(repoRoot, 'target/debug/agent-relay-broker');
}

/**
 * Check if the relay binary exists.
 * Returns a skip reason string if prerequisites are missing, or null if OK.
 * Note: RELAY_API_KEY is no longer checked here — ensureApiKey() creates one
 * dynamically if not set.
 */
export function checkPrerequisites(): string | null {
  const bin = process.env.AGENT_RELAY_BIN ?? resolveBinaryPath();
  if (!fs.existsSync(bin)) {
    return `agent-relay-broker binary not found at ${bin}`;
  }
  return null;
}

/**
 * Generate a unique name suffix for test isolation.
 */
export function uniqueSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
