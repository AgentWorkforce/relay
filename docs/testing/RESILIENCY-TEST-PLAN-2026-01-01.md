# Resiliency Features Test Plan

**Date:** 2026-01-01
**Features:** P0-P5 Leader Coordination and Failover
**Branch:** `claude/add-continuous-claude-logic-kba3r`

---

## Prerequisites

1. Build the project: `npm run build`
2. Have at least 2-3 terminal windows ready
3. Ensure `.beads/` directory exists with `issues.jsonl`

---

## P0: Stateless Lead Pattern

### Test 1: Lead reads tasks from Beads

**Setup:**
```bash
# Add a test task to Beads
echo '{"id":"test-001","title":"Test task for P0","status":"open","priority":1,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}' >> .beads/issues.jsonl
```

**Test:**
```typescript
import { createStatelessLead } from './src/resiliency';

const lead = createStatelessLead('.beads', 'TestLead', 'lead-001', {
  sendRelay: async (to, msg) => console.log(`[RELAY] To ${to}: ${msg}`),
  getAvailableWorkers: async () => ['Worker1', 'Worker2'],
});

await lead.start();
// Wait 5 seconds for poll
// Expected: Console shows "Assigned test-001 to Worker1"
```

**Verify:**
```bash
# Check task was assigned in Beads
grep "test-001" .beads/issues.jsonl
# Should show: "status":"in_progress","assignee":"Worker1"
```

**Pass criteria:**
- [ ] Task status changed to `in_progress`
- [ ] Task has `assignee` field set
- [ ] Task has `leaseExpires` timestamp

---

## P1: Task Lease Timeouts

### Test 2: Lease expiration returns task to queue

**Setup:**
```typescript
// Create lead with short lease (10 seconds for testing)
const lead = new StatelessLeadCoordinator({
  beadsDir: '.beads',
  agentName: 'TestLead',
  agentId: 'lead-001',
  pollIntervalMs: 2000,
  heartbeatIntervalMs: 5000,
  leaseDurationMs: 10000, // 10 second lease
  sendRelay: async (to, msg) => console.log(`[RELAY] To ${to}: ${msg}`),
  getAvailableWorkers: async () => ['Worker1'],
});
```

**Test:**
1. Start lead - task gets assigned
2. Wait 15 seconds (lease expires)
3. Add new worker to available list
4. Wait for next poll

**Verify:**
```bash
# Task should be reassigned after lease expires
grep "test-001" .beads/issues.jsonl
```

**Pass criteria:**
- [ ] Task returned to queue after lease expired
- [ ] Task reassigned to new worker on next poll

### Test 3: Lease renewal

**Test:**
```typescript
// Worker renews lease before expiration
await lead.renewLease('test-001', 'Worker1');
```

**Pass criteria:**
- [ ] `leaseExpires` timestamp updated
- [ ] Console shows "Renewed lease for test-001"

---

## P2: Leader Heartbeat File

### Test 4: Heartbeat file created and updated

**Test:**
```typescript
const lead = createStatelessLead('.beads', 'TestLead', 'lead-001', {
  sendRelay: async () => {},
  getAvailableWorkers: async () => [],
});

await lead.start();
// Wait 15 seconds
```

**Verify:**
```bash
cat .beads/leader-heartbeat.json
```

**Expected output:**
```json
{
  "leadName": "TestLead",
  "leadId": "lead-001",
  "timestamp": 1735689600000,
  "activeTaskCount": 0,
  "assignedAgents": []
}
```

**Pass criteria:**
- [ ] File exists at `.beads/leader-heartbeat.json`
- [ ] `timestamp` updates every 10 seconds
- [ ] `activeTaskCount` reflects assigned tasks

---

## P3: Watchdog in AgentSupervisor

### Test 5: Watchdog detects stale leader

**Terminal 1 - Start leader:**
```typescript
import { createStatelessLead } from './src/resiliency';

const lead = createStatelessLead('.beads', 'Leader1', 'lead-001', {
  sendRelay: async () => {},
  getAvailableWorkers: async () => [],
});
await lead.start();
console.log('Leader1 started');
```

**Terminal 2 - Start watchdog:**
```typescript
import { createLeaderWatchdog } from './src/resiliency';

const watchdog = createLeaderWatchdog('.beads', 'Watchdog1', 'watch-001', {
  onBecomeLeader: async () => console.log('I AM NOW LEADER!'),
  getHealthyAgents: async () => [
    { name: 'Watchdog1', id: 'watch-001', spawnedAt: new Date() }
  ],
});

watchdog.on('leaderDetected', (h) => console.log('Leader detected:', h.leadName));
watchdog.on('leaderStale', (d) => console.log('Leader stale!', d));
watchdog.on('becameLeader', () => console.log('Became leader'));

watchdog.start();
```

**Test:**
1. Both running - watchdog should detect Leader1
2. Kill Terminal 1 (Ctrl+C)
3. Wait 35 seconds (stale threshold + check interval)

**Pass criteria:**
- [ ] Watchdog logs "Leader detected: Leader1"
- [ ] After leader killed, watchdog logs "Leader stale!"
- [ ] Watchdog logs "I AM NOW LEADER!"
- [ ] New heartbeat file shows Watchdog1 as leader

---

## P4: Gossip-Based Health Broadcast

### Test 6: Peer discovery via heartbeats

**Terminal 1 - Agent A:**
```typescript
import { createGossipHealth } from './src/resiliency';

const messages: string[] = [];
const gossipA = createGossipHealth('AgentA', 'a-001', async (msg) => {
  messages.push(msg);
  console.log('[A broadcast]', msg);
});

gossipA.on('peerDiscovered', (p) => console.log('Discovered peer:', p.name));
gossipA.start();

// Simulate receiving B's heartbeat
setTimeout(() => {
  const heartbeat = {
    type: 'HEARTBEAT',
    agent: 'AgentB',
    agentId: 'b-001',
    timestamp: Date.now(),
    load: 0.5,
    healthy: true,
    isLeader: false,
    taskCount: 2,
  };
  gossipA.processHeartbeat(heartbeat);
}, 5000);
```

**Pass criteria:**
- [ ] AgentA broadcasts HEARTBEAT messages
- [ ] "Discovered peer: AgentB" logged
- [ ] `gossipA.getPeers()` returns AgentB

### Test 7: Stale peer detection

**Test:**
```typescript
// Process old heartbeat
const staleHeartbeat = {
  type: 'HEARTBEAT',
  agent: 'AgentC',
  agentId: 'c-001',
  timestamp: Date.now() - 60000, // 1 minute old
  load: 0,
  healthy: true,
  isLeader: false,
  taskCount: 0,
};

gossipA.on('peerStale', (d) => console.log('Peer stale:', d.peer.name));
gossipA.processHeartbeat(staleHeartbeat);

// Wait for check interval (5 seconds)
```

**Pass criteria:**
- [ ] "Peer stale: AgentC" logged within 10 seconds
- [ ] `gossipA.getPeer('AgentC').healthy` is `false`

---

## P5: Full Leader Election

### Test 8: Oldest agent wins election

**Setup:** Start 3 agents at different times

**Terminal 1 (start first):**
```typescript
import { getSupervisor } from './src/resiliency';

const supervisor = getSupervisor();
supervisor.start();

supervisor.on('electionStarted', (d) => console.log('Election started:', d));
supervisor.on('electionComplete', (d) => console.log('Election result:', d));
supervisor.on('becameLeader', () => console.log('*** I AM LEADER ***'));

supervisor.enableLeaderCoordination('.beads', async (to, msg) => {
  console.log(`Send to ${to}: ${msg}`);
});

console.log('Supervisor started at', new Date().toISOString());
```

**Verify:**
```bash
cat .beads/leader-heartbeat.json
# Should show first supervisor as leader
```

**Pass criteria:**
- [ ] First started supervisor becomes leader
- [ ] `leader-heartbeat.json` shows correct leader
- [ ] Election uses "oldest" method

### Test 9: Failover on leader death

**Test:**
1. Start Supervisor A (becomes leader)
2. Start Supervisor B (detects A as leader)
3. Kill Supervisor A
4. Wait 35 seconds

**Pass criteria:**
- [ ] Supervisor B logs "Leader stale"
- [ ] Supervisor B logs "*** I AM LEADER ***"
- [ ] Heartbeat file updates to show B as leader

---

## Integration Test: Full Workflow

### Test 10: End-to-end task assignment and failover

**Setup:**
```bash
# Clear test data
rm -f .beads/leader-heartbeat.json
# Add test tasks
cat >> .beads/issues.jsonl << 'EOF'
{"id":"e2e-001","title":"E2E Test Task 1","status":"open","priority":1,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}
{"id":"e2e-002","title":"E2E Test Task 2","status":"open","priority":2,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}
EOF
```

**Workflow:**
1. Start Lead agent
2. Start 2 Worker agents
3. Verify tasks assigned
4. Kill Lead agent
5. Verify new leader elected
6. Verify tasks continue processing

**Pass criteria:**
- [ ] Tasks assigned to workers
- [ ] Leader failover completes in <35 seconds
- [ ] No task duplication
- [ ] Orphaned tasks return to queue

---

## Cleanup

```bash
# Remove test data
grep -v "test-001\|e2e-00" .beads/issues.jsonl > .beads/issues.jsonl.tmp
mv .beads/issues.jsonl.tmp .beads/issues.jsonl
rm -f .beads/leader-heartbeat.json
```

---

## Summary Checklist

| Feature | Test | Status |
|---------|------|--------|
| P0: Stateless Lead | Test 1: Lead reads from Beads | ☐ |
| P1: Lease Timeouts | Test 2: Lease expiration | ☐ |
| P1: Lease Timeouts | Test 3: Lease renewal | ☐ |
| P2: Heartbeat File | Test 4: File created/updated | ☐ |
| P3: Watchdog | Test 5: Stale leader detection | ☐ |
| P4: Gossip Health | Test 6: Peer discovery | ☐ |
| P4: Gossip Health | Test 7: Stale peer detection | ☐ |
| P5: Leader Election | Test 8: Oldest wins | ☐ |
| P5: Leader Election | Test 9: Failover | ☐ |
| Integration | Test 10: Full workflow | ☐ |

---

**Tester:** ____________________
**Date Completed:** ____________________
**Notes:**
