/**
 * BrokerHarness type surface for @agent-relay/evals.
 *
 * The full BrokerHarness class implementation lives in
 * tests/integration/broker/utils/broker-harness.ts pending migration into
 * this package (see specs/agent-relay-evals-package.md). This module exports
 * the interface that eval scenarios depend on so downstream consumers can
 * type-check against it without importing the test-only implementation.
 */
import type {
  BrokerEvent,
  ListAgent,
  RuntimeSpawnOptions,
  SendMessageInput,
} from '@agent-relay/harness-driver';

export interface EventWaiter {
  promise: Promise<BrokerEvent>;
  cancel: () => void;
}

export interface BrokerHarness {
  spawnAgent(
    name: string,
    cli: string,
    channels: string[],
    options?: Partial<RuntimeSpawnOptions>
  ): Promise<{ name: string }>;

  releaseAgent(name: string): Promise<{ name: string }>;

  sendMessage(input: SendMessageInput): Promise<{ event_id: string; targets: string[] }>;

  listAgents(): Promise<ListAgent[]>;

  getEvents(): BrokerEvent[];

  clearEvents(): void;

  waitForEvent(
    kind: string,
    timeoutMs?: number,
    predicate?: (event: BrokerEvent) => boolean
  ): EventWaiter;
}
