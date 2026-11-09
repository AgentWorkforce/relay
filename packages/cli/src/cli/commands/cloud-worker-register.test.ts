import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const register = vi.hoisted(() => vi.fn());
vi.mock('@agent-relay/cloud', () => ({
  registerCloudWorker: register,
  cloudWorkerStateDir: vi.fn(),
  downloadCloudWorkerAssignmentStorage: vi.fn(),
  resolveCloudWorkerRecord: vi.fn(),
  runCloudWorkerLoop: vi.fn(),
  upsertCloudWorkerRecord: vi.fn(),
}));
vi.mock('../telemetry/index.js', () => ({ shutdown: vi.fn() }));

import { registerCloudWorkerCommands } from './cloud-worker.js';
import { MAX_WORKER_ENROLLMENT_TOKEN_BYTES } from '../lib/cloud-worker-enrollment-token.js';

const directories: string[] = [];
function file(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-register-'));
  directories.push(dir);
  const result = path.join(dir, 'token');
  fs.writeFileSync(result, content, { mode: 0o600 });
  return result;
}
function harness(stdin: Readable & { isTTY?: boolean } = Readable.from([])) {
  const program = new Command().exitOverride();
  const cloud = program.command('cloud');
  const log = vi.fn();
  const error = vi.fn();
  const fetchImpl = vi.fn();
  registerCloudWorkerCommands(cloud, { stdin, log, error, fetchImpl });
  return { program, log, error, fetchImpl };
}
beforeEach(() => {
  register.mockReset();
  register.mockResolvedValue({
    workerId: 'fixture-worker',
    workerToken: 'fixture-private-worker-token',
    name: 'fixture',
  });
});
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('cloud worker register token sources', () => {
  it.each(['legacy', 'file', 'stdin'])(
    'passes %s input only through the official registration API',
    async (source) => {
      const token = 'fixture-private-enrollment-token';
      const { program, log, error, fetchImpl } = harness(Readable.from([token + '\n']));
      const args =
        source === 'legacy'
          ? ['--token', token]
          : source === 'file'
            ? ['--token-file', file(token)]
            : ['--token-stdin'];
      await program.parseAsync([
        'node',
        'relay',
        'cloud',
        'worker',
        'register',
        '--name',
        'fixture',
        '--json',
        ...args,
      ]);
      expect(register).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ enrollmentToken: token, name: 'fixture', fetchImpl })
      );
      const output = JSON.stringify([...log.mock.calls, ...error.mock.calls]);
      expect(output).not.toContain(token);
      expect(output).not.toContain('fixture-private-worker-token');
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  it.each(
    [
      [],
      ['--token', 'fixture', '--token-stdin'],
      ['--token-file', 'not-present', '--token-stdin'],
      ['--token', 'fixture', '--token-file', 'not-present'],
      ['--token-file', 'not-present'],
      ['--token', ''],
    ].map((args) => ({ args }))
  )('refuses invalid selection/input before registration: $args', async ({ args }) => {
    const { program, log, error, fetchImpl } = harness();
    await expect(
      program.parseAsync(['node', 'relay', 'cloud', 'worker', 'register', '--name', 'fixture', ...args])
    ).rejects.toThrow(/^worker_enrollment_token_/);
    expect(register).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('refuses an oversized file before registration', async () => {
    const { program, fetchImpl } = harness();
    await expect(
      program.parseAsync([
        'node',
        'relay',
        'cloud',
        'worker',
        'register',
        '--name',
        'fixture',
        '--token-file',
        file('x'.repeat(MAX_WORKER_ENROLLMENT_TOKEN_BYTES + 1)),
      ])
    ).rejects.toThrow(/^worker_enrollment_token_too_large$/);
    expect(register).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses interactive stdin before registration', async () => {
    const { program, fetchImpl } = harness(Object.assign(Readable.from(['fixture']), { isTTY: true }));
    await expect(
      program.parseAsync([
        'node',
        'relay',
        'cloud',
        'worker',
        'register',
        '--name',
        'fixture',
        '--token-stdin',
      ])
    ).rejects.toThrow(/^worker_enrollment_token_stdin_tty_refused$/);
    expect(register).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
