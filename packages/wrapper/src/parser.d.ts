/**
 * PTY Output Parser
 * Extracts relay commands from agent terminal output.
 *
 * Supports two formats:
 * 1. Inline: ->relay:<target> <message> (single line, start of line only)
 * 2. Block: [[RELAY]]{ json }[[/RELAY]] (multi-line, structured)
 *
 * Rules:
 * - Inline only matches at start of line (after whitespace)
 * - Ignores content inside code fences
 * - Escape with \->relay: to output literal
 * - Block format is preferred for structured data
 */
import type { PayloadKind } from '@relay/protocol/types';
export interface ParsedCommand {
    to: string;
    kind: PayloadKind;
    body: string;
    data?: Record<string, unknown>;
    /** Optional thread ID for grouping related messages */
    thread?: string;
    /** Optional project for cross-project messaging (e.g., ->relay:project:agent) */
    project?: string;
    /** Optional thread project for cross-project threads (e.g., [thread:project:id]) */
    threadProject?: string;
    /** Optional sync metadata parsed from [await] */
    sync?: {
        blocking: boolean;
        timeoutMs?: number;
    };
    raw: string;
    meta?: ParsedMessageMetadata;
}
export interface ParserOptions {
    maxBlockBytes?: number;
    enableInline?: boolean;
    enableBlock?: boolean;
    /** Relay prefix pattern (default: '->relay:') */
    prefix?: string;
    /** Thinking prefix pattern (default: '->thinking:') */
    thinkingPrefix?: string;
}
/**
 * Check if a target name is a placeholder commonly used in documentation/examples.
 * These should not be treated as real message targets.
 */
export declare function isPlaceholderTarget(target: string): boolean;
export declare class OutputParser {
    private options;
    private inCodeFence;
    private inBlock;
    private blockBuffer;
    private blockType;
    private lastParsedMetadata;
    private inThinkingBlock;
    private inFencedInline;
    private fencedInlineBuffer;
    private fencedInlineTarget;
    private fencedInlineThread;
    private fencedInlineThreadProject;
    private fencedInlineProject;
    private fencedInlineRaw;
    private fencedInlineKind;
    private fencedInlineSync;
    private inlineRelayPattern;
    private inlineThinkingPattern;
    private fencedRelayPattern;
    private fencedThinkingPattern;
    private escapePattern;
    constructor(options?: ParserOptions);
    /**
     * Get the configured relay prefix
     */
    get prefix(): string;
    /**
     * Push data into the parser and extract commands.
     * Returns array of parsed commands and cleaned output.
     *
     * Design: Pass through data with minimal buffering to preserve terminal rendering.
     * Only buffer content when inside [[RELAY]]...[[/RELAY]] blocks.
     */
    parse(data: string): {
        commands: ParsedCommand[];
        output: string;
    };
    /**
     * Find [[RELAY_METADATA]] or [[RELAY]] that's at the start of a line and not inside a code fence.
     * Returns the index and identifier, or -1 and null if not found.
     */
    private findBlockStart;
    /**
     * Parse data in pass-through mode - TRUE pass-through for terminal rendering.
     * Output is exactly the input data, minus any relay command lines found in this chunk.
     * No cross-chunk buffering to avoid double-output issues.
     *
     * IMPORTANT: We ONLY parse complete lines (i.e. those terminated by `\n` in the
     * current chunk). The final unterminated line (if any) is passed through without
     * parsing. This intentionally avoids cross-chunk detection when a line is split
     * across chunks.
     */
    private parsePassThrough;
    /**
     * Parse while inside a [[RELAY]] block - buffer until we see [[/RELAY]].
     */
    private parseInBlockMode;
    /**
     * Process a single complete line for inline relay commands.
     * Block handling is done at the parse() level, not here.
     *
     * IMPORTANT: We strip ANSI codes for pattern matching, but preserve
     * the original line for output to maintain terminal rendering.
     *
     * OPTIMIZATION: Early exit for lines that can't possibly be relay commands.
     * Most lines don't contain relay patterns, so we avoid expensive regex/ANSI
     * stripping for the common case.
     */
    private processLine;
    /**
     * Finish processing a block and extract command.
     * Returns the command (if valid) and any remaining content after [[/RELAY]].
     */
    private finishBlock;
    /**
     * Check if the current fenced inline command should be filtered out.
     * Returns true if the command looks like instructional/example text.
     */
    private shouldFilterFencedInline;
    /**
     * Parse while inside a fenced inline block (->relay:Target <<< ... >>>).
     * Accumulates lines until >>> is seen on its own line.
     */
    private parseFencedInlineMode;
    /**
     * Flush any remaining buffer (call on stream end).
     */
    flush(): {
        commands: ParsedCommand[];
        output: string;
    };
    /**
     * Reset parser state.
     */
    reset(): void;
}
/**
 * Parsed message metadata block from agent output.
 */
export interface ParsedMessageMetadata {
    subject?: string;
    importance?: number;
    replyTo?: string;
    ackRequired?: boolean;
}
/**
 * Result of attempting to parse a RELAY_METADATA block.
 */
export interface MetadataParseResult {
    found: boolean;
    valid: boolean;
    metadata: ParsedMessageMetadata | null;
    rawContent: string | null;
}
/**
 * Parse [[RELAY_METADATA]]...[[/RELAY_METADATA]] blocks from agent output.
 * Agents can output metadata to enhance messages.
 *
 * Format:
 * [[RELAY_METADATA]]
 * {
 *   "subject": "Task update",
 *   "importance": 80,
 *   "replyTo": "msg-abc123",
 *   "ackRequired": true
 * }
 * [[/RELAY_METADATA]]
 */
export declare function parseRelayMetadataFromOutput(output: string): MetadataParseResult;
/**
 * Parsed summary block from agent output.
 */
export interface ParsedSummary {
    currentTask?: string;
    completedTasks?: string[];
    decisions?: string[];
    context?: string;
    files?: string[];
}
/**
 * Result of attempting to parse a SUMMARY block.
 */
export interface SummaryParseResult {
    found: boolean;
    valid: boolean;
    summary: ParsedSummary | null;
    rawContent: string | null;
}
/**
 * Parse [[SUMMARY]]...[[/SUMMARY]] blocks from agent output.
 * Agents can output summaries to keep a running context of their work.
 *
 * Format:
 * [[SUMMARY]]
 * {
 *   "currentTask": "Working on auth module",
 *   "context": "Completed login flow, now implementing logout",
 *   "files": ["src/auth.ts", "src/session.ts"]
 * }
 * [[/SUMMARY]]
 */
export declare function parseSummaryFromOutput(output: string): ParsedSummary | null;
/**
 * Parse SUMMARY block with full details for deduplication.
 * Returns raw content to allow caller to dedupe before logging errors.
 */
export declare function parseSummaryWithDetails(output: string): SummaryParseResult;
/**
 * Session end marker from agent output.
 */
export interface SessionEndMarker {
    summary?: string;
    completedTasks?: string[];
}
/**
 * Parse [[SESSION_END]]...[[/SESSION_END]] blocks from agent output.
 * Agents output this to explicitly mark their session as complete.
 *
 * Format:
 * [[SESSION_END]]
 * {"summary": "Completed auth module implementation", "completedTasks": ["login", "logout"]}
 * [[/SESSION_END]]
 *
 * Or simply: [[SESSION_END]][[/SESSION_END]] for a clean close without summary.
 */
export declare function parseSessionEndFromOutput(output: string): SessionEndMarker | null;
//# sourceMappingURL=parser.d.ts.map