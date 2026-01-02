/**
 * Summary Reminder Hook
 *
 * Reminds agents to output [[SUMMARY]] blocks after N tool calls.
 * Helps ensure session state is checkpointed for recovery.
 *
 * Usage in .claude/settings.json:
 * ```json
 * {
 *   "hooks": {
 *     "PostToolCall": [
 *       {
 *         "command": "node /path/to/agent-relay/dist/hooks/summary-reminder/hook.js",
 *         "timeout": 5000
 *       }
 *     ]
 *   }
 * }
 * ```
 *
 * Or via environment:
 * - SUMMARY_REMINDER_INTERVAL=20  (tool calls between reminders)
 * - SUMMARY_REMINDER_ENABLED=true (set to false to disable)
 */

export { summaryReminderHook, default } from './hook.js';
