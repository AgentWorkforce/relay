/**
 * Enhanced Features Integration Module
 *
 * Wires together the new performance and reliability features:
 * - Precompiled regex patterns
 * - Agent authentication with signing
 * - Dead Letter Queue
 * - Context compaction
 * - Consensus mechanism
 *
 * This module provides a unified interface for integrating
 * these features into the existing daemon and router.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import type { Pool as PgPool } from 'pg';

// Import new modules
import {
  getCompiledPatterns,
  isInstructionalTextFast,
  isPlaceholderTargetFast,
  stripAnsiFast,
  StaticPatterns,
} from '../utils/precompiled-patterns.js';

import {
  AgentSigningManager,
  loadSigningConfig,
  attachSignature,
  extractSignature,
  type AgentSigningConfig,
  type SignedMessage,
} from './agent-signing.js';

import {
  SQLiteDLQAdapter,
  PostgresDLQAdapter,
  InMemoryDLQAdapter,
  createDLQAdapter,
  DEFAULT_DLQ_CONFIG,
  type DLQStorageAdapter,
  type DLQConfig,
  type DeadLetter,
  type DLQStats,
} from '../storage/dlq-adapter.js';

import {
  ContextCompactor,
  createContextCompactor,
  estimateTokens,
  estimateContextTokens,
  formatTokenCount,
  type Message,
  type CompactionConfig,
  type CompactionResult,
} from '../memory/context-compaction.js';

import {
  ConsensusEngine,
  createConsensusEngine,
  formatProposalMessage,
  parseVoteCommand,
  formatResultMessage,
  type Proposal,
  type ConsensusResult,
  type ConsensusConfig,
  type VoteValue,
} from './consensus.js';

// =============================================================================
// Types
// =============================================================================

export interface EnhancedFeaturesConfig {
  /** Pattern matching configuration */
  patterns?: {
    relayPrefix?: string;
    thinkingPrefix?: string;
  };

  /** Signing configuration (or path to config file) */
  signing?: Partial<AgentSigningConfig> | string;

  /** DLQ configuration */
  dlq?: Partial<DLQConfig> & {
    /** Storage type */
    type?: 'sqlite' | 'postgres' | 'memory';
    /** SQLite database (if type is sqlite) */
    sqlite?: BetterSqlite3Database;
    /** PostgreSQL pool (if type is postgres) */
    postgres?: PgPool;
  };

  /** Context compaction configuration */
  compaction?: Partial<CompactionConfig>;

  /** Consensus configuration */
  consensus?: Partial<ConsensusConfig>;
}

export interface EnhancedFeatures {
  /** Precompiled pattern matching */
  patterns: {
    compiled: ReturnType<typeof getCompiledPatterns>;
    isInstructionalText: typeof isInstructionalTextFast;
    isPlaceholderTarget: typeof isPlaceholderTargetFast;
    stripAnsi: typeof stripAnsiFast;
    static: typeof StaticPatterns;
  };

  /** Agent signing manager */
  signing: AgentSigningManager;

  /** Dead Letter Queue */
  dlq: DLQStorageAdapter;

  /** Context compactor */
  compaction: ContextCompactor;

  /** Consensus engine */
  consensus: ConsensusEngine;

  /** Cleanup function */
  cleanup: () => Promise<void>;
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Initialize all enhanced features.
 */
export async function initEnhancedFeatures(
  config: EnhancedFeaturesConfig = {}
): Promise<EnhancedFeatures> {
  // Initialize pattern matching
  const patterns = {
    compiled: getCompiledPatterns(
      config.patterns?.relayPrefix ?? '->relay:',
      config.patterns?.thinkingPrefix ?? '->thinking:'
    ),
    isInstructionalText: isInstructionalTextFast,
    isPlaceholderTarget: isPlaceholderTargetFast,
    stripAnsi: stripAnsiFast,
    static: StaticPatterns,
  };

  // Initialize signing
  const signingConfig = typeof config.signing === 'string'
    ? loadSigningConfig(config.signing)
    : { ...loadSigningConfig(), ...config.signing };
  const signing = new AgentSigningManager(signingConfig);

  // Initialize DLQ
  let dlq: DLQStorageAdapter;
  const dlqConfig = config.dlq ?? {};

  if (dlqConfig.type === 'postgres' && dlqConfig.postgres) {
    dlq = new PostgresDLQAdapter(dlqConfig.postgres);
  } else if (dlqConfig.type === 'sqlite' && dlqConfig.sqlite) {
    dlq = new SQLiteDLQAdapter(dlqConfig.sqlite);
  } else if (dlqConfig.type === 'memory' || (!dlqConfig.sqlite && !dlqConfig.postgres)) {
    dlq = new InMemoryDLQAdapter();
  } else {
    dlq = new InMemoryDLQAdapter();
  }
  await dlq.init();

  // Initialize context compaction
  const compaction = createContextCompactor(config.compaction);

  // Initialize consensus
  const consensus = createConsensusEngine(config.consensus);

  // Cleanup function
  const cleanup = async () => {
    await dlq.close();
    consensus.cleanup();
  };

  return {
    patterns,
    signing,
    dlq,
    compaction,
    consensus,
    cleanup,
  };
}

// =============================================================================
// Router Integration Helpers
// =============================================================================

/**
 * Handle failed message delivery by adding to DLQ.
 */
export async function handleDeliveryFailure(
  dlq: DLQStorageAdapter,
  envelope: {
    id: string;
    from: string;
    to: string;
    topic?: string;
    payload: {
      kind: string;
      body: string;
      data?: Record<string, unknown>;
      thread?: string;
    };
    ts: number;
  },
  reason: 'max_retries_exceeded' | 'ttl_expired' | 'connection_lost' | 'target_not_found',
  attemptCount: number,
  errorMessage?: string
): Promise<DeadLetter> {
  return dlq.add(
    envelope.id,
    {
      from: envelope.from,
      to: envelope.to,
      topic: envelope.topic,
      kind: envelope.payload.kind,
      body: envelope.payload.body,
      data: envelope.payload.data,
      thread: envelope.payload.thread,
      ts: envelope.ts,
    },
    reason,
    attemptCount,
    errorMessage
  );
}

/**
 * Sign an outgoing envelope if signing is enabled.
 */
export function signEnvelope<T extends Record<string, unknown>>(
  signing: AgentSigningManager,
  envelope: T,
  agentName: string
): T {
  if (!signing.enabled) {
    return envelope;
  }

  const content = JSON.stringify(envelope);
  const signed = signing.sign(agentName, content);

  if (!signed) {
    return envelope;
  }

  return attachSignature(envelope, signed) as T;
}

/**
 * Verify an incoming envelope signature.
 */
export function verifyEnvelope(
  signing: AgentSigningManager,
  envelope: Record<string, unknown>
): { valid: boolean; error?: string } {
  if (!signing.enabled) {
    return { valid: true };
  }

  const signed = extractSignature(envelope);
  if (!signed) {
    const from = typeof envelope.from === 'string' ? envelope.from : 'unknown';
    if (signing.requiresVerification(from)) {
      return { valid: false, error: 'Missing signature' };
    }
    return { valid: true };
  }

  return signing.verify(signed);
}

// =============================================================================
// Consensus Integration Helpers
// =============================================================================

/**
 * Process a potential vote command from a relay message.
 */
export function processVoteMessage(
  consensus: ConsensusEngine,
  from: string,
  body: string
): { processed: boolean; result?: ReturnType<ConsensusEngine['vote']> } {
  const vote = parseVoteCommand(body);
  if (!vote) {
    return { processed: false };
  }

  const result = consensus.vote(vote.proposalId, from, vote.value, vote.reason);
  return { processed: true, result };
}

/**
 * Create a proposal and format it for broadcast.
 */
export function createAndBroadcastProposal(
  consensus: ConsensusEngine,
  options: Parameters<ConsensusEngine['createProposal']>[0]
): { proposal: Proposal; message: string } {
  const proposal = consensus.createProposal(options);
  const message = formatProposalMessage(proposal);
  return { proposal, message };
}

// =============================================================================
// Context Management Helpers
// =============================================================================

/**
 * Check if context needs compaction and compact if necessary.
 */
export function manageContext(
  compactor: ContextCompactor,
  messages: Message[]
): {
  messages: Message[];
  compacted: boolean;
  result?: CompactionResult;
  budget: ReturnType<ContextCompactor['getTokenBudget']>;
} {
  const budget = compactor.getTokenBudget(messages);

  if (!compactor.needsCompaction(messages)) {
    return { messages, compacted: false, budget };
  }

  const result = compactor.compact(messages);
  return {
    messages: result.messages,
    compacted: true,
    result,
    budget: compactor.getTokenBudget(result.messages),
  };
}

// =============================================================================
// Re-exports for convenience
// =============================================================================

export {
  // Patterns
  getCompiledPatterns,
  isInstructionalTextFast,
  isPlaceholderTargetFast,
  stripAnsiFast,
  StaticPatterns,

  // Signing
  AgentSigningManager,
  loadSigningConfig,
  attachSignature,
  extractSignature,
  type AgentSigningConfig,
  type SignedMessage,

  // DLQ
  SQLiteDLQAdapter,
  PostgresDLQAdapter,
  InMemoryDLQAdapter,
  createDLQAdapter,
  DEFAULT_DLQ_CONFIG,
  type DLQStorageAdapter,
  type DLQConfig,
  type DeadLetter,
  type DLQStats,

  // Compaction
  ContextCompactor,
  createContextCompactor,
  estimateTokens,
  estimateContextTokens,
  formatTokenCount,
  type Message,
  type CompactionConfig,
  type CompactionResult,

  // Consensus
  ConsensusEngine,
  createConsensusEngine,
  formatProposalMessage,
  parseVoteCommand,
  formatResultMessage,
  type Proposal,
  type ConsensusResult,
  type ConsensusConfig,
  type VoteValue,
};
