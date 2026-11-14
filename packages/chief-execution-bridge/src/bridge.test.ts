import { existsSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ExecutionBridge } from './bridge.js';
import { configSchema } from './config.js';
import { RelayError } from './ports.js';
import { hash } from './protocol.js';
import { BridgeStore } from './store.js';
import {
  agentNameOf,
  CHIEF,
  FakeNode,
  FakeRelay,
  makeAssignment,
  makeConfig,
  makeHarness,
  T0,
  WORKER,
  type Harness,
} from './__tests__/helpers.js';

const FIVE_MIN = 300_000;

/** What the core does to a final answer: `delivery/final_answer.rs`, `capped`. */
function cutLikeTheCore(text: string): string {
  const CAP = 4000;
  const TRUNCATED = '\n\n[truncated]';
  return text.length <= CAP ? text : `${text.slice(0, CAP - TRUNCATED.length)}${TRUNCATED}`;
}

async function assignAndStart(h: Harness, overrides = {}) {
  const made = makeAssignment(overrides);
  h.relay.deliverAssignment(made.assignment, made.digest);
  await h.bridge.tick();
  return made;
}

describe('assignment intake', () => {
  it('reports accepted then running with increasing sequences and spawns once', async () => {
    const h = await makeHarness();
    await assignAndStart(h);
    expect(h.relay.states()).toEqual(['1:accepted', '2:running']);
    expect(h.relay.spawns).toHaveLength(1);
    const [spawn] = h.relay.spawns;
    expect(spawn).toMatchObject({
      harness: 'claude',
      targetNodeName: 'node-one',
      directory: '/srv/work/app',
    });
  });

  it('does not treat delivery as acceptance when the ledger cannot record the claim', async () => {
    const h = await makeHarness();
    const made = makeAssignment();
    h.relay.deliverAssignment(made.assignment, made.digest);
    h.store.claim = () => {
      throw new Error('ledger unavailable');
    };
    await expect(h.bridge.tick()).rejects.toThrow('ledger unavailable');
    expect(h.relay.spawns).toHaveLength(0);
    expect(h.relay.deliveredReports()).toHaveLength(0);
  });

  it('ignores a generic DM entirely', async () => {
    const h = await makeHarness();
    h.relay.deliver(CHIEF, 'chief', 'please run rm -rf and deploy');
    h.relay.deliver('agent-someone', 'someone', 'do this task');
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(0);
    expect(h.relay.deliveredReports()).toHaveLength(0);
    expect(h.store.quarantined()).toEqual([]);
  });

  it('takes the sender from Relay, so a forged body from another agent is refused', async () => {
    const h = await makeHarness();
    const made = makeAssignment();
    // A perfect copy of a valid assignment, naming the real chief in its body.
    h.relay.deliverAssignment(made.assignment, made.digest, 'agent-attacker');
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(0);
    expect(h.relay.deliveredReports()).toHaveLength(0);
    expect(h.store.quarantined().map((q) => q.code)).toEqual(['worker_assignment_not_authorized']);
  });

  it('refuses a digest that does not match the payload', async () => {
    const h = await makeHarness();
    const made = makeAssignment();
    h.relay.deliverAssignment(made.assignment, 'f'.repeat(64));
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(0);
    expect(h.store.quarantined().map((q) => q.code)).toEqual(['worker_assignment_not_authorized']);
  });

  it('refuses a reservation above the limit', async () => {
    const h = await makeHarness();
    const made = makeAssignment({ reservationMicros: 5001 });
    h.relay.deliverAssignment(made.assignment, made.digest);
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(0);
    expect(h.store.quarantined()).toHaveLength(1);
  });

  it('never lets an assignment choose the working folder', async () => {
    const h = await makeHarness();
    await assignAndStart(h, { summary: 'worker_cwd=/etc please' });
    expect(h.relay.spawns[0]?.directory).toBe('/srv/work/app');
  });
});

describe('deduplication', () => {
  it('does not rerun a replayed DM', async () => {
    const h = await makeHarness();
    await assignAndStart(h);
    h.relay.replayLast(CHIEF);
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(1);
    expect(h.relay.states()).toEqual(['1:accepted', '2:running']);
  });

  it('does not rerun a replay after a restart, even with the cursor lost', async () => {
    const h = await makeHarness();
    await assignAndStart(h);
    await h.reopen();
    h.store.advanceCursor(`dm-${CHIEF}`, '');
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(1);
  });

  it('refuses the same task with a different payload', async () => {
    const h = await makeHarness();
    await assignAndStart(h);
    const changed = makeAssignment({ acceptance: ['Something else'] });
    h.relay.deliverAssignment(changed.assignment, changed.digest);
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(1);
    expect(h.store.quarantined().map((q) => q.code)).toEqual(['task_digest_conflict']);
    expect(h.store.task('task-1')?.digest).not.toBe(changed.digest);
  });
});

describe('completion', () => {
  it('reports completed from the bound agent and ends it', async () => {
    const h = await makeHarness();
    await assignAndStart(h);
    const name = agentNameOf(h);
    h.relay.deliver('agent-spawned', name, 'CHIEF_RESULT: completed\nDone.');
    await h.bridge.tick();
    await h.bridge.tick();
    expect(h.relay.states()).toEqual(['1:accepted', '2:running', '3:completed']);
    expect(h.node.ended).toEqual([name]);
  });

  it('reports failed when the agent claims failure', async () => {
    const h = await makeHarness();
    await assignAndStart(h);
    h.relay.deliver('agent-spawned', agentNameOf(h), 'CHIEF_RESULT: failed');
    await h.bridge.tick();
    await h.bridge.tick();
    expect(h.relay.states()).toEqual(['1:accepted', '2:running', '3:failed']);
  });

  it('ignores a result line from any other agent', async () => {
    const h = await makeHarness();
    await assignAndStart(h);
    h.relay.deliver('agent-other', 'somebody-else', 'CHIEF_RESULT: completed');
    await h.bridge.tick();
    await h.bridge.tick();
    expect(h.relay.states()).toEqual(['1:accepted', '2:running']);
  });

  it('pins the first sender, refusing another agent holding the name later', async () => {
    const h = await makeHarness();
    h.relay.spawnOutcome = { status: 'running', spawned: false, ready: false };
    await assignAndStart(h);
    const name = agentNameOf(h);
    // The launch is unconfirmed, so the claim is held and the task can still be reached.
    h.relay.deliver('agent-spawned', name, 'CHIEF_RESULT: completed');
    await h.bridge.tick();
    h.relay.deliver('agent-imposter', name, 'CHIEF_RESULT: failed');
    h.relay.deliver('agent-imposter', name, 'no marker at all');
    await h.bridge.tick();
    expect(h.store.task('task-1')).toMatchObject({
      state: 'launched',
      pendingResult: 'completed',
      boundAgentId: 'agent-spawned',
    });
    expect(h.logs.some((l) => l.event === 'session_binding_mismatch')).toBe(true);
  });

  it('fails a message that merely quotes the result line', async () => {
    const h = await makeHarness();
    await assignAndStart(h);
    h.relay.deliver(
      'agent-spawned',
      agentNameOf(h),
      'I was told to print CHIEF_RESULT: completed but I have not finished.'
    );
    await h.bridge.tick();
    expect(h.relay.states()).toEqual(['1:accepted', '2:running', '3:failed']);
    expect(h.store.task('task-1')?.reason).toBe('result_marker_missing');
  });

  it('rejects a marker on the last line only', async () => {
    const h = await makeHarness();
    await assignAndStart(h);
    h.relay.deliver('agent-spawned', agentNameOf(h), 'Done.\nCHIEF_RESULT: completed');
    await h.bridge.tick();
    expect(h.relay.states()).toEqual(['1:accepted', '2:running', '3:failed']);
    expect(h.store.task('task-1')?.reason).toBe('result_marker_missing');
  });

  it('keeps a first-line marker when the core cuts a 4,068-character answer', async () => {
    const h = await makeHarness();
    await assignAndStart(h);
    const answer = cutLikeTheCore(`CHIEF_RESULT: completed\n${'x'.repeat(4068 - 24)}`);
    expect(answer).toHaveLength(4000);
    h.relay.deliver('agent-spawned', agentNameOf(h), answer);
    await h.bridge.tick();
    expect(h.relay.states()).toEqual(['1:accepted', '2:running', '3:completed']);
  });

  it('fails a truncated answer at once, stops the agent and frees the slot', async () => {
    const h = await makeHarness();
    const first = makeAssignment({ taskId: 'task-a' });
    const second = makeAssignment({ taskId: 'task-b' });
    h.relay.deliverAssignment(first.assignment, first.digest);
    h.relay.deliverAssignment(second.assignment, second.digest);
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(1);
    const name = agentNameOf(h, 'task-a');
    const answer = cutLikeTheCore(`${'x'.repeat(4044)}\nCHIEF_RESULT: completed`);
    expect(answer).not.toContain('CHIEF_RESULT');
    h.relay.deliver('agent-spawned', name, answer);
    await h.bridge.tick();
    expect(h.store.task('task-a')).toMatchObject({ state: 'failed', reason: 'result_marker_missing' });
    expect(h.relay.states('task-a')).toEqual(['1:accepted', '2:running', '3:failed']);
    expect(h.node.ended).toEqual([name]);
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(2);
  });

  it('does not let a later unmarked message overrule a held claim', async () => {
    const h = await makeHarness();
    h.relay.spawnOutcome = { status: 'running', spawned: false, ready: false };
    await assignAndStart(h);
    const name = agentNameOf(h);
    h.relay.deliver('agent-spawned', name, 'CHIEF_RESULT: completed');
    h.relay.deliver('agent-spawned', name, 'one more thing');
    await h.bridge.tick();
    expect(h.store.task('task-1')).toMatchObject({ state: 'launched', pendingResult: 'completed' });
  });

  it('holds an early result until the launch is confirmed', async () => {
    const h = await makeHarness();
    h.relay.spawnOutcome = { status: 'running', spawned: false, ready: false };
    await assignAndStart(h);
    const name = agentNameOf(h);
    h.relay.deliver('agent-spawned', name, 'CHIEF_RESULT: completed');
    await h.bridge.tick();
    expect(h.relay.states()).toEqual(['1:accepted']);
    const invocation = h.store.task('task-1')?.invocationId as string;
    h.relay.invocations.set(invocation, {
      id: invocation,
      status: 'completed',
      nodeId: 'node-1',
      name,
      spawned: true,
      ready: true,
      taskUnconfirmed: false,
    });
    await h.bridge.tick();
    expect(h.relay.states()).toEqual(['1:accepted', '2:running', '3:completed']);
  });
});

describe('failures still report failed', () => {
  it('reports failed when the spawn is refused outright', async () => {
    const h = await makeHarness();
    h.relay.invokeFailure = new RelayError('relay_http_403', false);
    await assignAndStart(h);
    await h.bridge.tick();
    expect(h.relay.states()).toEqual(['1:accepted', '2:failed']);
    expect(h.store.task('task-1')?.reason).toBe('spawn_refused');
  });

  it('reports failed when the native launch fails', async () => {
    const h = await makeHarness();
    h.relay.spawnOutcome = { status: 'failed', spawned: false, ready: false };
    await assignAndStart(h);
    await h.bridge.tick();
    expect(h.relay.states()).toEqual(['1:accepted', '2:failed']);
  });

  it('reports failed and ends the agent when it runs past its limit', async () => {
    const h = await makeHarness();
    await assignAndStart(h);
    h.clock.now += 1_800_001;
    await h.bridge.tick();
    await h.bridge.tick();
    expect(h.relay.states()).toEqual(['1:accepted', '2:running', '3:failed']);
    expect(h.store.task('task-1')?.reason).toBe('runtime_exceeded');
    expect(h.node.ended).toEqual([agentNameOf(h)]);
  });

  it('reports failed promptly on an answer with no result line', async () => {
    const h = await makeHarness();
    await assignAndStart(h);
    h.relay.deliver('agent-spawned', agentNameOf(h), 'here is a long answer with no result line');
    await h.bridge.tick();
    expect(h.relay.states()).toEqual(['1:accepted', '2:running', '3:failed']);
    expect(h.store.task('task-1')?.reason).toBe('result_marker_missing');
  });

  it('reports failed when the agent never answers at all', async () => {
    const h = await makeHarness();
    await assignAndStart(h);
    h.clock.now += 1_800_001;
    await h.bridge.tick();
    await h.bridge.tick();
    expect(h.relay.states().at(-1)).toBe('3:failed');
    expect(h.store.task('task-1')?.reason).toBe('runtime_exceeded');
  });

  it('fails on a session on the wrong node', async () => {
    const h = await makeHarness();
    h.relay.spawnOutcome = { nodeId: 'node-other' };
    await assignAndStart(h);
    await h.bridge.tick();
    expect(h.store.task('task-1')).toMatchObject({ state: 'failed', reason: 'session_binding_mismatch' });
  });

  it('fails on a session with the wrong name', async () => {
    const h = await makeHarness();
    h.relay.spawnOutcome = { name: 'chief-someone-else' };
    await assignAndStart(h);
    await h.bridge.tick();
    expect(h.store.task('task-1')).toMatchObject({ state: 'failed', reason: 'session_binding_mismatch' });
  });

  it('keeps retrying the agent stop until the node can do it', async () => {
    const h = await makeHarness();
    await assignAndStart(h);
    h.node.endThrows = true;
    h.relay.deliver('agent-spawned', agentNameOf(h), 'CHIEF_RESULT: failed');
    await h.bridge.tick();
    await h.bridge.tick();
    expect(h.store.stopPending()).toHaveLength(1);
    h.node.endThrows = false;
    await h.bridge.tick();
    expect(h.store.stopPending()).toHaveLength(0);
  });

  it('does not take not-found as proof of a stop while a launch may still land', async () => {
    const h = await makeHarness({
      limits: {
        maxConcurrent: 2,
        maxReservationMicros: 5000,
        budgetMicros: 100_000,
        maxRuntimeMs: 60_000,
        maxQueuedMs: 900_000,
      },
    });
    h.relay.spawnOutcome = { status: 'running', spawned: false, ready: false };
    await assignAndStart(h);
    h.node.endOutcome = 'not_found';
    h.clock.now += 60_001;
    await h.bridge.tick();
    await h.bridge.tick();
    expect(h.store.task('task-1')?.state).toBe('failed');
    expect(h.store.stopPending()).toHaveLength(1);
  });
});

describe('uncertain invocations', () => {
  it('repeats with the same key after a lost response and launches once', async () => {
    const h = await makeHarness();
    h.relay.loseNextInvokeResponse = true;
    await assignAndStart(h);
    expect(h.store.task('task-1')?.state).toBe('invoking');
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(1);
    expect(h.relay.states()).toEqual(['1:accepted', '2:running']);
  });

  it('reconciles a crash mid-invoke through the same key', async () => {
    const h = await makeHarness();
    h.relay.loseNextInvokeResponse = true;
    await assignAndStart(h);
    await h.reopen();
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(1);
    expect(h.store.task('task-1')?.state).toBe('running');
  });

  it('never repeats an invoke beyond the replay window', async () => {
    const h = await makeHarness({
      limits: {
        maxConcurrent: 2,
        maxReservationMicros: 5000,
        budgetMicros: 100_000,
        maxRuntimeMs: 7_200_000,
        maxQueuedMs: 900_000,
      },
    });
    h.relay.loseNextInvokeResponse = true;
    await assignAndStart(h);
    const invocationsBefore = h.relay.invocations.size;
    h.relay.invocations.clear();
    h.clock.now += 3_600_001;
    await h.bridge.tick();
    expect(h.relay.invocations.size).toBe(0);
    expect(invocationsBefore).toBe(1);
    expect(h.store.task('task-1')).toMatchObject({ state: 'failed', reason: 'execution_outcome_unknown' });
  });
});

describe('report delivery', () => {
  it('retries an undelivered report with the same idempotency key', async () => {
    const h = await makeHarness();
    h.relay.failNextReports = 1;
    await assignAndStart(h);
    expect(h.relay.deliveredReports()).toHaveLength(0);
    h.clock.now += FIVE_MIN;
    await h.bridge.tick();
    expect(h.relay.states()).toEqual(['1:accepted', '2:running']);
    const keys = h.relay.reportAttempts.map((a) => a.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
  });

  it('holds later reports until the earlier one is delivered', async () => {
    const h = await makeHarness();
    h.relay.failNextReports = 3;
    await assignAndStart(h);
    for (let i = 0; i < 3; i += 1) {
      h.clock.now += FIVE_MIN;
      await h.bridge.tick();
    }
    const sequences = h.relay.reportAttempts.map(
      (a) => (a.data.chief_report as { sequence: number }).sequence
    );
    expect(sequences.slice(0, 3)).toEqual([1, 1, 1]);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });

  it('does not duplicate a report whose response was lost', async () => {
    const h = await makeHarness();
    h.relay.loseNextReportResponse = true;
    await assignAndStart(h);
    h.clock.now += FIVE_MIN;
    await h.bridge.tick();
    const accepted = h.relay.deliveredReports().filter((r) => r.state === 'accepted');
    expect(accepted).toHaveLength(1);
  });

  it('survives a restart with a report still owed', async () => {
    const h = await makeHarness();
    h.relay.failNextReports = 1;
    await assignAndStart(h);
    await h.reopen();
    h.clock.now += FIVE_MIN;
    await h.bridge.tick();
    expect(h.relay.states()).toEqual(['1:accepted', '2:running']);
  });

  it('still delivers failed when Relay was down at the moment of failure', async () => {
    const h = await makeHarness();
    h.relay.invokeFailure = new RelayError('relay_http_403', false);
    h.relay.failNextReports = 2;
    await assignAndStart(h);
    for (let i = 0; i < 4; i += 1) {
      h.clock.now += FIVE_MIN;
      await h.bridge.tick();
    }
    expect(h.relay.states()).toEqual(['1:accepted', '2:failed']);
  });
});

describe('limits', () => {
  it('runs no more than the concurrency limit', async () => {
    const h = await makeHarness({
      limits: {
        maxConcurrent: 1,
        maxReservationMicros: 5000,
        budgetMicros: 100_000,
        maxRuntimeMs: 1_800_000,
        maxQueuedMs: 900_000,
      },
    });
    const first = makeAssignment({ taskId: 'task-a' });
    const second = makeAssignment({ taskId: 'task-b', repository: 'acme/other' });
    h.relay.deliverAssignment(first.assignment, first.digest);
    h.relay.deliverAssignment(second.assignment, second.digest);
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(1);
    expect(h.store.task('task-b')?.state).toBe('queued');
  });

  it('serialises tasks in one repository', async () => {
    const h = await makeHarness();
    const first = makeAssignment({ taskId: 'task-a' });
    const second = makeAssignment({ taskId: 'task-b' });
    h.relay.deliverAssignment(first.assignment, first.digest);
    h.relay.deliverAssignment(second.assignment, second.digest);
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(1);
    h.relay.deliver('agent-spawned', agentNameOf(h, 'task-a'), 'CHIEF_RESULT: completed');
    await h.bridge.tick();
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(2);
  });

  it('fails a task that waits too long without starting it', async () => {
    const h = await makeHarness();
    h.node.refusal = 'node_at_capacity';
    await assignAndStart(h);
    h.clock.now += 900_001;
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(0);
    expect(h.relay.states()).toEqual(['1:accepted', '2:failed']);
    expect(h.store.task('task-1')?.reason).toBe('queue_timeout');
    expect(h.store.stopPending()).toHaveLength(0);
  });

  it('reports failed without spawning once the reservation budget is used', async () => {
    const h = await makeHarness({
      limits: {
        maxConcurrent: 2,
        maxReservationMicros: 5000,
        budgetMicros: 1500,
        maxRuntimeMs: 1_800_000,
        maxQueuedMs: 900_000,
      },
    });
    const first = makeAssignment({ taskId: 'task-a' });
    const second = makeAssignment({ taskId: 'task-b', repository: 'acme/other' });
    h.relay.deliverAssignment(first.assignment, first.digest);
    h.relay.deliverAssignment(second.assignment, second.digest);
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(1);
    expect(h.relay.states('task-b')).toEqual(['1:failed']);
    expect(h.store.task('task-b')?.reason).toBe('budget_exceeded');
  });

  it('starts nothing while the node preflight refuses', async () => {
    const h = await makeHarness();
    h.node.refusal = 'full_access_enabled';
    await assignAndStart(h);
    expect(h.relay.spawns).toHaveLength(0);
    h.node.refusal = undefined;
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(1);
  });
});

describe('startup refusals', () => {
  const build = (relay: FakeRelay, node: FakeNode, path: string) =>
    new ExecutionBridge({ config: makeConfig(), store: new BridgeStore(path), relay, node, now: () => T0 });

  it('refuses a token for a different agent', async () => {
    const relay = new FakeRelay();
    relay.identityValue = { agentId: 'someone-else', workspaceId: 'ws-1' };
    await expect(build(relay, new FakeNode(), ':memory:').start()).rejects.toThrow(
      'bridge_refused:identity_mismatch'
    );
  });

  it('refuses a different workspace', async () => {
    const relay = new FakeRelay();
    relay.identityValue = { agentId: WORKER, workspaceId: 'ws-2' };
    await expect(build(relay, new FakeNode(), ':memory:').start()).rejects.toThrow(
      'bridge_refused:identity_mismatch'
    );
  });

  it('refuses a node that fails preflight', async () => {
    const node = new FakeNode();
    node.refusal = 'full_access_enabled';
    await expect(build(new FakeRelay(), node, ':memory:').start()).rejects.toThrow(
      'bridge_refused:full_access_enabled'
    );
  });

  it('refuses a ledger pinned to another worker', async () => {
    const h = await makeHarness();
    h.store.close();
    const relay = new FakeRelay();
    relay.identityValue = { agentId: 'agent-other', workspaceId: 'ws-1' };
    const other = new ExecutionBridge({
      config: makeConfig({ worker: { agentId: 'agent-other', address: 'worker@node' } }),
      store: new BridgeStore(h.path),
      relay,
      node: new FakeNode(),
    });
    await expect(other.start()).rejects.toThrow('bridge_binding_mismatch');
  });

  it('requires the isolation attestation in configuration', () => {
    const base = makeConfig();
    for (const isolation of [undefined, {}, { dedicatedNode: true, scrubbedEnvironment: false }]) {
      expect(configSchema.safeParse({ ...base, isolation }).success).toBe(false);
    }
  });

  it('refuses an insecure Relay origin', () => {
    expect(configSchema.safeParse({ ...makeConfig(), relayOrigin: 'http://relay.example' }).success).toBe(
      false
    );
  });

  it('restricts the ledger file to its owner', async () => {
    const h = await makeHarness();
    expect(statSync(h.path).mode & 0o777).toBe(0o600);
  });
});

describe('separate Relay and Control workspaces', () => {
  const CONTROL = '8969308f-eda4-4d3e-a09a-4128eee7eea2';
  const RELAY = '245411583121604608';
  const ids = { workspaceId: CONTROL, relayWorkspaceId: RELAY };

  it("runs an assignment carrying Control's workspace under a token from Relay's", async () => {
    const h = await makeHarness(ids);
    await assignAndStart(h, { workspaceId: CONTROL });
    expect(h.store.quarantined()).toEqual([]);
    expect(h.relay.spawns).toHaveLength(1);
    expect(h.relay.states()).toEqual(['1:accepted', '2:running']);
  });

  it('refuses an assignment for another Control workspace', async () => {
    const h = await makeHarness(ids);
    await assignAndStart(h, { workspaceId: 'another-control-workspace' });
    expect(h.relay.spawns).toHaveLength(0);
    expect(h.store.quarantined()).toMatchObject([{ code: 'worker_assignment_not_authorized' }]);
  });

  it("refuses an assignment that carries Relay's workspace instead", async () => {
    const h = await makeHarness(ids);
    await assignAndStart(h, { workspaceId: RELAY });
    expect(h.relay.spawns).toHaveLength(0);
    expect(h.store.quarantined()).toMatchObject([{ code: 'worker_assignment_not_authorized' }]);
  });

  it.each([
    ['another Relay workspace', '245411583121604609'],
    ["Control's workspace", CONTROL],
  ])('refuses a token from %s', async (_label, workspaceId) => {
    const relay = new FakeRelay();
    relay.identityValue = { agentId: WORKER, workspaceId };
    const bridge = new ExecutionBridge({
      config: makeConfig(ids),
      store: new BridgeStore(':memory:'),
      relay,
      node: new FakeNode(),
    });
    await expect(bridge.start()).rejects.toThrow('bridge_refused:identity_mismatch');
  });

  it("defaults Relay's workspace to workspaceId", async () => {
    const h = await makeHarness();
    await assignAndStart(h);
    expect(h.relay.spawns).toHaveLength(1);
  });

  it("pins Relay's workspace in the ledger binding", async () => {
    const h = await makeHarness(ids);
    h.store.close();
    const relay = new FakeRelay();
    relay.identityValue = { agentId: WORKER, workspaceId: '245411583121604609' };
    const moved = new ExecutionBridge({
      config: makeConfig({ ...ids, relayWorkspaceId: '245411583121604609' }),
      store: new BridgeStore(h.path),
      relay,
      node: new FakeNode(),
    });
    await expect(moved.start()).rejects.toThrow('bridge_binding_mismatch');
  });

  it('keeps an existing binding when the Relay workspace equals workspaceId', async () => {
    const h = await makeHarness();
    h.store.close();
    const same = new ExecutionBridge({
      config: makeConfig({ relayWorkspaceId: 'ws-1' }),
      store: new BridgeStore(h.path),
      relay: new FakeRelay(),
      node: new FakeNode(),
    });
    await expect(same.start()).resolves.toBeUndefined();
  });
});

describe('long-running conversation history', () => {
  it('still hears the chief after its conversation ages out of the capped listing', async () => {
    const h = await makeHarness();
    await assignAndStart(h);
    h.relay.conversationListLimit = 1;
    h.relay.extraConversations = [{ id: 'dm-newer', type: '1:1', participants: [WORKER, 'agent-newer'] }];
    const next = makeAssignment({ taskId: 'task-2', repository: 'acme/other' });
    h.relay.deliverAssignment(next.assignment, next.digest);
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(2);
  });
});

describe('review regressions', () => {
  const limits = {
    maxConcurrent: 2,
    maxReservationMicros: 5000,
    budgetMicros: 100_000,
    maxRuntimeMs: 1_800_000,
    maxQueuedMs: 900_000,
  };

  it('reports failed for a result sent after the runtime limit', async () => {
    const h = await makeHarness();
    await assignAndStart(h);
    h.clock.now += 1_800_001;
    h.relay.deliver('agent-spawned', agentNameOf(h), 'CHIEF_RESULT: completed');
    await h.bridge.tick();
    expect(h.relay.states()).toEqual(['1:accepted', '2:running', '3:failed']);
    expect(h.store.task('task-1')?.reason).toBe('runtime_exceeded');
  });

  it('honours a result sent on time but read after the limit', async () => {
    const h = await makeHarness();
    await assignAndStart(h);
    const sentAt = h.clock.now + 1_799_000;
    h.clock.now += 1_800_010;
    h.relay.deliver('agent-spawned', agentNameOf(h), 'CHIEF_RESULT: completed', undefined, sentAt);
    await h.bridge.tick();
    expect(h.relay.states()).toEqual(['1:accepted', '2:running', '3:completed']);
  });

  it('does not repeat an invoke when its preflight crosses the replay window', async () => {
    const h = await makeHarness({ limits: { ...limits, maxRuntimeMs: 7_200_000 } });
    h.relay.loseNextInvokeResponse = true;
    await assignAndStart(h);
    const calls = h.relay.invokeCalls;
    h.clock.now += 3_599_999;
    h.node.onPreflight = () => {
      h.clock.now += 2;
      return undefined;
    };
    await h.bridge.tick();
    expect(h.relay.invokeCalls).toBe(calls);
    expect(h.store.task('task-1')).toMatchObject({ state: 'failed', reason: 'execution_outcome_unknown' });
  });

  it('keeps retrying a refused stop and holds the slot', async () => {
    const h = await makeHarness();
    await assignAndStart(h);
    h.node.endOutcome = 'refused';
    h.relay.deliver('agent-spawned', agentNameOf(h), 'CHIEF_RESULT: failed');
    await h.bridge.tick();
    await h.bridge.tick();
    expect(h.store.stopPending()).toHaveLength(1);
    expect(h.node.endAttempts.length).toBeGreaterThan(1);
    expect(h.node.ended).toEqual([]);
  });

  it('holds the repository until the finished agent has stopped', async () => {
    const h = await makeHarness();
    const first = makeAssignment({ taskId: 'task-a' });
    const second = makeAssignment({ taskId: 'task-b' });
    h.relay.deliverAssignment(first.assignment, first.digest);
    h.relay.deliverAssignment(second.assignment, second.digest);
    await h.bridge.tick();
    h.node.endThrows = true;
    h.relay.deliver('agent-spawned', agentNameOf(h, 'task-a'), 'CHIEF_RESULT: completed');
    await h.bridge.tick();
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(1);
    h.node.endThrows = false;
    await h.bridge.tick();
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(2);
  });

  it('holds the concurrency slot until the finished agent has stopped', async () => {
    const h = await makeHarness({ limits: { ...limits, maxConcurrent: 1 } });
    await assignAndStart(h);
    h.node.endThrows = true;
    h.relay.deliver('agent-spawned', agentNameOf(h), 'CHIEF_RESULT: completed');
    await h.bridge.tick();
    const next = makeAssignment({ taskId: 'task-2', repository: 'acme/other' });
    h.relay.deliverAssignment(next.assignment, next.digest);
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(1);
  });

  it('prechecks the node for every spawn in one pass', async () => {
    const h = await makeHarness();
    const first = makeAssignment({ taskId: 'task-a' });
    const second = makeAssignment({ taskId: 'task-b', repository: 'acme/other' });
    h.relay.deliverAssignment(first.assignment, first.digest);
    h.relay.deliverAssignment(second.assignment, second.digest);
    let calls = 0;
    h.node.onPreflight = () => (++calls === 2 ? 'node_at_capacity' : undefined);
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(1);
    expect(h.store.task('task-b')?.state).toBe('queued');
  });

  it('rechecks access before repeating an uncertain invoke', async () => {
    const h = await makeHarness();
    h.relay.loseNextInvokeResponse = true;
    await assignAndStart(h);
    const before = h.relay.invokeCalls;
    h.node.refusal = 'full_access_enabled';
    await h.bridge.tick();
    expect(h.relay.invokeCalls).toBe(before);
    expect(h.store.task('task-1')?.state).toBe('invoking');
  });

  it('repeats an uncertain invoke when the only refusal is capacity', async () => {
    const h = await makeHarness();
    h.relay.loseNextInvokeResponse = true;
    await assignAndStart(h);
    h.node.refusal = 'node_at_capacity';
    await h.bridge.tick();
    expect(h.store.task('task-1')?.state).toBe('running');
    expect(h.relay.spawns).toHaveLength(1);
  });

  it('times a task out if an earlier spawn in the pass used up its queue time', async () => {
    const h = await makeHarness();
    const first = makeAssignment({ taskId: 'task-a' });
    const second = makeAssignment({ taskId: 'task-b', repository: 'acme/other' });
    h.relay.deliverAssignment(first.assignment, first.digest);
    h.relay.deliverAssignment(second.assignment, second.digest);
    let calls = 0;
    h.node.onPreflight = () => {
      if (++calls === 2) h.clock.now += 900_001;
      return undefined;
    };
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(1);
    expect(h.store.task('task-b')?.reason).toBe('queue_timeout');
  });

  it('measures runtime from the invoke, not the start of the pass', async () => {
    const h = await makeHarness();
    h.node.onPreflight = () => {
      h.clock.now += 1000;
      return undefined;
    };
    await assignAndStart(h);
    expect(h.store.task('task-1')?.invokingAt).toBe(h.clock.now);
  });

  it('keeps advancing other tasks when one lookup fails', async () => {
    const h = await makeHarness();
    h.relay.spawnOutcome = { status: 'running', spawned: false, ready: false };
    const first = makeAssignment({ taskId: 'task-a' });
    const second = makeAssignment({ taskId: 'task-b', repository: 'acme/other' });
    h.relay.deliverAssignment(first.assignment, first.digest);
    h.relay.deliverAssignment(second.assignment, second.digest);
    await h.bridge.tick();
    const a = h.store.task('task-a')?.invocationId as string;
    const b = h.store.task('task-b')?.invocationId as string;
    h.relay.unavailableInvocations.add(a);
    h.relay.invocations.set(b, {
      id: b,
      status: 'completed',
      nodeId: 'node-1',
      name: agentNameOf(h, 'task-b'),
      spawned: true,
      ready: true,
      taskUnconfirmed: false,
    });
    await h.bridge.tick();
    expect(h.store.task('task-b')?.state).toBe('running');
    expect(h.store.task('task-a')?.state).toBe('launched');
  });

  it('fails an unspawnable task without owing a stop or holding its repository', async () => {
    const h = await makeHarness();
    const oversized = makeAssignment({
      taskId: 'task-big',
      acceptance: Array.from({ length: 20 }, () => 'é'.repeat(2000)),
      summary: 'é'.repeat(16_000),
    });
    const next = makeAssignment({ taskId: 'task-next' });
    h.relay.deliverAssignment(oversized.assignment, oversized.digest);
    h.relay.deliverAssignment(next.assignment, next.digest);
    await h.bridge.tick();
    expect(h.store.task('task-big')).toMatchObject({ state: 'failed', reason: 'task_too_large' });
    expect(h.store.stopPending()).toHaveLength(0);
    expect(h.node.endAttempts).toEqual([]);
    expect(h.relay.spawns.map((s) => s.name)).toEqual([agentNameOf(h, 'task-next')]);
  });

  it('refuses an action the assignment says this worker cannot do', async () => {
    const h = await makeHarness();
    const { assignment } = makeAssignment();
    const unblock = { ...assignment, action: 'unblock' as const };
    h.relay.deliverAssignment(unblock, hash(unblock));
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(0);
    expect(h.store.quarantined()).toMatchObject([{ code: 'worker_assignment_not_authorized' }]);
  });

  it('keeps only the newest quarantine rows', () => {
    const store = new BridgeStore(':memory:', { maxQuarantineRows: 2 });
    for (const id of ['1', '2', '3']) store.quarantine(id, 'worker_assignment_invalid', {}, 'x', T0);
    expect(store.quarantined().map((q) => q.messageId)).toEqual(['2', '3']);
    store.close();
  });

  it('keeps a stop owed past the grace period while the launch is unsettled', async () => {
    const h = await makeHarness({ limits: { ...limits, maxRuntimeMs: 60_000 } });
    h.relay.spawnOutcome = { status: 'dispatched', spawned: false, ready: false };
    await assignAndStart(h);
    h.node.endOutcome = 'not_found';
    h.clock.now += 700_000;
    await h.bridge.tick();
    await h.bridge.tick();
    expect(h.store.stopPending()).toHaveLength(1);
    const id = h.store.task('task-1')?.invocationId as string;
    h.relay.invocations.set(id, {
      id,
      status: 'failed',
      spawned: false,
      ready: false,
      taskUnconfirmed: false,
    });
    await h.bridge.tick();
    expect(h.store.stopPending()).toHaveLength(0);
  });

  it('drains a backlog over the batch size and then reaches a later assignment', async () => {
    const h = await makeHarness();
    for (let i = 0; i < 1100; i += 1) h.relay.deliver(CHIEF, 'chief', `noise ${i}`);
    const made = makeAssignment();
    h.relay.deliverAssignment(made.assignment, made.digest);
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(0);
    await h.bridge.tick();
    expect(h.relay.spawns).toHaveLength(1);
  });

  it('reads the chief first and survives another conversation failing', async () => {
    const h = await makeHarness();
    h.relay.deliver('agent-noisy', 'noisy', 'hello');
    h.relay.unavailableConversations.add('dm-agent-noisy');
    await assignAndStart(h);
    expect(h.relay.spawns).toHaveLength(1);
  });

  it('does not read a conversation with nothing new', async () => {
    const h = await makeHarness();
    h.relay.reportLastMessage = true;
    h.relay.deliver('agent-old', 'old', 'hello');
    await h.bridge.tick();
    h.relay.readConversations.length = 0;
    await h.bridge.tick();
    expect(h.relay.readConversations).not.toContain('dm-agent-old');
  });

  it('starts when its own agents have filled the node', async () => {
    const h = await makeHarness();
    h.node.refusal = 'node_at_capacity';
    await expect(h.reopen()).resolves.toBeUndefined();
  });

  it('keeps the ledger sidecars private', async () => {
    const h = await makeHarness();
    await assignAndStart(h);
    for (const suffix of ['-wal', '-shm']) {
      expect(existsSync(h.path + suffix)).toBe(true);
      expect(statSync(h.path + suffix).mode & 0o077).toBe(0);
    }
  });
});
