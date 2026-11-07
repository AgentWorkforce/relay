/**
 * Director meta-prompt builder for auto-routing.
 *
 * The Director is the lead agent in an auto-composed team. Its meta-prompt
 * tells it *what team it has* and *what each worker's job is* — so it only
 * needs to coordinate, not plan. Pre-composing the team is the key insight
 * that makes auto-routing reliable: the lead follows a script rather than
 * inventing delegation on its own.
 *
 * Worker noun: "relay worker" — chosen from s05 phrasing eval results. This
 * phrasing anchors the model to the agent-relay MCP tool namespace rather
 * than its native subagent mechanism.
 */
import type { TeamSpec } from './composer.js';

/**
 * Build the full system prompt for the Director (lead) agent.
 *
 * Includes:
 *   - Role description with team size and composition
 *   - Per-worker instructions (name, model tier, subtask)
 *   - Coordination protocol (spawn → wait → synthesise → release)
 *   - Onboarding text for the spawn/release tools
 */
export function buildDirectorPrompt(originalTask: string, team: TeamSpec): string {
  const { workers, lead } = team;
  const N = workers.length;

  const workerList = workers
    .map(
      (w, i) =>
        `  ${i + 1}. **${w.role}** (${w.model} relay worker): ${w.task.split('\n')[0].replace('You are a specialised ', '').replace(' worker. Your task:', '')}`
    )
    .join('\n');

  const spawnInstructions = workers
    .map(
      (w) =>
        `mcp__agent-relay__add_agent({ name: "${w.role}", cli: "claude", task: ${JSON.stringify(w.task)} })`
    )
    .join('\n');

  const releaseInstructions = workers
    .map((w) => `mcp__agent-relay__remove_agent({ name: "${w.role}" })`)
    .join('\n');

  // Onboarding injection: lead gets the relay tool names + protocol, regardless
  // of the lead onboarding tier (bare leads still need explicit tool names in
  // the meta-prompt since the meta-prompt IS their system prompt).
  const onboarding = `
## Your relay worker tools
- Spawn a relay worker: mcp__agent-relay__add_agent({ name, cli: "claude", task })
- Release a relay worker: mcp__agent-relay__remove_agent({ name })

Each relay worker DMs you "ACK: <understanding>" when it starts and "DONE: <result>" when done.
Always release workers with remove_agent as soon as they report DONE.`;

  return `You are Director, leading a ${N}-relay-worker team on this task:

${originalTask}

## Your team
${workerList}

## Protocol
1. Spawn each relay worker with the exact calls below:
${spawnInstructions}

2. Wait for all ${N} workers to DM you "DONE: …".

3. Synthesise their findings into a concise final answer.

4. Release each worker immediately after receiving their DONE:
${releaseInstructions}

5. Report your synthesised result to the channel.
${onboarding}`;
}
