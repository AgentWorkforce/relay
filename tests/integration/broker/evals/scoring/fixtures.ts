/**
 * Synthetic BrokerEvent builders for scorer unit tests.
 */
import type { BrokerEvent } from '@agent-relay/harness-driver';

let counter = 0;

/** A worker_stream chunk emitted by an agent. */
export function stream(name: string, chunk: string): BrokerEvent {
  return { kind: 'worker_stream', name, stream: 'stdout', chunk };
}

/** A relay_inbound event = an agent actually sent a message. */
export function inbound(from: string, target: string, body = ''): BrokerEvent {
  counter += 1;
  return { kind: 'relay_inbound', event_id: `evt-${counter}`, from, target, body };
}

/** A delivery_dropped event. */
export function dropped(name: string, reason = 'test'): BrokerEvent {
  return { kind: 'delivery_dropped', name, count: 1, reason };
}
