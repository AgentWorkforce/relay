/**
 * Detect whether a Claude agent used its built-in Task tool (native subagent)
 * instead of the mcp__agent-relay__add_agent relay tool.
 *
 * When Claude Code spawns a subagent via its Task tool, the PTY stream contains
 * the tool invocation text — "Task(" — before the subagent result is printed.
 * No `agent_spawned` broker event is emitted in this case.
 *
 * This is a heuristic: it fires if the pattern appears in the stream AND no
 * agent_spawned event was seen. Call it only after confirming spawnConfirmed=false.
 */
import type { BrokerEvent } from '@agent-relay/harness-driver';

import { cleanStreamOutput } from './stream-clean.js';

/**
 * Patterns that appear in the Claude Code PTY stream when the Task tool fires.
 * We look for the literal tool invocation ("Task(") which Claude Code emits as
 * part of its tool-call display, e.g. "● Task(subagent_prompt)".
 */
const NATIVE_TASK_RE = /\bTask\s*\(/;

/**
 * Returns true if the agent's stream output indicates that Claude's native
 * Task tool was invoked (rather than mcp__agent-relay__add_agent).
 *
 * Only call this when spawnConfirmed is false — a confirmed relay spawn with
 * Task( in the stream is not a problem (agent used both, relay one counts).
 */
export function detectNativeSubagent(events: BrokerEvent[], agentName: string): boolean {
  const text = cleanStreamOutput(events, agentName);
  return NATIVE_TASK_RE.test(text);
}
