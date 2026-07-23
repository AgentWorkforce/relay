/**
 * Strip terminal control sequences from raw PTY output so the phantom-message
 * detector matches on readable text.
 *
 * Agent CLIs emit ANSI SGR colour codes, OSC title/hyperlink sequences, and
 * private-mode (`?`) cursor/screen toggles interleaved with their prose. The
 * same regex set is used by the broker integration tests to assert on agent
 * output; centralising it here keeps the detector and those tests in sync.
 */
import type { BrokerEvent } from '@agent-relay/harness-driver';

import { eventsForAgent } from '../../utils/assert-helpers.js';

/** Matches CSI sequences, OSC sequences, and private-mode toggles. */
const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\[[?][0-9]*[a-z]/g;

/** Remove ANSI/OSC control sequences from a string. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, '');
}

/** Concatenate all `worker_stream` chunks emitted by an agent. */
export function collectStreamOutput(events: BrokerEvent[], agentName: string): string {
  const streams = eventsForAgent(events, agentName, 'worker_stream');
  return streams.map((ev) => (ev as BrokerEvent & { chunk: string }).chunk).join('');
}

/** Convenience: collect + strip an agent's raw output into clean text. */
export function cleanStreamOutput(events: BrokerEvent[], agentName: string): string {
  return stripAnsi(collectStreamOutput(events, agentName));
}
