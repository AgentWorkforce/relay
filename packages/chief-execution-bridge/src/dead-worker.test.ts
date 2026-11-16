import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BridgeStore, reportReason } from './store.js';
import { agentNameOf, makeAssignment, makeHarness, T0, type Harness } from './__tests__/helpers.js';

const GRACE = 60_000;
const RUNTIME = 1_800_000;

async function running(overrides: Record<string, unknown> = {}): Promise<{ h: Harness; name: string }> {
  const h = await makeHarness({ detectDeadWorkers: true, reportExtensions: true, ...overrides });
  const made = makeAssignment();
  h.relay.deliverAssignment(made.assignment, made.digest);
  await h.bridge.tick();
  const name = agentNameOf(h);
  // The node ended the agent itself, so the bridge's own stop finds nothing.
  h.node.endOutcome = 'not_found';
  h.node.agents = new Map([[name, 'live']]);
  await h.bridge.tick();
  expect(h.store.task('task-1')?.workerSeenAt).toBe(h.clock.now);
  return { h, name };
}

function failedReports(h: Harness) {
  return h.relay.deliveredReports().filter((r) => r.state === 'failed');
}

describe('dead worker detection', () => {
  it('fails a vanished agent with agent_failed once the grace window has passed', async () => {
    const { h } = await running();
    h.node.agents = new Map();
    await h.bridge.tick();
    const goneAt = h.clock.now;
    expect(h.store.task('task-1')).toMatchObject({ state: 'running', workerGoneAt: goneAt });
    expect(h.logs.some((l) => l.event === 'worker_gone')).toBe(true);

    h.clock.now = goneAt + GRACE - 1;
    await h.bridge.tick();
    expect(h.store.task('task-1')?.state).toBe('running');

    h.clock.now = goneAt + GRACE;
    await h.bridge.tick();
    expect(h.store.task('task-1')).toMatchObject({ state: 'failed', reason: 'worker_gone' });
    expect(h.relay.states()).toEqual(['1:accepted', '2:running', '3:failed']);
    expect(failedReports(h)).toEqual([expect.objectContaining({ reason: 'agent_failed' })]);

    // One terminal report only, and the slot is freed once the stop finds nothing.
    h.clock.now += RUNTIME;
    await h.bridge.tick();
    await h.bridge.tick();
    expect(failedReports(h)).toHaveLength(1);
    expect(h.store.stopPending()).toEqual([]);
  });

  it('frees the slot for the next queued task without waiting for the runtime limit', async () => {
    const { h } = await running({ limits: { ...limits(), maxConcurrent: 1 } });
    const next = makeAssignment({ taskId: 'task-2' });
    h.relay.deliverAssignment(next.assignment, next.digest);
    await h.bridge.tick();
    expect(h.store.task('task-2')?.state).toBe('queued');
    h.node.agents = new Map();
    await h.bridge.tick();
    h.clock.now += GRACE;
    await h.bridge.tick();
    await h.bridge.tick();
    expect(h.store.task('task-1')?.state).toBe('failed');
    expect(h.store.task('task-2')?.state).toBe('running');
  });

  it('fails an agent the core lists as exited', async () => {
    const { h, name } = await running();
    h.node.agents = new Map([[name, 'exited']]);
    await h.bridge.tick();
    h.clock.now += GRACE;
    await h.bridge.tick();
    expect(h.store.task('task-1')).toMatchObject({ state: 'failed', reason: 'worker_gone' });
  });

  it('completes normally when the final answer lands within the grace window', async () => {
    const { h, name } = await running();
    h.node.agents = new Map();
    await h.bridge.tick();
    h.clock.now += GRACE - 1000;
    h.relay.deliver('agent-spawned', name, 'CHIEF_RESULT: completed\nDone.');
    // The grace window ends in the same pass that reads the result.
    h.clock.now += 1000;
    await h.bridge.tick();
    expect(h.store.task('task-1')).toMatchObject({ state: 'completed' });
    expect(h.relay.states()).toEqual(['1:accepted', '2:running', '3:completed']);
    await h.bridge.tick();
    expect(failedReports(h)).toEqual([]);
  });

  it('never fails a task because the core cannot be reached', async () => {
    const { h } = await running();
    h.node.agents = new Map();
    await h.bridge.tick();
    h.node.agents = undefined;
    for (const step of [GRACE, GRACE * 5, RUNTIME / 2]) {
      h.clock.now += step;
      await h.bridge.tick();
      expect(h.store.task('task-1')?.state).toBe('running');
    }
    expect(h.logs.some((l) => l.event === 'worker_check_unavailable')).toBe(true);
    // The runtime limit still applies.
    h.clock.now += RUNTIME;
    await h.bridge.tick();
    expect(h.store.task('task-1')).toMatchObject({ state: 'failed', reason: 'runtime_exceeded' });
  });

  it('treats a throwing core as unreachable', async () => {
    const { h } = await running();
    h.node.listAgents = async () => {
      throw new Error('socket closed');
    };
    h.clock.now += GRACE * 2;
    await h.bridge.tick();
    expect(h.store.task('task-1')?.state).toBe('running');
  });

  it('keeps the gone mark across a restart and fails once the grace window has passed', async () => {
    const { h } = await running();
    h.node.agents = new Map();
    await h.bridge.tick();
    const goneAt = h.clock.now;
    h.clock.now = goneAt + GRACE / 2;
    await h.reopen();
    expect(h.store.task('task-1')).toMatchObject({ state: 'running', workerGoneAt: goneAt });
    await h.bridge.tick();
    expect(h.store.task('task-1')?.state).toBe('running');
    h.clock.now = goneAt + GRACE;
    await h.bridge.tick();
    expect(h.store.task('task-1')).toMatchObject({ state: 'failed', reason: 'worker_gone' });
    expect(failedReports(h)).toHaveLength(1);
  });

  it('starts the grace window again when the agent is listed again', async () => {
    const { h, name } = await running();
    h.node.agents = new Map();
    await h.bridge.tick();
    h.clock.now += GRACE - 1;
    h.node.agents = new Map([[name, 'live']]);
    await h.bridge.tick();
    expect(h.store.task('task-1')?.workerGoneAt).toBeUndefined();
    expect(h.logs.some((l) => l.event === 'worker_returned')).toBe(true);
    h.node.agents = new Map();
    h.clock.now += 1;
    await h.bridge.tick();
    h.clock.now += GRACE - 1;
    await h.bridge.tick();
    expect(h.store.task('task-1')?.state).toBe('running');
  });

  it('never fails an agent the core has not yet listed', async () => {
    const h = await makeHarness({ detectDeadWorkers: true });
    const made = makeAssignment();
    h.relay.deliverAssignment(made.assignment, made.digest);
    await h.bridge.tick();
    for (let i = 0; i < 5; i += 1) {
      h.clock.now += GRACE;
      await h.bridge.tick();
    }
    expect(h.store.task('task-1')).toMatchObject({ state: 'running', workerGoneAt: undefined });
  });

  it('honours a configured grace window', async () => {
    const { h } = await running({ deadWorkerGraceMs: 5000 });
    h.node.agents = new Map();
    await h.bridge.tick();
    h.clock.now += 5000;
    await h.bridge.tick();
    expect(h.store.task('task-1')?.state).toBe('failed');
  });

  it('keeps the old behaviour when the flag is off', async () => {
    const h = await makeHarness();
    const made = makeAssignment();
    h.relay.deliverAssignment(made.assignment, made.digest);
    await h.bridge.tick();
    h.node.agents = new Map();
    h.clock.now += RUNTIME;
    await h.bridge.tick();
    expect(h.node.listCalls).toBe(0);
    expect(h.store.task('task-1')?.state).toBe('running');
    h.clock.now += 1;
    await h.bridge.tick();
    expect(h.store.task('task-1')).toMatchObject({ state: 'failed', reason: 'runtime_exceeded' });
  });

  it('asks the core nothing while no task is running', async () => {
    const h = await makeHarness({ detectDeadWorkers: true });
    await h.bridge.tick();
    expect(h.node.listCalls).toBe(0);
  });

  it('reports worker_gone as agent_failed', () => {
    expect(reportReason('worker_gone')).toBe('agent_failed');
  });

  it('adds the worker columns to a ledger written before them', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'chief-bridge-')), 'old.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE tasks(task_id TEXT PRIMARY KEY, digest TEXT NOT NULL, assignment TEXT NOT NULL,
      repository TEXT NOT NULL, reservation_micros INTEGER NOT NULL, agent_name TEXT NOT NULL UNIQUE,
      invocation_key TEXT NOT NULL, state TEXT NOT NULL, next_sequence INTEGER NOT NULL, invocation_id TEXT,
      bound_agent_id TEXT, pending_result TEXT, reason TEXT, created_at INTEGER NOT NULL, invoking_at INTEGER,
      running_at INTEGER, finished_at INTEGER, stop_pending INTEGER NOT NULL DEFAULT 0, findings TEXT,
      revision TEXT)`);
    old.close();
    const store = new BridgeStore(path);
    const made = makeAssignment();
    store.claim({ ...made, agentName: 'n', invocationKey: 'k', budgetMicros: 1e6, now: T0 });
    store.markInvoking('task-1', T0);
    store.markLaunched('task-1', 'inv-1');
    store.markRunning('task-1', T0);
    store.observeWorker('task-1', 'exited', T0 + 5);
    expect(store.task('task-1')).toMatchObject({ workerSeenAt: T0 + 5, workerGoneAt: T0 + 5 });
    store.close();
  });
});

function limits() {
  return {
    maxConcurrent: 2,
    maxReservationMicros: 5000,
    budgetMicros: 100_000,
    maxRuntimeMs: RUNTIME,
    maxQueuedMs: 900_000,
  };
}
