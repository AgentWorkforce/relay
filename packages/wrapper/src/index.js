/**
 * @agent-relay/wrapper
 *
 * CLI agent wrappers for Agent Relay.
 * Phase 2B extraction - utilities and types.
 */
// ID generation
export { IdGenerator, idGen, generateId } from './id-generator.js';
// Tmux binary resolution
export { getTmuxPath, resolveTmux, isTmuxAvailable, checkTmuxVersion, getBundledTmuxDir, getBundledTmuxPath, getPlatformIdentifier, TmuxNotFoundError, BUNDLED_TMUX_DIR, BUNDLED_TMUX_PATH, MIN_TMUX_VERSION, } from './tmux-resolver.js';
// Output parser
export { OutputParser, parseSummaryFromOutput, parseSummaryWithDetails, parseSessionEndFromOutput, parseRelayMetadataFromOutput, isPlaceholderTarget, } from './parser.js';
// Shared wrapper utilities and types
export { stripAnsi, sleep, getDefaultRelayPrefix, buildInjectionString, injectWithRetry, INJECTION_CONSTANTS, CLI_QUIRKS, } from './shared.js';
// Auth revocation detection
export { AUTH_REVOCATION_PATTERNS, AUTH_FALSE_POSITIVE_PATTERNS, PROVIDER_AUTH_PATTERNS, detectProviderAuthRevocation, } from './auth-detection.js';
// Idle detection
export { UniversalIdleDetector, getTmuxPanePid, } from './idle-detector.js';
// Trajectory integration (PDERO paradigm tracking)
export { TrajectoryIntegration, getTrajectoryIntegration, detectPhaseFromContent, detectToolCalls, detectErrors, getCompactTrailInstructions, getTrailEnvVars, getTrailInstructions, isTrailAvailable, startTrajectory, getTrajectoryStatus, transitionPhase, recordDecision, recordEvent, recordMessage, completeTrajectory, abandonTrajectory, listTrajectorySteps, getTrajectoryHistory, } from './trajectory-integration.js';
// Stuck detection
export { StuckDetector, } from './stuck-detector.js';
// Prompt composition
export { composeForAgent, getAvailableRoles, parseRoleFromProfile, clearPromptCache, } from './prompt-composer.js';
// Relay client (internal)
export { RelayClient, } from './client.js';
// Base wrapper class
export { BaseWrapper, } from './base-wrapper.js';
// RelayPtyOrchestrator (relay-pty Rust binary)
export { RelayPtyOrchestrator, } from './relay-pty-orchestrator.js';
//# sourceMappingURL=index.js.map