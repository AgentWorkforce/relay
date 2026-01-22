/**
 * Cloud Persistence Service
 *
 * Handles durable persistence of agent session data for cloud deployments.
 * Subscribes to wrapper events ('summary', 'session-end') and persists
 * to PostgreSQL via Drizzle ORM.
 *
 * This decouples wrappers from storage concerns - the wrapper emits events,
 * this service handles persistence. Different storage backends can be swapped
 * by implementing alternative persistence services.
 *
 * @see RelayPtyOrchestratorEvents in src/wrapper/relay-pty-orchestrator.ts for event definitions
 */

import { eq, and, desc } from 'drizzle-orm';
import type { RelayPtyOrchestrator } from '@agent-relay/wrapper';
import type { SummaryEvent, SessionEndEvent } from '@agent-relay/wrapper';
import { getDb } from '../db/drizzle.js';
import { agentSessions, agentSummaries } from '../db/schema.js';

/**
 * Configuration for CloudPersistenceService
 */
export interface CloudPersistenceConfig {
  /** Workspace ID for scoping sessions */
  workspaceId: string;
  /** Optional callback when summary is persisted */
  onSummaryPersisted?: (agentName: string, summaryId: string) => void;
  /** Optional callback when session ends */
  onSessionEnded?: (agentName: string, sessionId: string) => void;
}

/**
 * CloudPersistenceService manages durable storage for agent sessions.
 *
 * Usage:
 * ```typescript
 * const persistence = new CloudPersistenceService({
 *   workspaceId: 'workspace-123',
 * });
 *
 * // Bind to a RelayPtyOrchestrator instance
 * const pty = new RelayPtyOrchestrator(config);
 * const sessionId = await persistence.bindToWrapper(pty);
 *
 * // When done, unbind to clean up listeners
 * persistence.unbindFromWrapper(pty);
 * ```
 */
export class CloudPersistenceService {
  private config: CloudPersistenceConfig;
  private boundWrappers = new Map<RelayPtyOrchestrator, {
    sessionId: string;
    summaryHandler: (event: SummaryEvent) => void;
    sessionEndHandler: (event: SessionEndEvent) => void;
  }>();

  constructor(config: CloudPersistenceConfig) {
    this.config = config;
  }

  /**
   * Bind to a RelayPtyOrchestrator instance and start persisting its events.
   * Creates a new agent session record and returns the session ID.
   *
   * @param wrapper The RelayPtyOrchestrator to bind to
   * @returns The session ID for this agent session
   */
  async bindToRelayPtyOrchestrator(wrapper: RelayPtyOrchestrator): Promise<string> {
    const db = getDb();
    const agentName = wrapper.name;

    // Create session record
    const result = await db.insert(agentSessions).values({
      workspaceId: this.config.workspaceId,
      agentName,
      status: 'active',
      startedAt: new Date(),
    }).returning();

    const session = result[0];
    if (!session) {
      throw new Error(`Failed to create session for agent ${agentName}`);
    }
    const sessionId = session.id;

    // Create event handlers
    const summaryHandler = async (event: SummaryEvent) => {
      await this.handleSummary(sessionId, event);
    };

    const sessionEndHandler = async (event: SessionEndEvent) => {
      await this.handleSessionEnd(sessionId, event);
    };

    // Bind handlers
    wrapper.on('summary', summaryHandler);
    wrapper.on('session-end', sessionEndHandler);

    // Track binding for cleanup
    this.boundWrappers.set(wrapper, {
      sessionId,
      summaryHandler,
      sessionEndHandler,
    });

    console.log(`[persistence] Bound to ${agentName}, session=${sessionId}`);
    return sessionId;
  }

  /**
   * Unbind from a RelayPtyOrchestrator and clean up event listeners.
   *
   * @param wrapper The RelayPtyOrchestrator to unbind from
   */
  unbindFromRelayPtyOrchestrator(wrapper: RelayPtyOrchestrator): void {
    const binding = this.boundWrappers.get(wrapper);
    if (!binding) return;

    wrapper.off('summary', binding.summaryHandler);
    wrapper.off('session-end', binding.sessionEndHandler);
    this.boundWrappers.delete(wrapper);

    console.log(`[persistence] Unbound from ${wrapper.name}`);
  }

  /**
   * Handle a summary event - persist to agent_summaries table.
   */
  private async handleSummary(sessionId: string, event: SummaryEvent): Promise<void> {
    try {
      const db = getDb();

      const result = await db.insert(agentSummaries).values({
        sessionId,
        agentName: event.agentName,
        summary: event.summary,
        createdAt: new Date(),
      }).returning();

      const summaryRecord = result[0];
      if (!summaryRecord) {
        console.error(`[persistence] Insert returned no record for ${event.agentName}`);
        return;
      }

      console.log(`[persistence] Saved summary for ${event.agentName}: ${event.summary.currentTask || 'no task'}`);

      this.config.onSummaryPersisted?.(event.agentName, summaryRecord.id);
    } catch (err) {
      console.error(`[persistence] Failed to save summary for ${event.agentName}:`, err);
    }
  }

  /**
   * Handle a session-end event - update agent_sessions with end marker.
   */
  private async handleSessionEnd(sessionId: string, event: SessionEndEvent): Promise<void> {
    try {
      const db = getDb();

      await db.update(agentSessions)
        .set({
          status: 'ended',
          endedAt: new Date(),
          endMarker: event.marker,
        })
        .where(eq(agentSessions.id, sessionId));

      console.log(`[persistence] Session ended for ${event.agentName}: ${event.marker.summary || 'no summary'}`);

      this.config.onSessionEnded?.(event.agentName, sessionId);
    } catch (err) {
      console.error(`[persistence] Failed to end session for ${event.agentName}:`, err);
    }
  }

  /**
   * Get the session ID for a bound wrapper.
   */
  getSessionId(wrapper: RelayPtyOrchestrator): string | undefined {
    return this.boundWrappers.get(wrapper)?.sessionId;
  }

  /**
   * Get all summaries for a session.
   */
  async getSessionSummaries(sessionId: string) {
    const db = getDb();
    return db.select()
      .from(agentSummaries)
      .where(eq(agentSummaries.sessionId, sessionId))
      .orderBy(agentSummaries.createdAt);
  }

  /**
   * Get the latest summary for an agent in THIS workspace.
   * Joins through agent_sessions to ensure workspace scoping.
   */
  async getLatestSummary(agentName: string) {
    const db = getDb();
    // Join with sessions to ensure we only get summaries from this workspace
    const results = await db.select({
      id: agentSummaries.id,
      sessionId: agentSummaries.sessionId,
      agentName: agentSummaries.agentName,
      summary: agentSummaries.summary,
      createdAt: agentSummaries.createdAt,
    })
      .from(agentSummaries)
      .innerJoin(agentSessions, eq(agentSummaries.sessionId, agentSessions.id))
      .where(and(
        eq(agentSummaries.agentName, agentName),
        eq(agentSessions.workspaceId, this.config.workspaceId)
      ))
      .orderBy(desc(agentSummaries.createdAt))
      .limit(1);
    return results[0] || null;
  }

  /**
   * Get active sessions for a workspace.
   */
  async getActiveSessions() {
    const db = getDb();
    return db.select()
      .from(agentSessions)
      .where(and(
        eq(agentSessions.workspaceId, this.config.workspaceId),
        eq(agentSessions.status, 'active')
      ));
  }

  /**
   * Clean up all bindings.
   */
  destroy(): void {
    for (const wrapper of this.boundWrappers.keys()) {
      this.unbindFromRelayPtyOrchestrator(wrapper);
    }
  }
}

/**
 * Factory function to create a persistence service for a workspace.
 */
export function createPersistenceService(workspaceId: string): CloudPersistenceService {
  return new CloudPersistenceService({ workspaceId });
}
