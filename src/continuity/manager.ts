/**
 * Continuity Manager
 *
 * Central service for managing session continuity.
 * Coordinates ledger storage, handoff creation, and context injection.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import { LedgerStore } from './ledger-store.js';
import { HandoffStore } from './handoff-store.js';
import {
  parseSaveContent,
  parseHandoffContent,
  isPlaceholderValue,
  filterPlaceholders,
  type ParsedHandoffContent,
} from './parser.js';
import {
  formatStartupContext,
  formatLedger,
  formatHandoff,
  formatSearchResults,
  formatBriefStatus,
} from './formatter.js';
import type {
  Ledger,
  Handoff,
  HandoffTrigger,
  ContinuityPaths,
  StartupContext,
  SaveLedgerOptions,
  SearchOptions,
  ContinuityCommand,
} from './types.js';

/**
 * Options for ContinuityManager
 */
export interface ContinuityManagerOptions {
  /** Base directory for continuity data (default: ~/.agent-relay/continuity) */
  basePath?: string;
  /** Default CLI type for new ledgers */
  defaultCli?: string;
}

/**
 * ContinuityManager - Central service for session continuity
 */
export class ContinuityManager {
  private paths: ContinuityPaths;
  private ledgerStore: LedgerStore;
  private handoffStore: HandoffStore;
  private defaultCli: string;
  private initialized = false;

  constructor(options: ContinuityManagerOptions = {}) {
    const basePath =
      options.basePath ||
      path.join(os.homedir(), '.agent-relay', 'continuity');

    this.paths = {
      base: basePath,
      ledgers: path.join(basePath, 'ledgers'),
      handoffs: path.join(basePath, 'handoffs'),
      artifactDb: path.join(basePath, 'artifact-index.db'),
    };

    this.ledgerStore = new LedgerStore(this.paths.ledgers);
    this.handoffStore = new HandoffStore(this.paths.handoffs);
    this.defaultCli = options.defaultCli || 'unknown';
  }

  /**
   * Initialize the continuity system (create directories)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await fs.mkdir(this.paths.base, { recursive: true });
    await this.ledgerStore.initialize();
    await this.handoffStore.initialize();

    this.initialized = true;
  }

  /**
   * Generate a session ID
   */
  private generateSessionId(): string {
    return `sess_${crypto.randomBytes(8).toString('hex')}`;
  }

  /**
   * Generate a unique agent ID using UUID v4
   */
  generateAgentId(): string {
    // Use crypto.randomUUID() for proper UUID v4
    return crypto.randomUUID();
  }

  // =========================================================================
  // Ledger Operations
  // =========================================================================

  /**
   * Get or create a ledger for an agent
   */
  async getOrCreateLedger(agentName: string, cli?: string, agentId?: string): Promise<Ledger> {
    await this.initialize();

    let ledger = await this.ledgerStore.load(agentName);
    if (!ledger) {
      ledger = await this.ledgerStore.create(
        agentName,
        cli || this.defaultCli,
        this.generateSessionId(),
        agentId || this.generateAgentId()
      );
    }
    return ledger;
  }

  /**
   * Find a ledger by agent ID (for resume functionality)
   */
  async findLedgerByAgentId(agentId: string): Promise<Ledger | null> {
    await this.initialize();
    return this.ledgerStore.findByAgentId(agentId);
  }

  /**
   * Get a ledger for an agent (returns null if not exists)
   */
  async getLedger(agentName: string): Promise<Ledger | null> {
    await this.initialize();
    return this.ledgerStore.load(agentName);
  }

  /**
   * Save a ledger, optionally creating a handoff
   */
  async saveLedger(
    agentName: string,
    content: string | Partial<Ledger>,
    options: SaveLedgerOptions = {}
  ): Promise<Ledger> {
    await this.initialize();

    // Parse content if string
    const updates =
      typeof content === 'string' ? parseSaveContent(content) : content;

    // Get or create existing ledger
    let ledger = await this.ledgerStore.load(agentName);

    if (ledger) {
      // Merge updates into existing ledger (preserve agentId)
      ledger = {
        ...ledger,
        ...updates,
        agentName,
        agentId: ledger.agentId, // Always preserve existing agentId
        updatedAt: new Date(),
      };
    } else {
      // Create new ledger with new agentId
      ledger = {
        agentName,
        agentId: this.generateAgentId(),
        sessionId: this.generateSessionId(),
        cli: this.defaultCli,
        currentTask: '',
        completed: [],
        inProgress: [],
        blocked: [],
        keyDecisions: [],
        uncertainItems: [],
        fileContext: [],
        ...updates,
        updatedAt: new Date(),
      };
    }

    await this.ledgerStore.save(agentName, ledger);

    // Create handoff if requested
    if (options.createHandoff) {
      await this.createHandoffFromLedger(
        ledger,
        options.triggerReason || 'manual'
      );
    }

    return ledger;
  }

  /**
   * Update specific fields in a ledger
   */
  async updateLedger(
    agentName: string,
    updates: Partial<Omit<Ledger, 'agentName' | 'updatedAt'>>
  ): Promise<Ledger | null> {
    await this.initialize();
    return this.ledgerStore.update(agentName, updates);
  }

  /**
   * Add an uncertain item to the ledger
   */
  async addUncertainItem(agentName: string, item: string): Promise<boolean> {
    await this.initialize();
    const prefixedItem = item.startsWith('UNCONFIRMED:')
      ? item
      : `UNCONFIRMED: ${item}`;
    return this.ledgerStore.addToList(agentName, 'uncertainItems', prefixedItem);
  }

  /**
   * Delete a ledger
   */
  async deleteLedger(agentName: string): Promise<boolean> {
    await this.initialize();
    return this.ledgerStore.delete(agentName);
  }

  // =========================================================================
  // Handoff Operations
  // =========================================================================

  /**
   * Create a handoff from a ledger
   */
  async createHandoffFromLedger(
    ledger: Ledger,
    triggerReason: HandoffTrigger
  ): Promise<Handoff> {
    const handoff: Handoff = {
      id: '', // Will be generated by store
      agentName: ledger.agentName,
      agentId: ledger.agentId,
      cli: ledger.cli,
      summary: '',
      taskDescription: ledger.currentTask,
      completedWork: [...ledger.completed],
      nextSteps: [...ledger.inProgress],
      fileReferences: [...ledger.fileContext],
      decisions: [...ledger.keyDecisions],
      relatedHandoffs: [],
      createdAt: new Date(),
      triggerReason,
      trajectoryId: ledger.trajectoryId,
      pderoPhase: ledger.pderoPhase,
    };

    await this.handoffStore.save(handoff);
    return handoff;
  }

  /**
   * Create a handoff from parsed content
   */
  async createHandoff(
    agentName: string,
    content: string | ParsedHandoffContent,
    triggerReason: HandoffTrigger = 'manual'
  ): Promise<Handoff> {
    await this.initialize();

    const parsed =
      typeof content === 'string' ? parseHandoffContent(content) : content;

    const handoff: Handoff = {
      id: '',
      agentName,
      cli: this.defaultCli,
      summary: parsed.summary || '',
      taskDescription: parsed.taskDescription || '',
      completedWork: parsed.completedWork,
      nextSteps: parsed.nextSteps,
      fileReferences: parsed.fileReferences,
      decisions: parsed.decisions,
      relatedHandoffs: [],
      createdAt: new Date(),
      triggerReason,
      learnings: parsed.learnings,
    };

    const id = await this.handoffStore.save(handoff);
    handoff.id = id;

    return handoff;
  }

  /**
   * Get the latest handoff for an agent
   */
  async getLatestHandoff(agentName: string): Promise<Handoff | null> {
    await this.initialize();
    return this.handoffStore.getLatest(agentName);
  }

  /**
   * Get a handoff by ID
   */
  async getHandoff(handoffId: string): Promise<Handoff | null> {
    await this.initialize();
    return this.handoffStore.loadById(handoffId);
  }

  /**
   * List handoffs for an agent
   */
  async listHandoffs(agentName: string, limit?: number): Promise<Handoff[]> {
    await this.initialize();
    return this.handoffStore.listForAgent(agentName, limit);
  }

  /**
   * Search handoffs (basic text search - FTS to be added)
   */
  async searchHandoffs(
    query: string,
    options: SearchOptions = {}
  ): Promise<Handoff[]> {
    await this.initialize();

    const queryLower = query.toLowerCase();
    const results: Handoff[] = [];

    // Get all agents or filter by agent
    const agents = options.agentName
      ? [options.agentName]
      : await this.handoffStore.listAgents();

    for (const agent of agents) {
      const handoffs = await this.handoffStore.listForAgent(agent);

      for (const handoff of handoffs) {
        // Filter by date if specified
        if (options.since && handoff.createdAt < options.since) {
          continue;
        }

        // Filter by trigger reason if specified
        if (
          options.triggerReason &&
          handoff.triggerReason !== options.triggerReason
        ) {
          continue;
        }

        // Basic text search
        const searchText = [
          handoff.taskDescription,
          handoff.summary,
          ...handoff.completedWork,
          ...handoff.nextSteps,
          ...handoff.decisions.map((d) => d.decision),
          ...(handoff.learnings || []),
        ]
          .join(' ')
          .toLowerCase();

        if (searchText.includes(queryLower)) {
          results.push(handoff);
        }
      }
    }

    // Apply limit
    if (options.limit) {
      return results.slice(0, options.limit);
    }

    return results;
  }

  // =========================================================================
  // Context Injection
  // =========================================================================

  /**
   * Get startup context for an agent (for injection on spawn).
   * Applies defensive filtering to remove any placeholder values.
   */
  async getStartupContext(agentName: string): Promise<StartupContext | null> {
    await this.initialize();

    let ledger = await this.ledgerStore.load(agentName);
    const handoff = await this.handoffStore.getLatest(agentName);

    if (!ledger && !handoff) {
      return null;
    }

    // Defensive filtering: clean any placeholder values that may have slipped through
    if (ledger) {
      ledger = this.filterLedgerPlaceholders(ledger);
    }

    const context: StartupContext = {
      ledger: ledger || undefined,
      handoff: handoff ? this.filterHandoffPlaceholders(handoff) : undefined,
      learnings: handoff?.learnings ? filterPlaceholders(handoff.learnings) : undefined,
      formatted: '',
    };

    context.formatted = formatStartupContext(context);

    return context;
  }

  /**
   * Filter placeholder values from a ledger (defensive)
   */
  private filterLedgerPlaceholders(ledger: Ledger): Ledger {
    return {
      ...ledger,
      currentTask: isPlaceholderValue(ledger.currentTask) ? '' : ledger.currentTask,
      completed: filterPlaceholders(ledger.completed),
      inProgress: filterPlaceholders(ledger.inProgress),
      blocked: filterPlaceholders(ledger.blocked),
      uncertainItems: filterPlaceholders(ledger.uncertainItems),
      fileContext: ledger.fileContext.filter(f => !isPlaceholderValue(f.path)),
      keyDecisions: ledger.keyDecisions.filter(d => !isPlaceholderValue(d.decision)),
    };
  }

  /**
   * Filter placeholder values from a handoff (defensive)
   */
  private filterHandoffPlaceholders(handoff: Handoff): Handoff {
    return {
      ...handoff,
      taskDescription: isPlaceholderValue(handoff.taskDescription) ? '' : handoff.taskDescription,
      summary: isPlaceholderValue(handoff.summary) ? '' : handoff.summary,
      completedWork: filterPlaceholders(handoff.completedWork),
      nextSteps: filterPlaceholders(handoff.nextSteps),
      fileReferences: handoff.fileReferences.filter(f => !isPlaceholderValue(f.path)),
      decisions: handoff.decisions.filter(d => !isPlaceholderValue(d.decision)),
      learnings: handoff.learnings ? filterPlaceholders(handoff.learnings) : undefined,
    };
  }

  /**
   * Format a ledger for display/injection
   */
  formatLedger(ledger: Ledger, compact = false): string {
    return formatLedger(ledger, { compact });
  }

  /**
   * Format a handoff for display/injection
   */
  formatHandoff(handoff: Handoff, compact = false): string {
    return formatHandoff(handoff, { compact });
  }

  /**
   * Format search results
   */
  formatSearchResults(handoffs: Handoff[], query: string): string {
    return formatSearchResults(handoffs, query);
  }

  /**
   * Get a brief status summary
   */
  async getBriefStatus(agentName: string): Promise<string> {
    const ledger = await this.getLedger(agentName);
    const handoff = await this.getLatestHandoff(agentName);
    return formatBriefStatus(ledger, handoff);
  }

  // =========================================================================
  // Command Handling
  // =========================================================================

  /**
   * Handle a continuity command from agent output
   */
  async handleCommand(
    agentName: string,
    command: ContinuityCommand
  ): Promise<string | null> {
    switch (command.type) {
      case 'save':
        await this.saveLedger(agentName, command.content || '', {
          createHandoff: command.createHandoff,
        });
        return null; // No response needed

      case 'load': {
        const context = await this.getStartupContext(agentName);
        return context?.formatted || 'No continuity data found.';
      }

      case 'search': {
        const results = await this.searchHandoffs(command.query || '', {
          limit: 5,
        });
        return this.formatSearchResults(results, command.query || '');
      }

      case 'uncertain':
        if (command.item) {
          await this.addUncertainItem(agentName, command.item);
        }
        return null;

      case 'handoff':
        await this.createHandoff(agentName, command.content || '');
        return null;

      default:
        return null;
    }
  }

  // =========================================================================
  // Auto-save (for crash/restart)
  // =========================================================================

  /**
   * Auto-save current state (called by wrapper on agent exit)
   * @param agentName - Name of the agent
   * @param reason - Why the save is happening
   * @param sessionEndData - Optional data from [[SESSION_END]] block to populate handoff
   */
  async autoSave(
    agentName: string,
    reason: 'crash' | 'restart' | 'session_end',
    sessionEndData?: { summary?: string; completedTasks?: string[] }
  ): Promise<void> {
    await this.initialize();

    const triggerReason: HandoffTrigger =
      reason === 'crash'
        ? 'crash'
        : reason === 'restart'
          ? 'auto_restart'
          : 'session_end';

    // If we have SESSION_END data, use it to create handoff directly
    // This fixes the issue where ledger is empty but SESSION_END has content
    if (sessionEndData && (sessionEndData.summary || sessionEndData.completedTasks?.length)) {
      const handoff: Handoff = {
        id: '',
        agentName,
        cli: this.defaultCli,
        summary: sessionEndData.summary || '',
        taskDescription: '',
        completedWork: sessionEndData.completedTasks || [],
        nextSteps: [],
        fileReferences: [],
        decisions: [],
        relatedHandoffs: [],
        createdAt: new Date(),
        triggerReason,
      };

      await this.handoffStore.save(handoff);
      return;
    }

    // Fall back to ledger-based handoff if no SESSION_END data
    const ledger = await this.ledgerStore.load(agentName);
    if (ledger) {
      await this.createHandoffFromLedger(ledger, triggerReason);
    }
  }

  // =========================================================================
  // Cleanup
  // =========================================================================

  /**
   * Clean placeholder data from all ledgers.
   * Removes known placeholder/template values that were incorrectly saved.
   * Returns the number of ledgers that were cleaned.
   */
  async cleanupPlaceholders(): Promise<{ cleaned: number; agents: string[] }> {
    await this.initialize();

    const agents = await this.ledgerStore.listAgents();
    const cleanedAgents: string[] = [];

    for (const agentName of agents) {
      const ledger = await this.ledgerStore.load(agentName);
      if (!ledger) continue;

      let modified = false;

      // Clean currentTask
      if (ledger.currentTask && isPlaceholderValue(ledger.currentTask)) {
        ledger.currentTask = '';
        modified = true;
      }

      // Clean arrays
      const originalCompleted = ledger.completed.length;
      ledger.completed = filterPlaceholders(ledger.completed);
      if (ledger.completed.length !== originalCompleted) modified = true;

      const originalInProgress = ledger.inProgress.length;
      ledger.inProgress = filterPlaceholders(ledger.inProgress);
      if (ledger.inProgress.length !== originalInProgress) modified = true;

      const originalBlocked = ledger.blocked.length;
      ledger.blocked = filterPlaceholders(ledger.blocked);
      if (ledger.blocked.length !== originalBlocked) modified = true;

      const originalUncertain = ledger.uncertainItems.length;
      ledger.uncertainItems = filterPlaceholders(ledger.uncertainItems);
      if (ledger.uncertainItems.length !== originalUncertain) modified = true;

      // Clean file context
      const originalFiles = ledger.fileContext.length;
      ledger.fileContext = ledger.fileContext.filter(f => !isPlaceholderValue(f.path));
      if (ledger.fileContext.length !== originalFiles) modified = true;

      // Clean decisions
      const originalDecisions = ledger.keyDecisions.length;
      ledger.keyDecisions = ledger.keyDecisions.filter(d => !isPlaceholderValue(d.decision));
      if (ledger.keyDecisions.length !== originalDecisions) modified = true;

      if (modified) {
        await this.ledgerStore.save(agentName, ledger);
        cleanedAgents.push(agentName);
      }
    }

    return { cleaned: cleanedAgents.length, agents: cleanedAgents };
  }

  /**
   * Clear all continuity data for an agent
   */
  async clearAgent(agentName: string): Promise<void> {
    await this.initialize();
    await this.ledgerStore.delete(agentName);
    // Note: We don't delete handoffs as they're meant to be permanent
  }

  /**
   * List all agents with continuity data
   */
  async listAgents(): Promise<string[]> {
    await this.initialize();

    const ledgerAgents = await this.ledgerStore.listAgents();
    const handoffAgents = await this.handoffStore.listAgents();

    // Combine and deduplicate
    const allAgents = new Set([...ledgerAgents, ...handoffAgents]);
    return Array.from(allAgents).sort();
  }

  /**
   * Get continuity paths
   */
  getPaths(): ContinuityPaths {
    return { ...this.paths };
  }
}

// Singleton instance with lazy initialization
let instance: ContinuityManager | null = null;
let instancePromise: Promise<ContinuityManager> | null = null;

/**
 * Get the singleton ContinuityManager instance (sync version)
 *
 * Note: This is safe for most uses since ContinuityManager methods
 * call initialize() internally. The race condition only matters
 * if multiple calls happen before the first completes AND they
 * pass different options (which is unlikely in practice).
 */
export function getContinuityManager(
  options?: ContinuityManagerOptions
): ContinuityManager {
  if (!instance) {
    instance = new ContinuityManager(options);
  }
  return instance;
}

/**
 * Get the singleton ContinuityManager instance (async version)
 *
 * This is the thread-safe version that ensures only one instance
 * is created even with concurrent calls. Use this in async contexts
 * where race conditions are possible.
 */
export async function getContinuityManagerAsync(
  options?: ContinuityManagerOptions
): Promise<ContinuityManager> {
  if (instance) {
    return instance;
  }

  if (!instancePromise) {
    instancePromise = (async () => {
      const manager = new ContinuityManager(options);
      await manager.initialize();
      instance = manager;
      return manager;
    })();
  }

  return instancePromise;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetContinuityManager(): void {
  instance = null;
  instancePromise = null;
}
