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
  /** Optional project for cross-project messaging (e.g., ->relay:project:agent) */
  project?: string;
  /** Optional thread project for cross-project threads (e.g., [thread:project:id]) */
  threadProject?: string;
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
const CODE_FENCE = /^```/;

// Fenced inline patterns: ->relay:Target <<< ... >>>
// Two patterns for fence end detection:
// - FENCE_END_START: ">>>" at the start of a line (with optional leading whitespace)
// - FENCE_END_LINE: ">>>" at the end of a line (content followed by >>>)
// Note: Escaped \>>> should NOT trigger fence end (see isEscapedFenceEnd)
const FENCE_END_START = /^(?:\s*)?>>>/;
const FENCE_END_LINE = />>>\s*$/;
const FENCE_END = new RegExp(`${FENCE_END_START.source}|${FENCE_END_LINE.source}`);

// Escape patterns for literal <<< and >>> in content
// Use \<<< to output literal <<<, use \>>> to output literal >>>
const ESCAPED_FENCE_START = /\\<<</g;
const ESCAPED_FENCE_END = /\\>>>/g;

// Maximum lines in a fenced block before assuming it's stuck
// Lower value (30) ensures messages get sent even if agent forgets >>>
// Most relay messages are under 20 lines; 30 gives buffer for longer ones
const MAX_FENCED_LINES = 30;

// Continuation helpers
const BULLET_OR_NUMBERED_LIST = /^[ \t]*([\-*•◦‣⏺◆◇○□■]|[0-9]+[.)])\s+/;
const PROMPTISH_LINE = /^[\s]*[>$%#➜›»][\s]*$/;
const RELAY_INJECTION_PREFIX = /^\s*Relay message from /;
const MAX_INLINE_CONTINUATION_LINES = 30;

// Spawn/release command patterns - these should NOT be parsed as relay messages
// They are handled separately by the wrappers (pty-wrapper.ts, tmux-wrapper.ts)
const SPAWN_COMMAND_PATTERN = /->relay:spawn\s+\S+/i;
const RELEASE_COMMAND_PATTERN = /->relay:release\s+\S+/i;

/**
 * Check if a line is a spawn or release command that should be handled
 * by the wrapper's spawn subsystem, not parsed as a relay message.
 */
function isSpawnOrReleaseCommand(line: string): boolean {
  return SPAWN_COMMAND_PATTERN.test(line) || RELEASE_COMMAND_PATTERN.test(line);
}

// Claude extended thinking block markers - skip content inside these
const THINKING_START = /<antml:thinking>/;
const THINKING_END = /<\/thinking>/;

/**
 * Patterns that indicate instructional/example text that should NOT be parsed as actual commands.
 * These are common in system prompts, documentation, and injected instructions.
 */
const INSTRUCTIONAL_MARKERS = [
  /\bSEND:\s*$/i,                    // "SEND:" at end of body (instruction prefix)
  /\bPROTOCOL:\s*\(\d+\)/i,          // "PROTOCOL: (1)" - numbered protocol instructions
  /\bExample:/i,                      // "Example:" marker
  /\\->relay:/,                       // Escaped relay prefix in body (documentation)
  /\\->thinking:/,                    // Escaped thinking prefix in body (documentation)
  /^AgentName\s+/,                    // Body starting with "AgentName" (placeholder in examples)
  /^Target\s+/,                       // Body starting with "Target" (placeholder in examples)
  /\[Agent Relay\]/,                  // Injected instruction header
  /MULTI-LINE:/i,                     // Multi-line format instruction
  /RECEIVE:/i,                        // Receive instruction marker
];

/**
 * Check if a parsed relay command body looks like instructional/example text.
 * These patterns commonly appear in system prompts and documentation.
 */
function isInstructionalText(body: string): boolean {
  return INSTRUCTIONAL_MARKERS.some(pattern => pattern.test(body));
}

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
 * Supports optional thread syntax:
 * - ->relay:Target [thread:id] message (local thread)
 * - ->relay:Target [thread:project:id] message (cross-project thread)
 * Thread IDs can contain alphanumeric chars, hyphens, underscores
 */
function buildInlinePattern(prefix: string): RegExp {
  const escaped = escapeRegex(prefix);
  // Group 1: target, Group 2: optional thread project, Group 3: thread ID, Group 4: message body
  // Includes box drawing characters (│┃┆┇┊┋╎╏) and sparkle (✦) for Gemini CLI output
  return new RegExp(`^(?:\\s*(?:[>$%#→➜›»●•◦‣⁃\\-*⏺◆◇○□■│┃┆┇┊┋╎╏✦]\\s*)*)?${escaped}(\\S+)(?:\\s+\\[thread:(?:([\\w-]+):)?([\\w-]+)\\])?\\s+(.+)$`);
}

/**
 * Build fenced inline pattern for multi-line messages: ->relay:Target <<<
 * This opens a fenced block that continues until >>> is seen on its own line.
 * Supports cross-project thread syntax: [thread:project:id]
 * Group 1: target, Group 2: optional thread project, Group 3: thread ID
 */
function buildFencedInlinePattern(prefix: string): RegExp {
  const escaped = escapeRegex(prefix);
  return new RegExp(`^(?:\\s*(?:[>$%#→➜›»●•◦‣⁃\\-*⏺◆◇○□■│┃┆┇┊┋╎╏✦]\\s*)*)?${escaped}(\\S+)(?:\\s+\\[thread:(?:([\\w-]+):)?([\\w-]+)\\])?\\s+<<<\\s*$`);
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

// Pattern for orphaned CSI sequences that lost their escape byte
// These look like [?25h, [?2026l, [0m, etc. at the start of content
const ORPHANED_CSI_PATTERN = /^\s*(\[\??\d*[A-Za-z])+\s*/g;

/**
 * Parse a target string that may contain cross-project syntax.
 * Supports: "agent" (local) or "project:agent" (cross-project)
 *
 * @param target The raw target string from the relay command
 * @returns Object with `to` (agent name) and optional `project`
 */
function parseTarget(target: string): { to: string; project?: string } {
  // Check for cross-project syntax: project:agent
  // Only split on FIRST colon to allow agent names with colons
  const colonIndex = target.indexOf(':');

  if (colonIndex > 0 && colonIndex < target.length - 1) {
    // Has a colon with content on both sides
    const project = target.substring(0, colonIndex);
    const agent = target.substring(colonIndex + 1);
    return { to: agent, project };
  }

  // Local target (no colon or malformed)
  return { to: target };
}

/**
 * Strip ANSI escape codes from a string for pattern matching.
 * Also strips orphaned CSI sequences that may have lost their escape byte.
 */
function stripAnsi(str: string): string {
  let result = str.replace(ANSI_PATTERN, '');
  // Strip orphaned CSI sequences at the start of the string
  result = result.replace(ORPHANED_CSI_PATTERN, '');
  return result;
}

/**
 * Check if a line contains an escaped fence end (\>>>) that should NOT trigger fence close.
 * Returns true if the >>> is escaped (preceded by backslash).
 */
function isEscapedFenceEnd(line: string): boolean {
  // Check if >>> at end of line is escaped
  if (/\\>>>\s*$/.test(line)) {
    return true;
  }
  // Check if >>> at start of line is escaped
  if (/^(?:\s*)?\\>>>/.test(line)) {
    return true;
  }
  return false;
}

/**
 * Unescape fence markers in content.
 * Converts \<<< to <<< and \>>> to >>>
 */
function unescapeFenceMarkers(content: string): string {
  return content
    .replace(ESCAPED_FENCE_START, '<<<')
    .replace(ESCAPED_FENCE_END, '>>>');
}

export class OutputParser {
  private options: Required<ParserOptions>;
  private inCodeFence = false;
  private inBlock = false;
  private blockBuffer = '';
  private blockType: 'RELAY' | 'RELAY_METADATA' | null = null;
  private lastParsedMetadata: ParsedMessageMetadata | null = null;

  // Claude extended thinking block state - skip content inside <thinking>...</thinking>
  private inThinkingBlock = false;

  // Fenced inline state: ->relay:Target <<< ... >>>
  private inFencedInline = false;
  private fencedInlineBuffer = '';
  private fencedInlineTarget = '';
  private fencedInlineThread: string | undefined = undefined;
  private fencedInlineThreadProject: string | undefined = undefined;
  private fencedInlineProject: string | undefined = undefined;
  private fencedInlineRaw: string[] = [];
  private fencedInlineKind: 'message' | 'thinking' = 'message';

  // Dynamic patterns based on prefix configuration
  private inlineRelayPattern: RegExp;
  private inlineThinkingPattern: RegExp;
  private fencedRelayPattern: RegExp;
  private fencedThinkingPattern: RegExp;
  private escapePattern: RegExp;

  constructor(options: ParserOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };

    // Build patterns based on configured prefixes
    this.inlineRelayPattern = buildInlinePattern(this.options.prefix);
    this.inlineThinkingPattern = buildInlinePattern(this.options.thinkingPrefix);
    this.fencedRelayPattern = buildFencedInlinePattern(this.options.prefix);
    this.fencedThinkingPattern = buildFencedInlinePattern(this.options.thinkingPrefix);
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

    // If we're inside a fenced inline block, accumulate until we see >>>
    if (this.inFencedInline) {
      return this.parseFencedInlineMode(data, commands);
    }

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

    const isFencedInlineStart = (line: string): { target: string; thread?: string; threadProject?: string; project?: string; kind: 'message' | 'thinking' } | null => {
      const stripped = stripAnsi(line);
      const relayMatch = stripped.match(this.fencedRelayPattern);
      if (relayMatch) {
        const [, target, threadProject, threadId] = relayMatch;
        const { to, project } = parseTarget(target);
        return { target: to, thread: threadId || undefined, threadProject: threadProject || undefined, project, kind: 'message' };
      }
      const thinkingMatch = stripped.match(this.fencedThinkingPattern);
      if (thinkingMatch) {
        const [, target, threadProject, threadId] = thinkingMatch;
        const { to, project } = parseTarget(target);
        return { target: to, thread: threadId || undefined, threadProject: threadProject || undefined, project, kind: 'thinking' };
      }
      return null;
    };

    const isBlockMarker = (line: string): boolean => {
      return CODE_FENCE.test(line) || line.includes('[[RELAY]]') || BLOCK_END.test(line);
    };

    const shouldStopContinuation = (line: string, continuationCount: number, lines: string[], currentIndex: number): boolean => {
      const trimmed = line.trim();
      if (isInlineStart(line)) return true;
      if (isFencedInlineStart(line)) return true;
      if (isBlockMarker(line)) return true;
      if (PROMPTISH_LINE.test(trimmed)) return true;
      if (RELAY_INJECTION_PREFIX.test(line)) return true; // Avoid swallowing injected inbound messages

      // Allow blank lines only in structured content like tables or between numbered sections
      if (trimmed === '') {
        // If we haven't started continuation yet, stop on blank
        if (continuationCount === 0) return true;

        // Look ahead to see if there's more content that looks like structured markdown
        for (let j = currentIndex + 1; j < lines.length; j++) {
          const nextLine = lines[j].trim();
          if (nextLine === '') {
            // Double blank line always stops
            return true;
          }
          // Only continue for table rows or numbered list items after blank
          if (/^\|/.test(nextLine)) return false; // Table row
          if (/^\d+[.)]\s/.test(nextLine)) return false; // Numbered list like "1." or "2)"
          // Stop for anything else after a blank line
          return true;
        }
        return true; // No more content, stop
      }
      return false;
    };

    const isContinuationLine = (
      original: string,
      stripped: string,
      prevStripped: string,
      continuationCount: number
    ): boolean => {
      // Note: shouldStopContinuation is already checked in the main loop before calling this
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

      // Skip Claude extended thinking blocks - don't parse or output their content
      // Check for thinking end first (to handle end tag on same line as start)
      if (this.inThinkingBlock) {
        if (THINKING_END.test(line)) {
          this.inThinkingBlock = false;
        }
        // Skip this line - don't output thinking content
        strippedCount++;
        continue;
      }
      // Check for thinking start
      if (THINKING_START.test(line)) {
        this.inThinkingBlock = true;
        // Also check if it ends on the same line (inline thinking block)
        if (THINKING_END.test(line)) {
          this.inThinkingBlock = false;
        }
        // Skip this line - don't output thinking content
        strippedCount++;
        continue;
      }

      // Check for fenced inline start: ->relay:Target <<<
      const fencedStart = isFencedInlineStart(line);
      if (fencedStart && this.options.enableInline) {
        // Enter fenced inline mode
        this.inFencedInline = true;
        this.fencedInlineTarget = fencedStart.target;
        this.fencedInlineThread = fencedStart.thread;
        this.fencedInlineThreadProject = fencedStart.threadProject;
        this.fencedInlineProject = fencedStart.project;
        this.fencedInlineKind = fencedStart.kind;
        this.fencedInlineBuffer = '';
        this.fencedInlineRaw = [line];

        // Process remaining lines in fenced mode
        if (i + 1 < lines.length) {
          // Don't double-add trailing newline - the empty string at end of lines array
          // already accounts for it when we join
          const remainingLines = lines.slice(i + 1);
          const remaining = remainingLines.join('\n') + (hasTrailingNewline && remainingLines[remainingLines.length - 1] !== '' ? '\n' : '');
          const result = this.parseFencedInlineMode(remaining, commands);
          strippedCount++;

          // Combine output
          let output = outputLines.join('\n');
          if (hasTrailingNewline && outputLines.length > 0 && !this.inFencedInline) {
            output += '\n';
          }
          output += result.output;
          return output;
        }

        // No more lines - waiting for more data
        strippedCount++;
        let output = outputLines.join('\n');
        if (hasTrailingNewline && outputLines.length > 0) {
          output += '\n';
        }
        return output;
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
            if (shouldStopContinuation(nextStripped, continuationLines, lines, i + 1)) {
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

    // Skip spawn/release commands - they are handled by the wrapper's spawn subsystem
    // These should not be parsed as regular relay messages
    if (isSpawnOrReleaseCommand(stripped)) {
      return { command: null, output: line };
    }

    // Check for inline relay (on stripped text)
    if (this.options.enableInline) {
      const relayMatch = stripped.match(this.inlineRelayPattern);
      if (relayMatch) {
        const [raw, target, threadProject, threadId, body] = relayMatch;

        // Skip instructional/example text (common in system prompts)
        if (isInstructionalText(body)) {
          return { command: null, output: line };
        }

        const { to, project } = parseTarget(target);
        return {
          command: {
            to,
            kind: 'message',
            body,
            thread: threadId || undefined, // undefined if no thread specified
            threadProject: threadProject || undefined, // undefined if local thread
            project, // undefined if local, set if cross-project
            raw,
          },
          output: null, // Don't output relay commands
        };
      }

      const thinkingMatch = stripped.match(this.inlineThinkingPattern);
      if (thinkingMatch) {
        const [raw, target, threadProject, threadId, body] = thinkingMatch;

        // Skip instructional/example text (common in system prompts)
        if (isInstructionalText(body)) {
          return { command: null, output: line };
        }

        const { to, project } = parseTarget(target);
        return {
          command: {
            to,
            kind: 'thinking',
            body,
            thread: threadId || undefined,
            threadProject: threadProject || undefined,
            project,
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

        // Handle cross-project syntax in block format
        // Supports both explicit "project" field and "project:agent" in "to" field
        let to = parsed.to;
        let project = parsed.project;

        if (!project && typeof to === 'string') {
          // Check if "to" field uses project:agent syntax
          const targetParsed = parseTarget(to);
          to = targetParsed.to;
          project = targetParsed.project;
        }

        const command: ParsedCommand = {
          to,
          kind: parsed.type as PayloadKind,
          body: parsed.body ?? parsed.text ?? '',
          data: parsed.data,
          thread: parsed.thread || undefined,
          project: project || undefined,
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
   * Parse while inside a fenced inline block (->relay:Target <<< ... >>>).
   * Accumulates lines until >>> is seen on its own line.
   */
  private parseFencedInlineMode(data: string, commands: ParsedCommand[]): { commands: ParsedCommand[]; output: string } {
    const lines = data.split('\n');
    const hasTrailingNewline = data.endsWith('\n');
    let output = '';
    let consecutiveBlankLines = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLastLine = i === lines.length - 1;
      const stripped = stripAnsi(line);

      // Track consecutive blank lines for auto-close
      if (stripped === '') {
        consecutiveBlankLines++;
      } else {
        consecutiveBlankLines = 0;
      }

      // Auto-close on double blank line (agent forgot >>>)
      // Only if we have actual content to send
      if (consecutiveBlankLines >= 2 && this.fencedInlineBuffer.trim().length > 0) {
        const body = unescapeFenceMarkers(stripAnsi(this.fencedInlineBuffer.trim()));
        const command: ParsedCommand = {
          to: this.fencedInlineTarget,
          kind: this.fencedInlineKind,
          body,
          thread: this.fencedInlineThread,
          threadProject: this.fencedInlineThreadProject,
          project: this.fencedInlineProject,
          raw: this.fencedInlineRaw.join('\n'),
        };
        commands.push(command);

        // Reset fenced inline state
        this.inFencedInline = false;
        this.fencedInlineBuffer = '';
        this.fencedInlineTarget = '';
        this.fencedInlineThread = undefined;
        this.fencedInlineThreadProject = undefined;
        this.fencedInlineProject = undefined;
        this.fencedInlineRaw = [];
        this.fencedInlineKind = 'message';

        // Process remaining lines in normal mode
        const remainingLines = lines.slice(i);
        const remaining = remainingLines.join('\n') + (hasTrailingNewline ? '\n' : '');
        const result = this.parse(remaining);
        commands.push(...result.commands);
        return { commands, output: result.output };
      }

      // Check if a new relay command started (means previous fenced block was never closed)
      // Auto-close and SEND the incomplete message instead of discarding it
      // This preserves message content when agents forget to close with >>>
      if (this.inlineRelayPattern.test(stripped) || this.fencedRelayPattern.test(stripped)) {
        // Auto-close and send the incomplete fenced block (if it has content)
        if (this.fencedInlineBuffer.trim().length > 0) {
          const body = unescapeFenceMarkers(stripAnsi(this.fencedInlineBuffer.trim()));
          const command: ParsedCommand = {
            to: this.fencedInlineTarget,
            kind: this.fencedInlineKind,
            body,
            thread: this.fencedInlineThread,
            threadProject: this.fencedInlineThreadProject,
            project: this.fencedInlineProject,
            raw: this.fencedInlineRaw.join('\n'),
          };
          commands.push(command);
        }

        // Reset fenced inline state
        this.inFencedInline = false;
        this.fencedInlineBuffer = '';
        this.fencedInlineTarget = '';
        this.fencedInlineThread = undefined;
        this.fencedInlineThreadProject = undefined;
        this.fencedInlineProject = undefined;
        this.fencedInlineRaw = [];
        this.fencedInlineKind = 'message';

        // Process remaining lines (including this one) in normal mode
        const remainingLines = lines.slice(i);
        const remaining = remainingLines.join('\n') + (hasTrailingNewline ? '\n' : '');
        const result = this.parse(remaining);
        commands.push(...result.commands);
        return { commands, output: result.output };
      }

      // Check if this line closes the fenced block
      // Skip if the >>> is escaped (\>>>)
      if (FENCE_END.test(stripped) && !isEscapedFenceEnd(stripped)) {
        // If >>> is at end of line (not start), extract content before it
        const endsWithFence = />>>\s*$/.test(stripped) && !/^(?:\s*)?>>>/.test(stripped);
        if (endsWithFence) {
          const contentBeforeFence = stripped.replace(/>>>\s*$/, '');
          if (contentBeforeFence.trim()) {
            if (this.fencedInlineBuffer.length > 0) {
              this.fencedInlineBuffer += '\n' + contentBeforeFence;
            } else {
              this.fencedInlineBuffer = contentBeforeFence;
            }
          }
        }

        // Complete the fenced inline command - unescape any \<<< and \>>> in content
        const body = unescapeFenceMarkers(stripAnsi(this.fencedInlineBuffer.trim()));
        this.fencedInlineRaw.push(line);

        const command: ParsedCommand = {
          to: this.fencedInlineTarget,
          kind: this.fencedInlineKind,
          body,
          thread: this.fencedInlineThread,
          threadProject: this.fencedInlineThreadProject,
          project: this.fencedInlineProject,
          raw: this.fencedInlineRaw.join('\n'),
        };
        commands.push(command);

        // Reset fenced inline state
        this.inFencedInline = false;
        this.fencedInlineBuffer = '';
        this.fencedInlineTarget = '';
        this.fencedInlineThread = undefined;
        this.fencedInlineThreadProject = undefined;
        this.fencedInlineProject = undefined;
        this.fencedInlineRaw = [];
        this.fencedInlineKind = 'message';

        // Process remaining lines after the fence close
        // Only process if there's actual content after the closing fence
        const remainingLines = lines.slice(i + 1);
        // Filter out trailing empty string from split
        const hasContent = remainingLines.some((l, idx) =>
          l.trim() !== '' || (idx < remainingLines.length - 1));

        if (hasContent) {
          const remaining = remainingLines.join('\n') + (hasTrailingNewline ? '\n' : '');
          const result = this.parse(remaining);
          commands.push(...result.commands);
          output += result.output;
        }
        return { commands, output };
      }

      // Accumulate this line into the buffer (preserving blank lines within content)
      // But skip trailing empty line from split (when input ends with \n)
      const isTrailingEmpty = isLastLine && line === '' && hasTrailingNewline;
      if (!isTrailingEmpty) {
        if (this.fencedInlineBuffer.length > 0) {
          this.fencedInlineBuffer += '\n' + line;
        } else if (line.trim() !== '') {
          // Start accumulating from first non-blank line
          this.fencedInlineBuffer = line;
        }
        this.fencedInlineRaw.push(line);
      }

      // Check size limit
      if (this.fencedInlineBuffer.length > this.options.maxBlockBytes) {
        console.error('[parser] Fenced inline block too large, discarding');
        this.inFencedInline = false;
        this.fencedInlineBuffer = '';
        this.fencedInlineTarget = '';
        this.fencedInlineThread = undefined;
        this.fencedInlineThreadProject = undefined;
        this.fencedInlineProject = undefined;
        this.fencedInlineRaw = [];
        this.fencedInlineKind = 'message';
        return { commands, output: '' };
      }

      // Check line count limit - prevents stuck fenced mode from blocking all messages
      if (this.fencedInlineRaw.length > MAX_FENCED_LINES) {
        console.error('[parser] Fenced inline block exceeded max lines, discarding');
        this.inFencedInline = false;
        this.fencedInlineBuffer = '';
        this.fencedInlineTarget = '';
        this.fencedInlineThread = undefined;
        this.fencedInlineThreadProject = undefined;
        this.fencedInlineProject = undefined;
        this.fencedInlineRaw = [];
        this.fencedInlineKind = 'message';
        return { commands, output: '' };
      }
    }

    // Still waiting for >>> - return empty output (content is buffered)
    return { commands, output: '' };
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
    this.inThinkingBlock = false;
    this.inFencedInline = false;
    this.fencedInlineBuffer = '';
    this.fencedInlineTarget = '';
    this.fencedInlineThread = undefined;
    this.fencedInlineThreadProject = undefined;
    this.fencedInlineProject = undefined;
    this.fencedInlineRaw = [];
    this.fencedInlineKind = 'message';
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
    this.inThinkingBlock = false;
    this.inFencedInline = false;
    this.fencedInlineBuffer = '';
    this.fencedInlineTarget = '';
    this.fencedInlineThread = undefined;
    this.fencedInlineThreadProject = undefined;
    this.fencedInlineProject = undefined;
    this.fencedInlineRaw = [];
    this.fencedInlineKind = 'message';
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
