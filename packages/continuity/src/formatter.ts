/**
 * Context Formatter
 *
 * Formats ledgers, handoffs, and learnings into markdown
 * for injection into agent context.
 */

import type { Ledger, Handoff, StartupContext, FileRef, Decision } from './types.js';

/**
 * Format options for context injection
 */
export interface FormatOptions {
  /** Maximum length of the formatted context */
  maxLength?: number;
  /** Include file references */
  includeFiles?: boolean;
  /** Include decisions */
  includeDecisions?: boolean;
  /** Include learnings */
  includeLearnings?: boolean;
  /** Compact mode (less verbose) */
  compact?: boolean;
}

const DEFAULT_OPTIONS: FormatOptions = {
  maxLength: 4000,
  includeFiles: true,
  includeDecisions: true,
  includeLearnings: true,
  compact: false,
};

/**
 * Format a startup context for injection
 */
export function formatStartupContext(
  context: Omit<StartupContext, 'formatted'>,
  options: FormatOptions = {}
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const sections: string[] = [];

  sections.push('# Session Continuity');
  sections.push('');
  sections.push('*This context was automatically loaded from your previous session.*');
  sections.push('');

  // Format ledger if present
  if (context.ledger) {
    sections.push(formatLedger(context.ledger, opts));
  }

  // Format handoff if present (and no ledger or ledger is stale)
  if (context.handoff) {
    if (!context.ledger || isHandoffNewer(context.handoff, context.ledger)) {
      sections.push('');
      sections.push(formatHandoff(context.handoff, opts));
    }
  }

  // Format learnings if present
  if (context.learnings && context.learnings.length > 0 && opts.includeLearnings) {
    sections.push('');
    sections.push('## Relevant Learnings');
    sections.push('');
    for (const learning of context.learnings.slice(0, 5)) {
      sections.push(`- ${learning}`);
    }
  }

  let result = sections.join('\n');

  // Truncate if too long
  if (opts.maxLength && result.length > opts.maxLength) {
    result = result.slice(0, opts.maxLength - 100) + '\n\n*[Context truncated for length]*';
  }

  return result;
}

/**
 * Format a ledger for context injection
 */
export function formatLedger(ledger: Ledger, options: FormatOptions = {}): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const lines: string[] = [];

  lines.push('## Current Session State');
  lines.push('');

  // Current task
  if (ledger.currentTask) {
    lines.push(`**Current Task:** ${ledger.currentTask}`);
    lines.push('');
  }

  // PDERO phase if available
  if (ledger.pderoPhase) {
    lines.push(`**Phase:** ${ledger.pderoPhase.toUpperCase()}`);
    lines.push('');
  }

  // Completed work
  if (ledger.completed.length > 0) {
    if (opts.compact) {
      lines.push(`**Completed:** ${ledger.completed.join(', ')}`);
    } else {
      lines.push('### Completed');
      for (const item of ledger.completed) {
        lines.push(`- ✓ ${item}`);
      }
    }
    lines.push('');
  }

  // In progress
  if (ledger.inProgress.length > 0) {
    if (opts.compact) {
      lines.push(`**In Progress:** ${ledger.inProgress.join(', ')}`);
    } else {
      lines.push('### In Progress');
      for (const item of ledger.inProgress) {
        lines.push(`- ${item}`);
      }
    }
    lines.push('');
  }

  // Blocked items
  if (ledger.blocked.length > 0) {
    if (opts.compact) {
      lines.push(`**Blocked:** ${ledger.blocked.join(', ')}`);
    } else {
      lines.push('### Blocked');
      for (const item of ledger.blocked) {
        lines.push(`- ⚠ ${item}`);
      }
    }
    lines.push('');
  }

  // Uncertain items
  if (ledger.uncertainItems.length > 0) {
    lines.push('### Needs Verification');
    for (const item of ledger.uncertainItems) {
      lines.push(`- ❓ ${item}`);
    }
    lines.push('');
  }

  // Key decisions
  if (ledger.keyDecisions.length > 0 && opts.includeDecisions) {
    if (opts.compact) {
      const decisions = ledger.keyDecisions.map((d) => d.decision).join('; ');
      lines.push(`**Decisions:** ${decisions}`);
    } else {
      lines.push('### Key Decisions');
      for (const decision of ledger.keyDecisions.slice(-5)) {
        lines.push(`- **${decision.decision}**`);
        if (decision.reasoning) {
          lines.push(`  - Reasoning: ${decision.reasoning}`);
        }
      }
    }
    lines.push('');
  }

  // File context
  if (ledger.fileContext.length > 0 && opts.includeFiles) {
    lines.push('### Relevant Files');
    for (const file of ledger.fileContext.slice(-10)) {
      let line = `- \`${file.path}\``;
      if (file.lines) {
        line += `:${file.lines[0]}-${file.lines[1]}`;
      }
      if (file.description) {
        line += ` - ${file.description}`;
      }
      lines.push(line);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format a handoff for context injection
 */
export function formatHandoff(handoff: Handoff, options: FormatOptions = {}): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const lines: string[] = [];

  lines.push('## Previous Session Handoff');
  lines.push('');

  // Task and summary
  if (handoff.taskDescription) {
    lines.push(`**Task:** ${handoff.taskDescription}`);
  }
  if (handoff.summary) {
    lines.push('');
    lines.push(handoff.summary);
  }
  lines.push('');

  // PDERO phase if available
  if (handoff.pderoPhase) {
    lines.push(`**Last Phase:** ${handoff.pderoPhase.toUpperCase()}`);
    if (handoff.confidence !== undefined) {
      lines.push(`**Confidence:** ${Math.round(handoff.confidence * 100)}%`);
    }
    lines.push('');
  }

  // Completed work
  if (handoff.completedWork.length > 0) {
    if (opts.compact) {
      lines.push(`**Completed:** ${handoff.completedWork.join(', ')}`);
    } else {
      lines.push('### Previously Completed');
      for (const item of handoff.completedWork) {
        lines.push(`- ✓ ${item}`);
      }
    }
    lines.push('');
  }

  // Next steps (these are the priority)
  if (handoff.nextSteps.length > 0) {
    lines.push('### Next Steps');
    for (const item of handoff.nextSteps) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  // Key decisions
  if (handoff.decisions.length > 0 && opts.includeDecisions) {
    if (opts.compact) {
      const decisions = handoff.decisions.map((d) => d.decision).join('; ');
      lines.push(`**Prior Decisions:** ${decisions}`);
    } else {
      lines.push('### Prior Decisions');
      for (const decision of handoff.decisions.slice(-5)) {
        lines.push(`- ${decision.decision}`);
        if (decision.reasoning) {
          lines.push(`  - *${decision.reasoning}*`);
        }
      }
    }
    lines.push('');
  }

  // File references
  if (handoff.fileReferences.length > 0 && opts.includeFiles) {
    lines.push('### Key Files');
    for (const file of handoff.fileReferences.slice(-10)) {
      let line = `- \`${file.path}\``;
      if (file.lines) {
        line += `:${file.lines[0]}-${file.lines[1]}`;
      }
      if (file.description) {
        line += ` - ${file.description}`;
      }
      lines.push(line);
    }
    lines.push('');
  }

  // Learnings
  if (handoff.learnings && handoff.learnings.length > 0 && opts.includeLearnings) {
    lines.push('### Learnings');
    for (const learning of handoff.learnings) {
      lines.push(`- ${learning}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format a search result summary
 */
export function formatSearchResults(handoffs: Handoff[], query: string): string {
  const lines: string[] = [];

  lines.push(`## Search Results for "${query}"`);
  lines.push('');

  if (handoffs.length === 0) {
    lines.push('*No matching handoffs found.*');
    return lines.join('\n');
  }

  lines.push(`Found ${handoffs.length} matching handoff(s):`);
  lines.push('');

  for (const handoff of handoffs) {
    const date = handoff.createdAt.toISOString().split('T')[0];
    lines.push(`### ${handoff.taskDescription || 'Untitled'} (${date})`);
    lines.push(`- **Agent:** ${handoff.agentName}`);
    lines.push(`- **ID:** ${handoff.id}`);
    if (handoff.summary) {
      lines.push(`- **Summary:** ${handoff.summary.slice(0, 100)}...`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format a brief status summary (for status line / dashboard)
 */
export function formatBriefStatus(ledger: Ledger | null, handoff: Handoff | null): string {
  if (!ledger && !handoff) {
    return 'No continuity data';
  }

  const parts: string[] = [];

  if (ledger) {
    if (ledger.currentTask) {
      parts.push(`Task: ${ledger.currentTask.slice(0, 40)}`);
    }
    if (ledger.pderoPhase) {
      parts.push(`Phase: ${ledger.pderoPhase}`);
    }
    const progress = `${ledger.completed.length}✓ ${ledger.inProgress.length}→ ${ledger.blocked.length}⚠`;
    parts.push(progress);
  }

  if (handoff && !ledger) {
    parts.push(`Last handoff: ${handoff.taskDescription?.slice(0, 30) || handoff.id}`);
    parts.push(handoff.createdAt.toISOString().split('T')[0]);
  }

  return parts.join(' | ');
}

/**
 * Check if handoff is newer than ledger
 */
function isHandoffNewer(handoff: Handoff, ledger: Ledger): boolean {
  return handoff.createdAt > ledger.updatedAt;
}

/**
 * Format file references for injection
 */
export function formatFileRefs(files: FileRef[]): string {
  return files
    .map((f) => {
      let line = f.path;
      if (f.lines) {
        line += `:${f.lines[0]}-${f.lines[1]}`;
      }
      return line;
    })
    .join(', ');
}

/**
 * Format decisions for injection
 */
export function formatDecisions(decisions: Decision[]): string {
  return decisions.map((d) => d.decision).join('; ');
}
