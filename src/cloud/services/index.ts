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

// Compute enforcement (free tier limits)
export {
  ComputeEnforcementService,
  ComputeEnforcementConfig,
  EnforcementResult,
  getComputeEnforcementService,
  createComputeEnforcementService,
} from './compute-enforcement.js';

// Intro expiration (auto-resize after free tier intro period)
export {
  IntroExpirationService,
  IntroExpirationConfig,
  IntroStatus,
  ExpirationResult as IntroExpirationResult,
  INTRO_PERIOD_DAYS,
  getIntroStatus,
  getIntroExpirationService,
  startIntroExpirationService,
  stopIntroExpirationService,
} from './intro-expiration.js';

// Workspace keepalive (prevent Fly.io from idling machines with active agents)
export {
  WorkspaceKeepaliveService,
  WorkspaceKeepaliveConfig,
  KeepaliveStats,
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
