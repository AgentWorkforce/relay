/**
 * Continuity Command Parser
 *
 * Parses `->continuity:` patterns from agent output.
 * Similar to how `->relay:` works for messaging.
 *
 * Supported patterns:
 *   ->continuity:save <<<...>>>
 *   ->continuity:load
 *   ->continuity:search "query"
 *   ->continuity:uncertain "item"
 *   ->continuity:handoff <<<...>>>
 */

import type { ContinuityCommand, Ledger, Decision, FileRef } from './types.js';

/**
 * Regex patterns for continuity commands
 */
const PATTERNS = {
  // ->continuity:save <<<...>>> or ->continuity:save --handoff <<<...>>>
  save: /->continuity:save(?:\s+(--handoff))?\s*<<<([\s\S]*?)>>>/,

  // ->continuity:load
  load: /->continuity:load\b/,

  // ->continuity:search "query" or ->continuity:search <<<query>>>
  search: /->continuity:search\s+(?:"([^"]+)"|<<<([\s\S]*?)>>>)/,

  // ->continuity:uncertain "item"
  uncertain: /->continuity:uncertain\s+"([^"]+)"/,

  // ->continuity:handoff <<<...>>> (explicit handoff creation)
  handoff: /->continuity:handoff\s*<<<([\s\S]*?)>>>/,
};

/**
 * Known placeholder/template values that should be filtered out.
 * These appear in documentation examples and startup messages.
 */
const PLACEHOLDER_VALUES = new Set([
  '...',
  '....',
  'What you\'ve done',
  'What you\'re working on',
  'What you\'re working on now',
  'What\'s remaining',
  'task1',
  'task2',
  'task3',
  'Important context for session recovery',
  'src/file1.ts',
  'src/file2.ts',
  'item1',
  'item2',
]);

/**
 * Check if a value is a placeholder/template string that should be filtered out.
 */
export function isPlaceholderValue(value: string): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  if (!trimmed) return true;

  // Exact match against known placeholders
  if (PLACEHOLDER_VALUES.has(trimmed)) return true;

  // Check for ellipsis-only values
  if (/^\.{2,}$/.test(trimmed)) return true;

  // Check for template-like patterns: [...]
  if (/^\[\.{3}\]$/.test(trimmed)) return true;

  // Check for placeholder array syntax: [...]
  if (trimmed === '[...]') return true;

  return false;
}

/**
 * Filter an array to remove placeholder values.
 */
export function filterPlaceholders<T extends string>(items: T[]): T[] {
  return items.filter(item => !isPlaceholderValue(item));
}

/**
 * Parse a continuity command from agent output
 */
export function parseContinuityCommand(output: string): ContinuityCommand | null {
  // Check for save command
  const saveMatch = output.match(PATTERNS.save);
  if (saveMatch) {
    return {
      type: 'save',
      content: saveMatch[2].trim(),
      createHandoff: saveMatch[1] === '--handoff',
    };
  }

  // Check for load command
  if (PATTERNS.load.test(output)) {
    return {
      type: 'load',
    };
  }

  // Check for search command
  const searchMatch = output.match(PATTERNS.search);
  if (searchMatch) {
    return {
      type: 'search',
      query: (searchMatch[1] || searchMatch[2]).trim(),
    };
  }

  // Check for uncertain command
  const uncertainMatch = output.match(PATTERNS.uncertain);
  if (uncertainMatch) {
    return {
      type: 'uncertain',
      item: uncertainMatch[1].trim(),
    };
  }

  // Check for handoff command
  const handoffMatch = output.match(PATTERNS.handoff);
  if (handoffMatch) {
    return {
      type: 'handoff',
      content: handoffMatch[1].trim(),
      createHandoff: true,
    };
  }

  return null;
}

/**
 * Check if output contains any continuity command
 */
export function hasContinuityCommand(output: string): boolean {
  return Object.values(PATTERNS).some((pattern) => pattern.test(output));
}

/**
 * Map section headers to ledger field names
 */
function mapSectionToField(section: string): string | null {
  const sectionMap: Record<string, string> = {
    'completed': 'completed',
    'previously completed': 'completed',
    'done': 'completed',
    'finished': 'completed',
    'in progress': 'inProgress',
    'working': 'inProgress',
    'ongoing': 'inProgress',
    'blocked': 'blocked',
    'blockers': 'blocked',
    'stuck': 'blocked',
    'key decisions': 'keyDecisions',
    'prior decisions': 'keyDecisions',
    'decisions': 'keyDecisions',
    'needs verification': 'uncertainItems',
    'uncertain': 'uncertainItems',
    'relevant files': 'fileContext',
    'key files': 'fileContext',
    'files': 'fileContext',
    'next steps': 'nextSteps',
    'todo': 'nextSteps',
    'next': 'nextSteps',
    'learnings': 'learnings',
  };
  return sectionMap[section] || null;
}

/**
 * Add an item to the appropriate ledger section.
 * Filters out placeholder/template values.
 */
function addItemToSection(result: Partial<Ledger>, section: string, item: string): void {
  const field = mapSectionToField(section);
  if (!field) return;

  // Filter out placeholder values
  if (isPlaceholderValue(item)) return;

  switch (field) {
    case 'completed':
      result.completed = [...(result.completed || []), item];
      break;
    case 'inProgress':
      result.inProgress = [...(result.inProgress || []), item];
      break;
    case 'blocked':
      result.blocked = [...(result.blocked || []), item];
      break;
    case 'keyDecisions':
      result.keyDecisions = [
        ...(result.keyDecisions || []),
        { decision: item, timestamp: new Date() },
      ];
      break;
    case 'uncertainItems':
      result.uncertainItems = [...(result.uncertainItems || []), item];
      break;
    case 'fileContext':
      result.fileContext = [...(result.fileContext || []), { path: item }];
      break;
    case 'nextSteps':
      result.inProgress = [...(result.inProgress || []), item];
      break;
  }
}

/**
 * Process a field-value pair from bold markdown or plain text.
 * Filters out placeholder/template values.
 */
function processFieldValue(result: Partial<Ledger>, field: string, value: string): void {
  switch (field) {
    case 'current task':
    case 'task':
    case 'working on':
      // Only set if not a placeholder
      if (!isPlaceholderValue(value)) {
        result.currentTask = value;
      }
      break;

    case 'completed':
    case 'done':
    case 'finished':
      result.completed = filterPlaceholders(parseListValue(value));
      break;

    case 'in progress':
    case 'working':
    case 'ongoing':
      result.inProgress = filterPlaceholders(parseListValue(value));
      break;

    case 'blocked':
    case 'blockers':
    case 'stuck':
      result.blocked = filterPlaceholders(parseListValue(value));
      break;

    case 'key decision':
    case 'key decisions':
    case 'decisions':
    case 'decided':
      result.keyDecisions = parseDecisions(value);
      break;

    case 'uncertain':
    case 'unconfirmed':
    case 'needs verification':
    case 'to verify':
      result.uncertainItems = filterPlaceholders(parseListValue(value));
      break;

    case 'files':
    case 'file context':
    case 'relevant files':
      result.fileContext = parseFileRefs(value).filter(f => !isPlaceholderValue(f.path));
      break;

    case 'next':
    case 'next steps':
    case 'todo':
      result.inProgress = [...(result.inProgress || []), ...filterPlaceholders(parseListValue(value))];
      break;

    case 'phase':
    case 'last phase':
      result.pderoPhase = value.toLowerCase() as Ledger['pderoPhase'];
      break;
  }
}

/**
 * Parse the content of a save command into ledger fields
 *
 * Expected format:
 *   Current task: <task>
 *   Completed: <item>, <item>, ...
 *   In progress: <item>, ...
 *   Blocked: <item>, ...
 *   Key decisions: <decision>
 *   Uncertain: <item>, ...
 *   Files: <path>:<lines>, ...
 *
 * Also handles markdown-formatted content:
 *   **Current Task:** <task>
 *   ### Completed
 *   - ✓ <item>
 */
export function parseSaveContent(content: string): Partial<Ledger> {
  const result: Partial<Ledger> = {
    completed: [],
    inProgress: [],
    blocked: [],
    keyDecisions: [],
    uncertainItems: [],
    fileContext: [],
  };

  const lines = content.split('\n');
  let currentSection: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check for markdown section headers (## or ###)
    const sectionMatch = trimmed.match(/^#{2,3}\s+(.+)$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].toLowerCase().trim();
      continue;
    }

    // Skip top-level markdown headers
    if (trimmed.startsWith('#')) continue;

    // Handle markdown list items under a section
    if (trimmed.startsWith('-') && currentSection) {
      const itemContent = trimmed.slice(1).trim().replace(/^[✓⚠❓]\s*/, '');
      if (itemContent) {
        addItemToSection(result, currentSection, itemContent);
      }
      continue;
    }

    // Skip standalone list items without a section context
    if (trimmed.startsWith('-') && !currentSection) {
      continue;
    }

    // Match "**Field:** value" (markdown bold syntax - colon can be inside or outside asterisks)
    // Format 1: **Field:** value (colon inside asterisks)
    // Format 2: **Field**: value (colon outside asterisks)
    const boldMatch = trimmed.match(/^\*\*([^*:]+):?\*\*:?\s*(.*)$/);
    if (boldMatch) {
      const field = boldMatch[1].toLowerCase().trim();
      const value = boldMatch[2].trim();
      processFieldValue(result, field, value);
      // Reset section when we see a bold field
      currentSection = null;
      continue;
    }

    // Match "Field: value" or "Field:" followed by list items
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;

    // Skip if colon is too early (likely a file path like "src/file.ts:10")
    // or if field contains special characters that suggest it's not a field
    const potentialField = trimmed.slice(0, colonIndex);
    if (
      colonIndex < 2 ||
      potentialField.includes('/') ||
      potentialField.includes('\\') ||
      potentialField.includes('`')
    ) {
      continue;
    }

    const field = potentialField.toLowerCase().trim();
    const value = trimmed.slice(colonIndex + 1).trim();

    // Reset section when we see a new field
    currentSection = null;

    processFieldValue(result, field, value);
  }

  return result;
}

/**
 * Parse a comma or newline separated list
 */
function parseListValue(value: string): string[] {
  if (!value) return [];

  // Handle both comma-separated and newline-separated
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item && !item.startsWith('-') && item !== '-')
    .map((item) => item.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
}

/**
 * Parse decisions from value
 */
function parseDecisions(value: string): Decision[] {
  const items = parseListValue(value);
  return items.map((item) => ({
    decision: item,
    timestamp: new Date(),
  }));
}

/**
 * Parse file references from value
 * Format: path:startLine-endLine, path, path:line
 */
function parseFileRefs(value: string): FileRef[] {
  const items = parseListValue(value);
  return items.map((item) => {
    // Match path:startLine-endLine or path:line or just path
    const match = item.match(/^([^:]+)(?::(\d+)(?:-(\d+))?)?$/);
    if (!match) {
      return { path: item.trim() };
    }

    const ref: FileRef = { path: match[1].trim() };
    if (match[2]) {
      const startLine = parseInt(match[2]);
      const endLine = match[3] ? parseInt(match[3]) : startLine;
      ref.lines = [startLine, endLine];
    }
    return ref;
  });
}

/**
 * Parse handoff content (similar to save but for permanent handoffs)
 *
 * Expected format:
 *   Summary: <summary>
 *   Task: <task description>
 *   Completed: <item>, ...
 *   Next steps: <item>, ...
 *   Key decisions: <decision>, ...
 *   Files: <path>, ...
 *   Learnings: <learning>, ...
 */
export interface ParsedHandoffContent {
  summary?: string;
  taskDescription?: string;
  completedWork: string[];
  nextSteps: string[];
  decisions: Decision[];
  fileReferences: FileRef[];
  learnings: string[];
}

export function parseHandoffContent(content: string): ParsedHandoffContent {
  const result: ParsedHandoffContent = {
    completedWork: [],
    nextSteps: [],
    decisions: [],
    fileReferences: [],
    learnings: [],
  };

  const lines = content.split('\n');
  let currentSection: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check for markdown section headers (## or ###)
    const sectionMatch = trimmed.match(/^#{2,3}\s+(.+)$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].toLowerCase().trim();
      continue;
    }

    // Skip top-level markdown headers
    if (trimmed.startsWith('#')) continue;

    // Handle markdown list items under a section
    if (trimmed.startsWith('-') && currentSection) {
      const itemContent = trimmed.slice(1).trim().replace(/^[✓⚠❓]\s*/, '');
      if (itemContent) {
        addItemToHandoffSection(result, currentSection, itemContent);
      }
      continue;
    }

    // Skip standalone list items without a section context
    if (trimmed.startsWith('-') && !currentSection) {
      continue;
    }

    // Match "**Field:** value" (markdown bold syntax - colon can be inside or outside asterisks)
    const boldMatch = trimmed.match(/^\*\*([^*:]+):?\*\*:?\s*(.*)$/);
    if (boldMatch) {
      const field = boldMatch[1].toLowerCase().trim();
      const value = boldMatch[2].trim();
      processHandoffFieldValue(result, field, value);
      currentSection = null;
      continue;
    }

    // Match "Field: value"
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;

    // Skip if colon is too early or field contains path-like characters
    const potentialField = trimmed.slice(0, colonIndex);
    if (
      colonIndex < 2 ||
      potentialField.includes('/') ||
      potentialField.includes('\\') ||
      potentialField.includes('`')
    ) {
      continue;
    }

    const field = potentialField.toLowerCase().trim();
    const value = trimmed.slice(colonIndex + 1).trim();

    currentSection = null;
    processHandoffFieldValue(result, field, value);
  }

  return result;
}

/**
 * Add an item to the appropriate handoff section.
 * Filters out placeholder/template values.
 */
function addItemToHandoffSection(
  result: ParsedHandoffContent,
  section: string,
  item: string
): void {
  const sectionMap: Record<string, keyof ParsedHandoffContent> = {
    'summary': 'summary',
    'completed': 'completedWork',
    'previously completed': 'completedWork',
    'done': 'completedWork',
    'next steps': 'nextSteps',
    'next': 'nextSteps',
    'todo': 'nextSteps',
    'key decisions': 'decisions',
    'prior decisions': 'decisions',
    'decisions': 'decisions',
    'files': 'fileReferences',
    'key files': 'fileReferences',
    'learnings': 'learnings',
  };

  const field = sectionMap[section];
  if (!field) return;

  // Filter out placeholder values
  if (isPlaceholderValue(item)) return;

  switch (field) {
    case 'completedWork':
      result.completedWork.push(item);
      break;
    case 'nextSteps':
      result.nextSteps.push(item);
      break;
    case 'decisions':
      result.decisions.push({ decision: item, timestamp: new Date() });
      break;
    case 'fileReferences':
      result.fileReferences.push({ path: item });
      break;
    case 'learnings':
      result.learnings.push(item);
      break;
  }
}

/**
 * Process a field-value pair for handoff content.
 * Filters out placeholder/template values.
 */
function processHandoffFieldValue(
  result: ParsedHandoffContent,
  field: string,
  value: string
): void {
  switch (field) {
    case 'summary':
      if (!isPlaceholderValue(value)) {
        result.summary = value;
      }
      break;

    case 'task':
    case 'task description':
      if (!isPlaceholderValue(value)) {
        result.taskDescription = value;
      }
      break;

    case 'completed':
    case 'done':
      result.completedWork = filterPlaceholders(parseListValue(value));
      break;

    case 'next':
    case 'next steps':
    case 'todo':
      result.nextSteps = filterPlaceholders(parseListValue(value));
      break;

    case 'decisions':
    case 'key decisions':
      result.decisions = parseDecisions(value).filter(d => !isPlaceholderValue(d.decision));
      break;

    case 'files':
      result.fileReferences = parseFileRefs(value).filter(f => !isPlaceholderValue(f.path));
      break;

    case 'learnings':
    case 'learned':
      result.learnings = filterPlaceholders(parseListValue(value));
      break;
  }
}

/**
 * Extract all continuity commands from a block of output
 * (in case multiple commands are present)
 */
export function extractAllCommands(output: string): ContinuityCommand[] {
  const commands: ContinuityCommand[] = [];

  // Find all save commands
  const saveRegex = new RegExp(PATTERNS.save.source, 'g');
  let match;
  while ((match = saveRegex.exec(output)) !== null) {
    commands.push({
      type: 'save',
      content: match[2].trim(),
      createHandoff: match[1] === '--handoff',
    });
  }

  // Find load commands
  if (PATTERNS.load.test(output)) {
    commands.push({ type: 'load' });
  }

  // Find search commands
  const searchRegex = new RegExp(PATTERNS.search.source, 'g');
  while ((match = searchRegex.exec(output)) !== null) {
    commands.push({
      type: 'search',
      query: (match[1] || match[2]).trim(),
    });
  }

  // Find uncertain commands
  const uncertainRegex = new RegExp(PATTERNS.uncertain.source, 'g');
  while ((match = uncertainRegex.exec(output)) !== null) {
    commands.push({
      type: 'uncertain',
      item: match[1].trim(),
    });
  }

  // Find handoff commands
  const handoffRegex = new RegExp(PATTERNS.handoff.source, 'g');
  while ((match = handoffRegex.exec(output)) !== null) {
    commands.push({
      type: 'handoff',
      content: match[1].trim(),
      createHandoff: true,
    });
  }

  return commands;
}
