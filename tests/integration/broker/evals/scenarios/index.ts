/**
 * Registry of all eval scenarios.
 *
 * `smoke` tier: leading prompts that name the tool — a plumbing canary.
 * `realistic` tier: natural-language prompts where the protocol must come from
 * the injected onboarding — the real benchmark (default).
 * `lifecycle` group: spawn/release reliability scenarios across onboarding variants.
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
import { scenario as threadReply } from './t01-thread-reply.js';
import { scenario as checkInbox } from './r05-check-inbox.js';
import { scenario as groupDm } from './r06-group-dm.js';
import { scenario as listAgents } from './r07-list-agents.js';
import { SPAWN_SCENARIOS } from './s01-spawn-worker.js';
import { RELEASE_SCENARIOS } from './s02-release-worker.js';
import { LIFECYCLE_SCENARIOS } from './s03-spawn-release-lifecycle.js';
import { NO_NATIVE_SUBAGENT_SCENARIOS } from './s04-no-native-subagents.js';
import { PHRASING_SCENARIOS } from './s05-phrasing-variants.js';
import { AUTO_ROUTING_SCENARIOS } from './s06-auto-routing.js';
import { LEAD_DELEGATION_SCENARIOS } from './s07-lead-delegation.js';
import { LEAD_QUALITY_SCENARIOS } from './s08-lead-quality.js';
import { CROSS_CLI_SPAWN_SCENARIOS } from './s09-cross-cli-spawn.js';

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
  threadReply,
  checkInbox,
  groupDm,
  listAgents,
];

/** Spawn/release reliability scenarios — run with --group=lifecycle. */
export const LIFECYCLE_EVAL_SCENARIOS: EvalScenario[] = [
  ...SPAWN_SCENARIOS,
  ...RELEASE_SCENARIOS,
  ...LIFECYCLE_SCENARIOS,
  ...NO_NATIVE_SUBAGENT_SCENARIOS,
];

/** Lead delegation discipline scenarios — run with --group=lead-delegation. */
export const LEAD_DELEGATION_EVAL_SCENARIOS: EvalScenario[] = [...LEAD_DELEGATION_SCENARIOS];

/** Lead coordination quality scenarios — run with --group=lead-quality. */
export const LEAD_QUALITY_EVAL_SCENARIOS: EvalScenario[] = [...LEAD_QUALITY_SCENARIOS];

/** Cross-CLI spawn and model-tier pinning scenarios — run with --group=cross-cli-spawn. */
export const CROSS_CLI_SPAWN_EVAL_SCENARIOS: EvalScenario[] = [...CROSS_CLI_SPAWN_SCENARIOS];

/** Phrasing-variant scenarios — run with --group=phrasing. */
export const PHRASING_EVAL_SCENARIOS: EvalScenario[] = [...PHRASING_SCENARIOS];

/** Auto-routing Director scenarios — run with --group=auto-routing. */
export const AUTO_ROUTING_EVAL_SCENARIOS: EvalScenario[] = [...AUTO_ROUTING_SCENARIOS];

/** All scenarios including lifecycle and phrasing. */
export const ALL_SCENARIOS: EvalScenario[] = [
  ...SCENARIOS,
  ...LIFECYCLE_EVAL_SCENARIOS,
  ...PHRASING_EVAL_SCENARIOS,
  ...AUTO_ROUTING_EVAL_SCENARIOS,
  ...LEAD_DELEGATION_EVAL_SCENARIOS,
  ...LEAD_QUALITY_EVAL_SCENARIOS,
  ...CROSS_CLI_SPAWN_EVAL_SCENARIOS,
];

/** Look up a scenario by id (searches all scenario registries). */
export function scenarioById(id: string): EvalScenario | undefined {
  return ALL_SCENARIOS.find((s) => s.id === id);
}

/** All messaging scenarios in a given tier. */
export function scenariosByTier(tier: EvalTier): EvalScenario[] {
  return SCENARIOS.filter((s) => s.tier === tier);
}
