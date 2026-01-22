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
