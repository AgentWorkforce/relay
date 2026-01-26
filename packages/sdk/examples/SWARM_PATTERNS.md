# Swarm Patterns with Agent Relay SDK

Build any multi-agent orchestration pattern using the SDK's flexible primitives.

## Why Agent Relay for Swarms?

Unlike frameworks that impose a specific orchestration model, Agent Relay provides **low-level communication primitives** that let you build any pattern:

| Framework | Approach | Limitation |
|-----------|----------|------------|
| OpenAI Agents | Handoff-based routing | Prescriptive flow control |
| Swarms.ai | Pre-built swarm types | Configuration-heavy |
| Strands | Self-organizing swarms | AWS ecosystem lock-in |
| **Agent Relay** | **Communication primitives** | **You design the orchestration** |

## Core Primitives for Swarms

```typescript
// Direct messaging
client.sendMessage(agent, message);

// Broadcast to all
client.broadcast(message);

// Channels for groups
client.joinChannel('#workers');
client.sendChannelMessage('#workers', message);

// Spawn workers
await client.spawn({ name, cli, task });
await client.release(name);

// Consensus for decisions
client.createProposal({ title, participants, consensusType });
client.vote({ proposalId, value });

// Query state
await client.listAgents();
await client.getMetrics();
```

---

## Pattern 1: Hierarchical Swarm (Lead + Workers)

A lead agent coordinates multiple specialist workers.

```typescript
import { RelayClient } from '@agent-relay/sdk';

// Lead agent orchestrates the work
const lead = new RelayClient({ agentName: 'Lead' });
await lead.connect();

const workers: string[] = [];

// Spawn specialized workers
for (const specialty of ['Frontend', 'Backend', 'Tests']) {
  const result = await lead.spawn({
    name: `${specialty}Worker`,
    cli: 'claude',
    task: `You are a ${specialty} specialist. Wait for tasks from Lead.`,
  });
  if (result.success) workers.push(`${specialty}Worker`);
}

// Distribute work
lead.sendMessage('FrontendWorker', 'Build the login page UI');
lead.sendMessage('BackendWorker', 'Create the /auth API endpoint');
lead.sendMessage('TestsWorker', 'Write integration tests for auth flow');

// Collect results
const results: Map<string, string> = new Map();

lead.onMessage = (from, { body }) => {
  results.set(from, body);

  if (results.size === workers.length) {
    console.log('All workers complete!');
    // Aggregate and continue...
  }
};
```

### When to Use
- Complex tasks that decompose into independent subtasks
- Need specialist agents for different domains
- Want centralized coordination and progress tracking

---

## Pattern 2: Fan-Out / Fan-In (Parallel Execution)

Distribute work in parallel, aggregate results.

```typescript
import { RelayClient } from '@agent-relay/sdk';

async function fanOutFanIn(task: string, workerCount: number) {
  const coordinator = new RelayClient({ agentName: 'Coordinator' });
  await coordinator.connect();

  // Fan-out: spawn workers for parallel execution
  const workerNames: string[] = [];
  const subtasks = splitTask(task, workerCount); // Your logic

  for (let i = 0; i < workerCount; i++) {
    const name = `Worker-${i}`;
    await coordinator.spawn({
      name,
      cli: 'claude',
      task: `Process this subtask and report back: ${subtasks[i]}`,
    });
    workerNames.push(name);
  }

  // Fan-in: collect results
  return new Promise((resolve) => {
    const results: string[] = [];

    coordinator.onMessage = async (from, { body }) => {
      results.push(body);

      if (results.length === workerCount) {
        // Release all workers
        for (const name of workerNames) {
          await coordinator.release(name);
        }

        // Aggregate results
        resolve(aggregateResults(results)); // Your logic
      }
    };
  });
}
```

### When to Use
- Embarrassingly parallel tasks (data processing, batch operations)
- Need to maximize throughput
- Results can be independently computed then merged

---

## Pattern 3: Handoff / Routing Swarm

Agents route tasks to specialists based on content.

```typescript
import { RelayClient } from '@agent-relay/sdk';

// Router agent examines tasks and delegates
const router = new RelayClient({ agentName: 'Router' });
await router.connect();

// Spawn specialist agents
await router.spawn({ name: 'CodeReviewer', cli: 'claude', task: 'Review code for quality and bugs' });
await router.spawn({ name: 'DocWriter', cli: 'claude', task: 'Write technical documentation' });
await router.spawn({ name: 'Debugger', cli: 'claude', task: 'Debug and fix issues' });

// Routing logic
function routeTask(task: string): string {
  if (task.includes('review') || task.includes('PR')) return 'CodeReviewer';
  if (task.includes('document') || task.includes('README')) return 'DocWriter';
  if (task.includes('bug') || task.includes('error')) return 'Debugger';
  return 'CodeReviewer'; // default
}

// Route incoming requests
router.onMessage = (from, { body }) => {
  const specialist = routeTask(body);
  router.sendMessage(specialist, `From ${from}: ${body}`);
};

// Specialists report back through router
// (Each specialist would sendMessage back to Router, who forwards to original requester)
```

### When to Use
- Triage/classification workflows
- Customer support routing
- Skill-based task assignment

---

## Pattern 4: Pipeline / Sequential Chain

Tasks flow through a sequence of agents.

```typescript
import { RelayClient } from '@agent-relay/sdk';

const stages = ['Planner', 'Implementer', 'Reviewer', 'Tester'];

async function createPipeline() {
  const clients: Map<string, RelayClient> = new Map();

  // Create all pipeline stages
  for (const stage of stages) {
    const client = new RelayClient({ agentName: stage });
    await client.connect();
    clients.set(stage, client);
  }

  // Wire up the pipeline: each stage passes to next
  for (let i = 0; i < stages.length - 1; i++) {
    const current = clients.get(stages[i])!;
    const nextStage = stages[i + 1];

    current.onMessage = (from, { body, data }) => {
      // Process and pass to next stage
      const result = processStage(stages[i], body);
      current.sendMessage(nextStage, result, 'message', {
        ...data,
        [`${stages[i]}Output`]: result,
      });
    };
  }

  // Final stage outputs result
  const final = clients.get(stages[stages.length - 1])!;
  final.onMessage = (from, { body, data }) => {
    console.log('Pipeline complete:', body);
    console.log('All stage outputs:', data);
  };

  // Return entry point
  return clients.get(stages[0])!;
}

// Usage
const pipeline = await createPipeline();
pipeline.sendMessage('Planner', 'Build a user authentication system');
```

### When to Use
- Multi-stage processing (plan → implement → review → test)
- Content pipelines (draft → edit → proofread → publish)
- CI/CD-like workflows

---

## Pattern 5: Consensus-Based Decision Making

Multiple agents vote on decisions.

```typescript
import { RelayClient } from '@agent-relay/sdk';

async function makeGroupDecision(question: string, voters: string[]) {
  const facilitator = new RelayClient({ agentName: 'Facilitator' });
  await facilitator.connect();

  // Spawn voting agents
  for (const voter of voters) {
    await facilitator.spawn({
      name: voter,
      cli: 'claude',
      task: `You are ${voter}. Analyze proposals and vote based on your expertise.`,
    });
  }

  // Wait for agents to connect, then create proposal
  await new Promise(r => setTimeout(r, 2000));

  facilitator.createProposal({
    title: question,
    description: 'Please vote on this decision',
    participants: voters,
    consensusType: 'majority', // or 'supermajority', 'unanimous'
    timeoutMs: 60000,
  });

  // Listen for result
  return new Promise((resolve) => {
    facilitator.onMessage = (from, { body, data }) => {
      if (data?._isConsensusMessage && body.includes('RESULT')) {
        resolve(body);
      }
    };
  });
}

// Usage
const decision = await makeGroupDecision(
  'Should we use GraphQL or REST for the new API?',
  ['Architect', 'FrontendLead', 'BackendLead', 'DevOps']
);
```

### When to Use
- Architecture decisions requiring multiple perspectives
- Code review approvals (N approvers required)
- Deployment gates

---

## Pattern 6: Self-Organizing Swarm

Agents discover and coordinate with each other dynamically.

```typescript
import { RelayClient } from '@agent-relay/sdk';

class SwarmAgent {
  private client: RelayClient;
  private peers: Set<string> = new Set();

  constructor(name: string, private specialty: string) {
    this.client = new RelayClient({ agentName: name });
  }

  async join() {
    await this.client.connect();

    // Join the swarm channel
    this.client.joinChannel('#swarm');

    // Announce presence
    this.client.sendChannelMessage('#swarm', JSON.stringify({
      type: 'join',
      agent: this.client.agentName,
      specialty: this.specialty,
    }));

    // Listen for peers and tasks
    this.client.onChannelMessage = (from, channel, body) => {
      const msg = JSON.parse(body);

      if (msg.type === 'join' && from !== this.client.agentName) {
        this.peers.add(from);
        console.log(`Discovered peer: ${from} (${msg.specialty})`);
      }

      if (msg.type === 'task' && this.canHandle(msg.task)) {
        this.claimTask(msg);
      }
    };
  }

  private canHandle(task: string): boolean {
    // Check if task matches specialty
    return task.toLowerCase().includes(this.specialty.toLowerCase());
  }

  private claimTask(msg: any) {
    // Claim the task before others
    this.client.sendChannelMessage('#swarm', JSON.stringify({
      type: 'claim',
      taskId: msg.taskId,
      agent: this.client.agentName,
    }));
  }

  postTask(task: string) {
    this.client.sendChannelMessage('#swarm', JSON.stringify({
      type: 'task',
      taskId: Date.now().toString(),
      task,
    }));
  }
}

// Create self-organizing swarm
const agents = [
  new SwarmAgent('Alice', 'frontend'),
  new SwarmAgent('Bob', 'backend'),
  new SwarmAgent('Charlie', 'testing'),
];

for (const agent of agents) {
  await agent.join();
}

// Post a task - agents self-organize to claim it
agents[0].postTask('Write frontend tests for the login page');
```

### When to Use
- Dynamic team composition
- Load balancing across available agents
- Resilient systems where agents can join/leave

---

## Pattern 7: Supervisor with Shadow Monitoring

A supervisor monitors workers without interfering.

```typescript
import { RelayClient } from '@agent-relay/sdk';

const supervisor = new RelayClient({ agentName: 'Supervisor' });
await supervisor.connect();

// Spawn a worker
await supervisor.spawn({
  name: 'Worker',
  cli: 'claude',
  task: 'Process customer requests',
});

// Bind as shadow to monitor without Worker knowing
supervisor.bindAsShadow('Worker', {
  receiveIncoming: true,  // See what Worker receives
  receiveOutgoing: true,  // See what Worker sends
});

// Log all Worker activity
supervisor.onMessage = (from, { body }, id, meta, originalTo) => {
  console.log(`[MONITOR] ${from} -> ${originalTo}: ${body.slice(0, 100)}...`);

  // Intervene if needed
  if (body.includes('ERROR') || body.includes('failed')) {
    supervisor.unbindAsShadow('Worker');
    supervisor.sendMessage('Worker', 'Supervisor here - need assistance?');
  }
};
```

### When to Use
- Quality assurance monitoring
- Training/mentoring scenarios
- Audit logging requirements

---

## Pattern 8: Map-Reduce Swarm

Classic map-reduce with agent workers.

```typescript
import { RelayClient } from '@agent-relay/sdk';

async function mapReduce<T, R>(
  items: T[],
  mapFn: (item: T) => string, // Convert item to task description
  reduceFn: (results: string[]) => R,
  workerCount = 4
): Promise<R> {
  const coordinator = new RelayClient({ agentName: 'MapReduce' });
  await coordinator.connect();

  // Spawn mapper workers
  const mappers: string[] = [];
  for (let i = 0; i < workerCount; i++) {
    const name = `Mapper-${i}`;
    await coordinator.spawn({ name, cli: 'claude', task: 'Process items as instructed' });
    mappers.push(name);
  }

  // Distribute items across mappers (map phase)
  const chunks = chunkArray(items, workerCount);
  for (let i = 0; i < mappers.length; i++) {
    const tasks = chunks[i].map(mapFn).join('\n---\n');
    coordinator.sendMessage(mappers[i], `Process these items:\n${tasks}`);
  }

  // Collect results (reduce phase)
  return new Promise((resolve) => {
    const results: string[] = [];

    coordinator.onMessage = async (from, { body }) => {
      results.push(body);

      if (results.length === mappers.length) {
        // Cleanup
        for (const m of mappers) await coordinator.release(m);

        // Reduce and return
        resolve(reduceFn(results));
      }
    };
  });
}

// Usage: Summarize multiple documents
const summaries = await mapReduce(
  documents,
  (doc) => `Summarize this document: ${doc.title}\n${doc.content}`,
  (results) => results.join('\n\n---\n\n')
);
```

---

## Combining Patterns

Real swarms often combine patterns:

```typescript
// Hierarchical + Consensus: Lead spawns workers, workers vote on approach
// Pipeline + Fan-out: Sequential stages where each stage fans out
// Router + Shadow: Route tasks while supervisor monitors

// Example: Review Pipeline with Voting
const reviewPipeline = {
  // Stage 1: Fan-out to multiple reviewers
  async review(code: string) {
    const reviewers = ['Security', 'Performance', 'Style'];
    // Fan out to all reviewers in parallel...
  },

  // Stage 2: Consensus on approval
  async approve(reviews: string[]) {
    // Create proposal with all reviewers...
  },

  // Stage 3: If approved, proceed to merge
  async merge() {
    // Final stage...
  }
};
```

---

## Best Practices

1. **Start simple** - Begin with direct messaging, add complexity as needed
2. **Use channels for groups** - More efficient than individual messages
3. **Implement timeouts** - Workers may fail; handle gracefully
4. **Monitor with shadows** - Don't interfere, just observe
5. **Use consensus for critical decisions** - Not everything needs voting
6. **Clean up workers** - Always `release()` when done
7. **Track state externally** - The SDK handles messaging, you handle orchestration state

## SDK Primitives → Swarm Patterns

| Primitive | Enables |
|-----------|---------|
| `sendMessage` | Direct coordination, handoffs |
| `broadcast` | Announcements, discovery |
| `channels` | Group communication, pub/sub |
| `spawn/release` | Dynamic team composition |
| `consensus` | Group decision making |
| `shadow` | Monitoring, QA, auditing |
| `listAgents` | Discovery, health checks |
| `getMetrics` | Load balancing, scaling decisions |

The SDK gives you the building blocks. **You design the swarm.**
