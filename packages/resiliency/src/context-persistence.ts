/**
 * Context Persistence
 *
 * Maintains agent context across restarts using ledger-based state storage.
 * Inspired by Continuous-Claude-v2: "Clear don't compact, save state to ledger."
 *
 * Key concepts:
 * - Ledger: Periodic snapshots of agent state
 * - Handoff: Detailed context for task continuation
 * - Artifact index: Searchable history of decisions/actions
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from './logger.js';

const logger = createLogger('context-persistence');

export interface AgentState {
  name: string;
  cli: string;
  task?: string;
  currentPhase: string;
  completedTasks: string[];
  decisions: Decision[];
  context: Record<string, unknown>;
  artifacts: Artifact[];
  lastCheckpoint: Date;
  sessionCount: number;
}

export interface Decision {
  timestamp: Date;
  description: string;
  reasoning: string;
  outcome?: 'success' | 'failure' | 'pending';
}

export interface Artifact {
  id: string;
  type: 'code' | 'file' | 'message' | 'error' | 'decision';
  path?: string;
  content: string;
  timestamp: Date;
  tags: string[];
}

export interface Handoff {
  fromAgent: string;
  toAgent?: string;
  createdAt: Date;
  task: string;
  summary: string;
  completedSteps: string[];
  nextSteps: string[];
  context: Record<string, unknown>;
  warnings: string[];
  artifacts: string[]; // Artifact IDs
}

export interface LedgerEntry {
  timestamp: Date;
  sessionId: string;
  type: 'checkpoint' | 'handoff' | 'crash' | 'complete';
  state: AgentState;
  handoff?: Handoff;
}

export class ContextPersistence {
  private baseDir: string;
  private states = new Map<string, AgentState>();
  private saveInterval?: ReturnType<typeof setInterval>;
  private saveIntervalMs = 30000; // Save every 30 seconds

  constructor(baseDir?: string) {
    this.baseDir = baseDir || path.join(process.cwd(), '.agent-relay', 'context');
    this.ensureDir(this.baseDir);
    this.ensureDir(path.join(this.baseDir, 'ledgers'));
    this.ensureDir(path.join(this.baseDir, 'handoffs'));
    this.ensureDir(path.join(this.baseDir, 'artifacts'));
  }

  /**
   * Start periodic state saving
   */
  startAutoSave(): void {
    if (this.saveInterval) return;

    this.saveInterval = setInterval(() => {
      this.saveAllStates();
    }, this.saveIntervalMs);

    logger.info('Auto-save started', { intervalMs: this.saveIntervalMs });
  }

  /**
   * Stop periodic state saving
   */
  stopAutoSave(): void {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = undefined;
      logger.info('Auto-save stopped');
    }
  }

  /**
   * Initialize or load state for an agent
   */
  initAgent(name: string, cli: string, task?: string): AgentState {
    // Try to load existing state
    const existing = this.loadLatestState(name);
    if (existing) {
      existing.sessionCount++;
      existing.lastCheckpoint = new Date();
      this.states.set(name, existing);
      logger.info('Loaded existing agent state', {
        name,
        sessionCount: existing.sessionCount,
        completedTasks: existing.completedTasks.length,
      });
      return existing;
    }

    // Create new state
    const state: AgentState = {
      name,
      cli,
      task,
      currentPhase: 'init',
      completedTasks: [],
      decisions: [],
      context: {},
      artifacts: [],
      lastCheckpoint: new Date(),
      sessionCount: 1,
    };

    this.states.set(name, state);
    this.saveState(name);

    logger.info('Created new agent state', { name, cli, task });
    return state;
  }

  /**
   * Update agent's current phase
   */
  updatePhase(name: string, phase: string): void {
    const state = this.states.get(name);
    if (state) {
      state.currentPhase = phase;
      state.lastCheckpoint = new Date();
    }
  }

  /**
   * Record a completed task
   */
  recordTask(name: string, task: string): void {
    const state = this.states.get(name);
    if (state) {
      state.completedTasks.push(task);
      state.lastCheckpoint = new Date();
      logger.debug('Recorded task completion', { name, task });
    }
  }

  /**
   * Record a decision
   */
  recordDecision(
    name: string,
    description: string,
    reasoning: string,
    outcome?: 'success' | 'failure' | 'pending'
  ): void {
    const state = this.states.get(name);
    if (state) {
      state.decisions.push({
        timestamp: new Date(),
        description,
        reasoning,
        outcome,
      });
      state.lastCheckpoint = new Date();
      logger.debug('Recorded decision', { name, description, outcome });
    }
  }

  /**
   * Add an artifact
   */
  addArtifact(
    name: string,
    type: Artifact['type'],
    content: string,
    options?: { path?: string; tags?: string[] }
  ): string {
    const state = this.states.get(name);
    if (!state) return '';

    const id = `${name}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const artifact: Artifact = {
      id,
      type,
      content: content.substring(0, 10000), // Limit size
      timestamp: new Date(),
      path: options?.path,
      tags: options?.tags || [],
    };

    state.artifacts.push(artifact);
    state.lastCheckpoint = new Date();

    // Save artifact to disk for searchability
    this.saveArtifact(artifact);

    return id;
  }

  /**
   * Update context
   */
  updateContext(name: string, context: Record<string, unknown>): void {
    const state = this.states.get(name);
    if (state) {
      state.context = { ...state.context, ...context };
      state.lastCheckpoint = new Date();
    }
  }

  /**
   * Create a handoff document for resumption
   */
  createHandoff(name: string, options?: { toAgent?: string }): Handoff {
    const state = this.states.get(name);
    if (!state) {
      throw new Error(`Agent ${name} not found`);
    }

    const handoff: Handoff = {
      fromAgent: name,
      toAgent: options?.toAgent,
      createdAt: new Date(),
      task: state.task || 'Unknown task',
      summary: this.generateSummary(state),
      completedSteps: state.completedTasks,
      nextSteps: this.inferNextSteps(state),
      context: state.context,
      warnings: this.getWarnings(state),
      artifacts: state.artifacts.slice(-10).map((a) => a.id), // Last 10 artifacts
    };

    // Save handoff
    this.saveHandoff(name, handoff);

    logger.info('Created handoff', {
      from: name,
      to: options?.toAgent,
      completedSteps: handoff.completedSteps.length,
    });

    return handoff;
  }

  /**
   * Load handoff for resumption
   */
  loadHandoff(name: string): Handoff | null {
    const handoffPath = path.join(this.baseDir, 'handoffs', `${name}_latest.json`);

    if (!fs.existsSync(handoffPath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(handoffPath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      logger.error('Failed to load handoff', { name, error });
      return null;
    }
  }

  /**
   * Record a crash for debugging
   */
  recordCrash(name: string, error: string, stack?: string): void {
    const state = this.states.get(name);
    if (!state) return;

    // Add crash as artifact
    this.addArtifact(name, 'error', `${error}\n\n${stack || ''}`, {
      tags: ['crash', 'error'],
    });

    // Save crash ledger entry
    this.saveLedgerEntry(name, 'crash', state);

    // Create handoff for resumption
    this.createHandoff(name);

    logger.error('Recorded crash', { name, error });
  }

  /**
   * Save checkpoint (call before expected context clear)
   */
  checkpoint(name: string): void {
    const state = this.states.get(name);
    if (!state) return;

    state.lastCheckpoint = new Date();
    this.saveLedgerEntry(name, 'checkpoint', state);
    this.createHandoff(name);

    logger.info('Created checkpoint', { name, phase: state.currentPhase });
  }

  /**
   * Generate markdown summary for CLAUDE.md injection
   */
  generateResumptionContext(name: string): string {
    const state = this.states.get(name);
    const handoff = this.loadHandoff(name);

    if (!state && !handoff) {
      return '';
    }

    const lines: string[] = [
      '# Agent Resumption Context',
      '',
      `**Session**: ${(state?.sessionCount || 0) + 1}`,
      `**Last Checkpoint**: ${state?.lastCheckpoint?.toISOString() || 'Unknown'}`,
      '',
    ];

    if (handoff) {
      lines.push('## Previous Session Summary');
      lines.push(handoff.summary);
      lines.push('');

      if (handoff.completedSteps.length > 0) {
        lines.push('## Completed Steps');
        handoff.completedSteps.forEach((step) => lines.push(`- ✅ ${step}`));
        lines.push('');
      }

      if (handoff.nextSteps.length > 0) {
        lines.push('## Next Steps');
        handoff.nextSteps.forEach((step) => lines.push(`- ⏳ ${step}`));
        lines.push('');
      }

      if (handoff.warnings.length > 0) {
        lines.push('## Warnings');
        handoff.warnings.forEach((w) => lines.push(`- ⚠️ ${w}`));
        lines.push('');
      }
    }

    if (state?.decisions.length) {
      lines.push('## Recent Decisions');
      state.decisions.slice(-5).forEach((d) => {
        const icon = d.outcome === 'success' ? '✅' : d.outcome === 'failure' ? '❌' : '🔄';
        lines.push(`- ${icon} ${d.description}`);
        if (d.reasoning) lines.push(`  - Reasoning: ${d.reasoning}`);
      });
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Get state for an agent
   */
  getState(name: string): AgentState | undefined {
    return this.states.get(name);
  }

  /**
   * Clean up old ledger entries
   */
  cleanup(name: string, keepDays: number = 7): void {
    const ledgerDir = path.join(this.baseDir, 'ledgers', name);
    if (!fs.existsSync(ledgerDir)) return;

    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(ledgerDir);

    for (const file of files) {
      const filePath = path.join(ledgerDir, file);
      const stats = fs.statSync(filePath);
      if (stats.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        logger.debug('Cleaned up old ledger', { file });
      }
    }
  }

  // Private methods

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private saveState(name: string): void {
    const state = this.states.get(name);
    if (!state) return;

    const statePath = path.join(this.baseDir, 'ledgers', `${name}_current.json`);
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  }

  private saveAllStates(): void {
    Array.from(this.states.keys()).forEach((name) => {
      this.saveState(name);
    });
  }

  private loadLatestState(name: string): AgentState | null {
    const statePath = path.join(this.baseDir, 'ledgers', `${name}_current.json`);

    if (!fs.existsSync(statePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(statePath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      logger.error('Failed to load state', { name, error });
      return null;
    }
  }

  private saveLedgerEntry(name: string, type: LedgerEntry['type'], state: AgentState): void {
    const ledgerDir = path.join(this.baseDir, 'ledgers', name);
    this.ensureDir(ledgerDir);

    const entry: LedgerEntry = {
      timestamp: new Date(),
      sessionId: `${name}-${Date.now()}`,
      type,
      state: { ...state },
    };

    const filename = `${type}_${Date.now()}.json`;
    fs.writeFileSync(path.join(ledgerDir, filename), JSON.stringify(entry, null, 2));
  }

  private saveHandoff(name: string, handoff: Handoff): void {
    const handoffDir = path.join(this.baseDir, 'handoffs');
    this.ensureDir(handoffDir);

    // Save as latest
    fs.writeFileSync(
      path.join(handoffDir, `${name}_latest.json`),
      JSON.stringify(handoff, null, 2)
    );

    // Also save timestamped version
    fs.writeFileSync(
      path.join(handoffDir, `${name}_${Date.now()}.json`),
      JSON.stringify(handoff, null, 2)
    );
  }

  private saveArtifact(artifact: Artifact): void {
    const artifactDir = path.join(this.baseDir, 'artifacts');
    this.ensureDir(artifactDir);

    fs.writeFileSync(
      path.join(artifactDir, `${artifact.id}.json`),
      JSON.stringify(artifact, null, 2)
    );
  }

  private generateSummary(state: AgentState): string {
    const parts: string[] = [];

    if (state.task) {
      parts.push(`Task: ${state.task}`);
    }

    parts.push(`Phase: ${state.currentPhase}`);
    parts.push(`Completed ${state.completedTasks.length} tasks`);
    parts.push(`Made ${state.decisions.length} decisions`);

    const successes = state.decisions.filter((d) => d.outcome === 'success').length;
    const failures = state.decisions.filter((d) => d.outcome === 'failure').length;
    if (successes || failures) {
      parts.push(`(${successes} successful, ${failures} failed)`);
    }

    return parts.join('. ');
  }

  private inferNextSteps(state: AgentState): string[] {
    const pending = state.decisions.filter((d) => d.outcome === 'pending');
    return pending.map((d) => d.description);
  }

  private getWarnings(state: AgentState): string[] {
    const warnings: string[] = [];

    const recentFailures = state.decisions.filter(
      (d) =>
        d.outcome === 'failure' &&
        new Date(d.timestamp).getTime() > Date.now() - 10 * 60 * 1000
    );

    if (recentFailures.length > 2) {
      warnings.push(`${recentFailures.length} recent failures - review approach`);
    }

    if (state.sessionCount > 3) {
      warnings.push(`Multiple restarts (${state.sessionCount}) - check for persistent issues`);
    }

    return warnings;
  }
}

// Singleton instance
let _persistence: ContextPersistence | null = null;

export function getContextPersistence(baseDir?: string): ContextPersistence {
  if (!_persistence) {
    _persistence = new ContextPersistence(baseDir);
  }
  return _persistence;
}
