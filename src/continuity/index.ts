/**
 * Continuity System
 *
 * CLI-agnostic session continuity for Agent Relay.
 * Preserves agent state across sessions via ledgers and handoffs.
 *
 * Key components:
 * - Ledgers: Within-session state snapshots (JSON)
 * - Handoffs: Cross-session transfer documents (Markdown)
 * - Parser: Detects `->continuity:` patterns in agent output
 * - Formatter: Formats context for injection
 * - Manager: Central service coordinating all operations
 *
 * Usage:
 * ```typescript
 * import { getContinuityManager, parseContinuityCommand } from './continuity';
 *
 * const manager = getContinuityManager();
 *
 * // On agent spawn - inject previous context
 * const context = await manager.getStartupContext('Alice');
 * if (context) {
 *   await injectMessage(context.formatted);
 * }
 *
 * // On agent output - check for continuity commands
 * const command = parseContinuityCommand(output);
 * if (command) {
 *   const response = await manager.handleCommand('Alice', command);
 *   if (response) {
 *     await injectMessage(response);
 *   }
 * }
 *
 * // On agent exit - auto-save
 * await manager.autoSave('Alice', 'restart');
 * ```
 */

// Types
export type {
  Decision,
  FileRef,
  Ledger,
  Handoff,
  HandoffTrigger,
  ContinuityCommand,
  StartupContext,
  ContinuityPaths,
  SaveLedgerOptions,
  SearchOptions,
} from './types.js';

// Parser
export {
  parseContinuityCommand,
  hasContinuityCommand,
  parseSaveContent,
  parseHandoffContent,
  extractAllCommands,
  isPlaceholderValue,
  filterPlaceholders,
  type ParsedHandoffContent,
} from './parser.js';

// Formatter
export {
  formatStartupContext,
  formatLedger,
  formatHandoff,
  formatSearchResults,
  formatBriefStatus,
  formatFileRefs,
  formatDecisions,
  type FormatOptions,
} from './formatter.js';

// Stores
export { LedgerStore } from './ledger-store.js';
export { HandoffStore } from './handoff-store.js';

// Manager
export {
  ContinuityManager,
  getContinuityManager,
  resetContinuityManager,
  type ContinuityManagerOptions,
} from './manager.js';
