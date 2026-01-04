/**
 * Cloud Services Index
 *
 * Exports all cloud-side services for easy importing.
 */

// Scaling infrastructure
export {
  ScalingPolicyService,
  ScalingThresholds,
  ScalingPolicy,
  ScalingCondition,
  ScalingAction,
  ScalingDecision,
  UserScalingContext,
  WorkspaceMetrics,
  getScalingPolicyService,
} from './scaling-policy.js';

export {
  AutoScaler,
  AutoScalerConfig,
  ScalingOperation,
  MetricsSnapshot,
  getAutoScaler,
  createAutoScaler,
} from './auto-scaler.js';

export {
  CapacityManager,
  CapacityManagerConfig,
  WorkspaceCapacity,
  PlacementRecommendation,
  CapacitySnapshot,
  CapacityForecast,
  getCapacityManager,
  createCapacityManager,
} from './capacity-manager.js';

export {
  ScalingOrchestrator,
  OrchestratorConfig,
  ScalingEvent,
  getScalingOrchestrator,
  createScalingOrchestrator,
} from './scaling-orchestrator.js';

// CI failure handling
export {
  spawnCIFixAgent,
  notifyAgentOfCIFailure,
  completeFixAttempt,
  getFailureHistory,
  getPRFailureHistory,
} from './ci-agent-spawner.js';

// Issue and mention handling
export {
  handleMention,
  handleIssueAssignment,
  getPendingMentions,
  getPendingIssueAssignments,
  processPendingMentions,
  processPendingIssueAssignments,
  KNOWN_AGENTS,
  isKnownAgent,
} from './mention-handler.js';
