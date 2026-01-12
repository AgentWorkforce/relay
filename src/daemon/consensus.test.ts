/**
 * Tests for Agent Consensus Mechanism
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ConsensusEngine,
  createConsensusEngine,
  formatProposalMessage,
  parseVoteCommand,
  formatResultMessage,
  type Proposal,
  type ConsensusResult,
} from './consensus.js';

// =============================================================================
// Test Setup
// =============================================================================

describe('ConsensusEngine', () => {
  let engine: ConsensusEngine;

  beforeEach(() => {
    engine = new ConsensusEngine({
      defaultTimeoutMs: 5000, // 5 seconds for tests
      autoResolve: true,
    });
  });

  afterEach(() => {
    engine.cleanup();
  });

  // ===========================================================================
  // Proposal Creation Tests
  // ===========================================================================

  describe('createProposal', () => {
    it('creates a proposal with required fields', () => {
      const proposal = engine.createProposal({
        title: 'Deploy to production',
        description: 'Should we deploy the new feature?',
        proposer: 'Lead',
        participants: ['Developer', 'Reviewer', 'QA'],
      });

      expect(proposal.id).toMatch(/^prop_/);
      expect(proposal.title).toBe('Deploy to production');
      expect(proposal.description).toBe('Should we deploy the new feature?');
      expect(proposal.proposer).toBe('Lead');
      expect(proposal.participants).toEqual(['Developer', 'Reviewer', 'QA']);
      expect(proposal.status).toBe('pending');
      expect(proposal.votes).toEqual([]);
      expect(proposal.consensusType).toBe('majority'); // Default
    });

    it('uses specified consensus type', () => {
      const proposal = engine.createProposal({
        title: 'Critical decision',
        description: 'Requires unanimous agreement',
        proposer: 'Lead',
        participants: ['Agent1', 'Agent2'],
        consensusType: 'unanimous',
      });

      expect(proposal.consensusType).toBe('unanimous');
    });

    it('sets expiry based on timeout', () => {
      const now = Date.now();
      const proposal = engine.createProposal({
        title: 'Test',
        description: 'Test',
        proposer: 'Lead',
        participants: ['Agent1'],
        timeoutMs: 10000,
      });

      expect(proposal.expiresAt).toBeGreaterThan(now);
      expect(proposal.expiresAt).toBeLessThanOrEqual(now + 10000 + 100);
    });

    it('generates unique thread ID', () => {
      const proposal = engine.createProposal({
        title: 'Test',
        description: 'Test',
        proposer: 'Lead',
        participants: ['Agent1'],
      });

      expect(proposal.thread).toMatch(/^consensus-prop_/);
    });

    it('emits proposal:created event', () => {
      const handler = vi.fn();
      engine.on('proposal:created', handler);

      const proposal = engine.createProposal({
        title: 'Test',
        description: 'Test',
        proposer: 'Lead',
        participants: ['Agent1'],
      });

      expect(handler).toHaveBeenCalledWith(proposal);
    });
  });

  // ===========================================================================
  // Voting Tests
  // ===========================================================================

  describe('vote', () => {
    let proposal: Proposal;

    beforeEach(() => {
      proposal = engine.createProposal({
        title: 'Test proposal',
        description: 'Vote on this',
        proposer: 'Lead',
        participants: ['Agent1', 'Agent2', 'Agent3'],
      });
    });

    it('accepts valid vote from participant', () => {
      const result = engine.vote(proposal.id, 'Agent1', 'approve', 'Looks good');

      expect(result.success).toBe(true);
      expect(result.proposal).toBeDefined();
      expect(result.proposal!.votes.length).toBe(1);
      expect(result.proposal!.votes[0].agent).toBe('Agent1');
      expect(result.proposal!.votes[0].value).toBe('approve');
      expect(result.proposal!.votes[0].reason).toBe('Looks good');
    });

    it('rejects vote from non-participant', () => {
      const result = engine.vote(proposal.id, 'Outsider', 'approve');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Agent not a participant');
    });

    it('rejects vote on non-existent proposal', () => {
      const result = engine.vote('fake-id', 'Agent1', 'approve');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Proposal not found');
    });

    it('allows vote change by default', () => {
      engine.vote(proposal.id, 'Agent1', 'approve');
      const result = engine.vote(proposal.id, 'Agent1', 'reject');

      expect(result.success).toBe(true);
      expect(result.proposal!.votes.length).toBe(1);
      expect(result.proposal!.votes[0].value).toBe('reject');
    });

    it('emits proposal:voted event', () => {
      const handler = vi.fn();
      engine.on('proposal:voted', handler);

      engine.vote(proposal.id, 'Agent1', 'approve');

      expect(handler).toHaveBeenCalled();
      const [emittedProposal, vote] = handler.mock.calls[0];
      expect(emittedProposal.id).toBe(proposal.id);
      expect(vote.agent).toBe('Agent1');
    });
  });

  // ===========================================================================
  // Majority Consensus Tests
  // ===========================================================================

  describe('majority consensus', () => {
    it('approves with majority approve votes', () => {
      const proposal = engine.createProposal({
        title: 'Test',
        description: 'Test',
        proposer: 'Lead',
        participants: ['A', 'B', 'C'],
        consensusType: 'majority',
      });

      engine.vote(proposal.id, 'A', 'approve');
      engine.vote(proposal.id, 'B', 'approve');
      engine.vote(proposal.id, 'C', 'reject');

      const result = engine.calculateResult(proposal);
      expect(result.decision).toBe('approved');
    });

    it('rejects with majority reject votes', () => {
      const proposal = engine.createProposal({
        title: 'Test',
        description: 'Test',
        proposer: 'Lead',
        participants: ['A', 'B', 'C'],
        consensusType: 'majority',
      });

      engine.vote(proposal.id, 'A', 'reject');
      engine.vote(proposal.id, 'B', 'reject');
      engine.vote(proposal.id, 'C', 'approve');

      const result = engine.calculateResult(proposal);
      expect(result.decision).toBe('rejected');
    });

    it('no consensus on tie', () => {
      const proposal = engine.createProposal({
        title: 'Test',
        description: 'Test',
        proposer: 'Lead',
        participants: ['A', 'B'],
        consensusType: 'majority',
      });

      engine.vote(proposal.id, 'A', 'approve');
      engine.vote(proposal.id, 'B', 'reject');

      const result = engine.calculateResult(proposal);
      expect(result.decision).toBe('no_consensus');
    });

    it('abstain does not count toward decision', () => {
      const proposal = engine.createProposal({
        title: 'Test',
        description: 'Test',
        proposer: 'Lead',
        participants: ['A', 'B', 'C'],
        consensusType: 'majority',
      });

      engine.vote(proposal.id, 'A', 'approve');
      engine.vote(proposal.id, 'B', 'reject');
      engine.vote(proposal.id, 'C', 'abstain');

      const result = engine.calculateResult(proposal);
      expect(result.decision).toBe('no_consensus'); // Tie on approve/reject
    });
  });

  // ===========================================================================
  // Unanimous Consensus Tests
  // ===========================================================================

  describe('unanimous consensus', () => {
    it('approves when all approve', () => {
      const proposal = engine.createProposal({
        title: 'Test',
        description: 'Test',
        proposer: 'Lead',
        participants: ['A', 'B', 'C'],
        consensusType: 'unanimous',
      });

      engine.vote(proposal.id, 'A', 'approve');
      engine.vote(proposal.id, 'B', 'approve');
      engine.vote(proposal.id, 'C', 'approve');

      const result = engine.calculateResult(proposal);
      expect(result.decision).toBe('approved');
    });

    it('rejects if any reject', () => {
      const proposal = engine.createProposal({
        title: 'Test',
        description: 'Test',
        proposer: 'Lead',
        participants: ['A', 'B', 'C'],
        consensusType: 'unanimous',
      });

      engine.vote(proposal.id, 'A', 'approve');
      engine.vote(proposal.id, 'B', 'approve');
      engine.vote(proposal.id, 'C', 'reject');

      const result = engine.calculateResult(proposal);
      expect(result.decision).toBe('rejected');
    });

    it('no consensus if not all voted', () => {
      const proposal = engine.createProposal({
        title: 'Test',
        description: 'Test',
        proposer: 'Lead',
        participants: ['A', 'B', 'C'],
        consensusType: 'unanimous',
      });

      engine.vote(proposal.id, 'A', 'approve');
      engine.vote(proposal.id, 'B', 'approve');
      // C has not voted

      const result = engine.calculateResult(proposal);
      expect(result.decision).toBe('no_consensus');
    });
  });

  // ===========================================================================
  // Supermajority Consensus Tests
  // ===========================================================================

  describe('supermajority consensus', () => {
    it('approves with 3/4 majority (exceeds threshold)', () => {
      const proposal = engine.createProposal({
        title: 'Test',
        description: 'Test',
        proposer: 'Lead',
        participants: ['A', 'B', 'C', 'D'],
        consensusType: 'supermajority',
      });

      engine.vote(proposal.id, 'A', 'approve');
      engine.vote(proposal.id, 'B', 'approve');
      engine.vote(proposal.id, 'C', 'approve');
      engine.vote(proposal.id, 'D', 'reject');

      const result = engine.calculateResult(proposal);
      // 3/4 = 0.75 >= 0.67 threshold
      expect(result.decision).toBe('approved');
    });

    it('rejected when reject ratio exceeds inverse threshold', () => {
      const proposal = engine.createProposal({
        title: 'Test',
        description: 'Test',
        proposer: 'Lead',
        participants: ['A', 'B', 'C', 'D'],
        consensusType: 'supermajority',
      });

      engine.vote(proposal.id, 'A', 'approve');
      engine.vote(proposal.id, 'B', 'approve');
      engine.vote(proposal.id, 'C', 'reject');
      engine.vote(proposal.id, 'D', 'reject');

      const result = engine.calculateResult(proposal);
      // 2/4 = 0.5 reject ratio > 0.33 (1 - 0.67 threshold)
      expect(result.decision).toBe('rejected');
    });

    it('respects custom threshold', () => {
      const proposal = engine.createProposal({
        title: 'Test',
        description: 'Test',
        proposer: 'Lead',
        participants: ['A', 'B', 'C', 'D'],
        consensusType: 'supermajority',
        threshold: 0.75,
      });

      engine.vote(proposal.id, 'A', 'approve');
      engine.vote(proposal.id, 'B', 'approve');
      engine.vote(proposal.id, 'C', 'approve');
      engine.vote(proposal.id, 'D', 'reject');

      const result = engine.calculateResult(proposal);
      // 3/4 = 0.75 >= 0.75
      expect(result.decision).toBe('approved');
    });
  });

  // ===========================================================================
  // Weighted Voting Tests
  // ===========================================================================

  describe('weighted consensus', () => {
    it('applies vote weights', () => {
      const proposal = engine.createProposal({
        title: 'Test',
        description: 'Test',
        proposer: 'Lead',
        participants: ['Lead', 'Junior1', 'Junior2'],
        consensusType: 'weighted',
        weights: [
          { agent: 'Lead', weight: 3, role: 'lead' },
          { agent: 'Junior1', weight: 1, role: 'junior' },
          { agent: 'Junior2', weight: 1, role: 'junior' },
        ],
      });

      // Vote juniors first to avoid auto-resolve when Lead votes
      engine.vote(proposal.id, 'Junior1', 'reject'); // Weight 1
      engine.vote(proposal.id, 'Junior2', 'reject'); // Weight 1
      engine.vote(proposal.id, 'Lead', 'approve'); // Weight 3

      const result = engine.calculateResult(proposal);
      // Approve: 3, Reject: 2 -> approved
      expect(result.decision).toBe('approved');
      expect(result.approveWeight).toBe(3);
      expect(result.rejectWeight).toBe(2);
    });

    it('defaults to weight 1 for unspecified agents', () => {
      const proposal = engine.createProposal({
        title: 'Test',
        description: 'Test',
        proposer: 'Lead',
        participants: ['Lead', 'Agent1'],
        consensusType: 'weighted',
        weights: [
          { agent: 'Lead', weight: 2 },
          // Agent1 not specified
        ],
      });

      // Vote Agent1 first to avoid auto-resolve when Lead votes
      engine.vote(proposal.id, 'Agent1', 'reject');
      engine.vote(proposal.id, 'Lead', 'approve');

      const result = engine.calculateResult(proposal);
      expect(result.approveWeight).toBe(2);
      expect(result.rejectWeight).toBe(1);
      expect(result.decision).toBe('approved');
    });
  });

  // ===========================================================================
  // Quorum Tests
  // ===========================================================================

  describe('quorum consensus', () => {
    it('requires quorum before majority', () => {
      const proposal = engine.createProposal({
        title: 'Test',
        description: 'Test',
        proposer: 'Lead',
        participants: ['A', 'B', 'C', 'D', 'E'],
        consensusType: 'quorum',
        quorum: 3,
      });

      engine.vote(proposal.id, 'A', 'approve');
      engine.vote(proposal.id, 'B', 'approve');
      // Only 2 votes, quorum is 3

      const result = engine.calculateResult(proposal);
      expect(result.quorumMet).toBe(false);
      expect(result.decision).toBe('no_consensus');
    });

    it('uses majority after quorum met', () => {
      const proposal = engine.createProposal({
        title: 'Test',
        description: 'Test',
        proposer: 'Lead',
        participants: ['A', 'B', 'C', 'D', 'E'],
        consensusType: 'quorum',
        quorum: 3,
      });

      engine.vote(proposal.id, 'A', 'approve');
      engine.vote(proposal.id, 'B', 'approve');
      engine.vote(proposal.id, 'C', 'reject');

      const result = engine.calculateResult(proposal);
      expect(result.quorumMet).toBe(true);
      expect(result.decision).toBe('approved');
    });
  });

  // ===========================================================================
  // Auto-Resolve Tests
  // ===========================================================================

  describe('auto-resolve', () => {
    it('resolves early when majority is certain', () => {
      const handler = vi.fn();
      engine.on('proposal:resolved', handler);

      const proposal = engine.createProposal({
        title: 'Test',
        description: 'Test',
        proposer: 'Lead',
        participants: ['A', 'B', 'C'],
        consensusType: 'majority',
      });

      engine.vote(proposal.id, 'A', 'approve');
      engine.vote(proposal.id, 'B', 'approve');
      // C hasn't voted but 2/3 is already majority

      // Should auto-resolve
      expect(handler).toHaveBeenCalled();
      const updated = engine.getProposal(proposal.id);
      expect(updated!.status).toBe('approved');
    });

    it('resolves early for unanimous when anyone rejects', () => {
      const handler = vi.fn();
      engine.on('proposal:resolved', handler);

      const proposal = engine.createProposal({
        title: 'Test',
        description: 'Test',
        proposer: 'Lead',
        participants: ['A', 'B', 'C'],
        consensusType: 'unanimous',
      });

      engine.vote(proposal.id, 'A', 'reject');
      // B and C haven't voted but unanimous is impossible now

      expect(handler).toHaveBeenCalled();
      const updated = engine.getProposal(proposal.id);
      expect(updated!.status).toBe('rejected');
    });
  });

  // ===========================================================================
  // Proposal Lifecycle Tests
  // ===========================================================================

  describe('proposal lifecycle', () => {
    it('expires proposal after timeout', async () => {
      const handler = vi.fn();
      engine.on('proposal:expired', handler);

      const shortEngine = new ConsensusEngine({ defaultTimeoutMs: 50 });
      const proposal = shortEngine.createProposal({
        title: 'Test',
        description: 'Test',
        proposer: 'Lead',
        participants: ['A'],
        timeoutMs: 50,
      });

      await new Promise(r => setTimeout(r, 100));

      const updated = shortEngine.getProposal(proposal.id);
      expect(updated!.status).toBe('expired');

      shortEngine.cleanup();
    });

    it('cancels proposal by proposer', () => {
      const handler = vi.fn();
      engine.on('proposal:cancelled', handler);

      const proposal = engine.createProposal({
        title: 'Test',
        description: 'Test',
        proposer: 'Lead',
        participants: ['A'],
      });

      const result = engine.cancelProposal(proposal.id, 'Lead');
      expect(result.success).toBe(true);

      const updated = engine.getProposal(proposal.id);
      expect(updated!.status).toBe('cancelled');
      expect(handler).toHaveBeenCalled();
    });

    it('only proposer can cancel', () => {
      const proposal = engine.createProposal({
        title: 'Test',
        description: 'Test',
        proposer: 'Lead',
        participants: ['Agent1'],
      });

      const result = engine.cancelProposal(proposal.id, 'Agent1');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Only proposer can cancel');
    });

    it('force resolves proposal', () => {
      const proposal = engine.createProposal({
        title: 'Test',
        description: 'Test',
        proposer: 'Lead',
        participants: ['A', 'B'],
      });

      engine.vote(proposal.id, 'A', 'approve');
      // B hasn't voted

      const result = engine.forceResolve(proposal.id);
      expect(result).not.toBeNull();
      // Force resolve uses current tally - more approves than rejects = approved
      expect(result!.decision).toBe('approved');
    });
  });

  // ===========================================================================
  // Query Tests
  // ===========================================================================

  describe('queries', () => {
    it('gets proposal by ID', () => {
      const proposal = engine.createProposal({
        title: 'Test',
        description: 'Test',
        proposer: 'Lead',
        participants: ['A'],
      });

      const retrieved = engine.getProposal(proposal.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(proposal.id);
    });

    it('returns null for non-existent ID', () => {
      const retrieved = engine.getProposal('fake-id');
      expect(retrieved).toBeNull();
    });

    it('gets proposals for agent', () => {
      engine.createProposal({
        title: 'Test 1',
        description: 'Test',
        proposer: 'Lead',
        participants: ['Agent1', 'Agent2'],
      });
      engine.createProposal({
        title: 'Test 2',
        description: 'Test',
        proposer: 'Agent1',
        participants: ['Lead'],
      });
      engine.createProposal({
        title: 'Test 3',
        description: 'Test',
        proposer: 'Other',
        participants: ['Other2'],
      });

      const forAgent1 = engine.getProposalsForAgent('Agent1');
      expect(forAgent1.length).toBe(2);
    });

    it('gets pending votes for agent', () => {
      const p1 = engine.createProposal({
        title: 'Test 1',
        description: 'Test',
        proposer: 'Lead',
        participants: ['Agent1', 'Agent2'],
      });
      const p2 = engine.createProposal({
        title: 'Test 2',
        description: 'Test',
        proposer: 'Lead',
        participants: ['Agent1'],
      });

      engine.vote(p1.id, 'Agent1', 'approve');

      const pending = engine.getPendingVotesForAgent('Agent1');
      expect(pending.length).toBe(1);
      expect(pending[0].id).toBe(p2.id);
    });
  });

  // ===========================================================================
  // Statistics Tests
  // ===========================================================================

  describe('getStats', () => {
    it('returns correct statistics', () => {
      const _p1 = engine.createProposal({
        title: 'Pending',
        description: 'Test',
        proposer: 'Lead',
        participants: ['A'],
      });

      const p2 = engine.createProposal({
        title: 'Approved',
        description: 'Test',
        proposer: 'Lead',
        participants: ['A', 'B', 'C'],
      });
      engine.vote(p2.id, 'A', 'approve');
      engine.vote(p2.id, 'B', 'approve');

      const stats = engine.getStats();

      expect(stats.total).toBe(2);
      expect(stats.pending).toBe(1);
      expect(stats.approved).toBe(1);
    });
  });
});

// =============================================================================
// Relay Integration Helpers Tests
// =============================================================================

describe('Relay Integration Helpers', () => {
  describe('formatProposalMessage', () => {
    it('formats proposal for broadcast', () => {
      const proposal: Proposal = {
        id: 'prop_123',
        title: 'Deploy feature',
        description: 'Should we deploy?',
        proposer: 'Lead',
        consensusType: 'majority',
        participants: ['Dev1', 'Dev2'],
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000,
        status: 'pending',
        votes: [],
        thread: 'consensus-prop_123',
      };

      const message = formatProposalMessage(proposal);

      expect(message).toContain('PROPOSAL: Deploy feature');
      expect(message).toContain('prop_123');
      expect(message).toContain('Lead');
      expect(message).toContain('majority');
      expect(message).toContain('Dev1, Dev2');
      expect(message).toContain('VOTE');
    });
  });

  describe('parseVoteCommand', () => {
    it('parses approve vote', () => {
      const result = parseVoteCommand('VOTE prop_123 approve');
      expect(result).not.toBeNull();
      expect(result!.proposalId).toBe('prop_123');
      expect(result!.value).toBe('approve');
      expect(result!.reason).toBeUndefined();
    });

    it('parses reject vote with reason', () => {
      const result = parseVoteCommand('VOTE prop_123 reject Needs more testing');
      expect(result).not.toBeNull();
      expect(result!.proposalId).toBe('prop_123');
      expect(result!.value).toBe('reject');
      expect(result!.reason).toBe('Needs more testing');
    });

    it('parses abstain vote', () => {
      const result = parseVoteCommand('VOTE prop_123 abstain');
      expect(result).not.toBeNull();
      expect(result!.value).toBe('abstain');
    });

    it('handles case insensitivity', () => {
      const result = parseVoteCommand('vote PROP_123 APPROVE');
      expect(result).not.toBeNull();
      expect(result!.value).toBe('approve');
    });

    it('returns null for invalid command', () => {
      expect(parseVoteCommand('not a vote')).toBeNull();
      expect(parseVoteCommand('VOTE')).toBeNull();
      expect(parseVoteCommand('VOTE prop_123')).toBeNull();
      expect(parseVoteCommand('VOTE prop_123 invalid')).toBeNull();
    });
  });

  describe('formatResultMessage', () => {
    it('formats approved result', () => {
      const proposal: Proposal = {
        id: 'prop_123',
        title: 'Deploy feature',
        description: 'Test',
        proposer: 'Lead',
        consensusType: 'majority',
        participants: ['A', 'B'],
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000,
        status: 'approved',
        votes: [],
      };

      const result: ConsensusResult = {
        decision: 'approved',
        approveWeight: 2,
        rejectWeight: 0,
        abstainWeight: 0,
        participation: 1.0,
        quorumMet: true,
        resolvedAt: Date.now(),
        nonVoters: [],
      };

      const message = formatResultMessage(proposal, result);

      expect(message).toContain('✅');
      expect(message).toContain('APPROVED');
      expect(message).toContain('100.0%');
    });

    it('formats rejected result', () => {
      const result: ConsensusResult = {
        decision: 'rejected',
        approveWeight: 1,
        rejectWeight: 2,
        abstainWeight: 0,
        participation: 1.0,
        quorumMet: true,
        resolvedAt: Date.now(),
        nonVoters: [],
      };

      const message = formatResultMessage({} as Proposal, result);

      expect(message).toContain('❌');
      expect(message).toContain('REJECTED');
    });

    it('includes non-voters', () => {
      const result: ConsensusResult = {
        decision: 'approved',
        approveWeight: 2,
        rejectWeight: 0,
        abstainWeight: 0,
        participation: 0.67,
        quorumMet: true,
        resolvedAt: Date.now(),
        nonVoters: ['Agent3'],
      };

      const message = formatResultMessage({} as Proposal, result);

      expect(message).toContain('Non-voters: Agent3');
    });
  });
});

// =============================================================================
// Factory Function Tests
// =============================================================================

describe('createConsensusEngine', () => {
  it('creates engine with default config', () => {
    const engine = createConsensusEngine();
    expect(engine).toBeInstanceOf(ConsensusEngine);
    engine.cleanup();
  });

  it('creates engine with custom config', () => {
    const engine = createConsensusEngine({
      defaultTimeoutMs: 10000,
      defaultConsensusType: 'unanimous',
    });

    const proposal = engine.createProposal({
      title: 'Test',
      description: 'Test',
      proposer: 'Lead',
      participants: ['A'],
    });

    expect(proposal.consensusType).toBe('unanimous');
    engine.cleanup();
  });
});
