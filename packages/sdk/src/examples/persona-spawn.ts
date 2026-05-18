/**
 * persona-spawn — spawn an agent from an AgentWorkforce persona.
 *
 * Personas are JSON files describing a pre-configured agent (harness, model,
 * system prompt, MCP servers, permissions). They live in
 *   ./agentworkforce/personas
 * or any directory you pass via `searchDirs` / `extraDirs`.
 *
 * Run:
 *   npm run build && node dist/examples/persona-spawn.js frontend "Build a settings page"
 *
 * Environment:
 *   RELAY_API_KEY — Relaycast workspace key (required)
 */
import { AgentRelay } from "../relay.js";
import { listPersonas } from "../personas.js";

const [, , personaId, ...taskParts] = process.argv;
const task = taskParts.join(" ").trim();

if (!personaId) {
  const found = listPersonas();
  console.error("Usage: persona-spawn <personaId> [task...]\n");
  if (found.length > 0) {
    console.error("Personas discovered in the default cascade:");
    for (const p of found) {
      console.error(`  - ${p.id}  (${p.path})`);
    }
  } else {
    console.error(
      "No personas found. Place JSON files under ./agentworkforce/personas " +
        "or set AGENT_WORKFORCE_HOME.",
    );
  }
  process.exit(1);
}

const relay = new AgentRelay();

relay.onAgentSpawned = (agent) => console.log(`spawned ${agent.name} (${agent.runtime})`);
relay.onAgentExited = (agent) =>
  console.log(`exited ${agent.name} code=${agent.exitCode ?? "none"}`);

const agent = await relay.spawnPersona(personaId, {
  ...(task ? { task } : {}),
  channels: ["general"],
});

console.log(`agent ${agent.name} ready, waiting for exit...`);
await agent.waitForExit();
await relay.shutdown();
