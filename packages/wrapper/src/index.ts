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
