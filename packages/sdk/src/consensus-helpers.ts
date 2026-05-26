/**
 * Consensus types and pure helper functions.
 *
 * This module has ZERO Node.js dependencies — safe for browser use.
 * The ConsensusEngine class (which needs node:crypto and node:events)
 * lives in consensus.ts.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type ConsensusType = 'majority' | 'supermajority' | 'unanimous' | 'weighted' | 'quorum';

export type VoteValue = 'approve' | 'reject' | 'abstain';

export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';

export interface AgentWeight {
  agent: string;
  weight: number;
  role?: string;
}

export interface Vote {
  agent: string;
  value: VoteValue;
  weight: number;
  reason?: string;
  timestamp: number;
}

export interface Proposal {
  id: string;
  title: string;
  description: string;
  proposer: string;
  consensusType: ConsensusType;
  participants: string[];
  quorum?: number;
  threshold?: number;
  weights?: AgentWeight[];
  createdAt: number;
  expiresAt: number;
  status: ProposalStatus;
  votes: Vote[];
  result?: ConsensusResult;
  metadata?: Record<string, unknown>;
  thread?: string;
}

export interface ConsensusResult {
  decision: 'approved' | 'rejected' | 'no_consensus';
  approveWeight: number;
  rejectWeight: number;
  abstainWeight: number;
  participation: number;
  quorumMet: boolean;
  resolvedAt: number;
  nonVoters: string[];
}

export interface ConsensusConfig {
  /** Default proposal timeout in ms (default: 5 min) */
  defaultTimeoutMs: number;
  defaultConsensusType: ConsensusType;
  /** Supermajority threshold (0–1, default 0.67) */
  defaultThreshold: number;
  allowVoteChange: boolean;
  /** Auto-resolve when outcome is mathematically certain */
  autoResolve: boolean;
  /** Max resolved/expired/cancelled proposals to retain. Oldest are evicted
   *  when this limit is exceeded. 0 = unlimited. Default: 100. */
  maxRetainedProposals: number;
}

export interface ConsensusEvents {
  'proposal:created': (proposal: Proposal) => void;
  'proposal:voted': (proposal: Proposal, vote: Vote) => void;
  'proposal:resolved': (proposal: Proposal, result: ConsensusResult) => void;
  'proposal:expired': (proposal: Proposal) => void;
  'proposal:cancelled': (proposal: Proposal) => void;
}

export interface ParsedProposalCommand {
  title: string;
  description: string;
  participants: string[];
  consensusType: ConsensusType;
  timeoutMs?: number;
  quorum?: number;
  threshold?: number;
}

// ── Pure helper functions (no Node.js deps) ──────────────────────────────────

export function formatProposalMessage(proposal: Proposal): string {
  return [
    `PROPOSAL: ${proposal.title}`,
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
  ].join('\n');
}

export function formatResultMessage(proposal: Proposal, result: ConsensusResult): string {
  const lines = [
    `CONSENSUS RESULT: ${proposal.title}`,
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

export function parseVoteCommand(
  message: string
): { proposalId: string; value: VoteValue; reason?: string } | null {
  const trimmed = message.trim();
  if (!trimmed.toUpperCase().startsWith('VOTE ')) return null;

  // Split into at most 4 parts: "VOTE", proposalId, value, reason...
  const parts = trimmed.split(/\s+/);
  if (parts.length < 3) return null;

  const proposalId = parts[1];
  const rawValue = parts[2].toLowerCase();
  if (rawValue !== 'approve' && rawValue !== 'reject' && rawValue !== 'abstain') {
    return null;
  }

  const reason = parts.length > 3 ? parts.slice(3).join(' ') : undefined;
  return { proposalId, value: rawValue, reason };
}

export function isConsensusCommand(message: string): boolean {
  const trimmed = message.trim();
  return trimmed.startsWith('PROPOSE:') || trimmed.toUpperCase().startsWith('VOTE ');
}

/**
 * Parse a PROPOSE command from a relay message.
 *
 * Format:
 * ```
 * PROPOSE: Title of the proposal
 * TYPE: majority|supermajority|unanimous|weighted|quorum
 * PARTICIPANTS: Agent1, Agent2, Agent3
 * DESCRIPTION: Detailed description
 * TIMEOUT: 3600000 (optional, ms)
 * QUORUM: 3 (optional)
 * THRESHOLD: 0.67 (optional)
 * ```
 */
export function parseProposalCommand(message: string): ParsedProposalCommand | null {
  if (!message.trim().startsWith('PROPOSE:')) return null;

  const lines = message.split('\n').map((l) => l.trim());

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
      const str = line.substring('PARTICIPANTS:'.length).trim();
      participants = str
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      inDescription = false;
    } else if (line.startsWith('DESCRIPTION:')) {
      description = line.substring('DESCRIPTION:'.length).trim();
      inDescription = true;
    } else if (line.startsWith('TIMEOUT:')) {
      const val = parseInt(line.substring('TIMEOUT:'.length).trim(), 10);
      if (!isNaN(val) && val > 0) timeoutMs = val;
      inDescription = false;
    } else if (line.startsWith('QUORUM:')) {
      const val = parseInt(line.substring('QUORUM:'.length).trim(), 10);
      if (!isNaN(val) && val > 0) quorum = val;
      inDescription = false;
    } else if (line.startsWith('THRESHOLD:')) {
      const val = parseFloat(line.substring('THRESHOLD:'.length).trim());
      if (!isNaN(val) && val > 0 && val <= 1) threshold = val;
      inDescription = false;
    } else if (inDescription && line.length > 0) {
      descriptionLines.push(line);
    }
  }

  if (descriptionLines.length > 0 && description) {
    description = description + '\n' + descriptionLines.join('\n');
  }

  if (!title || !participants || participants.length === 0) return null;
  if (!description) description = title;

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
