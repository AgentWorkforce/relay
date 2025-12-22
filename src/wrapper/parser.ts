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

import type { PayloadKind } from '../protocol/types.js';

export interface ParsedCommand {
  to: string;
  kind: PayloadKind;
  body: string;
  data?: Record<string, unknown>;
  /** Optional thread ID for grouping related messages */
  thread?: string;
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

const DEFAULT_OPTIONS: Required<ParserOptions> = {
  maxBlockBytes: 1024 * 1024, // 1 MiB
  enableInline: true,
  enableBlock: true,
  prefix: '->relay:',
  thinkingPrefix: '->thinking:',
};

// Static patterns (not prefix-dependent)
const BLOCK_END = /\[\[\/RELAY\]\]/;
const BLOCK_METADATA_START = '[[RELAY_METADATA]]';
const BLOCK_METADATA_END = /\[\[\/RELAY_METADATA\]\]/;
const CODE_FENCE = /^```/;// Continuation helpers
const BULLET_OR_NUMBERED_LIST = /^[ \t]*([\-*•◦‣⏺◆◇○□■]|[0-9]+[.)])\s+/;
const PROMPTISH_LINE = /^[\s]*[>$%#➜›»][\s]*$/;
const RELAY_INJECTION_PREFIX = /^\s*Relay message from /;
const MAX_INLINE_CONTINUATION_LINES = 30;

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build inline pattern for a given prefix
 * Allow common input prefixes: >, $, %, #, →, ➜, bullets (●•◦‣⁃-*⏺◆◇○□■), box chars (│┃┆┇┊┋╎╏), and their variations
 *
 * Supports optional thread syntax: ->relay:Target [thread:id] message
 * Thread IDs can contain alphanumeric chars, hyphens, underscores
 */
function buildInlinePattern(prefix: string): RegExp {
  const escaped = escapeRegex(prefix);
  // Group 1: target, Group 2: optional thread ID (without brackets), Group 3: message body
  // Includes box drawing characters (│┃┆┇┊┋╎╏) and sparkle (✦) for Gemini CLI output
  return new RegExp(`^(?:\\s*(?:[>$%#→➜›»●•◦‣⁃\\-*⏺◆◇○□■│┃┆┇┊┋╎╏✦]\\s*)*)?${escaped}(\\S+)(?:\\s+\\[thread:([\\w-]+)\\])?\\s+(.+)$`);
}

/**
 * Build escape pattern for a given prefix (e.g., \->relay: or \->)
 */
function buildEscapePattern(prefix: string, thinkingPrefix: string): RegExp {
  // Extract the first character(s) that would be escaped
  const prefixEscaped = escapeRegex(prefix);
  const thinkingEscaped = escapeRegex(thinkingPrefix);
  return new RegExp(`^(\\s*)\\\\(${prefixEscaped}|${thinkingEscaped})`);
}

// ANSI escape sequence pattern for stripping
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)|\r/g;

/**
 * Strip ANSI escape codes from a string for pattern matching.
 */
function stripAnsi(str: string): string {
  return str.replace(ANSI_PATTERN, '');
}

export class OutputParser {
  private options: Required<ParserOptions>;
  private inCodeFence = false;
  private inBlock = false;
  private blockBuffer = '';
  private blockType: 'RELAY' | 'RELAY_METADATA' | null = null;
  private lastParsedMetadata: ParsedMessageMetadata | null = null;

  // Dynamic patterns based on prefix configuration
  private inlineRelayPattern: RegExp;
  private inlineThinkingPattern: RegExp;
  private escapePattern: RegExp;

  constructor(options: ParserOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };

    // Build patterns based on configured prefixes
    this.inlineRelayPattern = buildInlinePattern(this.options.prefix);
    this.inlineThinkingPattern = buildInlinePattern(this.options.thinkingPrefix);
    this.escapePattern = buildEscapePattern(this.options.prefix, this.options.thinkingPrefix);
  }

  /**
   * Get the configured relay prefix
   */
  get prefix(): string {
    return this.options.prefix;
  }

  /**
   * Push data into the parser and extract commands.
   * Returns array of parsed commands and cleaned output.
   *
   * Design: Pass through data with minimal buffering to preserve terminal rendering.
   * Only buffer content when inside [[RELAY]]...[[/RELAY]] blocks.
   */
  parse(data: string): { commands: ParsedCommand[]; output: string } {
    const commands: ParsedCommand[] = [];
    let output = '';

    // If we're inside a block, accumulate until we see the end
    if (this.inBlock && this.blockType) {
      return this.parseInBlockMode(data, commands, this.blockType);
    }

    // Find [[RELAY_METADATA]] or [[RELAY]] that's at the start of a line
    const blockStart = this.findBlockStart(data);

    if (this.options.enableBlock && blockStart.index !== -1 && blockStart.identifier) {
      const blockStartIdentifier = blockStart.identifier;
      const before = data.substring(0, blockStart.index);
      const after = data.substring(blockStart.index + blockStartIdentifier.length);

      // Output everything before the block start
      if (before) {
        const beforeResult = this.parsePassThrough(before, commands);
        output += beforeResult;
      }

      // Enter block mode
      this.inBlock = true;
      this.blockType = blockStartIdentifier === BLOCK_METADATA_START ? 'RELAY_METADATA' : 'RELAY';
      this.blockBuffer = after;

      // Check size limit before processing
      if (this.blockBuffer.length > this.options.maxBlockBytes) {
        console.error('[parser] Block too large, discarding');
        this.inBlock = false;
        this.blockBuffer = '';
        this.blockType = null;
        return { commands, output };
      }

      // Check if block ends in same chunk
      const blockEndPattern = this.blockType === 'RELAY_METADATA' ? BLOCK_METADATA_END : BLOCK_END;
      if (blockEndPattern.test(this.blockBuffer)) {
        const blockResult = this.finishBlock(this.blockType);
        if (blockResult.command) {
          commands.push(blockResult.command);
        }
        if (blockResult.remaining) {
          // Recursively parse anything after the block
          const afterResult = this.parse(blockResult.remaining);
          commands.push(...afterResult.commands);
          output += afterResult.output;
        }
      }

      return { commands, output };
    }

    // Pass-through mode: output data immediately, only parse complete lines for relay commands
    output = this.parsePassThrough(data, commands);
    return { commands, output };
  }

  /**
   * Find [[RELAY_METADATA]] or [[RELAY]] that's at the start of a line and not inside a code fence.
   * Returns the index and identifier, or -1 and null if not found.
   */
  private findBlockStart(data: string): { index: number; identifier: string | null } {
    // Track code fence state through the data
    let inFence = this.inCodeFence;
    let searchStart = 0;

    // Prioritize RELAY_METADATA over RELAY
    const blockIdentifiers = [BLOCK_METADATA_START, '[[RELAY]]'];

    while (searchStart < data.length) {
      let earliestBlockIdx = -1;
      let earliestBlockIdentifier: string | null = null;

      for (const identifier of blockIdentifiers) {
        const currentBlockIdx = data.indexOf(identifier, searchStart);
        if (currentBlockIdx !== -1 && (earliestBlockIdx === -1 || currentBlockIdx < earliestBlockIdx)) {
          earliestBlockIdx = currentBlockIdx;
          earliestBlockIdentifier = identifier;
        }
      }

      // No more blocks found
      if (earliestBlockIdx === -1) {
        // Still update code fence state for remaining data
        let fenceIdx = data.indexOf('```', searchStart);
        while (fenceIdx !== -1) {
          inFence = !inFence;
          searchStart = fenceIdx + 3;
          fenceIdx = data.indexOf('```', searchStart);
        }
        return { index: -1, identifier: null };
      }

      // Process any code fences before this block
      let tempIdx = searchStart;
      while (true) {
        const nextFence = data.indexOf('```', tempIdx);
        if (nextFence === -1 || nextFence >= earliestBlockIdx) break;
        inFence = !inFence;
        tempIdx = nextFence + 3;
      }

      // If we're inside a code fence, skip this block
      if (inFence) {
        searchStart = earliestBlockIdx + (earliestBlockIdentifier?.length ?? 0); // Skip past the block
        continue;
      }

      // Check if block is at start of a line
      if (earliestBlockIdx === 0) {
        return { index: 0, identifier: earliestBlockIdentifier }; // At very start
      }

      // Look backwards for the start of line
      const beforeBlock = data.substring(0, earliestBlockIdx);
      const lastNewline = beforeBlock.lastIndexOf('\n');
      const lineStart = beforeBlock.substring(lastNewline + 1);

      // Must be only whitespace before block on this line
      if (/^\s*$/.test(lineStart)) {
        return { index: earliestBlockIdx, identifier: earliestBlockIdentifier };
      }

      // Not at start of line, keep searching
      searchStart = earliestBlockIdx + (earliestBlockIdentifier?.length ?? 0);
    }

    return { index: -1, identifier: null };
  }

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
  private parsePassThrough(data: string, commands: ParsedCommand[]): string {
   // Simple approach: split data, check each line (complete or not), rebuild output
    const lines = data.split('\n');
    const hasTrailingNewline = data.endsWith('\n');

    const isInlineStart = (line: string): boolean => {
      return this.inlineRelayPattern.test(line) || this.inlineThinkingPattern.test(line);
    };

    const isBlockMarker = (line: string): boolean => {
      return CODE_FENCE.test(line) || line.includes('[[RELAY]]') || BLOCK_END.test(line);
    };

    const shouldStopContinuation = (line: string): boolean => {
      const trimmed = line.trim();
      if (trimmed === '') return true; // Blank line ends the message
      if (isInlineStart(line)) return true;
      if (isBlockMarker(line)) return true;
      if (PROMPTISH_LINE.test(trimmed)) return true;
      if (RELAY_INJECTION_PREFIX.test(line)) return true; // Avoid swallowing injected inbound messages
      return false;
    };

    const isContinuationLine = (
      original: string,
      stripped: string,
      prevStripped: string,
      continuationCount: number
    ): boolean => {
      if (shouldStopContinuation(stripped)) return false;
      if (/^[ \t]/.test(original)) return true; // Indented lines from TUI wrapping
      if (BULLET_OR_NUMBERED_LIST.test(stripped)) return true; // Bullet/numbered lists after ->relay:
      const prevTrimmed = prevStripped.trimEnd();
      const prevSuggestsContinuation = prevTrimmed !== '' && /[:;,\-–—…]$/.test(prevTrimmed);
      if (prevSuggestsContinuation) return true;
      // If we've already continued once, allow subsequent lines until a stop condition
      if (continuationCount > 0) return true;
      return false;
    };

    const outputLines: string[] = [];
    let strippedCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLastLine = i === lines.length - 1;

      // Skip the empty string after a trailing newline
      if (isLastLine && hasTrailingNewline && line === '') {
        continue;
      }

      // If the chunk does NOT end in a newline, the last line is incomplete.
      // Pass it through unmodified and do not attempt to parse it.
      if (isLastLine && !hasTrailingNewline) {
        outputLines.push(line);
        continue;
      }

      if (line.length > 0) {
        // Only check complete lines for relay commands.
        const result = this.processLine(line);
        if (result.command) {
          // Collect continuation lines (in the same chunk) so inline messages can span multiple lines.
          let body = result.command.body;
          const rawLines = [result.command.raw];
          let consumed = 0;
          let continuationLines = 0;

          while (i + 1 < lines.length) {
            const nextIsLast = i + 1 === lines.length - 1;
            const nextLine = lines[i + 1];

            // Do not consume an incomplete trailing line (no newline terminator)
            if (nextIsLast && !hasTrailingNewline) {
              break;
            }

            const nextStripped = stripAnsi(nextLine);
            const prevStripped = stripAnsi(rawLines[rawLines.length - 1] ?? '');

            // Stop if this line clearly marks a new block, prompt, or inline command
            if (shouldStopContinuation(nextStripped)) {
              break;
            }

            if (continuationLines >= MAX_INLINE_CONTINUATION_LINES) {
              break;
            }

            // Consume as continuation if it looks like it belongs to the ->relay message
            if (!isContinuationLine(nextLine, nextStripped, prevStripped, continuationLines)) {
              break;
            }

            consumed++;
            i++; // Skip the consumed continuation line
            continuationLines++;
            body += '\n' + nextLine;
            rawLines.push(nextLine);
          }

          commands.push({ ...result.command, body, raw: rawLines.join('\n') });
          strippedCount += consumed + 1;
          continue;
        }
        if (result.output !== null) {
          outputLines.push(result.output);
        } else {
          // Line was stripped (relay command)
          strippedCount++;
        }
      } else {
        // Empty line - preserve it
        outputLines.push('');
      }
    }

    // Rebuild output
    if (outputLines.length === 0 && strippedCount > 0) {
      // All lines were relay commands - return empty
      return '';
    }

    let output = outputLines.join('\n');

    // Add trailing newline if original had one AND we have content
    if (hasTrailingNewline && outputLines.length > 0) {
      output += '\n';
    }

    return output;
  }

  /**
   * Parse while inside a [[RELAY]] block - buffer until we see [[/RELAY]].
   */
  private parseInBlockMode(data: string, commands: ParsedCommand[], blockType: 'RELAY' | 'RELAY_METADATA'): { commands: ParsedCommand[]; output: string } {
    this.blockBuffer += data;

    // Check size limit
    if (this.blockBuffer.length > this.options.maxBlockBytes) {
      console.error('[parser] Block too large, discarding');
      this.inBlock = false;
      this.blockBuffer = '';
      this.blockType = null;
      return { commands, output: '' };
    }

    // Check for block end
    const blockEndPattern = blockType === 'RELAY_METADATA' ? BLOCK_METADATA_END : BLOCK_END;
    if (blockEndPattern.test(this.blockBuffer)) {
      const result = this.finishBlock(blockType);
      if (result.command) {
        commands.push(result.command);
      }

      let output = '';
      if (result.remaining) {
        // Recursively parse anything after the block
        const afterResult = this.parse(result.remaining);
        commands.push(...afterResult.commands);
        output = afterResult.output;
      }

      return { commands, output };
    }

    // Still inside block, no output yet
    return { commands, output: '' };
  }

  /**
   * Process a single complete line for inline relay commands.
   * Block handling is done at the parse() level, not here.
   *
   * IMPORTANT: We strip ANSI codes for pattern matching, but preserve
   * the original line for output to maintain terminal rendering.
   */
  private processLine(line: string): { command: ParsedCommand | null; output: string | null } {
    // Strip ANSI codes for pattern matching
    const stripped = stripAnsi(line);

    // Handle code fences
    if (CODE_FENCE.test(stripped)) {
      this.inCodeFence = !this.inCodeFence;
      return { command: null, output: line };
    }

    // Inside code fence - pass through
    if (this.inCodeFence) {
      return { command: null, output: line };
    }

    // Check for escaped inline (on stripped text)
    const escapeMatch = stripped.match(this.escapePattern);
    if (escapeMatch) {
      // Output with escape removed (remove the backslash before the prefix)
      const unescaped = line.replace(/\\/, '');
      return { command: null, output: unescaped };
    }

    // Check for inline relay (on stripped text)
    if (this.options.enableInline) {
      const relayMatch = stripped.match(this.inlineRelayPattern);
      if (relayMatch) {
        const [raw, target, threadId, body] = relayMatch;
        return {
          command: {
            to: target,
            kind: 'message',
            body,
            thread: threadId || undefined, // undefined if no thread specified
            raw,
          },
          output: null, // Don't output relay commands
        };
      }

      const thinkingMatch = stripped.match(this.inlineThinkingPattern);
      if (thinkingMatch) {
        const [raw, target, threadId, body] = thinkingMatch;
        return {
          command: {
            to: target,
            kind: 'thinking',
            body,
            thread: threadId || undefined,
            raw,
          },
          output: null,
        };
      }
    }

    // Regular line
    return { command: null, output: line };
  }

  /**
   * Finish processing a block and extract command.
   * Returns the command (if valid) and any remaining content after [[/RELAY]].
   */
  private finishBlock(blockType: 'RELAY' | 'RELAY_METADATA'): { command: ParsedCommand | null; remaining: string | null; metadata: ParsedMessageMetadata | null } {
    const blockEndIdentifier = blockType === 'RELAY_METADATA' ? BLOCK_METADATA_END.source : BLOCK_END.source;
    const endIdx = this.blockBuffer.indexOf(blockEndIdentifier.replace(/\\/g, '')); // Remove regex escapes for indexOf
    const jsonStr = this.blockBuffer.substring(0, endIdx).trim();
    const remaining = this.blockBuffer.substring(endIdx + blockEndIdentifier.replace(/\\/g, '').length) || null;

    this.inBlock = false;
    this.blockBuffer = '';
    this.blockType = null;

    if (blockType === 'RELAY_METADATA') {
      try {
        const metadata = JSON.parse(jsonStr) as ParsedMessageMetadata;
        this.lastParsedMetadata = metadata;
        return { command: null, remaining, metadata };
      } catch (err) {
        console.error('[parser] Invalid JSON in RELAY_METADATA block:', err);
        this.lastParsedMetadata = null;
        return { command: null, remaining, metadata: null };
      }
    } else { // blockType === 'RELAY'
      try {
        const parsed = JSON.parse(jsonStr);

        // Validate required fields
        if (!parsed.to || !parsed.type) {
          console.error('[parser] Block missing required fields (to, type)');
          this.lastParsedMetadata = null; // Clear metadata even if RELAY block is invalid
          return { command: null, remaining, metadata: null };
        }

        const command: ParsedCommand = {
          to: parsed.to,
          kind: parsed.type as PayloadKind,
          body: parsed.body ?? parsed.text ?? '',
          data: parsed.data,
          thread: parsed.thread || undefined,
          raw: jsonStr,
          meta: this.lastParsedMetadata || undefined, // Attach last parsed metadata
        };

        this.lastParsedMetadata = null; // Clear after use

        return {
          command,
          remaining,
          metadata: null,
        };
      } catch (err) {
        console.error('[parser] Invalid JSON in RELAY block:', err);
        this.lastParsedMetadata = null;
        return { command: null, remaining, metadata: null };
      }
    }
  }

  /**
   * Flush any remaining buffer (call on stream end).
   */
  flush(): { commands: ParsedCommand[]; output: string } {
    const result = this.parse('\n');
    this.inBlock = false;
    this.blockBuffer = '';
    this.blockType = null;
    this.lastParsedMetadata = null;
    this.inCodeFence = false;
    return result;
  }

  /**
   * Reset parser state.
   */
  reset(): void {
    this.inBlock = false;
    this.blockBuffer = '';
    this.blockType = null;
    this.lastParsedMetadata = null;
    this.inCodeFence = false;
  }
}

/**
 * Format a relay command for injection into agent input.
 */
export function formatIncomingMessage(from: string, body: string, kind: PayloadKind = 'message'): string {
  const prefix = kind === 'thinking' ? '[THINKING]' : '[MSG]';
  return `\n${prefix} from ${from}: ${body}\n`;
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
  rawContent: string | null;  // Raw block content for deduplication
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
export function parseRelayMetadataFromOutput(output: string): MetadataParseResult {
  const match = output.match(/\[\[RELAY_METADATA\]\]([\s\S]*?)\[\[\/RELAY_METADATA\]\]/);

  if (!match) {
    return { found: false, valid: false, metadata: null, rawContent: null };
  }

  const rawContent = match[1].trim();

  try {
    const metadata = JSON.parse(rawContent) as ParsedMessageMetadata;
    return { found: true, valid: true, metadata, rawContent };
  } catch {
    return { found: true, valid: false, metadata: null, rawContent };
  }
}

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
  rawContent: string | null;  // Raw block content for deduplication
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
export function parseSummaryFromOutput(output: string): ParsedSummary | null {
  const result = parseSummaryWithDetails(output);
  return result.summary;
}

/**
 * Parse SUMMARY block with full details for deduplication.
 * Returns raw content to allow caller to dedupe before logging errors.
 */
export function parseSummaryWithDetails(output: string): SummaryParseResult {
  const match = output.match(/\[\[SUMMARY\]\]([\s\S]*?)\[\[\/SUMMARY\]\]/);

  if (!match) {
    return { found: false, valid: false, summary: null, rawContent: null };
  }

  const rawContent = match[1].trim();

  try {
    const summary = JSON.parse(rawContent) as ParsedSummary;
    return { found: true, valid: true, summary, rawContent };
  } catch {
    return { found: true, valid: false, summary: null, rawContent };
  }
}

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
export function parseSessionEndFromOutput(output: string): SessionEndMarker | null {
  const match = output.match(/\[\[SESSION_END\]\]([\s\S]*?)\[\[\/SESSION_END\]\]/);

  if (!match) {
    return null;
  }

  const content = match[1].trim();
  if (!content) {
    return {}; // Empty marker = session ended without summary
  }

  try {
    return JSON.parse(content) as SessionEndMarker;
  } catch {
    // If not valid JSON, treat the content as a plain summary string
    return { summary: content };
  }
}
