/**
 * Consensus / voting engine for distributed agent decision-making.
 *
 * Runs entirely in the SDK process — no broker protocol extension needed.
 * Proposals are broadcast and votes collected via the relay messaging layer.
 *
 * Consensus types:
 * - majority   — simple >50%
 * - supermajority — configurable threshold (default 2/3)
 * - unanimous  — all participants must approve
 * - weighted   — votes weighted by agent role/expertise
 * - quorum     — minimum participation + majority
 */

import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

// Re-export all types and pure helpers so consumers can import everything
// from "consensus.js" without needing to know about the split.
export type {
  ConsensusType,
  VoteValue,
  ProposalStatus,
  AgentWeight,
  Vote,
  Proposal,
  ConsensusResult,
  ConsensusConfig,
  ConsensusEvents,
  ParsedProposalCommand,
} from "./consensus-helpers.js";

export {
  formatProposalMessage,
  formatResultMessage,
  parseVoteCommand,
  isConsensusCommand,
  parseProposalCommand,
} from "./consensus-helpers.js";

import type {
  ConsensusType,
  VoteValue,
  AgentWeight,
  Vote,
  Proposal,
  ConsensusResult,
  ConsensusConfig,
} from "./consensus-helpers.js";

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ConsensusConfig = {
  defaultTimeoutMs: 5 * 60 * 1000,
  defaultConsensusType: "majority",
  defaultThreshold: 0.67,
  allowVoteChange: true,
  autoResolve: true,
  maxRetainedProposals: 100,
};

// ── Engine ───────────────────────────────────────────────────────────────────

export class ConsensusEngine extends EventEmitter {
  private config: ConsensusConfig;
  private proposals = new Map<string, Proposal>();
  private expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(config: Partial<ConsensusConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Proposal management ──────────────────────────────────────────────────

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
    const id = `prop_${Date.now()}_${randomBytes(4).toString("hex")}`;
    const now = Date.now();
    const timeoutMs = options.timeoutMs ?? this.config.defaultTimeoutMs;

    const proposal: Proposal = {
      id,
      title: options.title,
      description: options.description,
      proposer: options.proposer,
      consensusType:
        options.consensusType ?? this.config.defaultConsensusType,
      participants: options.participants,
      quorum: options.quorum,
      threshold: options.threshold ?? this.config.defaultThreshold,
      weights: options.weights,
      createdAt: now,
      expiresAt: now + timeoutMs,
      status: "pending",
      votes: [],
      metadata: options.metadata,
      thread: options.thread ?? `consensus-${id}`,
    };

    this.proposals.set(id, proposal);
    this.scheduleExpiry(proposal);
    this.emit("proposal:created", proposal);
    return proposal;
  }

  vote(
    proposalId: string,
    agent: string,
    value: VoteValue,
    reason?: string,
  ): { success: boolean; error?: string; proposal?: Proposal } {
    const proposal = this.proposals.get(proposalId);

    if (!proposal) return { success: false, error: "Proposal not found" };
    if (proposal.status !== "pending")
      return { success: false, error: `Proposal is ${proposal.status}` };
    if (!proposal.participants.includes(agent))
      return { success: false, error: "Agent not a participant" };
    if (Date.now() > proposal.expiresAt) {
      this.expireProposal(proposal);
      return { success: false, error: "Proposal has expired" };
    }

    const existingIdx = proposal.votes.findIndex((v) => v.agent === agent);
    if (existingIdx >= 0) {
      if (!this.config.allowVoteChange)
        return {
          success: false,
          error: "Vote already cast and changes not allowed",
        };
      proposal.votes.splice(existingIdx, 1);
    }

    const weight = this.getAgentWeight(proposal, agent);
    const vote: Vote = { agent, value, weight, reason, timestamp: Date.now() };

    proposal.votes.push(vote);
    this.emit("proposal:voted", proposal, vote);

    if (this.config.autoResolve) {
      const result = this.calculateResult(proposal);
      if (this.canResolveEarly(proposal, result)) {
        this.resolveProposal(proposal, result);
      }
    }

    return { success: true, proposal };
  }

  getProposal(proposalId: string): Proposal | null {
    return this.proposals.get(proposalId) ?? null;
  }

  getProposalsForAgent(agent: string): Proposal[] {
    const out: Proposal[] = [];
    for (const p of this.proposals.values()) {
      if (p.proposer === agent || p.participants.includes(agent)) out.push(p);
    }
    return out;
  }

  getPendingVotesForAgent(agent: string): Proposal[] {
    const out: Proposal[] = [];
    for (const p of this.proposals.values()) {
      if (p.status !== "pending") continue;
      if (!p.participants.includes(agent)) continue;
      if (p.votes.some((v) => v.agent === agent)) continue;
      out.push(p);
    }
    return out;
  }

  cancelProposal(
    proposalId: string,
    agent: string,
  ): { success: boolean; error?: string } {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return { success: false, error: "Proposal not found" };
    if (proposal.proposer !== agent)
      return { success: false, error: "Only proposer can cancel" };
    if (proposal.status !== "pending")
      return { success: false, error: `Proposal is ${proposal.status}` };

    proposal.status = "cancelled";
    this.clearExpiryTimer(proposalId);
    this.emit("proposal:cancelled", proposal);
    this.evictOldProposals();
    return { success: true };
  }

  forceResolve(proposalId: string): ConsensusResult | null {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== "pending") return null;
    const result = this.calculateResult(proposal);
    this.resolveProposal(proposal, result);
    return result;
  }

  // ── Calculation ──────────────────────────────────────────────────────────

  calculateResult(proposal: Proposal): ConsensusResult {
    let approveWeight = 0;
    let rejectWeight = 0;
    let abstainWeight = 0;

    for (const v of proposal.votes) {
      if (v.value === "approve") approveWeight += v.weight;
      else if (v.value === "reject") rejectWeight += v.weight;
      else abstainWeight += v.weight;
    }

    const totalWeight = this.getTotalWeight(proposal);
    const votedWeight = approveWeight + rejectWeight + abstainWeight;
    const participation = totalWeight > 0 ? votedWeight / totalWeight : 0;

    const voters = new Set(proposal.votes.map((v) => v.agent));
    const nonVoters = proposal.participants.filter((p) => !voters.has(p));

    const quorumRequired =
      proposal.quorum ?? Math.ceil(proposal.participants.length / 2);
    const quorumMet = proposal.votes.length >= quorumRequired;

    const decision = this.determineDecision(proposal, {
      approveWeight,
      rejectWeight,
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

  private determineDecision(
    proposal: Proposal,
    counts: {
      approveWeight: number;
      rejectWeight: number;
      votedWeight: number;
      quorumMet: boolean;
    },
  ): "approved" | "rejected" | "no_consensus" {
    const { approveWeight, rejectWeight, votedWeight, quorumMet } = counts;

    switch (proposal.consensusType) {
      case "unanimous": {
        if (proposal.votes.some((v) => v.value === "reject")) return "rejected";
        if (proposal.votes.length < proposal.participants.length)
          return "no_consensus";
        return proposal.votes.every((v) => v.value === "approve")
          ? "approved"
          : "rejected";
      }

      case "supermajority": {
        const threshold = proposal.threshold ?? this.config.defaultThreshold;
        if (votedWeight === 0) return "no_consensus";
        if (approveWeight / votedWeight >= threshold) return "approved";
        if (rejectWeight / votedWeight > 1 - threshold) return "rejected";
        return "no_consensus";
      }

      case "quorum": {
        if (!quorumMet) return "no_consensus";
        // fall through to majority
      }
      // eslint-disable-next-line no-fallthrough
      case "majority": {
        if (votedWeight === 0) return "no_consensus";
        if (approveWeight > rejectWeight) return "approved";
        if (rejectWeight > approveWeight) return "rejected";
        return "no_consensus";
      }

      case "weighted": {
        if (votedWeight === 0) return "no_consensus";
        if (approveWeight > rejectWeight) return "approved";
        if (rejectWeight > approveWeight) return "rejected";
        return "no_consensus";
      }

      default:
        return "no_consensus";
    }
  }

  private canResolveEarly(
    proposal: Proposal,
    result: ConsensusResult,
  ): boolean {
    const totalWeight = this.getTotalWeight(proposal);
    const remainingWeight =
      totalWeight -
      (result.approveWeight + result.rejectWeight + result.abstainWeight);

    switch (proposal.consensusType) {
      case "unanimous":
        return (
          proposal.votes.some((v) => v.value === "reject") ||
          proposal.votes.length === proposal.participants.length
        );

      case "supermajority": {
        const threshold = proposal.threshold ?? this.config.defaultThreshold;
        const votedWeight =
          result.approveWeight + result.rejectWeight + result.abstainWeight;
        if (
          votedWeight > 0 &&
          result.approveWeight / votedWeight >= threshold
        ) {
          return (
            result.approveWeight / (votedWeight + remainingWeight) >= threshold
          );
        }
        if (
          votedWeight > 0 &&
          result.rejectWeight / votedWeight > 1 - threshold
        ) {
          return true;
        }
        return false;
      }

      case "majority":
      case "weighted":
        return (
          result.approveWeight > totalWeight / 2 ||
          result.rejectWeight > totalWeight / 2
        );

      case "quorum":
        if (!result.quorumMet) return false;
        return (
          result.approveWeight > totalWeight / 2 ||
          result.rejectWeight > totalWeight / 2
        );

      default:
        return false;
    }
  }

  // ── Weight helpers ───────────────────────────────────────────────────────

  private getAgentWeight(proposal: Proposal, agent: string): number {
    if (proposal.weights) {
      const w = proposal.weights.find((w) => w.agent === agent);
      if (w) return w.weight;
    }
    return 1;
  }

  private getTotalWeight(proposal: Proposal): number {
    let total = 0;
    for (const p of proposal.participants) {
      total += this.getAgentWeight(proposal, p);
    }
    return total;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  private resolveProposal(
    proposal: Proposal,
    result: ConsensusResult,
  ): void {
    proposal.status =
      result.decision === "approved"
        ? "approved"
        : result.decision === "rejected"
          ? "rejected"
          : "rejected"; // no_consensus maps to rejected (not expired — that's for timeouts)
    proposal.result = result;
    this.clearExpiryTimer(proposal.id);
    this.emit("proposal:resolved", proposal, result);
    this.evictOldProposals();
  }

  private expireProposal(proposal: Proposal): void {
    if (proposal.status !== "pending") return;
    const result = this.calculateResult(proposal);
    proposal.status = "expired";
    proposal.result = result;
    this.clearExpiryTimer(proposal.id);
    this.emit("proposal:expired", proposal);
    this.evictOldProposals();
  }

  private scheduleExpiry(proposal: Proposal): void {
    const timeoutMs = proposal.expiresAt - Date.now();
    if (timeoutMs <= 0) {
      this.expireProposal(proposal);
      return;
    }
    const timer = setTimeout(() => this.expireProposal(proposal), timeoutMs);
    timer.unref();
    this.expiryTimers.set(proposal.id, timer);
  }

  private clearExpiryTimer(proposalId: string): void {
    const timer = this.expiryTimers.get(proposalId);
    if (timer) {
      clearTimeout(timer);
      this.expiryTimers.delete(proposalId);
    }
  }

  /** Remove oldest resolved/expired/cancelled proposals when over the limit. */
  private evictOldProposals(): void {
    const max = this.config.maxRetainedProposals;
    if (max <= 0) return; // unlimited

    const terminal: Proposal[] = [];
    for (const p of this.proposals.values()) {
      if (p.status !== "pending") terminal.push(p);
    }

    if (terminal.length <= max) return;

    // Sort oldest-first by createdAt, evict the excess
    terminal.sort((a, b) => a.createdAt - b.createdAt);
    const toEvict = terminal.length - max;
    for (let i = 0; i < toEvict; i++) {
      this.proposals.delete(terminal[i].id);
    }
  }

  cleanup(): void {
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
  }

  // ── Stats ────────────────────────────────────────────────────────────────

  getStats(): {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    expired: number;
    cancelled: number;
    avgParticipation: number;
  } {
    let pending = 0,
      approved = 0,
      rejected = 0,
      expired = 0,
      cancelled = 0;
    let totalParticipation = 0;
    let resolvedCount = 0;

    for (const p of this.proposals.values()) {
      if (p.status === "pending") pending++;
      else if (p.status === "approved") approved++;
      else if (p.status === "rejected") rejected++;
      else if (p.status === "expired") expired++;
      else if (p.status === "cancelled") cancelled++;

      if (p.result) {
        totalParticipation += p.result.participation;
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
      avgParticipation:
        resolvedCount > 0 ? totalParticipation / resolvedCount : 0,
    };
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createConsensusEngine(
  config?: Partial<ConsensusConfig>,
): ConsensusEngine {
  return new ConsensusEngine(config);
}
