# Agent Relay: Swarm Capabilities

Agent Relay provides the **primitives** that enable any swarm orchestration pattern. This document maps our capabilities to the key features swarm frameworks need.

## Capability Comparison

| Capability | OpenAI Agents | Swarms.ai | Strands | **Agent Relay** |
|------------|---------------|-----------|---------|-----------------|
| **Handoffs** | Built-in | Config-based | Tool-based | `sendMessage()` + routing |
| **Continuity** | Session memory | State sync | Shared context | **Session resume** + inbox |
| **Consensus** | None | None | None | **Native consensus** |
| **Memory** | SQLite/Redis | Custom | Shared memory | **Inbox** + state payloads |
| **Discovery** | Manual | Registry | Auto | `listAgents()` |
| **Monitoring** | Tracing integrations | Telemetry | Events | `getMetrics()` + shadows |
| **Spawning** | External | External | External | **Native** `spawn()`/`release()` |

---

## 1. Handoffs (Task Transfer)

Transfer work between agents seamlessly.

### The Primitive

```typescript
// Direct handoff
sourceAgent.sendMessage(targetAgent, task, 'action', {
  handoff: true,
  context: { /* state to transfer */ },
  originalRequester: 'User',
});

// Target receives and continues
targetAgent.onMessage = (from, { body, data }) => {
  if (data?.handoff) {
    // Continue the task with transferred context
    processTask(body, data.context);
  }
};
```

### Handoff Patterns

```typescript
// Pattern 1: Explicit routing
function routeToSpecialist(task: string, context: any) {
  const specialist = determineSpecialist(task);
  coordinator.sendMessage(specialist, task, 'action', { context });
}

// Pattern 2: Chain handoff (A → B → C)
agentA.sendMessage('AgentB', result, 'action', {
  chain: ['AgentC', 'AgentD'], // remaining chain
  accumulated: { stepA: result },
});

// Pattern 3: Conditional handoff
if (needsEscalation(result)) {
  worker.sendMessage('Supervisor', task, 'action', {
    escalation: true,
    reason: 'Complexity exceeded threshold',
  });
}
```

---

## 2. Continuity (Session Persistence)

Maintain state across disconnections and handoffs.

### The Primitives

```typescript
// Session resume - automatic on reconnect
const client = new RelayClient({
  agentName: 'Worker',
  reconnect: true, // Resumes session automatically
});

// Inbox - messages stored when offline
const missed = await client.getInbox({ unreadOnly: true });

// State payloads - share state in messages
client.sendMessage(target, summary, 'state', {
  currentStep: 3,
  completedTasks: ['a', 'b'],
  sharedContext: { key: 'value' },
});
```

### Continuity Patterns

```typescript
// Pattern 1: Checkpoint-based continuity
async function processWithCheckpoints(task: string) {
  const checkpoints: any[] = [];

  for (const step of steps) {
    const result = await executeStep(step);
    checkpoints.push({ step, result, timestamp: Date.now() });

    // Save checkpoint as state message
    client.sendMessage('StateStore', JSON.stringify(checkpoints), 'state');
  }
}

// Pattern 2: Handoff with full context
function handoffWithContinuity(target: string, task: string, myState: any) {
  client.sendMessage(target, task, 'action', {
    continuity: {
      previousAgent: client.agentName,
      sessionId: client.currentSessionId,
      state: myState,
      timestamp: Date.now(),
    },
  });
}

// Pattern 3: Recovery from inbox
async function recoverState() {
  const stateMessages = await client.getInbox({ from: 'StateStore' });
  if (stateMessages.length > 0) {
    const latest = stateMessages[stateMessages.length - 1];
    return JSON.parse(latest.body);
  }
  return null; // Fresh start
}
```

---

## 3. Consensus (Group Decisions)

Native distributed decision-making.

### The Primitives

```typescript
// Create a proposal
client.createProposal({
  title: 'Architecture Decision',
  description: 'Should we use microservices or monolith?',
  participants: ['Architect', 'DevLead', 'DevOps'],
  consensusType: 'supermajority', // majority | supermajority | unanimous | weighted | quorum
  threshold: 0.67,
  timeoutMs: 300000,
});

// Vote
client.vote({
  proposalId: 'prop_123',
  value: 'approve', // approve | reject | abstain
  reason: 'Microservices align with our scaling needs',
});
```

### Consensus Patterns

```typescript
// Pattern 1: Code review approval
async function requestReview(prId: string, reviewers: string[]) {
  client.createProposal({
    title: `Approve PR #${prId}`,
    description: await getPRDiff(prId),
    participants: reviewers,
    consensusType: 'quorum',
    quorum: 2, // Need at least 2 approvals
  });
}

// Pattern 2: Deployment gate
async function deploymentGate(environment: string) {
  const stakeholders = getStakeholders(environment);

  client.createProposal({
    title: `Deploy to ${environment}`,
    description: 'All tests passed. Ready to deploy?',
    participants: stakeholders,
    consensusType: environment === 'production' ? 'unanimous' : 'majority',
  });
}

// Pattern 3: Weighted voting by expertise
client.createProposal({
  title: 'API Design Choice',
  participants: ['Junior', 'Senior', 'Architect'],
  consensusType: 'weighted',
  // Weights would be configured in the daemon
});
```

---

## 4. Memory (Shared State)

Multiple approaches to shared memory.

### The Primitives

```typescript
// Inbox as message store
await client.getInbox({ limit: 100 });

// State payloads in messages
client.sendMessage(target, data, 'state', { key: 'value' });

// Channels for shared context
client.joinChannel('#project-state');
client.sendChannelMessage('#project-state', JSON.stringify(state));
```

### Memory Patterns

```typescript
// Pattern 1: Dedicated state agent
class StateAgent {
  private state: Map<string, any> = new Map();

  constructor() {
    this.client = new RelayClient({ agentName: 'StateStore' });
  }

  async start() {
    await this.client.connect();

    this.client.onMessage = (from, { body, data }) => {
      if (data?.action === 'get') {
        const value = this.state.get(data.key);
        this.client.sendMessage(from, JSON.stringify(value), 'state');
      } else if (data?.action === 'set') {
        this.state.set(data.key, JSON.parse(body));
        this.client.sendMessage(from, 'OK', 'state');
      }
    };
  }
}

// Pattern 2: Channel-based shared memory
class SharedMemory {
  private cache: Map<string, any> = new Map();

  async init(client: RelayClient) {
    client.joinChannel('#memory');

    client.onChannelMessage = (from, channel, body) => {
      if (channel === '#memory') {
        const { key, value } = JSON.parse(body);
        this.cache.set(key, value);
      }
    };
  }

  set(client: RelayClient, key: string, value: any) {
    this.cache.set(key, value);
    client.sendChannelMessage('#memory', JSON.stringify({ key, value }));
  }

  get(key: string) {
    return this.cache.get(key);
  }
}

// Pattern 3: Accumulator pattern
async function mapReduceWithMemory(tasks: string[]) {
  const results: any[] = [];

  for (const task of tasks) {
    const result = await client.sendAndWait('Worker', task);
    results.push(result);

    // Share accumulated results
    client.sendChannelMessage('#results', JSON.stringify({
      completed: results.length,
      total: tasks.length,
      latest: result,
    }));
  }

  return results;
}
```

---

## 5. Discovery (Agent Registry)

Find and monitor available agents.

### The Primitives

```typescript
// List all agents
const agents = await client.listAgents();

// Filter options
const active = await client.listAgents({ includeIdle: false });
const projectAgents = await client.listAgents({ project: 'myproject' });

// Agent info returned
interface AgentInfo {
  name: string;
  cli?: string;      // claude, codex, gemini
  idle?: boolean;
  parent?: string;   // spawner
  task?: string;
  connectedAt?: number;
}
```

### Discovery Patterns

```typescript
// Pattern 1: Find specialist
async function findSpecialist(specialty: string): Promise<string | null> {
  const agents = await client.listAgents({ includeIdle: false });

  for (const agent of agents) {
    if (agent.task?.toLowerCase().includes(specialty)) {
      return agent.name;
    }
  }
  return null;
}

// Pattern 2: Load balancing
async function leastBusyWorker(): Promise<string> {
  const metrics = await client.getMetrics();
  const workers = metrics.agents.filter(a => a.name.startsWith('Worker'));

  // Sort by CPU usage
  workers.sort((a, b) => (a.cpuPercent || 0) - (b.cpuPercent || 0));

  return workers[0]?.name || 'Worker-0';
}

// Pattern 3: Health-based routing
async function healthyAgents(): Promise<string[]> {
  const health = await client.getHealth();
  const agents = await client.listAgents();

  // Exclude agents with alerts
  const alertedAgents = new Set(health.alerts.map(a => a.agentName));
  return agents
    .filter(a => !alertedAgents.has(a.name))
    .map(a => a.name);
}
```

---

## 6. Monitoring (Observability)

Built-in monitoring without external integrations.

### The Primitives

```typescript
// System health
const health = await client.getHealth();
// { healthScore, issues, recommendations, crashes, alerts }

// Resource metrics
const metrics = await client.getMetrics();
// { agents: [...], system: { heapUsed, freeMemory } }

// Shadow monitoring (invisible observation)
client.bindAsShadow('TargetAgent', {
  receiveIncoming: true,
  receiveOutgoing: true,
});

// Agent logs
import { getLogs } from '@agent-relay/sdk';
const logs = await getLogs('Worker1', { lines: 100 });
```

### Monitoring Patterns

```typescript
// Pattern 1: Supervisor with real-time monitoring
class Supervisor {
  private alerts: any[] = [];

  async monitor(workers: string[]) {
    // Bind as shadow to all workers
    for (const worker of workers) {
      this.client.bindAsShadow(worker, {
        receiveIncoming: true,
        receiveOutgoing: true,
      });
    }

    // Log all activity
    this.client.onMessage = (from, { body }, id, meta, originalTo) => {
      console.log(`[${new Date().toISOString()}] ${from} → ${originalTo}: ${body.slice(0, 50)}...`);

      // Check for issues
      if (body.includes('ERROR') || body.includes('failed')) {
        this.alerts.push({ worker: from, message: body, time: Date.now() });
      }
    };
  }
}

// Pattern 2: Periodic health checks
async function healthCheckLoop(interval = 30000) {
  while (true) {
    const health = await client.getHealth();

    if (health.healthScore < 70) {
      console.warn('System health degraded:', health.issues);
      // Take action...
    }

    await new Promise(r => setTimeout(r, interval));
  }
}

// Pattern 3: Auto-scaling based on metrics
async function autoScale(minWorkers: number, maxWorkers: number) {
  const metrics = await client.getMetrics();
  const workers = metrics.agents.filter(a => a.name.startsWith('Worker'));
  const avgCpu = workers.reduce((sum, w) => sum + (w.cpuPercent || 0), 0) / workers.length;

  if (avgCpu > 80 && workers.length < maxWorkers) {
    await client.spawn({ name: `Worker-${workers.length}`, cli: 'claude', task: 'General worker' });
  } else if (avgCpu < 20 && workers.length > minWorkers) {
    await client.release(workers[workers.length - 1].name);
  }
}
```

---

## Combining Capabilities

Real swarms combine multiple capabilities:

```typescript
// Full-featured swarm coordinator
class SwarmCoordinator {
  constructor(private client: RelayClient) {}

  // Handoff with continuity
  async delegateTask(target: string, task: string, context: any) {
    return this.client.sendAndWait(target, task, {
      data: { handoff: true, context },
    });
  }

  // Consensus for critical decisions
  async groupDecision(question: string, voters: string[]) {
    this.client.createProposal({
      title: question,
      participants: voters,
      consensusType: 'majority',
    });
  }

  // Memory via state channel
  async shareState(key: string, value: any) {
    this.client.sendChannelMessage('#swarm-state', JSON.stringify({ key, value }));
  }

  // Discovery for dynamic routing
  async findAvailableWorker(): Promise<string | null> {
    const agents = await this.client.listAgents({ includeIdle: true });
    const workers = agents.filter(a => a.name.startsWith('Worker') && a.idle);
    return workers[0]?.name || null;
  }

  // Monitoring via shadows
  async monitorWorker(name: string) {
    this.client.bindAsShadow(name, { receiveIncoming: true, receiveOutgoing: true });
  }
}
```

---

## Summary: Primitives → Capabilities

| SDK Primitive | Swarm Capability |
|---------------|------------------|
| `sendMessage()` | Handoffs, task delegation |
| `sendAndWait()` | Synchronous handoffs, checkpoints |
| `getInbox()` | Continuity, missed message recovery |
| Session resume | Continuity across disconnections |
| `createProposal()` / `vote()` | Consensus decisions |
| `sendChannelMessage()` | Shared memory, pub/sub |
| State payloads (`data`) | Context transfer, memory |
| `listAgents()` | Discovery, registry |
| `getMetrics()` / `getHealth()` | Monitoring, auto-scaling |
| `bindAsShadow()` | Invisible monitoring, QA |
| `spawn()` / `release()` | Dynamic team composition |

**Agent Relay gives you primitives. You build the swarm.**
