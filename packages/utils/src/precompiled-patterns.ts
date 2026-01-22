/**
 * Precompiled Pattern Matching
 *
 * Optimized regex patterns for high-performance message parsing.
 * Inspired by russian-code-ts performance targets (<1ms for pattern matching).
 *
 * Strategies:
 * 1. Precompile patterns at module load (not per-instance)
 * 2. Combine multiple patterns into single regex where possible
 * 3. Use non-capturing groups and atomic patterns
 * 4. Cache compiled patterns by prefix
 */

// =============================================================================
// Pattern Cache
// =============================================================================

export interface CompiledPatterns {
  inline: RegExp;
  fencedInline: RegExp;
  escape: RegExp;
}

const patternCache = new Map<string, CompiledPatterns>();

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Get or create compiled patterns for a given prefix configuration.
 * Patterns are cached for reuse across parser instances.
 */
export function getCompiledPatterns(
  prefix: string = '->relay:',
  thinkingPrefix: string = '->thinking:'
): CompiledPatterns {
  const cacheKey = `${prefix}|${thinkingPrefix}`;

  const cached = patternCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const escapedPrefix = escapeRegex(prefix);
  const escapedThinking = escapeRegex(thinkingPrefix);

  // Combined prompt character class for line start
  // Includes: >, $, %, #, →, ➜, ›, », bullets (●•◦‣⁃-*⏺◆◇○□■), box chars (│┃┆┇┊┋╎╏), sparkle (✦)
  const promptChars = String.raw`[>$%#→➜›»●•◦‣⁃\-*⏺◆◇○□■│┃┆┇┊┋╎╏✦]`;
  const lineStartPrefix = String.raw`^(?:\s*(?:${promptChars}\s*)*)?`;

  // Thread syntax: [thread:id] or [thread:project:id]
  const threadSyntax = String.raw`(?:\s+\[thread:(?:([\w-]+):)?([\w-]+)\])?`;

  const patterns: CompiledPatterns = {
    // Combined inline pattern for both relay and thinking prefixes
    // Groups: 1=prefix type (relay/thinking), 2=target, 3=thread project, 4=thread id, 5=body
    inline: new RegExp(
      `${lineStartPrefix}(${escapedPrefix}|${escapedThinking})(\\S+)${threadSyntax}\\s+(.+)$`
    ),

    // Combined fenced inline pattern: ->relay:Target <<<
    // Groups: 1=prefix type, 2=target, 3=thread project, 4=thread id
    fencedInline: new RegExp(
      `${lineStartPrefix}(${escapedPrefix}|${escapedThinking})(\\S+)${threadSyntax}\\s+<<<\\s*$`
    ),

    // Escape pattern for \->relay: or \->thinking:
    escape: new RegExp(`^(\\s*)\\\\(${escapedPrefix}|${escapedThinking})`),
  };

  patternCache.set(cacheKey, patterns);
  return patterns;
}

// =============================================================================
// Combined Instructional Markers (Single Regex)
// =============================================================================

/**
 * Combined instructional markers pattern.
 * Instead of testing each pattern separately, we combine into one regex.
 *
 * Original patterns:
 * - /\bSEND:\s*$/i
 * - /\bPROTOCOL:\s*\(\d+\)/i
 * - /\bExample:/i
 * - /\\->relay:/
 * - /\\->thinking:/
 * - /^AgentName\s+/
 * - /^Target\s+/
 * - /\[Agent Relay\]/
 * - /MULTI-LINE:/i
 * - /RECEIVE:/i
 */
const INSTRUCTIONAL_COMBINED = new RegExp(
  [
    String.raw`\bSEND:\s*$`,           // "SEND:" at end (instruction prefix)
    String.raw`\bPROTOCOL:\s*\(\d+\)`, // "PROTOCOL: (1)" - numbered instructions
    String.raw`\bExample:`,             // "Example:" marker
    String.raw`\\->relay:`,             // Escaped relay prefix (documentation)
    String.raw`\\->thinking:`,          // Escaped thinking prefix (documentation)
    String.raw`^AgentName\s+`,          // Body starting with "AgentName"
    String.raw`^Target\s+`,             // Body starting with "Target"
    String.raw`\[Agent Relay\]`,        // Injected instruction header
    String.raw`MULTI-LINE:`,            // Multi-line format instruction
    String.raw`RECEIVE:`,               // Receive instruction marker
  ].join('|'),
  'i' // Case insensitive
);

/**
 * Fast check if text matches any instructional pattern.
 * Single regex test instead of array.some().
 */
export function isInstructionalTextFast(body: string): boolean {
  return INSTRUCTIONAL_COMBINED.test(body);
}

// =============================================================================
// Placeholder Targets (Set for O(1) Lookup)
// =============================================================================

/**
 * Placeholder target names - precomputed lowercase set for fast lookup.
 */
const PLACEHOLDER_TARGETS_SET = new Set([
  'agentname',
  'target',
  'recipient',
  'yourtarget',
  'targetagent',
  'someagent',
  'otheragent',
  'worker',
]);

/**
 * Fast placeholder target check using Set.
 */
export function isPlaceholderTargetFast(target: string): boolean {
  return PLACEHOLDER_TARGETS_SET.has(target.toLowerCase());
}

// =============================================================================
// ANSI Stripping (Precompiled)
// =============================================================================

/**
 * Precompiled ANSI escape sequence pattern.
 * Global flag for replace operations.
 */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN_COMPILED = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)|\r/g;

/**
 * Precompiled orphaned CSI pattern.
 */
const ORPHANED_CSI_COMPILED = /^\s*(\[(?:\?|\d)\d*[A-Za-z])+\s*/g;

/**
 * Strip ANSI escape codes from a string.
 * Uses precompiled patterns for better performance.
 */
export function stripAnsiFast(str: string): string {
  // Reset lastIndex for global patterns
  ANSI_PATTERN_COMPILED.lastIndex = 0;
  ORPHANED_CSI_COMPILED.lastIndex = 0;

  let result = str.replace(ANSI_PATTERN_COMPILED, '');
  result = result.replace(ORPHANED_CSI_COMPILED, '');
  return result;
}

// =============================================================================
// Static Patterns (Precompiled)
// =============================================================================

/**
 * Precompiled static patterns used across parsing operations.
 */
export const StaticPatterns = {
  // Block markers
  BLOCK_END: /\[\[\/RELAY\]\]/,
  BLOCK_METADATA_END: /\[\[\/RELAY_METADATA\]\]/,
  CODE_FENCE: /^```/,

  // Fence markers
  FENCE_END_START: /^(?:\s*)?>>>/,
  FENCE_END_LINE: />>>\s*$/,
  FENCE_END: /^(?:\s*)?>>>|>>>\s*$/,

  // Escape patterns
  ESCAPED_FENCE_START: /\\<<</g,
  ESCAPED_FENCE_END: /\\>>>/g,
  ESCAPED_FENCE_END_CHECK: /\\>>>\s*$/,
  ESCAPED_FENCE_START_CHECK: /^(?:\s*)?\\>>>/,

  // Continuation helpers
  BULLET_OR_NUMBERED_LIST: /^[ \t]*([\-*•◦‣⏺◆◇○□■]|[0-9]+[.)])\s+/,
  PROMPTISH_LINE: /^[\s]*[>$%#➜›»][\s]*$/,
  RELAY_INJECTION_PREFIX: /^\s*Relay message from /,

  // Spawn/release commands
  SPAWN_COMMAND: /->relay:spawn\s+\S+/i,
  RELEASE_COMMAND: /->relay:release\s+\S+/i,

  // Claude extended thinking blocks
  THINKING_START: /<thinking>/,
  THINKING_END: /<\/thinking>/,

  // Agent name validation (PascalCase, 2-30 chars)
  AGENT_NAME: /^[A-Z][a-zA-Z0-9]{1,29}$/,

  // CLI prompt patterns by type
  CLI_PROMPTS: {
    claude: /^[>›»]\s*$/,
    gemini: /^[>›»]\s*$/,
    codex: /^[>›»]\s*$/,
    droid: /^[>›»]\s*$/,
    opencode: /^[>›»]\s*$/,
    spawned: /^[>›»]\s*$/,
    other: /^[>$%#➜›»]\s*$/,
  } as const,
} as const;

// =============================================================================
// Pattern Matching Utilities
// =============================================================================

/**
 * Check if line is a spawn or release command.
 */
export function isSpawnOrReleaseCommandFast(line: string): boolean {
  return StaticPatterns.SPAWN_COMMAND.test(line) ||
         StaticPatterns.RELEASE_COMMAND.test(line);
}

/**
 * Check if a line contains an escaped fence end.
 */
export function isEscapedFenceEndFast(line: string): boolean {
  return StaticPatterns.ESCAPED_FENCE_END_CHECK.test(line) ||
         StaticPatterns.ESCAPED_FENCE_START_CHECK.test(line);
}

/**
 * Unescape fence markers in content.
 */
export function unescapeFenceMarkersFast(content: string): string {
  StaticPatterns.ESCAPED_FENCE_START.lastIndex = 0;
  StaticPatterns.ESCAPED_FENCE_END.lastIndex = 0;

  return content
    .replace(StaticPatterns.ESCAPED_FENCE_START, '<<<')
    .replace(StaticPatterns.ESCAPED_FENCE_END, '>>>');
}

// =============================================================================
// Performance Metrics
// =============================================================================

interface PatternMetrics {
  calls: number;
  totalMs: number;
  maxMs: number;
}

const metrics = new Map<string, PatternMetrics>();

/**
 * Track pattern matching performance (for debugging/profiling).
 * Call with pattern name and execution time.
 */
export function trackPatternPerformance(name: string, ms: number): void {
  const existing = metrics.get(name);
  if (existing) {
    existing.calls++;
    existing.totalMs += ms;
    existing.maxMs = Math.max(existing.maxMs, ms);
  } else {
    metrics.set(name, { calls: 1, totalMs: ms, maxMs: ms });
  }
}

/**
 * Get pattern performance metrics.
 */
export function getPatternMetrics(): Map<string, PatternMetrics & { avgMs: number }> {
  const result = new Map<string, PatternMetrics & { avgMs: number }>();
  for (const [name, m] of metrics) {
    result.set(name, {
      ...m,
      avgMs: m.calls > 0 ? m.totalMs / m.calls : 0,
    });
  }
  return result;
}

/**
 * Reset pattern performance metrics.
 */
export function resetPatternMetrics(): void {
  metrics.clear();
}

// =============================================================================
// Benchmark Utility
// =============================================================================

/**
 * Benchmark pattern matching performance.
 * Useful for testing optimization impact.
 */
export function benchmarkPatterns(
  iterations: number = 10000
): Record<string, { avgNs: number; maxNs: number }> {
  const testStrings = [
    '->relay:Agent Hello world',
    '->relay:Lead [thread:task-123] Starting work',
    '  > ->relay:Worker <<<',
    'Some random text without relay',
    '\x1b[32m->relay:Test\x1b[0m message with ANSI',
    '->relay:spawn Worker claude "task"',
    'ACK: Task received',
    'SEND: Protocol instruction',
    'Example: how to use relay',
  ];

  const results: Record<string, { avgNs: number; maxNs: number }> = {};

  // Benchmark combined instructional check
  {
    let maxNs = 0;
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      for (const str of testStrings) {
        const s = process.hrtime.bigint();
        isInstructionalTextFast(str);
        const elapsed = Number(process.hrtime.bigint() - s);
        if (elapsed > maxNs) maxNs = elapsed;
      }
    }
    const totalNs = Number(process.hrtime.bigint() - start);
    results['instructionalCheck'] = {
      avgNs: totalNs / (iterations * testStrings.length),
      maxNs,
    };
  }

  // Benchmark ANSI stripping
  {
    let maxNs = 0;
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      for (const str of testStrings) {
        const s = process.hrtime.bigint();
        stripAnsiFast(str);
        const elapsed = Number(process.hrtime.bigint() - s);
        if (elapsed > maxNs) maxNs = elapsed;
      }
    }
    const totalNs = Number(process.hrtime.bigint() - start);
    results['ansiStrip'] = {
      avgNs: totalNs / (iterations * testStrings.length),
      maxNs,
    };
  }

  // Benchmark placeholder check
  {
    const targets = ['AgentName', 'Lead', 'Worker', 'target', 'Developer'];
    let maxNs = 0;
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      for (const t of targets) {
        const s = process.hrtime.bigint();
        isPlaceholderTargetFast(t);
        const elapsed = Number(process.hrtime.bigint() - s);
        if (elapsed > maxNs) maxNs = elapsed;
      }
    }
    const totalNs = Number(process.hrtime.bigint() - start);
    results['placeholderCheck'] = {
      avgNs: totalNs / (iterations * targets.length),
      maxNs,
    };
  }

  return results;
}
