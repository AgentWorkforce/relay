/**
 * Onboarding variants for spawn/release reliability evals.
 *
 * Ordered from lightest to heaviest. The eval runner tests each variant and
 * the goal is to find the MINIMUM text that achieves 10/10 reliability, so
 * variants at the top of the list are preferred if they prove sufficient.
 *
 * bare        → zero spawn/release guidance (measures the baseline failure rate)
 * one-liner   → single sentence naming both tools (minimum viable hint)
 * brief       → tool names + parameters + when-to-use (compact but complete)
 * skill       → full reference with examples (maximum clarity, maximum tokens)
 */

export type OnboardingVariant = 'bare' | 'one-liner' | 'brief' | 'skill';

export const ONBOARDING_VARIANTS: OnboardingVariant[] = ['bare', 'one-liner', 'brief', 'skill'];

/**
 * Return the onboarding text suffix for a given variant.
 * Appended to the scenario-specific role description.
 */
export function onboardingText(variant: OnboardingVariant): string {
  switch (variant) {
    case 'bare':
      return '';

    case 'one-liner':
      return '\n\nCall mcp__agent-relay__add_agent to spawn a relay worker for a task, and mcp__agent-relay__remove_agent to release relay workers when they are done.';

    case 'brief':
      return `

## Agent management
- Spawn a relay worker: mcp__agent-relay__add_agent({ name, cli, task })
  cli: "claude" (Claude Code), "codex" (OpenAI Codex), "gemini" (Google Gemini), "opencode".
  To pin a Claude model: add model: "claude-opus-4-8" (Opus) or "claude-sonnet-4-6" (Sonnet).
  name = unique identifier, task = full instructions for the relay worker.
- Release a relay worker: mcp__agent-relay__remove_agent({ name })
When the task says to delegate or assign work, call add_agent. Release with remove_agent when the relay worker reports done.`;

    case 'skill':
      return `

## Managing Worker Agents

### Spawn a relay worker
To delegate work, call:
  mcp__agent-relay__add_agent({ name: "WorkerName", cli: "claude", task: "detailed instructions" })

Required fields: name (unique string), cli (which AI tool to use), task (full instructions for the relay worker).
The relay worker will DM you "ACK: <understanding>" when it starts and "DONE: <result>" when complete.

**CLI options**: cli: "claude" (Claude Code), cli: "codex" (OpenAI Codex), cli: "gemini" (Google Gemini), cli: "opencode".
**Model pinning** (Claude only): add model to specify a tier — "claude-opus-4-8" (Opus, most capable), "claude-sonnet-4-6" (Sonnet, balanced), "claude-haiku-4-5-20251001" (Haiku, fast).
Examples: add_agent({ name: "CodexWorker", cli: "codex", task: "..." }) · add_agent({ name: "OpusWorker", cli: "claude", model: "claude-opus-4-8", task: "..." })

**Important**: When your task asks you to "assign to a relay worker", "delegate to an agent", or "spawn a relay worker",
this means calling mcp__agent-relay__add_agent — never your built-in Task capability.

### Release a relay worker
As soon as a relay worker reports done, call:
  mcp__agent-relay__remove_agent({ name: "WorkerName" })

Always release relay workers when done — unreleased agents waste resources.

### When to spawn vs do the work yourself
If the task explicitly asks you to delegate or assign work to a relay worker, always spawn — do not do it yourself.
Spawn for anything large, parallel, or that needs specialised focus.
Only handle it yourself when the task is trivial AND you were not asked to delegate.`;
  }
}
