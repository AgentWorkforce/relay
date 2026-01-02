/**
 * Summary Reminder Hook
 *
 * Reminds agents to output [[SUMMARY]] blocks periodically.
 * Triggers after a configurable number of tool calls without a summary.
 *
 * Configuration (via environment):
 * - SUMMARY_REMINDER_INTERVAL: Tool calls between reminders (default: 20)
 * - SUMMARY_REMINDER_ENABLED: Set to 'false' to disable (default: true)
 */

import type { HookContext, HookResult } from '../types.js';

/** Number of tool calls before reminding about summary */
const DEFAULT_INTERVAL = 20;

/** Memory keys */
const LAST_SUMMARY_CALL = 'lastSummaryCall';
const TOOL_CALLS_SINCE_SUMMARY = 'toolCallsSinceSummary';

/**
 * Check if the output contains a [[SUMMARY]] block
 */
function containsSummary(output: string): boolean {
  return /\[\[SUMMARY\]\][\s\S]*?\[\[\/SUMMARY\]\]/.test(output);
}

/**
 * PostToolCall hook that tracks tool calls and reminds about summaries.
 */
export async function summaryReminderHook(context: HookContext): Promise<HookResult> {
  // Check if disabled
  if (context.env.SUMMARY_REMINDER_ENABLED === 'false') {
    return {};
  }

  const interval = parseInt(context.env.SUMMARY_REMINDER_INTERVAL || '', 10) || DEFAULT_INTERVAL;

  // Check if recent output contains a summary
  const recentOutput = context.output
    .filter(o => o.type === 'text')
    .map(o => o.content)
    .join('\n');

  if (containsSummary(recentOutput)) {
    // Reset counter on summary
    context.memory.set(TOOL_CALLS_SINCE_SUMMARY, 0);
    context.memory.set(LAST_SUMMARY_CALL, Date.now());
    return {};
  }

  // Increment tool call counter
  const callsSinceSummary = (context.memory.get<number>(TOOL_CALLS_SINCE_SUMMARY) || 0) + 1;
  context.memory.set(TOOL_CALLS_SINCE_SUMMARY, callsSinceSummary);

  // Check if we should remind
  if (callsSinceSummary >= interval) {
    // Reset counter
    context.memory.set(TOOL_CALLS_SINCE_SUMMARY, 0);

    // Inject reminder
    return {
      inject: `[System] You've completed ${interval} operations. Please output a [[SUMMARY]] block to checkpoint your progress:
\`\`\`
[[SUMMARY]]
{"currentTask": "...", "completedTasks": [...], "context": "...", "files": [...]}
[[/SUMMARY]]
\`\`\`
This enables session recovery if the connection drops.`,
    };
  }

  return {};
}

export default summaryReminderHook;
