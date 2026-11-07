/**
 * @agent-relay/evals
 *
 * Agent Relay eval harness — scenario runner, broker harness, and scoring
 * utilities for testing relay-connected agents across CLI harnesses.
 *
 * The source of truth for scenario implementations and the runner currently
 * lives in tests/integration/broker/evals/. This package exposes the stable
 * public surface that downstream consumers (pear, agent-assistant, etc.) depend
 * on. The full migration into this package is tracked in
 * specs/agent-relay-evals-package.md.
 */

export type {
  EvalScenario,
  ScenarioContext,
  ScenarioResult,
  EvalTier,
  MetricSet,
  EvalReport,
  MatrixReport,
  AgentInfo,
  TranscriptEntry,
  Phantom,
  // Mount / writeback eval types
  MountScenario,
  MountScenarioResult,
  MountCellMetrics,
} from './types.js';

export { SCHEMA_VERSION } from './types.js';
export {
  deriveDescriptorsFromMount,
  fullInjectInstructions,
  initialSpawnInstructions,
  parseWritableResources,
  prescriptiveInstructions,
  slimInstructions,
} from '@agent-relay/integration-prompts';
export type {
  DeriveDescriptorsOptions,
  IntegrationDescriptor,
  IntegrationSubscriptionSummary,
  MountDiscoveryReader,
  MountListPaths,
  MountReadFile,
  WritableResourceDescriptor,
} from '@agent-relay/integration-prompts';
