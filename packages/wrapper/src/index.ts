/**
 * @agent-relay/wrapper
 *
 * CLI agent wrappers for Agent Relay.
 * Phase 2B extraction - utilities and types.
 */

// ID generation
export { IdGenerator, idGen, generateId } from './id-generator.js';

// Tmux binary resolution
export {
  getTmuxPath,
  resolveTmux,
  isTmuxAvailable,
  checkTmuxVersion,
  getBundledTmuxDir,
  getBundledTmuxPath,
  getPlatformIdentifier,
  TmuxNotFoundError,
  type TmuxInfo,
  BUNDLED_TMUX_DIR,
  BUNDLED_TMUX_PATH,
  MIN_TMUX_VERSION,
} from './tmux-resolver.js';

// Output parser
export {
  OutputParser,
  parseSummaryFromOutput,
  parseSummaryWithDetails,
  parseSessionEndFromOutput,
  parseRelayMetadataFromOutput,
  isPlaceholderTarget,
  type ParsedCommand,
  type ParserOptions,
  type ParsedSummary,
  type ParsedMessageMetadata,
  type MetadataParseResult,
  type SummaryParseResult,
  type SessionEndMarker,
} from './parser.js';

// Shared wrapper utilities and types
export {
  stripAnsi,
  sleep,
  getDefaultRelayPrefix,
  buildInjectionString,
  injectWithRetry,
  INJECTION_CONSTANTS,
  CLI_QUIRKS,
  type QueuedMessage,
  type InjectionResult,
  type InjectionMetrics,
  type CliType,
  type InjectionCallbacks,
} from './shared.js';

// Auth revocation detection
export {
  AUTH_REVOCATION_PATTERNS,
  AUTH_FALSE_POSITIVE_PATTERNS,
  PROVIDER_AUTH_PATTERNS,
  detectProviderAuthRevocation,
  type AuthRevocationResult,
} from './auth-detection.js';

// Idle detection
export {
  UniversalIdleDetector,
  getTmuxPanePid,
  type IdleSignal,
  type IdleResult,
  type IdleDetectorConfig,
} from './idle-detector.js';

// Trajectory integration (PDERO paradigm tracking)
export {
  TrajectoryIntegration,
  getTrajectoryIntegration,
  detectPhaseFromContent,
  detectToolCalls,
  detectErrors,
  getCompactTrailInstructions,
  getTrailEnvVars,
  getTrailInstructions,
  isTrailAvailable,
  startTrajectory,
  getTrajectoryStatus,
  transitionPhase,
  recordDecision,
  recordEvent,
  recordMessage,
  completeTrajectory,
  abandonTrajectory,
  listTrajectorySteps,
  getTrajectoryHistory,
  type PDEROPhase,
  type StartTrajectoryOptions,
  type CompleteTrajectoryOptions,
  type DecisionOptions,
  type TrajectoryStepData,
  type TrajectoryHistoryEntry,
  type DetectedToolCall,
  type DetectedError,
} from './trajectory-integration.js';

// Wrapper event types
export {
  type InjectionFailedEvent,
  type SummaryEvent,
  type SessionEndEvent,
  type AuthRevokedEvent,
} from './wrapper-types.js';

// Stuck detection
export {
  StuckDetector,
  type StuckEvent,
  type StuckReason,
  type StuckDetectorConfig,
} from './stuck-detector.js';

// Prompt composition
export {
  composeForAgent,
  getAvailableRoles,
  parseRoleFromProfile,
  clearPromptCache,
  type AgentRole,
  type AgentProfile,
  type ComposedPrompt,
} from './prompt-composer.js';

/**
 * Relay client (internal use only)
 *
 * @deprecated **MIGRATION REQUIRED** - Use `@agent-relay/sdk` instead.
 *
 * ```typescript
 * // BEFORE (deprecated)
 * import { RelayClient } from '@agent-relay/wrapper';
 *
 * // AFTER (recommended)
 * import { RelayClient } from '@agent-relay/sdk';
 * ```
 *
 * This export is retained only for internal daemon/wrapper integration.
 * External consumers should migrate to `@agent-relay/sdk`.
 * This export will be removed in a future major version.
 */
export {
  RelayClient,
  type ClientState,
  type ClientConfig,
  type SyncOptions,
} from './client.js';

// Base wrapper class
export {
  BaseWrapper,
  type BaseWrapperConfig,
} from './base-wrapper.js';

// RelayBrokerOrchestrator (agent-relay Rust binary)
export {
  RelayBrokerOrchestrator,
  type RelayBrokerOrchestratorConfig,
} from './relay-broker-orchestrator.js';

// OpenCode HTTP API integration
export {
  OpenCodeApi,
  openCodeApi,
  type OpenCodeApiConfig,
  type OpenCodeSession,
  type OpenCodeApiResponse,
} from './opencode-api.js';

// OpenCode wrapper (HTTP API + PTY fallback)
export {
  OpenCodeWrapper,
  type OpenCodeWrapperConfig,
} from './opencode-wrapper.js';

// Typed event definitions (inspired by opencode's BusEvent pattern)
export {
  RelayEvent,
  defineEvent,
  relayEventBus,
  emitEvent,
  onEvent,
  onAnyEvent,
  generateEventSchemas,
  type EventDefinition,
  type EventProperties,
  type EventPayload,
} from './wrapper-events.js';
