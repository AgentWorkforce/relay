/**
 * Tests for WorkflowBuilder.run() local persistence and resume behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Mock fetch ───────────────────────────────────────────────────────────────

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({ data: { api_key: 'rk_live_test', workspace_id: 'ws-test' } }),
  text: () => Promise.resolve(''),
});
vi.stubGlobal('fetch', mockFetch);

// ── Mock RelayCast SDK ───────────────────────────────────────────────────────

const mockRelaycastAgent = {
  send: vi.fn().mockResolvedValue(undefined),
  heartbeat: vi.fn().mockResolvedValue(undefined),
  channels: {
    create: vi.fn().mockResolvedValue(undefined),
    join: vi.fn().mockResolvedValue(undefined),
    invite: vi.fn().mockResolvedValue(undefined),
  },
};

const mockRelaycast = {
  agents: {
    register: vi.fn().mockResolvedValue({ token: 'token-1' }),
  },
  as: vi.fn().mockReturnValue(mockRelaycastAgent),
};

class MockRelayError extends Error {
  code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.name = 'RelayError';
    (this as any).status = status;
  }
}

vi.mock('@relaycast/sdk', () => ({
  RelayCast: vi.fn().mockImplementation(() => mockRelaycast),
  RelayError: MockRelayError,
}));

// ── Mock AgentRelay ──────────────────────────────────────────────────────────

const mockRelayInstance = {
  shutdown: vi.fn().mockResolvedValue(undefined),
  onBrokerStderr: vi.fn().mockReturnValue(() => {}),
  onMessageReceived: null as any,
  onAgentSpawned: null as any,
  onAgentReleased: null as any,
  onAgentExited: null as any,
  onAgentIdle: null as any,
  onWorkerOutput: null as any,
  onDeliveryUpdate: null as any,
};

vi.mock('../relay.js', () => ({
  AgentRelay: vi.fn().mockImplementation(() => mockRelayInstance),
}));

// Import after mocking
const { workflow } = await import('../workflows/builder.js');

type JsonlEntry =
  | { kind: 'run'; row: { id: string; workflowName: string; status: string } }
  | { kind: 'step'; row: { runId: string; stepName: string; status: string; output?: string } };

function readJsonl(filePath: string): JsonlEntry[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonlEntry);
}

describe('WorkflowBuilder.run() resume persistence', () => {
  let tmpDir: string;
  let originalResumeRunId: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'builder-resume-persistence-'));
    originalResumeRunId = process.env.RESUME_RUN_ID;
    delete process.env.RESUME_RUN_ID;
  });

  afterEach(() => {
    if (originalResumeRunId === undefined) {
      delete process.env.RESUME_RUN_ID;
    } else {
      process.env.RESUME_RUN_ID = originalResumeRunId;
    }

    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // tmpDir may already be gone; nothing to clean up.
    }
  });

  it('WorkflowBuilder.run() persists run state to JsonFileWorkflowDb by default', async () => {
    const run = await workflow('t')
      .trajectories(false)
      .step('s1', { type: 'deterministic', command: 'echo ok' })
      .run({ cwd: tmpDir, logLevel: false });

    const dbPath = path.join(tmpDir, '.agent-relay', 'workflow-runs.jsonl');
    const dbContents = readFileSync(dbPath, 'utf8');
    const entries = readJsonl(dbPath);

    expect(run.status).toBe('completed');
    expect(existsSync(dbPath)).toBe(true);
    expect(dbContents).toContain('"kind":"run"');
    expect(dbContents).toContain('"workflowName":"t-workflow"');
    expect(entries.some((entry) => entry.kind === 'run' && entry.row.workflowName === 't-workflow')).toBe(
      true
    );
  });

  it('WorkflowBuilder.run() with RESUME_RUN_ID reconstructs from cached step outputs', async () => {
    const runId = 'test-run-cached';
    const stepOutputDir = path.join(tmpDir, '.agent-relay', 'step-outputs', runId);
    const s1OutputPath = path.join(stepOutputDir, 's1.md');
    mkdirSync(stepOutputDir, { recursive: true });
    writeFileSync(s1OutputPath, 'cached-step-1');

    process.env.RESUME_RUN_ID = runId;

    const run = await workflow('t')
      .trajectories(false)
      .step('s1', { type: 'deterministic', command: 'echo ok' })
      .step('s2', { type: 'deterministic', command: 'echo ok', dependsOn: ['s1'] })
      .run({ cwd: tmpDir, logLevel: false });

    const dbPath = path.join(tmpDir, '.agent-relay', 'workflow-runs.jsonl');
    const entries = readJsonl(dbPath);

    expect(run.id).toBe(runId);
    expect(run.status).toBe('completed');
    expect(readFileSync(s1OutputPath, 'utf8')).toBe('cached-step-1');
    expect(entries.some((entry) => entry.kind === 'run' && entry.row.id === runId)).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.kind === 'step' &&
          entry.row.runId === runId &&
          entry.row.stepName === 's1' &&
          entry.row.output === 'cached-step-1'
      )
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.kind === 'step' &&
          entry.row.runId === runId &&
          entry.row.stepName === 's2' &&
          entry.row.status === 'completed'
      )
    ).toBe(true);
  });

  it.skip('WorkflowBuilder.run() with cloud option does NOT create local JSONL db', () => {
    // Add this as a dedicated cloud-path test once packages/sdk/src/workflows/cloud-runner.ts
    // is mocked at the builder boundary without invoking the remote API contract.
  });
});
