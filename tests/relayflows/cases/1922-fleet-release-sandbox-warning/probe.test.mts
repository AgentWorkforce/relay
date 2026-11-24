import fs from 'node:fs';

import { Command } from 'commander';
import { expect, test, vi } from 'vitest';

// The runner copies this probe into <target>/.relay-pr-proof/.
import { registerFleetCommands } from '../packages/cli/src/cli/commands/fleet.js';

test('a dispatched fleet release keeps JSON stdout and reports sandbox costs on stderr', async () => {
  const observationPath = process.env.RELAY_PR1922_OBSERVATION_PATH;
  if (!observationPath) throw new Error('Missing RELAY_PR1922_OBSERVATION_PATH.');

  const stdout: string[] = [];
  const stderr: string[] = [];
  const errors: string[] = [];
  const receipt = {
    invocationId: 'inv_release_proof',
    actionName: 'agent.release',
    status: 'dispatched',
  };
  const release = vi.fn(async () => receipt);
  const deleteSandbox = vi.fn();
  const program = new Command();
  program.exitOverride();
  // Exercise the production default log/warn sinks; only the remote lifecycle API is stubbed.
  const log = vi.spyOn(console, 'log').mockImplementation((message) => stdout.push(String(message)));
  const warn = vi.spyOn(console, 'warn').mockImplementation((message) => stderr.push(String(message)));
  const error = vi.spyOn(console, 'error').mockImplementation((message) => errors.push(String(message)));

  try {
    registerFleetCommands(program, {
      createFleetWorkspaceClient: (() => ({ agents: { release } })) as never,
      deleteCloudFleetSandbox: deleteSandbox as never,
    });
    await program.parseAsync(['fleet', 'release', 'proof-worker', '--workspace-key', 'rk_proof'], {
      from: 'user',
    });

    expect(errors).toEqual([]);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toEqual(receipt);
    expect(release).toHaveBeenCalledExactlyOnceWith({
      name: 'proof-worker',
      reason: expect.stringMatching(/^fleet agent released \(actor: .+\)$/),
      deleteAgent: false,
    });
    expect(deleteSandbox).not.toHaveBeenCalled();

    const missingWarning = stderr.length === 0;
    const hasWarning =
      stderr.length === 1 &&
      stderr[0]!.includes('Release was dispatched') &&
      stderr[0]!.includes('Cloud/provider sandbox may keep running and incurring cost') &&
      stderr[0]!.includes('`fleet release` does not tear it down');
    expect(missingWarning || hasWarning, JSON.stringify(stderr)).toBe(true);
    fs.writeFileSync(observationPath, JSON.stringify({ missingWarning, hasWarning }));
  } finally {
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  }
});
