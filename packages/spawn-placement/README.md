# @agent-relay/spawn-placement

The spawn placement policy shared by Agent Relay control planes (Agent Relay
Cloud and relay-control): whether a machine has the memory for one more agent,
how launch targets are ranked, and which alternatives a refusal offers. It is
pure: no I/O, no clock, no dependencies. Each control plane keeps its own
parsing, permission rules and wording, and adapts its targets to
`PlacementCandidate`.

Spec: [relay-control `docs/specs/spawn-placement-memory.md`](https://github.com/AgentWorkforce/relay-control/blob/main/docs/specs/spawn-placement-memory.md).

```ts
import {
  parseMemoryPolicy,
  rankCandidates,
  alternativesFor,
  memoryRefusal,
} from '@agent-relay/spawn-placement';

const policy = parseMemoryPolicy({
  mode: env.SPAWN_MEMORY_POLICY,
  floor: env.SPAWN_MEMORY_FLOOR,
  harnessMemory: env.SPAWN_HARNESS_MEMORY,
  agentMemory: env.SPAWN_AGENT_MEMORY,
  densityCapsConfigured: env.SPAWN_DENSITY_CAPS_CONFIGURED,
  freshSeconds: env.SPAWN_MEMORY_FRESH_SECONDS,
});
const ranked = rankCandidates(candidates, { harness: 'claude', policy, now: new Date() });
const refused = memoryRefusal(
  ranked.find((entry) => entry.candidate.id === target)!,
  policy
); // only in enforce
```

Modes: `off` (today's behavior), `observe` (default: assess and report only),
`rank` (memory changes order and alternatives) and `enforce` (also refuses
with `spawn_memory_low`).

## Parity

`@agent-relay/spawn-placement/fixtures` exports `GOLDEN_FIXTURES`: raw
Relaycast node records with the expected order, memory tiers, refusal and
alternatives. Every control plane runs them through its own adapter in CI.
A change to any expected result must be adopted by every control plane on
the same version before the mode moves past `observe`.
