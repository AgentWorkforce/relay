/**
 * Agent Consensus Mechanism
 *
 * Enables distributed decision-making across multiple agents.
 * Inspired by russian-code-ts roadmap: "Consensus-based decision making"
 *
 * Consensus Types:
 * 1. Majority Vote - Simple >50% agreement
 * 2. Supermajority - 2/3 or configurable threshold
 * 3. Unanimous - All participants must agree
 * 4. Weighted - Votes weighted by agent role/expertise
 * 5. Quorum - Minimum participation required
 *
 * Use Cases:
 * - Code review approval (2+ agents approve)
 * - Architecture decisions (lead + majority)
 * - Deployment gates (all critical agents agree)
 * - Task assignment (weighted by expertise)
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

// =============================================================================
// Types
// =============================================================================

export type ConsensusType =
  | 'majority'      // >50% agree
  | 'supermajority' // >=threshold agree (default 2/3)
  | 'unanimous'     // 100% agree
  | 'weighted'      // Weighted by role
  | 'quorum';       // Minimum participation + majority

export type VoteValue = 'approve' | 'reject' | 'abstain';

export type ProposalStatus =
  | 'pending'       // Awaiting votes
  | 'approved'      // Consensus reached (approved)
  | 'rejected'      // Consensus reached (rejected)
  | 'expired'       // Timeout without consensus
  | 'cancelled';    // Proposer cancelled

export interface AgentWeight {
  /** Agent name */
  agent: string;
  /** Vote weight (default: 1) */
  weight: number;
  /** Agent role for context */
  role?: string;
}

export interface Vote {
  /** Voting agent */
  agent: string;
  /** Vote value */
  value: VoteValue;
  /** Vote weight (resolved at vote time) */
  weight: number;
  /** Optional reasoning */
  reason?: string;
  /** Vote timestamp */
  timestamp: number;
}

export interface Proposal {
  /** Unique proposal ID */
  id: string;
  /** Proposal title/subject */
  title: string;
  /** Detailed description */
  description: string;
  /** Proposing agent */
  proposer: string;
  /** Consensus type required */
  consensusType: ConsensusType;
  /** Agents allowed to vote */
  participants: string[];
  /** Minimum votes required (for quorum) */
  quorum?: number;
  /** Threshold for supermajority (0-1, default 0.67) */
  threshold?: number;
  /** Agent weights (for weighted voting) */
  weights?: AgentWeight[];
  /** Proposal creation timestamp */
  createdAt: number;
  /** Expiry timestamp */
  expiresAt: number;
  /** Current status */
  status: ProposalStatus;
  /** Collected votes */
  votes: Vote[];
  /** Result details (set when resolved) */
  result?: ConsensusResult;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
  /** Thread ID for relay messages */
  thread?: string;
}

export interface ConsensusResult {
  /** Final decision */
  decision: 'approved' | 'rejected' | 'no_consensus';
  /** Total approve weight */
  approveWeight: number;
  /** Total reject weight */
  rejectWeight: number;
  /** Total abstain weight */
  abstainWeight: number;
  /** Participation rate (0-1) */
  participation: number;
  /** Whether quorum was met */
  quorumMet: boolean;
  /** Resolution timestamp */
  resolvedAt: number;
  /** Agents who didn't vote */
  nonVoters: string[];
}

export interface ConsensusConfig {
  /** Default proposal timeout in ms (default: 5 minutes) */
  defaultTimeoutMs: number;
  /** Default consensus type */
  defaultConsensusType: ConsensusType;
  /** Default supermajority threshold */
  defaultThreshold: number;
  /** Allow vote changes before resolution */
  allowVoteChange: boolean;
  /** Auto-resolve when consensus is mathematically certain */
  autoResolve: boolean;
  /** Broadcast proposals to all participants */
  broadcastProposals: boolean;
}

export interface ConsensusEvents {
  'proposal:created': (proposal: Proposal) => void;
  'proposal:voted': (proposal: Proposal, vote: Vote) => void;
  'proposal:resolved': (proposal: Proposal, result: ConsensusResult) => void;
  'proposal:expired': (proposal: Proposal) => void;
  'proposal:cancelled': (proposal: Proposal) => void;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: ConsensusConfig = {
  defaultTimeoutMs: 5 * 60 * 1000, // 5 minutes
  defaultConsensusType: 'majority',
  defaultThreshold: 0.67, // 2/3 for supermajority
  allowVoteChange: true,
  autoResolve: true,
  broadcastProposals: true,
};

// =============================================================================
// Consensus Engine
// =============================================================================

export class ConsensusEngine extends EventEmitter {
  private config: ConsensusConfig;
  private proposals: Map<string, Proposal> = new Map();
  private expiryTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(config: Partial<ConsensusConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ===========================================================================
  // Proposal Management
  // ===========================================================================

  /**
   * Create a new proposal.
   */
  createProposal(options: {
    title: string;
    description: string;
    proposer: string;
    participants: string[];
    consensusType?: ConsensusType;
    timeoutMs?: number;
    quorum?: number;
    threshold?: number;
    weights?: AgentWeight[];
    metadata?: Record<string, unknown>;
    thread?: string;
  }): Proposal {
    const id = `prop_${Date.now()}_${randomUUID().substring(0, 8)}`;
    const now = Date.now();
    const timeoutMs = options.timeoutMs ?? this.config.defaultTimeoutMs;

    const proposal: Proposal = {
      id,
      title: options.title,
      description: options.description,
      proposer: options.proposer,
      consensusType: options.consensusType ?? this.config.defaultConsensusType,
      participants: options.participants,
      quorum: options.quorum,
      threshold: options.threshold ?? this.config.defaultThreshold,
      weights: options.weights,
      createdAt: now,
      expiresAt: now + timeoutMs,
      status: 'pending',
      votes: [],
      metadata: options.metadata,
      thread: options.thread ?? `consensus-${id}`,
    };

    this.proposals.set(id, proposal);
    this.scheduleExpiry(proposal);

    this.emit('proposal:created', proposal);
    return proposal;
  }

  /**
   * Submit a vote on a proposal.
   */
  vote(
    proposalId: string,
    agent: string,
    value: VoteValue,
    reason?: string
  ): { success: boolean; error?: string; proposal?: Proposal } {
    const proposal = this.proposals.get(proposalId);

    if (!proposal) {
      return { success: false, error: 'Proposal not found' };
    }

    if (proposal.status !== 'pending') {
      return { success: false, error: `Proposal is ${proposal.status}` };
    }

    if (!proposal.participants.includes(agent)) {
      return { success: false, error: 'Agent not a participant' };
    }

    if (Date.now() > proposal.expiresAt) {
      this.expireProposal(proposal);
      return { success: false, error: 'Proposal has expired' };
    }

    // Check for existing vote
    const existingVoteIndex = proposal.votes.findIndex(v => v.agent === agent);
    if (existingVoteIndex >= 0) {
      if (!this.config.allowVoteChange) {
        return { success: false, error: 'Vote already cast and changes not allowed' };
      }
      // Remove existing vote
      proposal.votes.splice(existingVoteIndex, 1);
    }

    // Determine vote weight
    const weight = this.getAgentWeight(proposal, agent);

    const vote: Vote = {
      agent,
      value,
      weight,
      reason,
      timestamp: Date.now(),
    };

    proposal.votes.push(vote);
    this.emit('proposal:voted', proposal, vote);

    // Check for auto-resolution
    if (this.config.autoResolve) {
      const result = this.calculateResult(proposal);
      if (this.canResolveEarly(proposal, result)) {
        this.resolveProposal(proposal, result);
      }
    }

    return { success: true, proposal };
  }

  /**
   * Get a proposal by ID.
   */
  getProposal(proposalId: string): Proposal | null {
    return this.proposals.get(proposalId) ?? null;
  }

  /**
   * Get all proposals for an agent (as participant or proposer).
   */
  getProposalsForAgent(agent: string): Proposal[] {
    const results: Proposal[] = [];
    for (const proposal of this.proposals.values()) {
      if (proposal.proposer === agent || proposal.participants.includes(agent)) {
        results.push(proposal);
      }
    }
    return results;
  }

  /**
   * Get pending proposals awaiting an agent's vote.
   */
  getPendingVotesForAgent(agent: string): Proposal[] {
    const results: Proposal[] = [];
    for (const proposal of this.proposals.values()) {
      if (proposal.status !== 'pending') continue;
      if (!proposal.participants.includes(agent)) continue;
      if (proposal.votes.some(v => v.agent === agent)) continue;
      results.push(proposal);
    }
    return results;
  }

  /**
   * Cancel a proposal (only proposer can cancel).
   */
  cancelProposal(proposalId: string, agent: string): { success: boolean; error?: string } {
    const proposal = this.proposals.get(proposalId);

    if (!proposal) {
      return { success: false, error: 'Proposal not found' };
    }

    if (proposal.proposer !== agent) {
      return { success: false, error: 'Only proposer can cancel' };
    }

    if (proposal.status !== 'pending') {
      return { success: false, error: `Proposal is ${proposal.status}` };
    }

    proposal.status = 'cancelled';
    this.clearExpiryTimer(proposalId);
    this.emit('proposal:cancelled', proposal);

    return { success: true };
  }

  /**
   * Force resolve a proposal (for admin/system use).
   */
  forceResolve(proposalId: string): ConsensusResult | null {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== 'pending') return null;

    const result = this.calculateResult(proposal);
    this.resolveProposal(proposal, result);
    return result;
  }

  // ===========================================================================
  // Consensus Calculation
  // ===========================================================================

  /**
   * Calculate current consensus result.
   */
  calculateResult(proposal: Proposal): ConsensusResult {
    let approveWeight = 0;
    let rejectWeight = 0;
    let abstainWeight = 0;

    for (const vote of proposal.votes) {
      switch (vote.value) {
        case 'approve':
          approveWeight += vote.weight;
          break;
        case 'reject':
          rejectWeight += vote.weight;
          break;
        case 'abstain':
          abstainWeight += vote.weight;
          break;
      }
    }

    const totalWeight = this.getTotalWeight(proposal);
    const votedWeight = approveWeight + rejectWeight + abstainWeight;
    const participation = totalWeight > 0 ? votedWeight / totalWeight : 0;

    const voters = new Set(proposal.votes.map(v => v.agent));
    const nonVoters = proposal.participants.filter(p => !voters.has(p));

    // Check quorum
    const quorumRequired = proposal.quorum ?? Math.ceil(proposal.participants.length / 2);
    const quorumMet = proposal.votes.length >= quorumRequired;

    // Determine decision based on consensus type
    const decision = this.determineDecision(proposal, {
      approveWeight,
      rejectWeight,
      abstainWeight,
      totalWeight,
      votedWeight,
      quorumMet,
    });

    return {
      decision,
      approveWeight,
      rejectWeight,
      abstainWeight,
      participation,
      quorumMet,
      resolvedAt: Date.now(),
      nonVoters,
    };
  }

  /**
   * Determine decision based on consensus type and votes.
   */
  private determineDecision(
    proposal: Proposal,
    counts: {
      approveWeight: number;
      rejectWeight: number;
      abstainWeight: number;
      totalWeight: number;
      votedWeight: number;
      quorumMet: boolean;
    }
  ): 'approved' | 'rejected' | 'no_consensus' {
    const { approveWeight, rejectWeight, votedWeight, quorumMet } = counts;

    switch (proposal.consensusType) {
      case 'unanimous': {
        // All participants must approve - any reject makes it impossible
        const hasReject = proposal.votes.some(v => v.value === 'reject');
        if (hasReject) return 'rejected';
        if (proposal.votes.length < proposal.participants.length) {
          return 'no_consensus';
        }
        const allApprove = proposal.votes.every(v => v.value === 'approve');
        return allApprove ? 'approved' : 'rejected';
      }

      case 'supermajority': {
        const threshold = proposal.threshold ?? this.config.defaultThreshold;
        if (votedWeight === 0) return 'no_consensus';
        const approveRatio = approveWeight / votedWeight;
        if (approveRatio >= threshold) return 'approved';
        const rejectRatio = rejectWeight / votedWeight;
        if (rejectRatio > (1 - threshold)) return 'rejected';
        return 'no_consensus';
      }

      case 'quorum': {
        if (!quorumMet) return 'no_consensus';
        // Fall through to majority
      }
      // eslint-disable-next-line no-fallthrough
      case 'majority': {
        if (votedWeight === 0) return 'no_consensus';
        if (approveWeight > rejectWeight) return 'approved';
        if (rejectWeight > approveWeight) return 'rejected';
        return 'no_consensus'; // Tie
      }

      case 'weighted': {
        // Same as majority but weights are already applied
        if (votedWeight === 0) return 'no_consensus';
        if (approveWeight > rejectWeight) return 'approved';
        if (rejectWeight > approveWeight) return 'rejected';
        return 'no_consensus';
      }

      default:
        return 'no_consensus';
    }
  }

  /**
   * Check if proposal can be resolved early (consensus mathematically certain).
   */
  private canResolveEarly(proposal: Proposal, result: ConsensusResult): boolean {
    const totalWeight = this.getTotalWeight(proposal);
    const remainingWeight = totalWeight - (result.approveWeight + result.rejectWeight + result.abstainWeight);

    switch (proposal.consensusType) {
      case 'unanimous':
        // Can resolve early if anyone rejects
        return proposal.votes.some(v => v.value === 'reject') ||
               proposal.votes.length === proposal.participants.length;

      case 'supermajority': {
        const threshold = proposal.threshold ?? this.config.defaultThreshold;
        const votedWeight = result.approveWeight + result.rejectWeight + result.abstainWeight;
        // Approved if approve ratio already exceeds threshold
        if (votedWeight > 0 && result.approveWeight / votedWeight >= threshold) {
          // Check if remaining votes can't change outcome
          return (result.approveWeight / (votedWeight + remainingWeight)) >= threshold;
        }
        // Rejected if reject ratio exceeds (1 - threshold)
        if (votedWeight > 0 && result.rejectWeight / votedWeight > (1 - threshold)) {
          return true;
        }
        return false;
      }

      case 'majority':
      case 'weighted':
        // Can resolve if one side has >50% of total weight
        return result.approveWeight > totalWeight / 2 ||
               result.rejectWeight > totalWeight / 2;

      case 'quorum':
        // Need quorum first
        if (!result.quorumMet) return false;
        // Then same as majority
        return result.approveWeight > totalWeight / 2 ||
               result.rejectWeight > totalWeight / 2;

      default:
        return false;
    }
  }

  // ===========================================================================
  // Weight Management
  // ===========================================================================

  /**
   * Get weight for an agent in a proposal.
   */
  private getAgentWeight(proposal: Proposal, agent: string): number {
    if (proposal.weights) {
      const weightConfig = proposal.weights.find(w => w.agent === agent);
      if (weightConfig) return weightConfig.weight;
    }
    return 1; // Default weight
  }

  /**
   * Get total weight of all participants.
   */
  private getTotalWeight(proposal: Proposal): number {
    let total = 0;
    for (const participant of proposal.participants) {
      total += this.getAgentWeight(proposal, participant);
    }
    return total;
  }

  // ===========================================================================
  // Lifecycle Management
  // ===========================================================================

  /**
   * Resolve a proposal with result.
   */
  private resolveProposal(proposal: Proposal, result: ConsensusResult): void {
    proposal.status = result.decision === 'approved' ? 'approved' :
                      result.decision === 'rejected' ? 'rejected' : 'expired';
    proposal.result = result;
    this.clearExpiryTimer(proposal.id);
    this.emit('proposal:resolved', proposal, result);
  }

  /**
   * Expire a proposal.
   */
  private expireProposal(proposal: Proposal): void {
    if (proposal.status !== 'pending') return;

    const result = this.calculateResult(proposal);
    proposal.status = 'expired';
    proposal.result = result;
    this.clearExpiryTimer(proposal.id);
    this.emit('proposal:expired', proposal);
  }

  /**
   * Schedule expiry timer for a proposal.
   */
  private scheduleExpiry(proposal: Proposal): void {
    const timeoutMs = proposal.expiresAt - Date.now();
    if (timeoutMs <= 0) {
      this.expireProposal(proposal);
      return;
    }

    const timer = setTimeout(() => {
      this.expireProposal(proposal);
    }, timeoutMs);

    timer.unref(); // Don't prevent process exit
    this.expiryTimers.set(proposal.id, timer);
  }

  /**
   * Clear expiry timer for a proposal.
   */
  private clearExpiryTimer(proposalId: string): void {
    const timer = this.expiryTimers.get(proposalId);
    if (timer) {
      clearTimeout(timer);
      this.expiryTimers.delete(proposalId);
    }
  }

  /**
   * Cleanup all timers (for shutdown).
   */
  cleanup(): void {
    for (const timer of this.expiryTimers.values()) {
      clearTimeout(timer);
    }
    this.expiryTimers.clear();
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  /**
   * Get consensus statistics.
   */
  getStats(): {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    expired: number;
    cancelled: number;
    avgParticipation: number;
  } {
    let pending = 0, approved = 0, rejected = 0, expired = 0, cancelled = 0;
    let totalParticipation = 0;
    let resolvedCount = 0;

    for (const proposal of this.proposals.values()) {
      switch (proposal.status) {
        case 'pending': pending++; break;
        case 'approved': approved++; break;
        case 'rejected': rejected++; break;
        case 'expired': expired++; break;
        case 'cancelled': cancelled++; break;
      }

      if (proposal.result) {
        totalParticipation += proposal.result.participation;
        resolvedCount++;
      }
    }

    return {
      total: this.proposals.size,
      pending,
      approved,
      rejected,
      expired,
      cancelled,
      avgParticipation: resolvedCount > 0 ? totalParticipation / resolvedCount : 0,
    };
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a consensus engine with the given configuration.
 */
export function createConsensusEngine(config?: Partial<ConsensusConfig>): ConsensusEngine {
  return new ConsensusEngine(config);
}

// =============================================================================
// Relay Integration Helpers
// =============================================================================

/**
 * Format a proposal as a relay message for broadcasting.
 */
export function formatProposalMessage(proposal: Proposal): string {
  const lines = [
    `📋 **PROPOSAL: ${proposal.title}**`,
    `ID: ${proposal.id}`,
    `From: ${proposal.proposer}`,
    `Type: ${proposal.consensusType}`,
    `Expires: ${new Date(proposal.expiresAt).toISOString()}`,
    '',
    proposal.description,
    '',
    `Participants: ${proposal.participants.join(', ')}`,
    '',
    'Reply with: VOTE <proposal-id> <approve|reject|abstain> [reason]',
  ];

  return lines.join('\n');
}

/**
 * Parse a vote command from a relay message.
 */
export function parseVoteCommand(message: string): {
  proposalId: string;
  value: VoteValue;
  reason?: string;
} | null {
  const match = message.match(/^VOTE\s+(\S+)\s+(approve|reject|abstain)(?:\s+(.+))?$/i);
  if (!match) return null;

  return {
    proposalId: match[1],
    value: match[2].toLowerCase() as VoteValue,
    reason: match[3]?.trim(),
  };
}

/**
 * Format a consensus result as a relay message.
 */
export function formatResultMessage(proposal: Proposal, result: ConsensusResult): string {
  const statusEmoji = result.decision === 'approved' ? '✅' :
                      result.decision === 'rejected' ? '❌' : '⏳';

  const lines = [
    `${statusEmoji} **CONSENSUS RESULT: ${proposal.title}**`,
    `Decision: ${result.decision.toUpperCase()}`,
    `Participation: ${(result.participation * 100).toFixed(1)}%`,
    '',
    `Approve: ${result.approveWeight} | Reject: ${result.rejectWeight} | Abstain: ${result.abstainWeight}`,
  ];

  if (result.nonVoters.length > 0) {
    lines.push(`Non-voters: ${result.nonVoters.join(', ')}`);
  }

  return lines.join('\n');
}

// =============================================================================
// Proposal Command Parsing
// =============================================================================

export interface ParsedProposalCommand {
  title: string;
  description: string;
  participants: string[];
  consensusType: ConsensusType;
  timeoutMs?: number;
  quorum?: number;
  threshold?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Parse a PROPOSE command from a relay message.
 *
 * Format:
 * ```
 * PROPOSE: Title of the proposal
 * TYPE: majority|supermajority|unanimous|weighted|quorum
 * PARTICIPANTS: Agent1, Agent2, Agent3
 * DESCRIPTION: Detailed description of what is being proposed
 * TIMEOUT: 3600000 (optional, in milliseconds)
 * QUORUM: 3 (optional, minimum votes)
 * THRESHOLD: 0.67 (optional, for supermajority)
 * ```
 */
export function parseProposalCommand(message: string): ParsedProposalCommand | null {
  // Check if message starts with PROPOSE:
  if (!message.trim().startsWith('PROPOSE:')) {
    return null;
  }

  const lines = message.split('\n').map(line => line.trim());

  // Parse each field
  let title: string | undefined;
  let description: string | undefined;
  let participants: string[] | undefined;
  let consensusType: ConsensusType = 'majority';
  let timeoutMs: number | undefined;
  let quorum: number | undefined;
  let threshold: number | undefined;

  let inDescription = false;
  const descriptionLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('PROPOSE:')) {
      title = line.substring('PROPOSE:'.length).trim();
      inDescription = false;
    } else if (line.startsWith('TYPE:')) {
      const type = line.substring('TYPE:'.length).trim().toLowerCase();
      if (['majority', 'supermajority', 'unanimous', 'weighted', 'quorum'].includes(type)) {
        consensusType = type as ConsensusType;
      }
      inDescription = false;
    } else if (line.startsWith('PARTICIPANTS:')) {
      const participantStr = line.substring('PARTICIPANTS:'.length).trim();
      participants = participantStr.split(',').map(p => p.trim()).filter(p => p.length > 0);
      inDescription = false;
    } else if (line.startsWith('DESCRIPTION:')) {
      description = line.substring('DESCRIPTION:'.length).trim();
      inDescription = true;
    } else if (line.startsWith('TIMEOUT:')) {
      const val = parseInt(line.substring('TIMEOUT:'.length).trim(), 10);
      if (!isNaN(val) && val > 0) {
        timeoutMs = val;
      }
      inDescription = false;
    } else if (line.startsWith('QUORUM:')) {
      const val = parseInt(line.substring('QUORUM:'.length).trim(), 10);
      if (!isNaN(val) && val > 0) {
        quorum = val;
      }
      inDescription = false;
    } else if (line.startsWith('THRESHOLD:')) {
      const val = parseFloat(line.substring('THRESHOLD:'.length).trim());
      if (!isNaN(val) && val > 0 && val <= 1) {
        threshold = val;
      }
      inDescription = false;
    } else if (inDescription && line.length > 0) {
      // Continue collecting description lines
      descriptionLines.push(line);
    }
  }

  // Append continuation lines to description
  if (descriptionLines.length > 0 && description) {
    description = description + '\n' + descriptionLines.join('\n');
  }

  // Validate required fields
  if (!title || !participants || participants.length === 0) {
    return null;
  }

  // Default description if not provided
  if (!description) {
    description = title;
  }

  return {
    title,
    description,
    participants,
    consensusType,
    timeoutMs,
    quorum,
    threshold,
  };
}

/**
 * Check if a message is a consensus command (PROPOSE or VOTE).
 */
export function isConsensusCommand(message: string): boolean {
  const trimmed = message.trim();
  return trimmed.startsWith('PROPOSE:') || /^VOTE\s+/i.test(trimmed);
}
