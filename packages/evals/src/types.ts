/**
 * Type definitions for the agent messaging eval harness.
 *
 * The eval suite spawns real agent CLIs, drives them through coordination
 * scenarios, and scores — purely from broker events — whether agents actually
 * used the messaging tools (MCP/CLI) versus emitting plain-text "phantom"
 * messages.
 */
import type { BrokerHarness } from './harness.js';

/** Context handed to each scenario's `run` function. */
export interface ScenarioContext {
  /** A started broker harness. The scenario owns its agents but not the harness lifecycle. */
  harness: BrokerHarness;
  /** The CLI/harness under test (e.g. "claude", "codex", "opencode"). */
  cli: string;
  /** Optional model override to pass to the agent CLI (e.g. "claude-haiku-4-5-20251001"). */
  model?: string;
  /** Unique suffix for isolating agent/channel names across runs. */
  suffix: string;
  /** Sleep helper. */
  sleep: (ms: number) => Promise<void>;
}

/**
 * A single phantom message: forward-looking intent to communicate expressed in
 * plain text that was never backed by an actual `relay_inbound` send.
 */
export interface Phantom {
  /** The agent that expressed the intent. */
  agent: string;
  /** The matched verb (e.g. "tell", "post", "send"). */
  verb: string;
  /** The parsed target, if the regex captured one (e.g. "Lead"). */
  target?: string;
  /** A short snippet of surrounding text for debugging. */
  snippet: string;
}

/** An agent under test in a scenario, with the task prompt it was given. */
export interface AgentInfo {
  name: string;
  cli: string;
  /** Optional role label (e.g. "relay hop A"). */
  role?: string;
  /** The task prompt the agent was spawned with. */
  prompt: string;
}

/** One message in a scenario's conversation, derived from a relay_inbound event. */
export interface TranscriptEntry {
  from: string;
  target: string;
  body: string;
  /** True if `from` is one of the scenario's agents under test (a real send). */
  fromAgent: boolean;
  threadId?: string;
}

/** Raw, scenario-specific signal counts derived from the event stream. */
export interface ScenarioResult {
  id: string;
  title: string;
  /** Overall pass/fail for this scenario. */
  pass: boolean;
  /** Agents under test and the prompts they were given. */
  agents: AgentInfo[];
  /** The full message transcript (stimulus + agent sends), in order. */
  transcript: TranscriptEntry[];
  /** Number of messages the agent(s) actually sent (relay_inbound). */
  sent: number;
  /** Number of sends the scenario expected. */
  expected: number;
  /** Phantom messages detected (intent without a backing send). */
  phantoms: Phantom[];
  /** Total forward-looking intents detected (satisfied + phantom). */
  totalIntents: number;
  /** Protocol adherence score in [0,1], or null if not applicable. */
  protocolAdherence: number | null;
  /** Replies that targeted the wrong channel / a DM when a channel was expected. */
  wrongChannelReplies: number;
  /** True if no delivery_dropped / acl_denied events occurred. */
  deliveryOk: boolean;
  /** Coarse event counts for the report. */
  events: {
    relayInbound: number;
    dropped: number;
    aclDenied: number;
  };
  /** Lifecycle: number of confirmed add_agent calls in this run. */
  spawnCount?: number;
  /** Lifecycle: number of confirmed remove_agent calls in this run. */
  releaseCount?: number;
  /** Onboarding variant used (lifecycle scenarios only). */
  onboarding?: string;
  /** True when the agent used Claude's native Task tool instead of mcp__agent-relay__add_agent. */
  nativeSubagentDetected?: boolean;
  /** Optional human-readable notes (e.g. partial-chain detail). */
  notes?: string;
}

/**
 * Eval tiers:
 * - `smoke`: leading prompts that name the exact tool. A plumbing canary — proves
 *   the broker→MCP→agent→scoring path works; not a measure of protocol retention.
 * - `realistic`: natural-language prompts where messaging is incidental to real
 *   work and the protocol must come from the injected onboarding (skill + broker
 *   hints) — what production agents actually get. This is the real benchmark.
 */
export type EvalTier = 'smoke' | 'realistic';

/** A scenario the runner can execute against a harness. */
export interface EvalScenario {
  id: string;
  title: string;
  tier: EvalTier;
  /** Channels the broker should subscribe to for this scenario. */
  channels: string[];
  /** If set, only run for these harnesses. */
  harnessFilter?: string[];
  /** Overall test timeout in ms. */
  timeoutMs: number;
  /** Onboarding variant (lifecycle scenarios only — used for report grouping). */
  onboardingVariant?: string;
  /**
   * Orchestrate the scenario end-to-end: spawn agents, inject the stimulus,
   * wait for responses, and score the captured events into a ScenarioResult.
   */
  run: (ctx: ScenarioContext) => Promise<ScenarioResult>;
}

/** Aggregated metrics for one harness across all scenarios. */
export interface MetricSet {
  messageSentRate: number;
  phantomRate: number;
  phantomCount: number;
  protocolAdherence: number;
  deliverySuccessRate: number;
  wrongChannelReplies: number;
  scenariosPassed: number;
  scenariosTotal: number;
  /** Lifecycle: fraction of s01/s03 scenarios where add_agent was called. */
  spawnRate?: number;
  /** Lifecycle: fraction of s02/s03 scenarios where remove_agent was called. */
  releaseRate?: number;
}

/** A full report for one harness run. */
export interface EvalReport {
  schemaVersion: number;
  startedAt: string;
  durationMs: number;
  harness: string;
  gitSha: string;
  env: {
    realCli: boolean;
    repeat: number;
  };
  metrics: MetricSet;
  scenarios: ScenarioResult[];
}

/** The matrix roll-up across harnesses. */
export interface MatrixReport {
  schemaVersion: number;
  startedAt: string;
  gitSha: string;
  harnesses: Record<string, MetricSet>;
}

export const SCHEMA_VERSION = 1;
