import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { registerStatusCommand, type StatusDependencies } from './status.js';

function harness(overrides: Partial<StatusDependencies> = {}) {
  const log = vi.fn();
  const deps: Partial<StatusDependencies> = {
    getProjectRoot: () => '/tmp/project',
    getCloudAuth: vi.fn(async () => ({ apiUrl: 'https://cloud.example' })),
    log,
    error: vi.fn(),
    exit: vi.fn() as never,
    ...overrides,
  };
  const program = new Command();
  program.exitOverride();
  registerStatusCommand(program, deps);
  return { program, log };
}

describe('relay status (composite)', () => {
  it('reports workspace and cloud login', async () => {
    const { program, log } = harness();
    await program.parseAsync(['status'], { from: 'user' });
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContainEqual(expect.stringContaining('/tmp/project'));
    expect(lines).toContainEqual(expect.stringContaining('logged in (https://cloud.example)'));
    expect(lines.some((line) => /broker/i.test(line))).toBe(false);
  });

  it('reports not-logged-in', async () => {
    const { program, log } = harness({ getCloudAuth: vi.fn(async () => null) });
    await program.parseAsync(['status'], { from: 'user' });
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContainEqual(expect.stringContaining('not logged in'));
  });
});
