/**
 * Consensus Integration for Agent Relay
 *
 * Integrates the consensus mechanism with the router/daemon.
 * This is an optional feature that can be enabled to allow agents
 * to participate in distributed decision-making.
 *
 * Usage:
 * 1. Create a ConsensusIntegration with the router and optional config
 * 2. Call processIncomingMessage() on each received message to detect votes
 * 3. Use createProposal() to start a new consensus vote
 *
 * Example:
 * ```typescript
 * const consensus = new ConsensusIntegration(router, { enabled: true });
 *
 * // Create a proposal
 * consensus.createProposal({
 *   title: 'Approve API design',
 *   description: 'Should we proceed with the REST API design?',
 *   proposer: 'Architect',
 *   participants: ['Developer', 'Reviewer', 'Lead'],
 *   consensusType: 'majority',
 * });
 *
 * // Process incoming messages to detect votes
 * consensus.processIncomingMessage(from, body);
 * ```
 */

import { generateId } from '@agent-relay/wrapper';
import {
  ConsensusEngine,
  createConsensusEngine,
  formatProposalMessage,
  formatResultMessage,
  parseVoteCommand,
  parseProposalCommand,
  isConsensusCommand,
  type Proposal,
  type ConsensusResult,
  type ConsensusConfig,
  type VoteValue,
  type ConsensusType,
  type ParsedProposalCommand,
} from './consensus.js';
import type { Router } from './router.js';
import { PROTOCOL_VERSION, type SendEnvelope } from '@agent-relay/protocol/types';

// =============================================================================
// Types
// =============================================================================

export interface CloudSyncConfig {
  /** Cloud API base URL (defaults to AGENT_RELAY_CLOUD_URL or https://agent-relay.com) */
  url?: string;
  /** Daemon API key for authentication (defaults to AGENT_RELAY_API_KEY) */
  apiKey?: string;
  /** Workspace ID for self-hosted setups (optional - cloud can derive from API key) */
  workspaceId?: string;
}

export interface ConsensusIntegrationConfig {
  /** Enable consensus feature (default: true) */
  enabled: boolean;
  /** Consensus engine configuration */
  consensus?: Partial<ConsensusConfig>;
  /** Auto-broadcast proposals to participants (default: true) */
  autoBroadcast?: boolean;
  /** Auto-broadcast results when resolved (default: true) */
  autoResultBroadcast?: boolean;
  /** Log consensus events (default: true) */
  logEvents?: boolean;
  /** Cloud sync configuration (optional) */
  cloudSync?: CloudSyncConfig;
}

export interface ProposalOptions {
  title: string;
  description: string;
  proposer: string;
  participants: string[];
  consensusType?: ConsensusType;
  timeoutMs?: number;
  quorum?: number;
  threshold?: number;
  metadata?: Record<string, unknown>;
}

const DEFAULT_CONFIG: ConsensusIntegrationConfig = {
  enabled: true,
  autoBroadcast: true,
  autoResultBroadcast: true,
  logEvents: true,
};

// =============================================================================
// Consensus Integration
// =============================================================================

/**
 * Integrates consensus mechanism with the relay router.
 * Provides automatic proposal broadcasting and vote detection.
 */
export class ConsensusIntegration {
  private config: ConsensusIntegrationConfig;
  private engine: ConsensusEngine;
  private router: Router;
  private log: (msg: string, data?: Record<string, unknown>) => void;

  constructor(
    router: Router,
    config: Partial<ConsensusIntegrationConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.router = router;
    this.engine = createConsensusEngine(config.consensus);

    // Setup logging
    this.log = this.config.logEvents
      ? (msg, data) => console.log(`[consensus] ${msg}`, data ?? '')
      : () => {};

    // Subscribe to engine events
    this.setupEventHandlers();
  }

  /**
   * Check if consensus is enabled.
   */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get the underlying consensus engine.
   */
  getEngine(): ConsensusEngine {
    return this.engine;
  }

  /**
   * Create a new proposal and optionally broadcast to participants.
   */
  createProposal(options: ProposalOptions): Proposal {
    if (!this.config.enabled) {
      throw new Error('Consensus is not enabled');
    }

    const proposal = this.engine.createProposal({
      ...options,
      thread: `consensus-${options.title.toLowerCase().replace(/\s+/g, '-')}`,
    });

    this.log('Proposal created', { id: proposal.id, title: proposal.title });

    return proposal;
  }

  /**
   * Process an incoming message to detect and handle consensus commands.
   * Handles both PROPOSE and VOTE commands.
   */
  processIncomingMessage(from: string, body: string): {
    isConsensusCommand: boolean;
    type?: 'propose' | 'vote';
    result?: { success: boolean; error?: string; proposal?: Proposal };
  } {
    if (!this.config.enabled) {
      return { isConsensusCommand: false };
    }

    // Check for PROPOSE command
    const proposeCmd = parseProposalCommand(body);
    if (proposeCmd) {
      try {
        const proposal = this.createProposal({
          ...proposeCmd,
          proposer: from,
        });

        this.log('Proposal created via command', {
          from,
          proposalId: proposal.id,
          title: proposal.title,
        });

        return {
          isConsensusCommand: true,
          type: 'propose',
          result: { success: true, proposal },
        };
      } catch (err) {
        return {
          isConsensusCommand: true,
          type: 'propose',
          result: {
            success: false,
            error: err instanceof Error ? err.message : 'Failed to create proposal',
          },
        };
      }
    }

    // Check for VOTE command
    const voteCmd = parseVoteCommand(body);
    if (voteCmd) {
      const result = this.engine.vote(
        voteCmd.proposalId,
        from,
        voteCmd.value,
        voteCmd.reason
      );

      this.log('Vote received', {
        from,
        proposalId: voteCmd.proposalId,
        value: voteCmd.value,
        success: result.success,
      });

      return { isConsensusCommand: true, type: 'vote', result };
    }

    return { isConsensusCommand: false };
  }

  /**
   * Check if a message is a consensus command without processing it.
   */
  isConsensusMessage(body: string): boolean {
    return isConsensusCommand(body);
  }

  /**
   * Get pending proposals for an agent.
   */
  getPendingVotes(agentName: string): Proposal[] {
    return this.engine.getPendingVotesForAgent(agentName);
  }

  /**
   * Get all proposals for an agent.
   */
  getProposals(agentName: string): Proposal[] {
    return this.engine.getProposalsForAgent(agentName);
  }

  /**
   * Get a specific proposal by ID.
   */
  getProposal(proposalId: string): Proposal | null {
    return this.engine.getProposal(proposalId);
  }

  /**
   * Cancel a proposal.
   */
  cancelProposal(proposalId: string, agentName: string): { success: boolean; error?: string } {
    return this.engine.cancelProposal(proposalId, agentName);
  }

  /**
   * Get consensus statistics.
   */
  getStats() {
    return this.engine.getStats();
  }

  /**
   * Cleanup resources.
   */
  cleanup(): void {
    this.engine.cleanup();
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Sync a proposal to the cloud dashboard.
   *
   * Auto-detects cloud settings from workspace env vars:
   * - CLOUD_API_URL / AGENT_RELAY_CLOUD_URL - cloud URL
   * - WORKSPACE_ID / AGENT_RELAY_WORKSPACE_ID - workspace ID
   * - WORKSPACE_TOKEN / AGENT_RELAY_API_KEY - auth token
   */
  private async syncToCloud(
    proposal: Proposal,
    event: 'created' | 'voted' | 'resolved' | 'expired' | 'cancelled'
  ): Promise<void> {
    // Get cloud sync settings - check workspace env vars first, then agent-relay vars
    const cloudUrl = this.config.cloudSync?.url
      || process.env.CLOUD_API_URL
      || process.env.AGENT_RELAY_CLOUD_URL;
    const workspaceId = this.config.cloudSync?.workspaceId
      || process.env.WORKSPACE_ID
      || process.env.AGENT_RELAY_WORKSPACE_ID;
    const token = this.config.cloudSync?.apiKey
      || process.env.WORKSPACE_TOKEN
      || process.env.AGENT_RELAY_API_KEY;

    // Skip if no cloud URL configured
    if (!cloudUrl) {
      return;
    }

    // Skip if no workspace ID
    if (!workspaceId) {
      return;
    }

    try {
      const url = `${cloudUrl}/api/daemons/consensus/sync`;

      // Build headers - token is optional for localhost
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ proposal, event, workspaceId }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.log(`Cloud sync failed: ${response.status} ${errorText}`);
      } else {
        this.log(`Cloud sync: ${event} for proposal ${proposal.id}`);
      }
    } catch (err) {
      // Don't fail on cloud sync errors - just log them
      this.log(`Cloud sync error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private setupEventHandlers(): void {
    // Broadcast new proposals to participants
    this.engine.on('proposal:created', (proposal: Proposal) => {
      if (this.config.autoBroadcast) {
        this.broadcastProposal(proposal);
      }
      // Sync to cloud dashboard
      this.syncToCloud(proposal, 'created');
    });

    // Notify participants when someone votes
    this.engine.on('proposal:voted', (proposal: Proposal, vote) => {
      this.log('Vote recorded', {
        proposalId: proposal.id,
        voter: vote.agent,
        value: vote.value,
      });

      // Sync updated proposal to cloud dashboard
      this.syncToCloud(proposal, 'voted');
    });

    // Broadcast results when resolved
    this.engine.on('proposal:resolved', (proposal: Proposal, result: ConsensusResult) => {
      this.log('Proposal resolved', {
        id: proposal.id,
        decision: result.decision,
        participation: `${(result.participation * 100).toFixed(1)}%`,
      });

      if (this.config.autoResultBroadcast) {
        this.broadcastResult(proposal, result);
      }

      // Sync resolved proposal to cloud dashboard
      this.syncToCloud(proposal, 'resolved');
    });

    // Log expired proposals
    this.engine.on('proposal:expired', (proposal: Proposal) => {
      this.log('Proposal expired', { id: proposal.id, title: proposal.title });
      // Sync expired proposal to cloud dashboard
      this.syncToCloud(proposal, 'expired');
    });

    // Log cancelled proposals
    this.engine.on('proposal:cancelled', (proposal: Proposal) => {
      this.log('Proposal cancelled', { id: proposal.id, title: proposal.title });
      // Sync cancelled proposal to cloud dashboard
      this.syncToCloud(proposal, 'cancelled');
    });
  }

  /**
   * Broadcast a proposal to all participants via the router.
   */
  private broadcastProposal(proposal: Proposal): void {
    const message = formatProposalMessage(proposal);

    for (const participant of proposal.participants) {
      this.sendToAgent(proposal.proposer, participant, message, proposal.thread);
    }

    this.log('Proposal broadcast', {
      id: proposal.id,
      recipients: proposal.participants.length,
    });
  }

  /**
   * Broadcast the result of a proposal to all participants.
   */
  private broadcastResult(proposal: Proposal, result: ConsensusResult): void {
    const message = formatResultMessage(proposal, result);

    // Send to proposer
    this.sendToAgent('_consensus', proposal.proposer, message, proposal.thread);

    // Send to all participants
    for (const participant of proposal.participants) {
      if (participant !== proposal.proposer) {
        this.sendToAgent('_consensus', participant, message, proposal.thread);
      }
    }

    this.log('Result broadcast', {
      id: proposal.id,
      decision: result.decision,
      recipients: proposal.participants.length,
    });
  }

  /**
   * Send a message to an agent via the router.
   */
  private sendToAgent(from: string, to: string, body: string, thread?: string): void {
    // Create a SEND envelope
    const envelope: SendEnvelope = {
      v: PROTOCOL_VERSION,
      type: 'SEND',
      id: generateId(),
      ts: Date.now(),
      from,
      to,
      payload: {
        kind: 'action',
        body,
        thread,
        data: {
          _isConsensusMessage: true,
          _consensusAction: 'proposal',
        },
      },
    };

    // Get the target connection and route
    const target = this.router.getConnection(to);
    if (target) {
      // Use a mock connection for system messages
      const mockFrom = {
        id: `consensus-${generateId()}`,
        agentName: from,
        sessionId: 'consensus-system',
        close: () => {},
        send: () => true,
        getNextSeq: () => 0,
      };

      // Route the message
      this.router.route(mockFrom, envelope);
    } else {
      this.log(`Target agent not connected: ${to}`);
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a consensus integration instance.
 */
export function createConsensusIntegration(
  router: Router,
  config?: Partial<ConsensusIntegrationConfig>
): ConsensusIntegration {
  return new ConsensusIntegration(router, config);
}

// =============================================================================
// Re-exports for convenience
// =============================================================================

export {
  ConsensusEngine,
  createConsensusEngine,
  formatProposalMessage,
  formatResultMessage,
  parseVoteCommand,
  parseProposalCommand,
  isConsensusCommand,
  type Proposal,
  type ConsensusResult,
  type ConsensusConfig,
  type VoteValue,
  type ConsensusType,
  type ParsedProposalCommand,
};
