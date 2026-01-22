/**
 * Context Compaction for Long Agent Sessions
 *
 * Manages conversation context to prevent token limit exhaustion.
 * Provides token counting, message summarization, and context pruning.
 *
 * Inspired by russian-code-ts context management targets:
 * - Token estimation: <20ms
 * - Embeddings-based semantic search for relevant context
 *
 * Strategies:
 * 1. Fast token estimation (character-based heuristic)
 * 2. Importance-weighted message retention
 * 3. Sliding window with summary injection
 * 4. Semantic deduplication of similar messages
 */

// =============================================================================
// Types
// =============================================================================

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  /** Message importance (0-100, higher = more important) */
  importance?: number;
  /** Whether this is a summary message */
  isSummary?: boolean;
  /** Original message IDs if this is a summary */
  summarizes?: string[];
  /** Thread ID for grouping */
  thread?: string;
  /** Token count (cached) */
  tokenCount?: number;
}

export interface ContextWindow {
  messages: Message[];
  totalTokens: number;
  maxTokens: number;
  usagePercent: number;
}

export interface CompactionResult {
  /** Messages after compaction */
  messages: Message[];
  /** Number of messages removed */
  messagesRemoved: number;
  /** Tokens saved */
  tokensSaved: number;
  /** Summary message added (if any) */
  summaryAdded?: Message;
  /** Compaction strategy used */
  strategy: CompactionStrategy;
}

export type CompactionStrategy =
  | 'none'           // No compaction needed
  | 'trim_old'       // Remove oldest messages
  | 'trim_low_importance' // Remove low-importance messages
  | 'summarize'      // Summarize and replace old messages
  | 'deduplicate'    // Remove semantically similar messages
  | 'aggressive';    // Combination of all strategies

export interface CompactionConfig {
  /** Maximum tokens for context window */
  maxTokens: number;
  /** Target token usage after compaction (e.g., 0.7 = 70%) */
  targetUsage: number;
  /** Threshold to trigger compaction (e.g., 0.9 = 90%) */
  compactionThreshold: number;
  /** Minimum importance to retain during compaction */
  minImportanceRetain: number;
  /** Number of recent messages to always keep */
  keepRecentCount: number;
  /** Enable summarization */
  enableSummarization: boolean;
  /** Enable semantic deduplication */
  enableDeduplication: boolean;
  /** Similarity threshold for deduplication (0-1) */
  deduplicationThreshold: number;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: CompactionConfig = {
  maxTokens: 100000,       // 100k tokens (Claude's typical limit)
  targetUsage: 0.7,        // Target 70% after compaction
  compactionThreshold: 0.85, // Trigger at 85% usage
  minImportanceRetain: 30, // Keep messages with importance >= 30
  keepRecentCount: 10,     // Always keep last 10 messages
  enableSummarization: true,
  enableDeduplication: true,
  deduplicationThreshold: 0.85,
};

// =============================================================================
// Token Estimation
// =============================================================================

/**
 * Fast token estimation using character-based heuristic.
 * Targets <20ms latency for large texts.
 *
 * Heuristic: ~4 characters per token for English text.
 * Adjusts for code (more tokens per char) and whitespace.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  const length = text.length;

  // Fast path for short texts
  if (length < 100) {
    return Math.ceil(length / 3.5);
  }

  // Sample-based estimation for longer texts
  // Count different character types in sample
  const sampleSize = Math.min(1000, length);
  const sample = text.substring(0, sampleSize);

  let codeChars = 0;
  let whitespaceChars = 0;
  let _punctuationChars = 0;

  for (let i = 0; i < sample.length; i++) {
    const char = sample[i];
    if (/\s/.test(char)) {
      whitespaceChars++;
    } else if (/[{}[\]();:,.<>!=+\-*/&|^~`@#$%]/.test(char)) {
      _punctuationChars++;
      codeChars++;
    }
  }

  const codeRatio = codeChars / sampleSize;
  const whitespaceRatio = whitespaceChars / sampleSize;

  // Adjust chars per token based on content type
  // Heuristics based on tokenization patterns:
  // - Base prose: ~4 chars/token (average English text)
  // - Code: ~3 chars/token (more tokens due to symbols/structure)
  // - High whitespace: ~3.5 chars/token (more word boundaries = more tokens)
  const baseCharsPerToken = 4;
  const codeAdjustment = codeRatio * 1.5; // Code reduces chars/token (more tokens)
  const whitespaceAdjustment = whitespaceRatio * 0.5; // Whitespace reduces chars/token (more word boundaries)

  const charsPerToken = baseCharsPerToken - codeAdjustment - whitespaceAdjustment;
  const adjustedCharsPerToken = Math.max(2.5, Math.min(5, charsPerToken));

  return Math.ceil(length / adjustedCharsPerToken);
}

/**
 * Estimate tokens for a message (uses caching).
 */
export function estimateMessageTokens(message: Message): number {
  if (message.tokenCount !== undefined) {
    return message.tokenCount;
  }

  // Role overhead: ~4 tokens for role markers
  const roleOverhead = 4;
  const contentTokens = estimateTokens(message.content);

  message.tokenCount = roleOverhead + contentTokens;
  return message.tokenCount;
}

/**
 * Estimate tokens for entire context.
 */
export function estimateContextTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  // Add overhead for message separators (~2 tokens per message)
  total += messages.length * 2;
  return total;
}

// =============================================================================
// Importance Scoring
// =============================================================================

/**
 * Calculate importance score for a message.
 * Higher scores = more important to retain.
 */
export function calculateImportance(message: Message, index: number, total: number): number {
  let score = 50; // Base score

  // Recency bonus (0-20 points)
  const recencyRatio = index / total;
  score += recencyRatio * 20;

  // System messages are important
  if (message.role === 'system') {
    score += 30;
  }

  // Check for important content patterns
  const content = message.content.toLowerCase();

  // Task-related keywords
  if (/\b(todo|task|implement|fix|bug|error|important|critical|urgent)\b/.test(content)) {
    score += 15;
  }

  // Code blocks are often important context
  if (/```[\s\S]*```/.test(message.content)) {
    score += 10;
  }

  // Questions that might need answers retained
  if (/\?/.test(content) && message.role === 'user') {
    score += 10;
  }

  // Acknowledgments and status updates can be lower priority
  if (/^(ok|ack|got it|understood|done|completed)/i.test(content)) {
    score -= 20;
  }

  // Very short messages are usually less important
  if (message.content.length < 50) {
    score -= 10;
  }

  // Summaries should be kept
  if (message.isSummary) {
    score += 25;
  }

  // User-specified importance overrides
  if (message.importance !== undefined) {
    score = (score + message.importance) / 2;
  }

  return Math.max(0, Math.min(100, score));
}

// =============================================================================
// Similarity Detection
// =============================================================================

/**
 * Simple similarity score between two strings (Jaccard on word set).
 * Returns 0-1 where 1 = identical.
 */
export function calculateSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));

  if (wordsA.size === 0 || wordsB.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) {
      intersection++;
    }
  }

  const union = wordsA.size + wordsB.size - intersection;
  return intersection / union;
}

/**
 * Find duplicate/similar messages.
 */
export function findDuplicates(
  messages: Message[],
  threshold: number = 0.85
): Map<string, string[]> {
  const duplicates = new Map<string, string[]>();

  for (let i = 0; i < messages.length; i++) {
    for (let j = i + 1; j < messages.length; j++) {
      const similarity = calculateSimilarity(
        messages[i].content,
        messages[j].content
      );

      if (similarity >= threshold) {
        const key = messages[i].id;
        const existing = duplicates.get(key) ?? [];
        existing.push(messages[j].id);
        duplicates.set(key, existing);
      }
    }
  }

  return duplicates;
}

// =============================================================================
// Summarization
// =============================================================================

/**
 * Create a summary of multiple messages.
 * This is a simple extractive summary - in production, use an LLM.
 */
export function createSummary(messages: Message[]): Message {
  const messageCount = messages.length;
  const roles = new Set(messages.map(m => m.role));
  const threads = new Set(messages.filter(m => m.thread).map(m => m.thread));

  // Extract key sentences (first sentence of each message, or first 100 chars)
  const keyPoints: string[] = [];
  for (const msg of messages.slice(0, 5)) { // Take up to 5 key points
    const firstSentence = msg.content.split(/[.!?]\s/)[0];
    if (firstSentence && firstSentence.length < 200) {
      keyPoints.push(`- ${firstSentence}`);
    }
  }

  const content = [
    `[Summary of ${messageCount} messages]`,
    `Participants: ${Array.from(roles).join(', ')}`,
    threads.size > 0 ? `Threads: ${Array.from(threads).join(', ')}` : '',
    'Key points:',
    ...keyPoints,
    `[End summary]`,
  ].filter(Boolean).join('\n');

  return {
    id: `summary_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    role: 'system',
    content,
    timestamp: Date.now(),
    importance: 70,
    isSummary: true,
    summarizes: messages.map(m => m.id),
  };
}

// =============================================================================
// Context Compaction
// =============================================================================

/**
 * Context compaction manager.
 */
export class ContextCompactor {
  private config: CompactionConfig;

  constructor(config: Partial<CompactionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get current context window status.
   */
  getContextWindow(messages: Message[]): ContextWindow {
    const totalTokens = estimateContextTokens(messages);
    return {
      messages,
      totalTokens,
      maxTokens: this.config.maxTokens,
      usagePercent: totalTokens / this.config.maxTokens,
    };
  }

  /**
   * Check if compaction is needed.
   */
  needsCompaction(messages: Message[]): boolean {
    const window = this.getContextWindow(messages);
    return window.usagePercent >= this.config.compactionThreshold;
  }

  /**
   * Perform context compaction.
   */
  compact(messages: Message[]): CompactionResult {
    const window = this.getContextWindow(messages);

    // No compaction needed
    if (window.usagePercent < this.config.compactionThreshold) {
      return {
        messages,
        messagesRemoved: 0,
        tokensSaved: 0,
        strategy: 'none',
      };
    }

    const targetTokens = Math.floor(this.config.maxTokens * this.config.targetUsage);
    let result = [...messages];
    let strategy: CompactionStrategy = 'none';
    const originalTokens = window.totalTokens;

    // Calculate importance for all messages
    const importanceMap = new Map<string, number>();
    for (let i = 0; i < result.length; i++) {
      importanceMap.set(result[i].id, calculateImportance(result[i], i, result.length));
    }

    // Strategy 1: Deduplicate similar messages
    if (this.config.enableDeduplication) {
      const duplicates = findDuplicates(result, this.config.deduplicationThreshold);
      if (duplicates.size > 0) {
        const toRemove = new Set<string>();
        for (const [, dups] of duplicates) {
          for (const id of dups) {
            toRemove.add(id);
          }
        }
        result = result.filter(m => !toRemove.has(m.id));
        if (toRemove.size > 0) {
          strategy = 'deduplicate';
        }
      }
    }

    // Check if we've met target
    if (estimateContextTokens(result) <= targetTokens) {
      return {
        messages: result,
        messagesRemoved: messages.length - result.length,
        tokensSaved: originalTokens - estimateContextTokens(result),
        strategy,
      };
    }

    // Strategy 2: Remove low-importance messages (keep recent)
    const recentIds = new Set(
      result.slice(-this.config.keepRecentCount).map(m => m.id)
    );

    result = result.filter(m => {
      if (recentIds.has(m.id)) return true;
      if (m.isSummary) return true;
      if (m.role === 'system') return true;
      const importance = importanceMap.get(m.id) ?? 50;
      return importance >= this.config.minImportanceRetain;
    });

    if (result.length < messages.length) {
      strategy = 'trim_low_importance';
    }

    // Check if we've met target
    if (estimateContextTokens(result) <= targetTokens) {
      return {
        messages: result,
        messagesRemoved: messages.length - result.length,
        tokensSaved: originalTokens - estimateContextTokens(result),
        strategy,
      };
    }

    // Strategy 3: Summarize old messages
    if (this.config.enableSummarization) {
      const messagesToSummarize = result.slice(0, -this.config.keepRecentCount)
        .filter(m => !m.isSummary && m.role !== 'system');

      if (messagesToSummarize.length >= 3) {
        const summary = createSummary(messagesToSummarize);
        const summaryIds = new Set(messagesToSummarize.map(m => m.id));

        result = [
          summary,
          ...result.filter(m => !summaryIds.has(m.id)),
        ];

        strategy = 'summarize';

        return {
          messages: result,
          messagesRemoved: messages.length - result.length,
          tokensSaved: originalTokens - estimateContextTokens(result),
          summaryAdded: summary,
          strategy,
        };
      }
    }

    // Strategy 4: Aggressive trim (last resort)
    while (estimateContextTokens(result) > targetTokens && result.length > this.config.keepRecentCount + 1) {
      // Remove oldest non-system, non-summary message
      const removeIndex = result.findIndex(m => !m.isSummary && m.role !== 'system');
      if (removeIndex === -1) break;
      result.splice(removeIndex, 1);
    }

    strategy = 'aggressive';

    return {
      messages: result,
      messagesRemoved: messages.length - result.length,
      tokensSaved: originalTokens - estimateContextTokens(result),
      strategy,
    };
  }

  /**
   * Add a message to context with automatic compaction if needed.
   */
  addMessage(
    messages: Message[],
    newMessage: Message
  ): { messages: Message[]; compacted: boolean; result?: CompactionResult } {
    const updated = [...messages, newMessage];

    if (this.needsCompaction(updated)) {
      const result = this.compact(updated);
      return {
        messages: result.messages,
        compacted: true,
        result,
      };
    }

    return {
      messages: updated,
      compacted: false,
    };
  }

  /**
   * Get token budget remaining.
   */
  getTokenBudget(messages: Message[]): {
    used: number;
    remaining: number;
    percentUsed: number;
  } {
    const used = estimateContextTokens(messages);
    return {
      used,
      remaining: this.config.maxTokens - used,
      percentUsed: (used / this.config.maxTokens) * 100,
    };
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a context compactor with the given configuration.
 */
export function createContextCompactor(config?: Partial<CompactionConfig>): ContextCompactor {
  return new ContextCompactor(config);
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Format token count for display.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return tokens.toString();
}

/**
 * Benchmark token estimation performance.
 */
export function benchmarkTokenEstimation(iterations: number = 10000): {
  avgNs: number;
  maxNs: number;
  tokensPerMs: number;
} {
  const testTexts = [
    'Hello world',
    'This is a longer piece of text that contains multiple sentences and should take more time to process.',
    '```typescript\nfunction hello() {\n  console.log("Hello");\n}\n```',
    'A'.repeat(10000), // 10k chars
  ];

  let maxNs = 0;
  let totalTokens = 0;
  const start = process.hrtime.bigint();

  for (let i = 0; i < iterations; i++) {
    for (const text of testTexts) {
      const s = process.hrtime.bigint();
      const tokens = estimateTokens(text);
      totalTokens += tokens;
      const elapsed = Number(process.hrtime.bigint() - s);
      if (elapsed > maxNs) maxNs = elapsed;
    }
  }

  const totalNs = Number(process.hrtime.bigint() - start);
  const totalMs = totalNs / 1_000_000;

  return {
    avgNs: totalNs / (iterations * testTexts.length),
    maxNs,
    tokensPerMs: totalTokens / totalMs,
  };
}
