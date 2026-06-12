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
      return '\n\nUse add_agent to delegate work to a new worker agent, and remove_agent to release workers when their task is done.';

    case 'brief':
      return `

## Agent management
- Spawn a worker: mcp__agent-relay__add_agent({ name, cli: "claude", task })
- Release a worker: mcp__agent-relay__remove_agent({ name })
Spawn when a task needs dedicated focus. Release as soon as the worker reports done.`;

    case 'skill':
      return `

## Managing Worker Agents

### Spawning
Call add_agent when you need to delegate work to a dedicated agent:
  mcp__agent-relay__add_agent({ name: "WorkerName", cli: "claude", task: "detailed instructions" })
  agent-relay.add_agent({ name: "WorkerName", cli: "claude", task: "detailed instructions" })

The worker is automatically pre-registered. It will DM you "ACK: <understanding>" on start
and "DONE: <result>" on completion.

### Releasing
Call remove_agent as soon as a worker reports done or is no longer needed:
  mcp__agent-relay__remove_agent({ name: "WorkerName" })
  agent-relay.remove_agent({ name: "WorkerName" })

### Guidance
- Spawn for tasks requiring focused execution or specialised skill.
- Use descriptive, unique worker names so you can release the right agent later.
- Always release workers — unreleased workers remain online and consume resources.
- The worker's cli is the model harness: "claude", "codex", "gemini", or "opencode".`;
  }
}
