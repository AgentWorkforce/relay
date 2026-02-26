---
name: choosing-swarm-patterns
description: Use when coordinating multiple AI agents and need to pick the right orchestration pattern - covers 10 patterns (fan-out, pipeline, hub-spoke, consensus, mesh, handoff, cascade, dag, debate, hierarchical) with decision framework and reflection protocol
---

# Choosing Swarm Patterns

## Overview

10 orchestration patterns for multi-agent workflows. Pick the simplest pattern that solves the problem — add complexity only when the system proves it's insufficient.

## Quick Decision Framework

```
Is the task independent per agent?
  YES → fan-out (parallel workers)

Does each step need the previous step's output?
  YES → Is it strictly linear?
    YES → pipeline
    NO  → dag (parallel where possible)

Does a coordinator need to stay alive and adapt?
  YES → Is there one level of management?
    YES → hub-spoke
    NO  → hierarchical (multi-level)

Is the task about making a decision?
  YES → Do agents need to argue opposing sides?
    YES → debate (adversarial)
    NO  → consensus (cooperative voting)

Does the right specialist emerge during processing?
  YES → handoff (dynamic routing)

Do all agents need to freely collaborate?
  YES → mesh (peer-to-peer)

Is cost the primary concern?
  YES → cascade (cheap model first, escalate if needed)
```

## Pattern Reference

| #   | Pattern          | Topology           | Agents                        | Best For                                        |
| --- | ---------------- | ------------------ | ----------------------------- | ----------------------------------------------- |
| 1   | **fan-out**      | Star (SDK center)  | N parallel                    | Independent subtasks (reviews, research, tests) |
| 2   | **pipeline**     | Linear chain       | Sequential                    | Ordered stages (design → implement → test)      |
| 3   | **hub-spoke**    | Star (live hub)    | 1 lead + N workers            | Dynamic coordination, lead reviews/adjusts      |
| 4   | **consensus**    | Broadcast + vote   | N voters                      | Architecture decisions, approval gates          |
| 5   | **mesh**         | Fully connected    | N peers                       | Brainstorming, collaborative debugging          |
| 6   | **handoff**      | Routing chain      | 1 active at a time            | Triage, specialist routing, support flows       |
| 7   | **cascade**      | Tiered escalation  | Cheapest → most capable       | Cost optimization, production workloads         |
| 8   | **dag**          | Dependency graph   | Parallel + joins              | Complex projects with mixed dependencies        |
| 9   | **debate**       | Adversarial rounds | 2+ debaters + judge           | Rigorous evaluation, architecture trade-offs    |
| 10  | **hierarchical** | Tree (multi-level) | Lead → coordinators → workers | Large teams, domain separation                  |

## Pattern Details

### 1. fan-out — Parallel Workers

```ts
fanOut(
  [
    { task: 'Review auth.ts', name: 'AuthReviewer' },
    { task: 'Review db.ts', name: 'DbReviewer' },
  ],
  { cli: 'claude' }
);
```

- Workers run independently, no inter-agent communication
- SDK collects all DONE messages
- Use when: tasks are embarrassingly parallel

### 2. pipeline — Sequential Stages

```ts
pipeline([
  { task: 'Design the API schema', name: 'Designer' },
  { task: 'Implement the endpoints', name: 'Implementer' },
  { task: 'Write integration tests', name: 'Tester' },
]);
```

- Stage N+1 receives Stage N's DONE summary as context
- Pipeline halts on failure
- Use when: clear linear dependency chain

### 3. hub-spoke — Persistent Coordinator

```ts
hubAndSpoke({
  hub: { task: 'Coordinate building a REST API', name: 'Lead' },
  workers: [
    { task: 'Build database models', name: 'DbWorker' },
    { task: 'Build route handlers', name: 'ApiWorker' },
  ],
});
```

- Hub stays alive, receives ACK/DONE from workers
- Hub can spawn additional workers dynamically
- Use when: lead needs to review, adjust, and make decisions

### 4. consensus — Cooperative Voting

```ts
consensus({
  proposal: 'Should we migrate to Fastify?',
  voters: [
    { task: 'Evaluate performance', name: 'PerfExpert' },
    { task: 'Evaluate DX', name: 'DxExpert' },
  ],
  consensusType: 'majority',
});
```

- Agents independently evaluate, then VOTE: approve/reject
- Supports majority, supermajority, unanimous, weighted, quorum
- Use when: need a decision with diverse perspectives

### 5. mesh — Peer Collaboration

```ts
mesh({
  goal: 'Debug the auth flow returning 500',
  agents: [
    { task: 'Check server logs', name: 'LogAnalyst' },
    { task: 'Review auth code', name: 'CodeReviewer' },
    { task: 'Write repro test', name: 'Tester' },
  ],
});
```

- All agents on same channel, free communication
- Round tracking detects stalls
- Use when: collaborative exploration without hierarchy

### 6. handoff — Dynamic Routing

```ts
handoff({
  entryPoint: { task: 'Triage the request', name: 'Triage' },
  routes: [
    { agent: { task: 'Handle billing', name: 'Billing' }, condition: 'billing, payment' },
    { agent: { task: 'Handle tech issues', name: 'TechSupport' }, condition: 'error, bug' },
  ],
  maxHandoffs: 3,
});
```

- One active agent at a time; transfers control dynamically
- Circuit breaker prevents infinite routing loops
- Use when: right specialist isn't known upfront

### 7. cascade — Cost-Aware Escalation

```ts
cascade({
  tiers: [
    { agent: { task: 'Answer this', cli: 'claude' }, confidenceThreshold: 0.7, costWeight: 1 },
    { agent: { task: 'Answer this', cli: 'claude' }, confidenceThreshold: 0.85, costWeight: 5 },
    { agent: { task: 'Answer this', cli: 'claude' }, costWeight: 20 },
  ],
});
```

- Start cheap, escalate if confidence < threshold
- Agent reports: `DONE [confidence=0.4]: <answer>`
- Use when: most tasks are simple, some need heavy reasoning

### 8. dag — Directed Acyclic Graph

```ts
dag({
  nodes: [
    { id: 'scaffold', task: 'Create project scaffold' },
    { id: 'frontend', task: 'Build React UI', dependsOn: ['scaffold'] },
    { id: 'backend', task: 'Build API', dependsOn: ['scaffold'] },
    { id: 'integrate', task: 'Wire together', dependsOn: ['frontend', 'backend'] },
  ],
  maxConcurrency: 3,
});
```

- Topological sort determines execution order
- Independent nodes run in parallel
- Use when: pipeline is too linear, fan-out is too flat

### 9. debate — Adversarial Refinement

```ts
debate({
  topic: 'Monorepo vs polyrepo for the new platform?',
  debaters: [
    { task: 'Argue for monorepo', position: 'monorepo' },
    { task: 'Argue for polyrepo', position: 'polyrepo' },
  ],
  judge: { task: 'Judge and decide', name: 'ArchJudge' },
  maxRounds: 3,
});
```

- Structured rounds: ARGUMENT → counterargument → VERDICT
- Optional judge; without judge, agents self-converge or split
- Use when: need rigorous adversarial examination

### 10. hierarchical — Multi-Level Delegation

```ts
hierarchical({
  agents: [
    { id: 'lead', task: 'Coordinate full-stack app', role: 'lead' },
    { id: 'fe-coord', task: 'Manage frontend', role: 'coordinator', reportsTo: 'lead' },
    { id: 'be-coord', task: 'Manage backend', role: 'coordinator', reportsTo: 'lead' },
    { id: 'fe-dev', task: 'Build components', role: 'worker', reportsTo: 'fe-coord' },
    { id: 'be-dev', task: 'Build API', role: 'worker', reportsTo: 'be-coord' },
  ],
});
```

- Workers → coordinators → lead (multi-level reporting)
- Coordinators synthesize sub-team output
- Use when: too many workers for one hub to manage

## Reflection Protocol

All patterns support reflection — periodic synthesis that enables course correction. Enabled via `reflectionThreshold` on WorkflowOptions.

```ts
{
  reflectionThreshold: 10, // trigger after 10 agent messages
  onReflect: async (ctx) => {
    // Examine ctx.recentMessages, ctx.agentStatuses
    // Return adjustments or null
  },
}
```

Reflection is event-driven (importance-weighted accumulation), not timer-based. See WORKFLOWS_SPEC.md for full details.

## Common Mistakes

| Mistake                             | Why It Fails                               | Fix                               |
| ----------------------------------- | ------------------------------------------ | --------------------------------- |
| Using mesh for everything           | O(n^2) communication, debugging nightmare  | Use hub-spoke for most tasks      |
| Pipeline for independent work       | Sequential bottleneck                      | Use fan-out or dag                |
| Hub-spoke for simple parallel tasks | Hub is unnecessary overhead                | Use fan-out                       |
| Consensus for non-decisions         | Voting on implementation tasks wastes time | Use hub-spoke, let lead decide    |
| No circuit breaker on handoff       | Infinite routing loops                     | Always set maxHandoffs            |
| Cascade without confidence parsing  | Agents don't report confidence             | Convention injection handles this |
| Hierarchical for 3 agents           | Management overhead exceeds benefit        | Use hub-spoke for small teams     |

## DAG Executor — Proven Pattern

The recommended architecture for DAG workflow execution, validated on a 9-node / 5-wave production run.

### Agent Completion: Detect → Release → Collect

**This is the critical pattern.** Claude Code agents don't auto-exit — the orchestrator must detect completion and release them.

```
Agent writes summary file → Orchestrator polls (5s) → Detects new mtime →
  Reads summary → Calls client.release(agent) → agent_exited fires → Node marked complete
```

**Implementation:**

```ts
// Track initial mtime to distinguish new writes from stale files
let initialMtime = 0;
try {
  initialMtime = statSync(summaryPath).mtimeMs;
} catch {}

// Poll for summary file every 5s
const poll = setInterval(() => {
  const stat = statSync(summaryPath);
  if (stat.mtimeMs > initialMtime) {
    const content = readFileSync(summaryPath, 'utf-8').trim();
    await client.release(agentName); // triggers agent_exited
    finish('completed', content);
  }
}, 5_000);
```

**Convention injection tells agents to:**

1. Send summary via **Relaycast MCP** (`mcp__relaycast__send` to channel) for inter-agent communication
2. Write summary to `.relay/summaries/{nodeId}.md` as the completion signal
3. Include file paths, type names, method signatures — downstream agents depend on this

### Communication: Relaycast MCP

Agents communicate through the Relaycast MCP, not file-based protocols:

- **Channel messages:** `mcp__relaycast__send` with channel name
- **Direct messages:** `mcp__relaycast__dm` with agent name
- Claude Code agents inherit `.mcp.json` config and have full MCP access
- Other CLIs (codex, aider) may not have MCP — use summary files as fallback

### State & Resume

Persist state after every node completion for crash recovery:

```ts
saveState(completed, depsOutput, results, startTime);
// Restart with --resume to skip completed nodes
```

**Pitfall:** When resuming, only load `completed` nodes — never load `failed` entries, or downstream will be permanently blocked.

### Pitfalls Reference

| Category           | Pitfall                                                                              | Fix                                                                              |
| ------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| **Completion**     | Waiting for `agent_exited` without releasing — agents idle until timeout             | Poll for summary file, release agent when detected                               |
| **Completion**     | No resolved guard — poll interval and timeout both fire, double-resolve              | `resolved` boolean flag checked before every resolve                             |
| **Signals**        | PTY prompt echo matches signal keywords (`DONE:`, `ERROR:`) causing false completion | Never put signal keywords in task prompts; use file-based signals                |
| **Summaries**      | Thin summaries ("Created types") useless for downstream agents                       | Convention injection requires file paths, signatures, key exports                |
| **Execution**      | `Promise.race` in batch — one success masks later failures                           | `Promise.allSettled` for each batch                                              |
| **Resilience**     | No `--resume` — orchestrator crash loses all progress                                | Persist completed set + depsOutput after each node                               |
| **Resilience**     | No downstream failure propagation — dependents stuck in limbo                        | Mark all transitive dependents as "blocked" on failure                           |
| **Convention**     | Agents don't read existing code — output doesn't match project patterns              | `readFirst` field per node, included in convention injection                     |
| **Capabilities**   | Assuming all CLIs have MCP tools — codex/aider may not                               | Check CLI capabilities; use summary files as fallback for non-Claude CLIs        |
| **Infrastructure** | Rust broker vs Node.js CLI binary confusion (same name, different behavior)          | Always set explicit `binaryPath`; use unique broker names to avoid 409 conflicts |
| **Infrastructure** | `getLogs()` assumes Node.js daemon log files — Rust broker doesn't write them        | Use broker events or summary files, not log file polling                         |

## YAML Workflow Definition

Any pattern can be defined in YAML for portability:

```yaml
version: '1.0'
name: feature-dev
pattern: hub-spoke
agents:
  - id: lead
    role: lead
    cli: claude
  - id: developer
    role: worker
    cli: codex
    reportsTo: lead
steps:
  - id: plan
    agent: lead
    prompt: 'Create a development plan for: {{task}}'
    expects: 'PLAN_COMPLETE'
  - id: implement
    agent: developer
    dependsOn: [plan]
    prompt: 'Implement: {{steps.plan.output}}'
    expects: 'DONE'
reflection:
  enabled: true
  threshold: 10
trajectory:
  enabled: true
```

Store in `.relay/workflows/` and run with:

```ts
const workflow = await loadWorkflow('.relay/workflows/feature-dev.yaml');
const run = runWorkflow(workflow, 'Add user authentication');
```
