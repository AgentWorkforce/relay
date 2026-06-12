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
      return '\n\nCall mcp__agent-relay__add_agent to spawn a worker agent for a task, and mcp__agent-relay__remove_agent to release workers when they are done.';

    case 'brief':
      return `

## Agent management
- Spawn a worker: mcp__agent-relay__add_agent({ name, cli: "claude", task })
- Release a worker: mcp__agent-relay__remove_agent({ name })
Spawn when a task needs dedicated focus. Release as soon as the worker reports done.`;

    case 'skill':
      return `

## Managing Worker Agents

### Spawn a relay worker
To delegate work, call:
  mcp__agent-relay__add_agent({ name: "WorkerName", cli: "claude", task: "detailed instructions" })

Required fields: name (unique string), cli ("claude"), task (full instructions for the worker).
The relay worker will DM you "ACK: <understanding>" when it starts and "DONE: <result>" when complete.

**Important**: When your task asks you to "assign to a worker", "delegate to an agent", or "spawn a relay worker",
this means calling mcp__agent-relay__add_agent — never your built-in Task capability.

### Release a relay worker
As soon as a relay worker reports done, call:
  mcp__agent-relay__remove_agent({ name: "WorkerName" })

Always release relay workers when done — unreleased agents waste resources.

### When to spawn vs do the work yourself
If the task explicitly asks you to delegate or assign work to a worker, always spawn — do not do it yourself.
Spawn for anything large, parallel, or that needs specialised focus.
Only handle it yourself when the task is trivial AND you were not asked to delegate.`;
  }
}
