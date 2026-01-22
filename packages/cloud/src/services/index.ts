/**
 * Cloud Services Index
 *
 * Exports all cloud-side services for easy importing.
 */

// Scaling infrastructure
export {
  ScalingPolicyService,
  type ScalingThresholds,
  type ScalingPolicy,
  type ScalingCondition,
  type ScalingAction,
  type ScalingDecision,
  type UserScalingContext,
  type WorkspaceMetrics,
  getScalingPolicyService,
} from './scaling-policy.js';

export {
  AutoScaler,
  type AutoScalerConfig,
  type ScalingOperation,
  type MetricsSnapshot,
  getAutoScaler,
  createAutoScaler,
} from './auto-scaler.js';

export {
  CapacityManager,
  type CapacityManagerConfig,
  type WorkspaceCapacity,
  type PlacementRecommendation,
  type CapacitySnapshot,
  type CapacityForecast,
  getCapacityManager,
  createCapacityManager,
} from './capacity-manager.js';

export {
  ScalingOrchestrator,
  type OrchestratorConfig,
  type ScalingEvent,
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

// Compute enforcement (free tier limits)
export {
  ComputeEnforcementService,
  type ComputeEnforcementConfig,
  type EnforcementResult,
  getComputeEnforcementService,
  createComputeEnforcementService,
} from './compute-enforcement.js';

// Intro expiration (auto-resize/destroy after free tier intro period)
export {
  IntroExpirationService,
  type IntroExpirationConfig,
  type IntroStatus,
  type ExpirationResult as IntroExpirationResult,
  INTRO_PERIOD_DAYS,
  DESTROY_GRACE_PERIOD_DAYS,
  getIntroStatus,
  getIntroExpirationService,
  startIntroExpirationService,
  stopIntroExpirationService,
} from './intro-expiration.js';

// Workspace keepalive (prevent Fly.io from idling machines with active agents)
export {
  WorkspaceKeepaliveService,
  type WorkspaceKeepaliveConfig,
  type KeepaliveStats,
  getWorkspaceKeepaliveService,
  createWorkspaceKeepaliveService,
} from './workspace-keepalive.js';

// Presence registry (shared registry for tracking online users)
export {
  registerUserPresence,
  unregisterUserPresence,
  updateUserLastSeen,
  isUserOnline,
  getOnlineUser,
  getOnlineUsers,
  getOnlineUsersForDiscovery,
  clearAllPresence,
  type PresenceUserInfo,
} from './presence-registry.js';

// Cloud message bus (event-based message delivery for cloud users)
export {
  cloudMessageBus,
  type CloudMessage,
} from './cloud-message-bus.js';
