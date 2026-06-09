/**
 * Registry of all eval scenarios.
 *
 * `smoke` tier: leading prompts that name the tool — a plumbing canary.
 * `realistic` tier: natural-language prompts where the protocol must come from
 * the injected onboarding — the real benchmark (default).
 */
import type { EvalScenario, EvalTier } from '../types.js';
import { scenario as dmRoundtrip } from './01-dm-roundtrip.js';
import { scenario as channelReply } from './02-channel-reply.js';
import { scenario as ackDone } from './03-ack-done.js';
import { scenario as relayChain } from './04-relay-chain.js';
import { scenario as incidentalReport } from './r01-incidental-report.js';
import { scenario as forgetToReport } from './r02-forget-to-report.js';
import { scenario as proactiveHandoff } from './r03-proactive-handoff.js';
import { scenario as channelVsDm } from './r04-channel-vs-dm.js';

export const SCENARIOS: EvalScenario[] = [
  // smoke (plumbing canary)
  dmRoundtrip,
  channelReply,
  ackDone,
  relayChain,
  // realistic (benchmark)
  incidentalReport,
  forgetToReport,
  proactiveHandoff,
  channelVsDm,
];

/** Look up a scenario by id. */
export function scenarioById(id: string): EvalScenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/** All scenarios in a given tier. */
export function scenariosByTier(tier: EvalTier): EvalScenario[] {
  return SCENARIOS.filter((s) => s.tier === tier);
}
