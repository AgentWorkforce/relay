import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@relaycast/sdk', () => ({
  RelayCast: vi.fn(),
  RelayError: class RelayError extends Error {},
}));

vi.mock('../../relay.js', () => ({
  AgentRelay: vi.fn(),
}));

const { WorkflowRunner } = await import('../runner.js');

describe('WorkflowRunner interactive spawn naming', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds a retry suffix for interactive respawns after the first attempt', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'relay-runner-spawn-name-'));
    const runner = new WorkflowRunner({ cwd });
    const relay = {
      spawnPty: vi.fn(async ({ name }: { name: string }) => ({
        name,
        exitCode: 0,
        exitSignal: undefined,
        release: vi.fn(async () => undefined),
      })),
      listAgentsRaw: vi.fn(async () => []),
    };

    (runner as any).relay = relay;
    (runner as any).currentRunId = 'adf00e1b12345678';
    vi.spyOn(runner as any, 'waitForExitWithIdleNudging').mockResolvedValue('released');

    const agent = {
      name: 'codex',
      cli: 'codex',
      interactive: true,
    };
    const step = {
      name: 'debate',
      task: 'Resolve the issue.',
    };

    await (runner as any).spawnAndWait(agent, step, undefined, {
      agentNameSuffix: 'codex',
    });
    await (runner as any).spawnAndWait(agent, step, undefined, {
      agentNameSuffix: 'codex',
      attempt: 1,
    });

    const requestedNames = relay.spawnPty.mock.calls.map(([options]: [{ name: string }]) => options.name);

    expect(requestedNames).toEqual(['debate-codex-adf00e1b', 'debate-codex-adf00e1b-r1']);
    expect(requestedNames[1]).not.toBe(requestedNames[0]);
  });
});
